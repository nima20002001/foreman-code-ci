import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PostgresSourceService, type SourceExecutionHostPort } from './service.js'
import { PrivateSourceSnapshotStore } from './store.js'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture() {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'source-closure-'))
  directories.push(directory)
  const store = new PrivateSourceSnapshotStore(directory)
  const bytes = Buffer.from('original immutable source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' },
    executablePolicy: 'strip', deletions: [], entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  const runtime = verificationRuntimeFixture()
  const root = runtime.measurement.fingerprint.root
  const binding = { ...root.binding, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const record = SourceMaterializationRecordSchema.parse({
    receipt: { version: 1, materializationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(),
      binding, quota: runtime.measurement.fingerprint.quotaPool!.slots[0], placementHash: 'a'.repeat(64),
      keyRevision: root.registration?.keyRevision ?? null, authorizationRevision: root.registration?.authorizationRevision ?? null,
      verifiedManifestDigest: manifest.manifestDigest, verifiedEntries: manifest.totalEntries,
      verifiedBytes: manifest.totalBytes, verifiedAt: new Date().toISOString(), localTreeIdentity: binding.filesystem },
    rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: root.selection.rootPolicyRevision,
    operationId: randomUUID(), reservationId: randomUUID(), sourceBindingHash: 'a'.repeat(64),
    finalDispatchBindingHash: 'b'.repeat(64), state: 'prepared',
  })
  const reservation = { reservationId: record.reservationId, ownerKind: 'materialization', ownerId: record.operationId,
    scopeId: 'original-host-filesystem', reservedBytes: 4096 }
  const state = { materialization: 'prepared', reservation: 'owned' }
  const query = async (text: string) => {
    if (text.includes('from source_snapshots')) return { rows: [{ availability: 'retained' }] }
    if (text.includes('select record from source_execution_materializations')) return { rows: [{ record }] }
    if (text.includes('select record from source_storage_reservations')) return { rows: [{ record: reservation }] }
    if (text.startsWith('update source_execution_materializations')) state.materialization = 'closed'
    if (text.includes("set state='reclaimed'")) state.reservation = 'reclaimed'
    return { rows: [], rowCount: 1 }
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const releaseClaim = vi.fn(async () => ({ retainedBytes: 0 }))
  const executions = { releaseClaim } as unknown as SourceExecutionHostPort
  const sources = new PostgresSourceService(pool, {} as never, {} as never, store, binding.mainId,
    {} as never, executions, { confirmedClosed: async () => true })
  return { store, bytes, manifest, record, state, releaseClaim, sources }
}

it('keeps verification quota occupied when database retention has no canonical source bytes', async () => {
  const f = await fixture()
  await expect(f.sources.confirmClosed(f.record)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.releaseClaim).not.toHaveBeenCalled()
  expect(f.state).toEqual({ materialization: 'prepared', reservation: 'owned' })
})

it('releases a stopped verification Job while preserving its committed canonical snapshot', async () => {
  const f = await fixture()
  await f.store.write(f.manifest.snapshotId, f.manifest.entries[0]!, f.bytes)
  await f.store.commit(f.manifest)
  await f.sources.confirmClosed(f.record)
  expect(f.releaseClaim).toHaveBeenCalledWith(f.record, undefined)
  expect(f.state).toEqual({ materialization: 'closed', reservation: 'reclaimed' })
  expect(await f.store.manifest(f.manifest.snapshotId)).toEqual(f.manifest)
  expect(await f.store.read(f.manifest, f.manifest.entries[0]!, AbortSignal.timeout(5000))).toEqual(f.bytes)
})

it('preserves explicit cleanup options when releasing a verification Job source', async () => {
  const f = await fixture()
  await f.store.write(f.manifest.snapshotId, f.manifest.entries[0]!, f.bytes)
  await f.store.commit(f.manifest)
  const options = { signal: new AbortController().signal }
  await f.sources.confirmClosed(f.record, options)
  expect(f.releaseClaim).toHaveBeenCalledWith(f.record, options)
  expect(f.state).toEqual({ materialization: 'closed', reservation: 'reclaimed' })
})
