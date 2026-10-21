import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import type { WorkspaceRootSelection, WorkspaceRootAttestation, WorkspaceRootPolicy, ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { WorkspaceBoundLocationService } from './service.js'
import { DomainError } from '../errors.js'

afterEach(() => vi.restoreAllMocks())

/** Synthetic SQL/host fixtures: actual command coordinator and service logic,
 * not database/native/real-device qualification. */
function fixture() {
  const mainId = randomUUID(), installation = randomUUID(), deviceId = randomUUID(), baseId = randomUUID(), fs = { device: '1', inode: '2', mountId: '3' }, hash = 'a'.repeat(64)
  const principal = ManagementPrincipalSchema.parse({ id: 'owner', name: 'Owner', audience: 'operator', expiresAt: new Date(Date.now() + 600_000).toISOString(), revokedAt: null,
    grants: [{ actions: ['source_roots:read', 'source_roots:bind', 'workspace_locations:read', 'workspace_locations:update', 'workspace_locations:validate'], scope: { workspaceIds: ['workspace'] } }] })
  const selection: WorkspaceRootSelection = { workspaceId: 'workspace', hostRef: { kind: 'device', mainId, deviceId }, allowedBaseId: baseId, configurationRevision: '1',
    relativePath: 'project', accessMode: 'read-only', expectedLocationRevision: 1, expectedRootPolicyRevision: 0 }
  const allowlist: ApprovedRootAllowlist = { schemaVersion: 1, hostRef: selection.hostRef, applicationInstallationId: installation, configurationRevision: '1',
    bases: [{ baseId, canonicalPath: '/approved', filesystem: fs, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: '/runtime', runtimeFilesystem: fs }
  const registration = { workerInstallationId: installation, keyRevision: 1, authorizationRevision: 1 }
  const attestation: WorkspaceRootAttestation = { schemaVersion: 1, attestationId: randomUUID(), requestDigest: hash, hostRef: selection.hostRef,
    applicationInstallationId: installation, configurationRevision: '1', allowedBaseId: baseId, relativePath: 'project', accessMode: 'read-only',
    canonicalProjectRoot: '/approved/project', filesystem: fs, directoryIdentityHash: hash, managedRuntimeRoot: '/runtime', runtimeFilesystem: fs, attestationDigest: hash }
  let revoked = false, receipt: unknown, location: unknown = null, revision = '1'
  let inTransaction = false
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('begin')) inTransaction = true
    if (sql === 'commit' || sql === 'rollback') inTransaction = false
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 }
    if (sql.startsWith('with recursive owners')) return { rows: [{ id: principal.id }], rowCount: 1 }
    if (sql.includes('from management_principals')) return { rows: [{ id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
      expires_at: new Date(principal.expiresAt), revoked_at: revoked ? new Date() : null, delegated_from: null }], rowCount: 1 }
    if (sql.includes('from management_command_receipts')) return { rows: receipt ? [receipt] : [], rowCount: receipt ? 1 : 0 }
    if (sql.includes('from workspaces')) return { rows: [{ execution_location: location, location_revision: revision, archived_at: null }], rowCount: 1 }
    if (sql.startsWith('update workspaces')) { location = JSON.parse(String(values[1])); revision = String(values[3]); return { rows: [], rowCount: 1 } }
    if (sql.includes('insert into management_command_receipts')) receipt = { input_hash: values[4], target_key: values[3], result: JSON.parse(String(values[5])) }
    return { rows: [], rowCount: 1 }
  })
  const client = { query, release: vi.fn() }
  const pool = { options: {}, connect: async () => client, query, end: async () => undefined, on: () => undefined } as unknown as pg.Pool
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return pool })
  let policy: WorkspaceRootPolicy | undefined
  const roots: WorkspaceRootPolicyPort = { list: vi.fn(async () => ({ workspaceId: 'workspace', policies: policy ? [policy] : [], allowlists: [allowlist], readiness: 'metadata-only' as const })),
    authorize: vi.fn(async (_sql, _principal, selected) => ({ selection: selected, allowlist, ownerPrincipalId: principal.id, registration })),
    attest: vi.fn(async () => attestation), inspect: vi.fn(async () => {}), browse: vi.fn(async () => ({ relativePath: 'project', directories: [], truncated: false })), fence: vi.fn(async () => {}),
    bind: vi.fn(async (_sql, _p, root, proof, next) => {
      policy = { schemaVersion: 1, rootPolicyId: randomUUID(), rootPolicyRevision: '1', workspaceId: root.selection.workspaceId, hostRef: proof.hostRef,
        applicationInstallationId: proof.applicationInstallationId, registration, locationRevision: String(next), ownerPrincipalId: principal.id,
        allowedBaseId: proof.allowedBaseId, configurationRevision: proof.configurationRevision, relativePath: proof.relativePath, accessMode: proof.accessMode,
        canonicalProjectRoot: proof.canonicalProjectRoot, filesystem: proof.filesystem, directoryIdentityHash: proof.directoryIdentityHash,
        managedRuntimeRoot: proof.managedRuntimeRoot, runtimeFilesystem: proof.runtimeFilesystem, attestationId: proof.attestationId, attestationDigest: proof.attestationDigest }
      return policy
    }), resolve: vi.fn(async () => { if (!policy) throw new Error('not bound'); return policy }), read: vi.fn(async () => policy ? [policy] : []) }
  const service = new WorkspaceBoundLocationService(pool, new PostgresCommandCoordinator(pool), roots)
  return { service, roots, principal, selection, attestation, revoke: () => { revoked = true },
    restore: () => { revoked = false }, query, inTransaction: () => inTransaction }
}
describe('independent workspace root commands', () => {
  it('releases database locks before waiting for device attestation', async () => {
    const f = fixture()
    vi.mocked(f.roots.attest).mockImplementation(async () => {
      expect(f.inTransaction()).toBe(false)
      return f.attestation
    })
    const saved = await f.service.set(f.principal, 'mcp', { ...f.selection, commandId: randomUUID() })
    expect(saved.value).toMatchObject({ evidence: 'bound' })
    expect((await f.service.choices(f.principal, { workspaceId: f.selection.workspaceId })).policies)
      .toEqual([saved.value.evidence === 'bound' ? saved.value.binding : undefined])
  })
  it('commits exact server-owned host/path and replays original receipt without another host probe', async () => {
    const f = fixture(), input = { ...f.selection, commandId: randomUUID() }
    const first = await f.service.set(f.principal, 'http', input)
    expect(first.replayed).toBe(false); expect(first.value.evidence).toBe('bound')
    if (first.value.evidence !== 'bound') throw new Error('bound result required')
    expect(first.value.executionLocation).toEqual({ runnerId: f.attestation.applicationInstallationId, rootPath: f.attestation.canonicalProjectRoot })
    expect(first.value.binding.hostRef).toEqual(input.hostRef)
    vi.mocked(f.roots.attest).mockRejectedValue(new Error('worker offline after successful commit'))
    expect(await f.service.set(f.principal, 'mcp', input)).toEqual({ ...first, replayed: true })
    expect(f.roots.attest).toHaveBeenCalledTimes(1)
    expect(await f.service.get(f.principal, { workspaceId: input.workspaceId }))
      .toMatchObject({ evidence: 'unconfigured', locationRevision: 1 })
    expect((await f.service.choices(f.principal, { workspaceId: input.workspaceId })).policies)
      .toEqual([first.value.binding])
    await expect(f.service.set(f.principal, 'http', { ...input, relativePath: 'other' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  })
  it('rejects a missing folder without changing the saved location', async () => {
    const f = fixture()
    vi.mocked(f.roots.attest).mockRejectedValue(new DomainError('ROOT_DIRECTORY_MISSING', 'Folder missing.', 409))
    await expect(f.service.set(f.principal, 'http', { ...f.selection, commandId: randomUUID() }))
      .rejects.toMatchObject({ code: 'ROOT_DIRECTORY_MISSING' })
    expect(await f.service.get(f.principal, { workspaceId: f.selection.workspaceId }))
      .toMatchObject({ evidence: 'unconfigured', locationRevision: 1 })
    expect(f.roots.bind).not.toHaveBeenCalled()
  })
  it('revocation during host I/O prevents binding and CAS', async () => {
    const f = fixture()
    vi.mocked(f.roots.attest).mockImplementation(async () => { f.revoke(); return f.attestation })
    await expect(f.service.set(f.principal, 'http', { ...f.selection, commandId: randomUUID() })).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(f.roots.bind).not.toHaveBeenCalled()
    f.restore()
    expect(await f.service.get(f.principal, { workspaceId: f.selection.workspaceId }))
      .toMatchObject({ evidence: 'unconfigured', locationRevision: 1 })
  })
  it('rejects wrong-host proof and stale root fence without saving a replacement target', async () => {
    const f = fixture()
    vi.mocked(f.roots.attest).mockResolvedValueOnce({ ...f.attestation, applicationInstallationId: randomUUID() })
    await expect(f.service.set(f.principal, 'http', { ...f.selection, commandId: randomUUID() })).rejects.toMatchObject({ code: 'WORKSPACE_ROOT_ATTESTATION_CONFLICT' })
    vi.mocked(f.roots.fence).mockRejectedValue(new DomainError('ROOT_REVISION_CONFLICT', 'Root changed.', 409))
    await expect(f.service.set(f.principal, 'http', { ...f.selection, commandId: randomUUID() })).rejects.toMatchObject({ code: 'ROOT_REVISION_CONFLICT' })
    expect(f.roots.bind).not.toHaveBeenCalled()
    expect(await f.service.get(f.principal, { workspaceId: f.selection.workspaceId }))
      .toMatchObject({ evidence: 'unconfigured', locationRevision: 1 })
  })
  it('denied caller cannot probe or list another workspace', async () => {
    const f = fixture()
    await expect(f.service.validate(f.principal, 'mcp', { ...f.selection, workspaceId: 'foreign' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    await expect(f.service.choices(f.principal, { workspaceId: 'foreign' })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.roots.attest).not.toHaveBeenCalled(); expect(f.roots.list).not.toHaveBeenCalled()
  })
})
