import { setupMaterializationReservationCleanup } from './helpers/materializationReservationCleanup.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobPendingAdmissionSchema, JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { createSourceManifest } from '../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'

let fixture: Awaited<ReturnType<typeof setupMaterializationReservationCleanup>> | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

it('reclaims abandoned owned and preparing copies and restores placement through authenticated MCP', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const owned = await f.orphan('owned')
  const preparing = await f.orphan('preparing')
  f.online()
  const definition = await f.save()
  const client = await f.connect(f.writer.token)
  const input = { workspaceId: f.workspaceId, commandId: randomUUID(), definitionId: definition.id,
    expectedRevision: definition.revision }
  const started = await client.callTool({ name: 'job_start', arguments: input })
  expect(started.isError, JSON.stringify(started)).not.toBe(true)
  const pending = JobPendingAdmissionSchema.parse((decodeMcpToolResult(started) as { admission: unknown }).admission)
  await f.jobs.wakeQueue()
  const before = await client.callTool({ name: 'job_queue_get', arguments: { workspaceId: f.workspaceId, ticketId: pending.ticket.id } })
  expect(before.isError, JSON.stringify(before)).not.toBe(true)
  expect(JobQueueTicketSchema.parse((decodeMcpToolResult(before) as { ticket: unknown }).ticket).waitingReasons).toEqual(['busy'])
  expect(f.accept).not.toHaveBeenCalled()
  const denied = await f.access.issue({ name: 'Unscoped fixture reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['jobs:read'], scope: { workspaceIds: ['another-workspace'] } }] })
  const readOnly = await f.connect(denied.token)
  const deniedStart = await readOnly.callTool({ name: 'job_start', arguments: { ...input, commandId: randomUUID() } })
  expect(deniedStart.isError).toBe(true)
  expect(JSON.stringify(deniedStart.content)).toContain('ACCESS_DENIED')
  expect(await f.cleanup.reconcile()).toBe(2)
  for (const orphan of [owned, preparing]) {
    await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
      [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
  }
  const audits = await f.pool.query("select details from management_audit where action='source.materialization.reservation.release'")
  expect(audits.rows).toHaveLength(2)
  expect(await f.cleanup.reconcile()).toBe(0)
  await f.jobs.wakeQueue()
  const after = await client.callTool({ name: 'job_queue_get', arguments: { workspaceId: f.workspaceId, ticketId: pending.ticket.id } })
  expect(after.isError, JSON.stringify(after)).not.toBe(true)
  expect(JobQueueTicketSchema.parse((decodeMcpToolResult(after) as { ticket: unknown }).ticket))
    .toMatchObject({ state: 'accepted', waitingReasons: [],
      selectedComputer: { rootId: f.root.binding.rootId, bindingRevision: f.root.binding.bindingRevision } })
  expect(f.accept).toHaveBeenCalledTimes(1)
}, 60_000)

it('leaves a live computer selection and its reservation untouched', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const definition = await f.save()
  await f.pool.query(`insert into job_computer_selections
    (execution_id,workspace_id,definition_version_id,attempt_id,operation_id,host_key,spec,limits,selection,source_scope,source_bytes)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,'{}',$6,1)`,
  [orphan.attempt.executionId, f.workspaceId, definition.versionId, orphan.attempt.attemptId, orphan.reservation.ownerId,
    f.scopeId, JSON.stringify(f.computers[0]!.candidate.spec), JSON.stringify(f.computers[0]!.candidate.profile.limits)])
  expect(await f.cleanup.reconcile()).toBe(0)
  expect(f.reclaim).not.toHaveBeenCalled()
  expect((await f.pool.query('select state,record from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]).toEqual({ state: 'owned',
    record: { ...orphan.reservation, cleanupRetry: { failures: 0, nextAttemptAt: expect.any(String) } } })
  expect(await readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt'))).toBeDefined()
}, 60_000)

it('reclaims an original copy while another root on the same filesystem has a live producer', async () => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('owned')
  const policyId = randomUUID()
  const namespace = join(f.runtime, 'source-materializations', policyId)
  await mkdir(namespace, { mode: 0o700 })
  const directory = await openPrivateRoot(namespace)
  const filesystem = await identity(directory)
  await directory.close()
  const otherRoot = SourceRootRecordSchema.parse({ ...f.root,
    selection: { ...f.root.selection, rootPolicyId: policyId },
    binding: { ...f.root.binding, rootId: randomUUID(), canonicalPath: namespace, filesystem } })
  await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [otherRoot.binding.rootId, f.workspaceId, randomUUID()])
  await f.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [otherRoot.binding.rootId, f.workspaceId, f.manifest.snapshotId,
    JSON.stringify(otherRoot)])
  const producer = spawn(process.execPath, ['-e',
    "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"],
  { cwd: namespace, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      producer.once('error', reject)
      producer.stdout.once('data', () => resolve())
    })
    expect(await f.cleanup.reconcile()).toBe(1)
    expect(producer.exitCode).toBeNull()
    expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
      [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
    await expect(readFile(join(f.namespace, orphan.receipt.materializationId, 'tree', 'source.txt')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (producer.exitCode === null && producer.signalCode === null) {
      const exited = once(producer, 'exit')
      producer.kill('SIGTERM')
      await exited
    }
  }
}, 60_000)

it.each([false, true])('ignores an unrelated historical host key during cleanup (other workspace: %s)', async otherWorkspace => {
  fixture = await setupMaterializationReservationCleanup()
  const f = fixture
  const orphan = await f.orphan('preparing')
  const workspaceId = otherWorkspace ? randomUUID() : f.workspaceId
  const manifest = otherWorkspace
    ? createSourceManifest({ ...f.manifest, snapshotId: randomUUID(), approvedSourceId: randomUUID() })
    : f.manifest
  if (otherWorkspace) {
    await f.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Historical roots' })])
    await f.pool.query(`insert into source_approvals
      (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
      values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
      [manifest.approvedSourceId, manifest.snapshotId, workspaceId, f.writer.principal.id,
        randomUUID(), 'f'.repeat(64)])
    await f.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
      select $1,$2,$3,$4,record || jsonb_build_object('workspaceId',$3::text,'manifest',$5::jsonb)
      from source_snapshots where snapshot_id=$6`,
      [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest,
        JSON.stringify(manifest), f.manifest.snapshotId])
  }
  const rootId = randomUUID()
  const old = SourceRootRecordSchema.parse({ ...f.root,
    source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest },
    registration: { ...f.root.registration!, keyRevision: 2 },
    binding: { ...f.root.binding, rootId, workspaceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest } })
  const current = SourceRootRecordSchema.parse({ ...old, registration: f.root.registration,
    binding: { ...old.binding, bindingRevision: 2 } })
  await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,2)`, [rootId, workspaceId, randomUUID()])
  for (const root of [old, current]) await f.pool.query(`insert into source_root_bindings
    (root_id,binding_revision,workspace_id,snapshot_id,record) values($1,$2,$3,$4,$5::jsonb)`,
    [rootId, root.binding.bindingRevision, workspaceId, manifest.snapshotId, JSON.stringify(root)])
  expect(await f.cleanup.reconcile()).toBe(1)
  expect(f.reclaim.mock.calls[0]![0].roots).toEqual([f.root])
  expect((await f.pool.query('select state from source_storage_reservations where reservation_id=$1',
    [orphan.reservation.reservationId])).rows[0]!.state).toBe('reclaimed')
  expect((await f.pool.query('select record from source_root_bindings where root_id=$1 and binding_revision=1',
    [rootId])).rows[0]!.record).toEqual(old)
}, 60_000)


