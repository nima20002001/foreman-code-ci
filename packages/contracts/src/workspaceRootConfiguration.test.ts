import { describe, expect, it } from 'vitest'
import { WorkspaceRootWorkerRequestSchema, WORKSPACE_ROOT_WORKER_OPERATIONS } from './workspaceRootPolicies.js'
import { WorkspaceRootConfigurationAdoptSchema, WorkspaceRootConfigurationAdoptResultSchema,
  WorkspaceBoundLocationSetInputSchema, WorkspaceBoundLocationBrowseResultSchema } from './workspaceBoundLocation.js'
const id = '11111111-1111-4111-8111-111111111111'
const hostRef = { kind: 'main', mainId: id }
const filesystem = { device: '12', inode: '34', mountId: '56' }
const configuration = { schemaVersion: 1, hostRef, applicationInstallationId: id, configurationRevision: '1',
  bases: [{ baseId: id, canonicalPath: '/protected/source', filesystem, accessModes: ['read-only'] }],
  managedRuntimeRoot: '/protected/runtime', runtimeFilesystem: filesystem }
describe('protected root configuration discovery and audited adoption', () => {
  it('retains the existing bound-location browse response while adding adoption', () => {
    const result = { workspaceId: 'workspace', selection: { workspaceId: 'workspace', hostRef,
      allowedBaseId: id, configurationRevision: '1', relativePath: '', accessMode: 'read-only',
      expectedLocationRevision: 0, expectedRootPolicyRevision: 0 },
    browse: { relativePath: '', directories: [], truncated: false } }
    expect(WorkspaceBoundLocationBrowseResultSchema.parse(result)).toEqual(result)
  })
  it('reads only the authenticated Worker configuration without caller paths or authority', () => {
    const request = { version: 1, operation: 'workspace-roots.configuration' }
    expect(WorkspaceRootWorkerRequestSchema.parse(request)).toEqual(request)
    expect(WORKSPACE_ROOT_WORKER_OPERATIONS).toContain(request.operation)
    for (const extra of [{ path: '/arbitrary' }, { hostRef }, { approvedRoots: ['/arbitrary'] }, { commandId: 'arbitrary' }]) {
      expect(WorkspaceRootWorkerRequestSchema.safeParse({ ...request, ...extra }).success).toBe(false)
    }
    expect(WorkspaceRootWorkerRequestSchema.safeParse({ ...request, version: 2 }).success).toBe(false)
  })
  it('adopts only an ID-selected existing Main or device configuration', () => {
    for (const selected of [hostRef, { kind: 'device', mainId: id, deviceId: id }]) {
      const request = { workspaceId: 'workspace', commandId: 'adopt-command', hostRef: selected }
      expect(WorkspaceRootConfigurationAdoptSchema.parse(request)).toEqual(request)
    }
    expect(WorkspaceRootConfigurationAdoptSchema.shape.commandId).toBe(WorkspaceBoundLocationSetInputSchema.shape.commandId)
  })
  it('rejects caller paths, digests, missing identity and incomplete audit commands', () => {
    const request = { workspaceId: 'workspace', commandId: 'adopt-command', hostRef }
    for (const value of [
      { ...request, commandId: 'short' }, { ...request, workspaceId: '' },
      { ...request, hostRef: { kind: 'device', mainId: id } },
      { ...request, hostRef: { ...hostRef, mainId: 'invalid' } },
      { ...request, canonicalPath: '/arbitrary' }, { ...request, configurationDigest: 'a'.repeat(64) },
      { ...request, hostRef: { ...hostRef, rootPath: '/arbitrary' } },
    ]) expect(WorkspaceRootConfigurationAdoptSchema.safeParse(value).success).toBe(false)
  })
  it('returns the original protected allowlist with explicit replay status', () => {
    const result = { value: configuration, replayed: false }
    expect(WorkspaceRootConfigurationAdoptResultSchema.parse(result)).toEqual(result)
    expect(WorkspaceRootConfigurationAdoptResultSchema.safeParse({ value: configuration }).success).toBe(false)
    expect(WorkspaceRootConfigurationAdoptResultSchema.safeParse({ ...result, value: { ...configuration, arbitrary: true } }).success).toBe(false)
  })
  it('retains persistent filesystem IDs through approved configuration adoption readback', () => {
    const value = { ...configuration, runtimeFilesystemId: '1234abcd',
      bases: configuration.bases.map(base => ({ ...base, filesystemId: '9876abcd' })) }
    expect(WorkspaceRootConfigurationAdoptResultSchema.parse({ value, replayed: true }))
      .toEqual({ value, replayed: true })
    expect(WorkspaceRootConfigurationAdoptResultSchema.safeParse({
      value: { ...value, runtimeFilesystemId: 'not-a-filesystem-id' }, replayed: false,
    }).success).toBe(false)
  })
})
