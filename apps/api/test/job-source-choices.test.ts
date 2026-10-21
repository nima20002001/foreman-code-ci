import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { DeviceRegistrationSchema, revokeDevice } from '@foreman-code/contracts/device-identity'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceRootPolicyPort } from '../src/modules/sources/rootPolicyPorts.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { CanonicalJobPreparationSources } from '../src/modules/jobs/sourcePreparation.js'
import { assertDeviceHostInstallation } from '../src/modules/devices/hostAuthorization.js'
import { DeviceAccessError } from '../src/modules/devices/access.js'
import { DomainError } from '../src/modules/errors.js'
import { AutoJobDefinitionSpecSchema, jobPolicyRequirements } from '@foreman-code/contracts/jobs'
import { jobSpec } from './helpers/jobFixture.js'

function fixture() {
  const spec = jobSpec()
  const workspaceId = 'workspace-fixture'
  const principal: ManagementPrincipal = {
    id: 'job-choice-reader', name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z',
    grants: [{ actions: ['sources:read', 'source_roots:read'], scope: { workspaceIds: [workspaceId] } }],
  }
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const boundAt = '2026-10-01T00:00:00.000Z'
  const paired = [0, 1].map(() => DeviceRegistrationSchema.parse({
    mainId: spec.target.mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
    publicKeyFingerprint: '1'.repeat(64), keyRevision: 1, authorizationRevision: 1,
    status: 'paired', scopes: ['connect', 'heartbeat'],
  }))
  const devices = [revokeDevice(paired[0]!), paired[1]!]
  const roots = paired.map(device => {
    const rootId = randomUUID()
    return SourceRootRecordSchema.parse({
      version: 1, source: {
        approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId,
        manifestDigest: spec.source.manifestDigest,
      },
      selection: {
        hostRef: { kind: 'device', mainId: device.mainId, deviceId: device.deviceId },
        rootPolicyId: rootId, rootPolicyRevision: '1', locationRevision: '1',
      },
      binding: {
        version: 1, mainId: device.mainId, deviceId: device.deviceId,
        workerInstallationId: device.workerInstallationId, workspaceId, rootId,
        bindingRevision: 1, locationRevision: 1,
        canonicalPath: `/approved/runtime/source-materializations/${rootId}`,
        filesystem, accessMode: 'exclusive-write', snapshotId: spec.source.snapshotId,
        manifestDigest: spec.source.manifestDigest,
      },
      ownerPrincipalId: principal.id, authorizedByPrincipalId: principal.id,
      registration: {
        workerInstallationId: device.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
      },
      attestationId: randomUUID(), attestationDigest: '1'.repeat(64), boundAt,
    })
  })
  const policies = roots.map(root => WorkspaceRootPolicySchema.parse({
    schemaVersion: 1, rootPolicyId: root.selection.rootPolicyId, rootPolicyRevision: '1', workspaceId,
    hostRef: root.selection.hostRef, applicationInstallationId: root.binding.workerInstallationId,
    registration: root.registration, locationRevision: '1', ownerPrincipalId: principal.id,
    allowedBaseId: root.binding.rootId, configurationRevision: '1', relativePath: 'project',
    accessMode: 'read-write', canonicalProjectRoot: '/approved/project', filesystem,
    directoryIdentityHash: '1'.repeat(64), managedRuntimeRoot: '/approved/runtime',
    runtimeFilesystem: filesystem, attestationId: root.attestationId, attestationDigest: root.attestationDigest,
  }))
  const source = ApprovedSourceSchema.parse({
    version: 1, workspaceId, ownerPrincipalId: principal.id, approvedByPrincipalId: principal.id,
    locationRevision: 1, mainId: spec.target.mainId, originIdentityHash: `sha256:${'1'.repeat(64)}`,
    manifest: {
      version: 1, snapshotId: spec.source.snapshotId, approvedSourceId: spec.source.approvedSourceId,
      capturePolicy: 'git-tree-v1', executablePolicy: 'strip',
      git: { commit: spec.source.commit, tree: '3'.repeat(40), objectFormat: 'sha1' },
      entries: [], deletions: [], totalEntries: 0, totalBytes: 0, manifestDigest: spec.source.manifestDigest,
    },
    approvedAt: boundAt, availability: 'retained',
  })
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    let rows: unknown[] = []
    if (text.includes('select id,name,audience,grants')) {
      rows = [{
        ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
      }]
    } else if (text.includes('with recursive owners')) rows = [{ id: principal.id }]
    else if (text.includes('source_snapshots')) rows = [{ record: source }]
    else if (text.includes('source_root_catalog')) {
      rows = roots.filter(root => !values?.[1] || root.attestationId === values[1]).map(record => ({ record }))
    } else if (text.includes('application_installation')) rows = [{ id: spec.target.mainId }]
    else if (text.includes('device_registrations')) {
      rows = devices.filter(device => device.deviceId === values?.[0]).map(record => ({ record }))
    }
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
  })
  const sql: JobSql = { query: query as JobSql['query'] }
  const resolve = vi.fn<WorkspaceRootPolicyPort['resolve']>(async (client, _principal, selection) => {
    const policy = policies.find(policy => policy.rootPolicyId === selection.rootPolicyId)!
    await assertDeviceHostInstallation(client, selection.hostRef, policy.applicationInstallationId)
    return policy
  })
  const runtime = { choices: vi.fn(async () => [spec.policy]), revalidate: vi.fn() }
  const service = new CanonicalJobPreparationSources(
    { resolveApprovedSource: vi.fn(async () => source) } as unknown as PostgresSourceService, runtime, { prepare: vi.fn() },
    { validateDeclaredJobInputs: vi.fn(async () => undefined) }, { resolve },
  )
  return { service, sql, query, principal, workspaceId, roots, devices, source, resolve, spec, runtime }
}

describe('job source choices', () => {
  it('validates Auto source and permissions without checking computer presence or materializing source', async () => {
    const f = fixture()
    const auto = AutoJobDefinitionSpecSchema.parse({ ...f.spec, target: { kind: 'auto' },
      policy: jobPolicyRequirements(f.spec.policy), limits: { cpuLimit: 1, memoryBytes: 67108864, pidsLimit: 32, diskBytes: 8388608 } })
    expect(await f.service.validateAuto(f.sql, f.principal, f.workspaceId, auto)).toMatchObject({ valid: true, sideEffects: false })
    expect(f.runtime.revalidate).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
    await expect(f.service.validateAuto(f.sql, f.principal, 'foreign', auto)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
  })

  it('keeps a paired target available when another retained root belongs to a revoked device', async () => {
    const f = fixture()
    const history = structuredClone({ roots: f.roots, devices: f.devices, source: f.source })
    const choices = await f.service.choices(f.sql, f.principal, f.workspaceId)
    expect(choices.targets).toMatchObject([{ id: f.roots[1]!.binding.rootId, ready: true, reasons: [] }])
    expect(choices.targets[0]!.target.hostRef).toEqual(f.roots[1]!.selection.hostRef)
    expect(choices.sources).toEqual([f.spec.source])
    expect(choices.policies).toEqual([f.spec.policy])
    expect({ roots: f.roots, devices: f.devices, source: f.source }).toEqual(history)
    expect(f.query.mock.calls.every(([text]) => /^(select|with recursive) /i.test(text))).toBe(true)
  })

  it('continues to reject selection of a saved revoked target', async () => {
    const f = fixture()
    const root = f.roots[0]!
    f.spec.target.hostRef = root.selection.hostRef
    f.spec.target.registration = root.registration
    f.spec.target.destination.attestationId = root.attestationId
    await expect(f.service.validateSelection(f.sql, f.principal, f.workspaceId, f.spec))
      .rejects.toMatchObject({ code: 'revoked', status: 403 })
  })

  it('rejects callers without source-read permission before enumerating targets', async () => {
    const f = fixture()
    await expect(f.service.choices(f.sql, { ...f.principal, grants: [] }, f.workspaceId))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(f.query).not.toHaveBeenCalled()
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it('rejects source-read grants for a different workspace', async () => {
    const f = fixture()
    await expect(f.service.choices(f.sql, f.principal, 'other-workspace'))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(f.resolve).not.toHaveBeenCalled()
  })

  it.each([
    new DomainError('ACCESS_DENIED', 'Root scope denied.', 403),
    new DomainError('revoked', 'Caller authority revoked.', 403),
    new DeviceAccessError('unauthorized'),
  ])('preserves other permission failures: $code', async error => {
    const f = fixture()
    f.resolve.mockRejectedValueOnce(error)
    await expect(f.service.choices(f.sql, f.principal, f.workspaceId)).rejects.toBe(error)
  })
})
