import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ApprovedSource, SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { qualifyApprovedRootAllowlist } from './rootAttestation.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceMaterializationClaimName } from './quotaClaims.js'
import { sourceBindingHash } from './bindingHash.js'
import { PostgresSourceRsyncLifecycle, createWorkerSourceRsyncAcknowledgement } from './rsyncTransferLifecycle.js'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const directory = await mkdtemp('/tmp/source-rsync-lifecycle-'); directories.push(directory)
  const runtime = join(directory, 'runtime'), base = join(directory, 'projects')
  await mkdir(runtime, { mode: 0o700 }); await mkdir(base, { mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const context = transferContextForBinding(binding)
  const roots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
    applicationInstallationId: binding.workerInstallationId, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
  const policyId = randomUUID(), parent = join(runtime, 'source-materializations'), namespace = join(parent, policyId)
  await mkdir(parent, { mode: 0o700 }); await mkdir(namespace, { mode: 0o700 })
  const handle = await openPrivateRoot(namespace), filesystem = await identity(handle); await handle.close()
  const bytes = Buffer.from('exact original source bytes\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(), capturePolicy: 'exclusive-explicit-bytes-v1',
    executablePolicy: 'strip', deletions: [], entries: [{ path: 'src/main.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const root: SourceRootRecord = { version: 1, source: { snapshotId: manifest.snapshotId, approvedSourceId: manifest.approvedSourceId, manifestDigest: manifest.manifestDigest },
    selection: { hostRef: roots.hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, workspaceId: 'source-lifecycle-workspace', ...context, rootId: randomUUID(), bindingRevision: 1,
      locationRevision: 1, canonicalPath: namespace, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    ownerPrincipalId: 'original-human', authorizedByPrincipalId: 'original-preparation', registration: { workerInstallationId: binding.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1 }, attestationId: randomUUID(), attestationDigest: 'a'.repeat(64), boundAt: new Date().toISOString() }
  // The root binding has only its own shared fields, not transfer context fields.
  for (const key of ['bootId', 'connectionEpoch', 'keyRevision', 'authorizationRevision']) delete (root.binding as unknown as Record<string, unknown>)[key]
  const operationId = randomUUID(), attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '', keyRevision: 1, authorizationRevision: 1 }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  const packageBytes = Buffer.concat([Buffer.from(JSON.stringify(manifest)), bytes])
  const admitted = { root, attempt, identity: { operationId, ownerPrincipalId: root.authorizedByPrincipalId, expiresAt: new Date(Date.now() + 120000).toISOString() },
    intent: { ...context, version: 1, transferId: randomUUID(), operationId, executionId: attempt.executionId, attemptId: attempt.attemptId,
      placementHash: attempt.placementHash, rootId: root.binding.rootId, rootBindingRevision: 1, direction: 'to-worker', byteClass: 'source',
      manifestDigest: manifest.manifestDigest, sha256: sourceSha256(packageBytes), byteSize: packageBytes.length, chunkBytes: 1024,
      expiresAt: new Date(Date.now() + 60000).toISOString() } as TransferIntent }
  const receipt = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}).prepare({ manifest, binding: root.binding, attempt })
  const record: SourceMaterializationRecord = { receipt, operationId, reservationId: randomUUID(), rootPolicyId: policyId, rootPolicyRevision: '1',
    sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' }
  const source: ApprovedSource = { version: 1, workspaceId: root.binding.workspaceId, ownerPrincipalId: root.ownerPrincipalId,
    approvedByPrincipalId: root.ownerPrincipalId, locationRevision: 1, mainId: binding.mainId, originIdentityHash: `sha256:${'b'.repeat(64)}`,
    manifest, approvedAt: new Date().toISOString(), availability: 'retained' }
  const facts = { admissions: [admitted], materializations: [{ record, state: 'prepared', reservation_id: record.reservationId, materialization_id: record.receipt.materializationId }],
    roots: [{ record: root }], snapshots: [{ record: source, availability: 'retained' }],
    reservations: [{ state: 'owned', owner_kind: 'materialization', owner_id: operationId, reserved_bytes: String(manifest.totalBytes * 3 + 8192 + 2 * 1024 * 1024) }] }
  const sqlCalls: string[] = [], release = vi.fn()
  const query = vi.fn(async (text: string) => {
    sqlCalls.push(text)
    let rows: unknown[] = []
    if (text.includes('management_command_receipts')) rows = facts.admissions.map(result => ({ result }))
    else if (text.includes('source_execution_materializations')) rows = facts.materializations
    else if (text.includes('source_root_bindings')) rows = facts.roots
    else if (text.includes('source_snapshots')) rows = facts.snapshots
    else if (text.includes('source_storage_reservations')) rows = facts.reservations
    else if (!['begin', 'commit', 'rollback'].includes(text)) throw new Error(`Unexpected fixture SQL: ${text}`)
    return { rows, rowCount: rows.length }
  })
  const pool = { query, connect: async () => ({ query, release }) } as unknown as pg.Pool
  const accepted = { intent: vi.fn(async () => admitted.intent), authorize: vi.fn(async () => {}) }
  const lifecycle = new PostgresSourceRsyncLifecycle(pool, accepted)
  const authenticate = vi.fn(async () => {}), currentCommitted = vi.fn(async () => ({ intent: admitted.intent, record: structuredClone(record) }))
  const approvedRoots = vi.fn(async () => roots)
  const worker = createWorkerSourceRsyncAcknowledgement({ authenticate, currentCommitted, approvedRoots })
  return { directory, namespace, binding, context, bytes, admitted, record, source, facts, sqlCalls, query, release, accepted, lifecycle,
    worker, authenticate, currentCommitted, approvedRoots }
}

describe('original source rsync lifecycle', () => {
  it('returns the exact original admitted intent and committed owned materialization without new allocation', async () => {
    const f = await fixture()
    expect(await f.lifecycle.intent(f.admitted.intent.transferId, f.binding)).toEqual(f.admitted.intent)
    expect(await f.lifecycle.status(f.admitted.intent.transferId, f.binding)).toEqual({ intent: f.admitted.intent, record: f.record })
    await f.lifecycle.acknowledged(f.admitted.intent, f.context)
    expect(f.release).toHaveBeenCalledTimes(2)
    expect(f.sqlCalls.filter(sql => /insert|update|delete/i.test(sql))).toEqual([])
  })
  it.each(['missing', 'ambiguous', 'attempt', 'root', 'expiry-extension', 'archive-hash'] as const)('rejects changed or %s source admission', async defect => {
    const f = await fixture(), original = structuredClone(f.admitted.intent)
    if (defect === 'missing') f.facts.admissions = []
    if (defect === 'ambiguous') f.facts.admissions.push(f.admitted)
    if (defect === 'attempt') f.admitted.attempt.attemptId = randomUUID()
    if (defect === 'root') f.admitted.intent.rootBindingRevision++
    if (defect === 'expiry-extension') f.admitted.intent.expiresAt = new Date(Date.parse(f.admitted.identity.expiresAt) + 1000).toISOString()
    if (defect === 'archive-hash') f.admitted.intent.sha256 = 'c'.repeat(64)
    await expect(f.lifecycle.authorize(original, f.context, 'read')).rejects.toThrow()
  })
  it.each(['not-committed', 'uncertain', 'receipt', 'materialization', 'policy', 'snapshot', 'counts', 'reservation', 'accounting'] as const)('rejects %s adoption evidence', async defect => {
    const f = await fixture()
    if (defect === 'not-committed') f.facts.materializations = []
    if (defect === 'uncertain') f.facts.materializations[0]!.state = 'uncertain'
    if (defect === 'receipt') f.record.receipt.attemptId = randomUUID()
    if (defect === 'materialization') f.record.receipt.materializationId = randomUUID()
    if (defect === 'policy') f.record.rootPolicyRevision = '2'
    if (defect === 'snapshot') f.facts.snapshots[0]!.availability = 'unavailable'
    if (defect === 'counts') f.record.receipt.verifiedBytes++
    if (defect === 'reservation') f.facts.reservations[0]!.state = 'uncertain'
    if (defect === 'accounting') f.facts.reservations[0]!.reserved_bytes = '0'
    await expect(f.lifecycle.acknowledged(f.admitted.intent, f.context)).rejects.toThrow()
    expect(f.sqlCalls).toContain('rollback'); expect(f.release).toHaveBeenCalledOnce()
  })
  it('rechecks live grant after SQL commit and releases SQL before that recheck', async () => {
    const f = await fixture()
    f.accepted.authorize.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      expect(f.release).toHaveBeenCalledOnce(); expect(f.sqlCalls).toContain('commit')
      throw new Error('original grant revoked')
    })
    await expect(f.lifecycle.acknowledged(f.admitted.intent, f.context)).rejects.toThrow('revoked')
  })
  it('recovers the original transfer for post-commit materialization ACK/retry without a sender map', async () => {
    const f = await fixture()
    expect(await f.lifecycle.forMaterialization(f.record, f.binding)).toEqual(f.admitted.intent)
    expect(await f.lifecycle.forMaterialization(f.record, f.binding)).toEqual(f.admitted.intent)
    await expect(f.lifecycle.forMaterialization({ ...f.record, reservationId: randomUUID() }, f.binding)).rejects.toThrow('committed original record')
    f.facts.admissions.push(f.admitted)
    await expect(f.lifecycle.forMaterialization(f.record, f.binding)).rejects.toThrow('missing or ambiguous')
  })
  it('returns only original expired identity, never admission or stopped-writer authority', async () => {
    const f = await fixture()
    await expect(f.lifecycle.expiredIntent(f.admitted.intent.transferId)).rejects.toThrow('original transfer expiry')
    f.admitted.intent.expiresAt = new Date(Date.now() - 1000).toISOString()
    expect(await f.lifecycle.expiredIntent(f.admitted.intent.transferId)).toEqual(f.admitted.intent)
    expect(f.accepted.authorize).not.toHaveBeenCalled()
    await expect(f.lifecycle.authorize(f.admitted.intent, f.context, 'read')).rejects.toThrow('expired')
  })
})
describe('worker actual source adoption acknowledgement', () => {
  it('verifies original Main commit and actual local ready receipt/tree before ACK', async () => {
    const f = await fixture()
    await f.worker.acknowledged(f.admitted.intent, f.context)
    expect(f.currentCommitted).toHaveBeenCalledTimes(2)
    expect(f.authenticate.mock.calls.length).toBeGreaterThanOrEqual(4)
  })
  it('does not ACK a verified byte transfer without an actual local ready receipt', async () => {
    const f = await fixture()
    await rm(join(f.namespace, sourceMaterializationClaimName(f.admitted.root.binding, f.record.receipt,
      f.record.receipt.quota, f.record.receipt.claimScope)))
    await expect(f.worker.acknowledged(f.admitted.intent, f.context)).rejects.toThrow('actual local ready source receipt')
  })
  it('rejects a changed detached tree even with a genuine Main committed receipt', async () => {
    const f = await fixture(), path = join(f.namespace, f.record.receipt.materializationId, 'tree', 'src/main.ts')
    await chmod(path, 0o600); await writeFile(path, 'changed current native bytes')
    await expect(f.worker.acknowledged(f.admitted.intent, f.context)).rejects.toThrow()
  })
  it('rejects a different Main transfer before reading approved roots', async () => {
    const f = await fixture()
    f.currentCommitted.mockResolvedValue({ intent: { ...f.admitted.intent, sha256: 'd'.repeat(64) }, record: f.record })
    await expect(f.worker.acknowledged(f.admitted.intent, f.context)).rejects.toThrow('another source transfer')
    expect(f.approvedRoots).not.toHaveBeenCalled()
  })
  it('requires current authenticated source authority and preserves its denial', async () => {
    const f = await fixture()
    f.authenticate.mockRejectedValue(new Error('current source authority revoked'))
    await expect(f.worker.acknowledged(f.admitted.intent, f.context)).rejects.toThrow('revoked')
    expect(f.currentCommitted).not.toHaveBeenCalled()
  })
  it('rejects changed Main status after local verification', async () => {
    const f = await fixture()
    f.currentCommitted.mockResolvedValueOnce({ intent: f.admitted.intent, record: structuredClone(f.record) })
      .mockResolvedValueOnce({ intent: f.admitted.intent, record: { ...f.record, finalDispatchBindingHash: 'e'.repeat(64) } })
    await expect(f.worker.acknowledged(f.admitted.intent, f.context)).rejects.toThrow('changed during local acknowledgement')
  })
})
