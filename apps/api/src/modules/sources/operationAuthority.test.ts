import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { SourceMaterializationRecord, SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { PostgresSourceOperationAuthority, authorizeClosedSourceRelease } from './operationAuthority.js'
vi.mock('../access/liveManagementPrincipal.js', () => ({ readLiveManagementPrincipal: vi.fn() }))
vi.mock('../devices/hostAuthorization.js', () => ({ assertDeviceHostInstallation: vi.fn() }))
function fixture() {
  const binding = { workspaceId: 'actual-workspace', mainId: 'actual-main', workerInstallationId: 'actual-install' }
  const root = { binding, selection: { hostRef: { kind: 'device', mainId: 'actual-main', deviceId: 'actual-device' },
    rootPolicyId: 'actual-policy', rootPolicyRevision: '1' }, registration: { keyRevision: 3, authorizationRevision: 4 } } as SourceRootRecord
  const record = { receipt: { binding }, rootPolicyId: 'actual-policy', rootPolicyRevision: '1' } as SourceMaterializationRecord
  const query = vi.fn(async () => ({ rows: [{}], rowCount: 1 }))
  return { root, record, query, sql: { query } as unknown as GraphSqlClient }
}
it('permits original terminal cleanup from positive Main closure and current exact device without regranting Run execution', async () => {
  const f = fixture(), closure = vi.fn(async () => true)
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ keyRevision: 3, authorizationRevision: 4 } as never)
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, closure)).resolves.toBeUndefined()
  expect(closure).toHaveBeenCalledWith(f.sql, f.record)
  expect(assertDeviceHostInstallation).toHaveBeenCalledWith(f.sql, f.root.selection.hostRef, 'actual-install')
})
it('holds uncertain physical ownership without touching device or filesystem authority', async () => {
  const f = fixture(); vi.mocked(assertDeviceHostInstallation).mockClear()
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, async () => false)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  expect(f.query).not.toHaveBeenCalled(); expect(assertDeviceHostInstallation).not.toHaveBeenCalled()
})
it('denies revoked device and changed root even with positive Main closure', async () => {
  const f = fixture(); vi.mocked(assertDeviceHostInstallation).mockRejectedValue(new Error('revoked device'))
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, async () => true)).rejects.toThrow('revoked device')
  await expect(authorizeClosedSourceRelease(f.sql, f.root, { ...f.record, rootPolicyRevision: '2' }, async () => true)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue({ keyRevision: 3, authorizationRevision: 5 } as never)
  await expect(authorizeClosedSourceRelease(f.sql, f.root, f.record, async () => true)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CONFLICT' })
})

it.each([false, true])('releases a proven closed original claim with worktree=%s after its admission grant expires', async worktree => {
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const hash = 'a'.repeat(64)
  const rootId = randomUUID()
  const snapshotId = randomUUID()
  const policyId = randomUUID()
  const binding = { version: 1, mainId, deviceId, workerInstallationId, workspaceId: 'workspace', rootId,
    bindingRevision: 1, locationRevision: 1, canonicalPath: '/original/source',
    accessMode: worktree ? 'exclusive-write' : 'read-only',
    filesystem: { device: '1', inode: '2', mountId: '3' }, snapshotId, manifestDigest: hash }
  const root = SourceRootRecordSchema.parse({ version: 1, binding,
    source: { approvedSourceId: randomUUID(), snapshotId, manifestDigest: hash },
    selection: { hostRef: { kind: 'device', mainId, deviceId }, rootPolicyId: policyId,
      rootPolicyRevision: '1', locationRevision: '1' },
    ownerPrincipalId: 'admission-owner', authorizedByPrincipalId: 'admission-owner',
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    attestationId: randomUUID(), attestationDigest: hash, boundAt: new Date().toISOString() })
  const record = SourceMaterializationRecordSchema.parse({ receipt: { version: 1, binding,
    materializationId: randomUUID(), executionId: 'execution', attemptId: randomUUID(), placementHash: hash,
    keyRevision: 1, authorizationRevision: 1, verifiedManifestDigest: hash, verifiedEntries: 1,
    verifiedBytes: 4, verifiedAt: new Date().toISOString(), localTreeIdentity: binding.filesystem,
    ...(worktree ? { claimScope: 'execution', sharedTree: { id: randomUUID(), referenceIdentity: binding.filesystem },
      worktree: { repository: 'fixture/project', branch: `foreman/cleanup-${randomUUID()}`, commit: 'a'.repeat(40) } } : {}) },
    rootPolicyId: policyId, rootPolicyRevision: '1', operationId: randomUUID(), reservationId: randomUUID(),
    sourceBindingHash: hash, finalDispatchBindingHash: hash, state: 'prepared' })
  const allocation = { operation_id: record.operationId, principal_id: 'admission-owner', preparation_kind: 'workflow' }
  const leaseExpiry = new Date(Date.now() + 60_000)
  const releasedRows = () => [[], [allocation], [{ record: root }], [{ availability: 'retained' }],
    [{ record, state: 'prepared' }], [{}], [{ expires_at: leaseExpiry }], []]
  const responses = releasedRows()
  const query = vi.fn(async () => { const rows = responses.shift() ?? []; return { rows, rowCount: rows.length } })
  const client = { query, release: vi.fn() }
  const pool = { connect: async () => client } as unknown as pg.Pool
  const attempts = { authorize: vi.fn(), authorizeFinal: vi.fn() }
  const closure = vi.fn(async () => true)
  vi.mocked(assertDeviceHostInstallation).mockResolvedValue(root.registration as never)
  vi.mocked(readLiveManagementPrincipal).mockRejectedValue(new DomainError('AUTH_REVOKED', 'Expired', 401))
  const authority = new PostgresSourceOperationAuthority(pool, attempts as never, closure)
  const device = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionGeneration: 1 }
  const released = await authority.resolve({ version: 1, operation: 'sources.release', record }, device)
  expect(released.physicalClosureConfirmed).toBe(true)
  expect(released.identity.ownerPrincipalId).toBe('admission-owner')
  expect(released.record).toEqual(record)
  expect(attempts.authorize).not.toHaveBeenCalled()
  responses.length = 0
  responses.push(...releasedRows())
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_000)
  try {
    const rechecked = await authority.resolve({ version: 1, operation: 'sources.release', record }, device)
    expect(rechecked).toEqual(released)
  } finally { clock.mockRestore() }
  responses.length = 0
  responses.push([], [allocation])
  await expect(authority.resolve({ version: 1, operation: 'sources.verify', record, relativeCwd: '' }, device))
    .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
})
