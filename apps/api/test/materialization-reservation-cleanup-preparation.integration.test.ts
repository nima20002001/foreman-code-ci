import { setupMaterializationReservationCleanup } from './helpers/materializationReservationCleanup.js'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresSourceReservations, type SourceReservation } from '../src/modules/sources/reservations.js'
import { releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { measureRetainedMaterializationFootprint, measureRetainedSourceDirectory } from '../src/modules/sources/retainedDirectoryUsage.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { readSourceStorageCapacity } from '../src/modules/sources/storageCapacity.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

let fixture: Awaited<ReturnType<typeof setupMaterializationReservationCleanup>> | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

it.each(['timeout', 'invalid reply', 'adoption rollback'] as const)(
  'preserves an atomic cleanup owner after %s and reclaims the failed preparation automatically', async failure => {
    fixture = await setupMaterializationReservationCleanup()
    const f = fixture
    const operationId = randomUUID()
    const attempt = f.attempt(operationId)
    const definition = await f.save(f.computers[0]!.candidate.spec)
    const commandId = randomUUID()
    await f.pool.query(`insert into job_preparations
      (execution_id,attempt_id,operation_id,workspace_id,definition_version_id,principal_id,command_id,definition)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [attempt.executionId, attempt.attemptId, operationId,
      f.workspaceId, definition.versionId, f.principal.id, commandId, JSON.stringify(definition)])
    const authorize = vi.fn(async () => {})
    if (failure === 'adoption rollback') {
      authorize.mockResolvedValueOnce().mockResolvedValueOnce().mockRejectedValueOnce(new Error('Adoption rolled back'))
    }
    const sources = new PostgresSourceService(f.pool, f.commands,
      new WorkspaceLocationService(f.pool, f.commands, f.runtime, 'fixture'),
      new PrivateSourceSnapshotStore(join(f.runtime, 'snapshots')), f.root.binding.mainId,
      { authorize: f.unused, attest: f.unused, fence: f.unused },
      { authorize, authorizeFinal: f.unused, verify: f.unused, verifyWorkingDirectory: f.unused,
        storageCapacity: root => readSourceStorageCapacity(root.binding.canonicalPath, root.binding.filesystem),
        releaseClaim: f.unused, prepare: async () => {
          const receipt = await f.materializer.prepare({ binding: f.root.binding, manifest: f.manifest, attempt })
          if (failure === 'timeout') throw new Error('Lost source activation reply')
          if (failure === 'invalid reply') return { ...receipt, executionId: randomUUID() }
          return receipt
        } }, { confirmedClosed: f.unused })
    const input = { principal: f.principal, workspaceId: f.workspaceId, rootId: f.root.binding.rootId,
      bindingRevision: 1, source: f.root.source, attempt, operationId }
    await expect(sources.prepareExecution(input)).rejects.toThrow()
    const row = (await f.pool.query<{ record: SourceReservation }>(
      'select record from source_storage_reservations where owner_id=$1', [operationId])).rows[0]!
    expect(row.record.preparation).toMatchObject({ root: f.root, attempt, identity: { operationId } })
    expect((await f.pool.query('select 1 from source_execution_materializations where operation_id=$1', [operationId])).rowCount).toBe(0)
    expect(await f.cleanup.reconcile()).toBe(0)
    await f.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,'http','job.start',$2,'failed',$3::jsonb)`, [f.principal.id, f.workspaceId, JSON.stringify({ commandId })])
    expect(await f.cleanup.reconcile()).toBe(1)
    expect((await f.pool.query('select state from source_storage_reservations where owner_id=$1', [operationId])).rows[0]!.state)
      .toBe('reclaimed')
    await expect(sources.prepareExecution(input)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_RECONCILED' })
  }, 60_000)


it.each(['unadopted', 'recorded'] as const)(
  'keeps abandoned writable trees and their measured charge after releasing %s preparation ownership', async state => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned', { sharedWritableTree: true })
  if (state === 'recorded') {
    const record = SourceMaterializationRecordSchema.parse({ receipt: orphan.receipt,
      rootPolicyId: f.root.selection.rootPolicyId, rootPolicyRevision: f.root.selection.rootPolicyRevision,
      operationId: orphan.reservation.ownerId, reservationId: orphan.reservation.reservationId,
      sourceBindingHash: orphan.receipt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    await f.pool.query(`update source_storage_reservations
      set record=jsonb_set(record,'{preparation,record}',$2::jsonb) where reservation_id=$1`,
    [orphan.reservation.reservationId, JSON.stringify(record)])
  }
  const working = join(f.namespace, orphan.receipt.sharedTree!.id, 'tree', 'output.txt')
  await writeFile(working, 'Unintegrated Agent output')
  expect(await f.cleanup.reconcile()).toBe(1)
  expect(await f.cleanup.reconcile()).toBe(0)
  const footprint = await measureRetainedMaterializationFootprint(orphan.receipt)
  const retained = (await f.pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!
  expect(retained).toEqual({ state: 'retained', reserved_bytes: String(footprint.retainedBytes + 16 * 1024) })
  const stored = (await f.pool.query<{ record: SourceReservation }>(
    'select record from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.record
  expect(stored.preparationClosure).toMatchObject({ operationId: orphan.reservation.ownerId,
    executionId: orphan.attempt.executionId, attemptId: orphan.attempt.attemptId,
    materializationId: orphan.receipt.materializationId, childrenClosed: true, claimReleased: true })
  expect(stored.referenceReclaimed).toBeUndefined()
  expect(await readFile(working, 'utf8')).toBe('Unintegrated Agent output')
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
  const next = await f.orphan('owned')
  expect(next.reservation.reservationId).not.toBe(orphan.reservation.reservationId)
}, 60_000)

it('charges three closed references and one reused writable tree across closure replay', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const copies = []
  const reservations = new PostgresSourceReservations()
  async function close(copy: Awaited<ReturnType<typeof f.orphan>>) {
    await releaseMaterializationClaim(copy.receipt, async () => 'released')
    const footprint = await measureRetainedMaterializationFootprint(copy.receipt)
    await withTransaction(f.pool, async sql => {
      await reservations.retainMaterialization(sql, copy.reservation,
        { ...footprint, retainedBytes: footprint.retainedBytes + 16 * 1024 })
    })
  }
  for (let index = 0; index < 3; index++) {
    const copy = await f.orphan('owned', { sharedWritableTree: true })
    await close(copy)
    copies.push(copy)
  }
  expect(new Set(copies.map(copy => copy.receipt.sharedTree!.id)).size).toBe(1)
  const references = await Promise.all(copies.map(copy =>
    measureRetainedSourceDirectory(f.namespace, copy.receipt.materializationId)))
  const shared = await measureRetainedSourceDirectory(f.namespace, copies[0]!.receipt.sharedTree!.id)
  const expected = references.reduce((total, bytes) => total + bytes, 0) + shared + 3 * 16 * 1024
  const charged = async () => Number((await f.pool.query<{ bytes: string }>(
    "select sum(reserved_bytes) as bytes from source_storage_reservations where scope_id=$1 and state<>'reclaimed'",
    [f.scopeId])).rows[0]!.bytes)
  expect(await charged()).toBe(expected)
  for (const copy of copies) await close(copy)
  expect(await charged()).toBe(expected)
}, 60_000)

