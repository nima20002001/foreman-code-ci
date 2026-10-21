import { persistentFixtureRoot } from './helpers/fixtureStorage.js'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { ApprovedSourceSchema, SourceRootRecordSchema, SourceMaterializationRecordSchema, type SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import type { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { createProductionSources } from '../src/modules/sources/production.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { jobSpec } from './helpers/jobFixture.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function filesystem(path: string) { const handle = await openPrivateRoot(path); try { return await identity(handle) } finally { await handle.close() } }
async function fixture(device = false) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'hrt-source-policy-')); roots.push(root)
  const mainId = randomUUID(), workspaceId = randomUUID(), rootPolicyId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID()
  const runtimeRoot = join(root, 'runtime'), base = join(root, 'base'), namespace = join(runtimeRoot, 'source-materializations', rootPolicyId)
  await mkdir(runtimeRoot, { mode: 0o700 }); await mkdir(base, { mode: 0o700 }); await mkdir(join(runtimeRoot, 'source-materializations'), { mode: 0o700 }); await mkdir(namespace, { mode: 0o700 })
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'original execution actor', audience: 'operator', grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
    expiresAt: new Date(Date.now() + 3600000).toISOString(), revokedAt: null }
  const hostRef = device ? { kind: 'device' as const, mainId, deviceId } : { kind: 'main' as const, mainId }
  const registration = device ? { workerInstallationId, keyRevision: 1, authorizationRevision: 1 } : null
  const configuration = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef, applicationInstallationId: device ? workerInstallationId : mainId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, filesystem: await filesystem(base), accessModes: ['read-write'] }],
    managedRuntimeRoot: runtimeRoot, runtimeFilesystem: await filesystem(runtimeRoot) })
  const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId, rootPolicyRevision: '1', workspaceId, hostRef,
    applicationInstallationId: configuration.applicationInstallationId, registration, locationRevision: '1', ownerPrincipalId: principal.id,
    allowedBaseId: configuration.bases[0]!.baseId, configurationRevision: '1', relativePath: '', accessMode: 'read-write', canonicalProjectRoot: base,
    filesystem: configuration.bases[0]!.filesystem, directoryIdentityHash: 'a'.repeat(64), managedRuntimeRoot: runtimeRoot,
    runtimeFilesystem: configuration.runtimeFilesystem, attestationId: randomUUID(), attestationDigest: 'b'.repeat(64) })
  const bytes = Buffer.from('actual original source bytes\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(), capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'file.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const rootRecord = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    selection: { hostRef, rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' }, binding: { version: 1, mainId, deviceId: device ? deviceId : null,
      workerInstallationId: device ? workerInstallationId : null, workspaceId, rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
      canonicalPath: namespace, filesystem: await filesystem(namespace), accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    ownerPrincipalId: principal.id, authorizedByPrincipalId: principal.id, registration, attestationId: policy.attestationId, attestationDigest: policy.attestationDigest, boundAt: new Date().toISOString() })
  const spec = jobSpec()
  spec.source = { ...spec.source, ...rootRecord.source }
  Object.assign(spec.target, { mainId, hostRef, registration, mainInstallationId: mainId })
  Object.assign(spec.target.destination, { rootPolicyId, rootPolicyRevision: '1', locationRevision: '1', attestationId: policy.attestationId, attestationHash: policy.attestationDigest })
  const definition = { schemaVersion: 1, id: randomUUID(), workspaceId, versionId: randomUUID(), revision: 1, name: 'Original allocated job', spec,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const operationId = randomUUID(), executionId = randomUUID(), attemptId = randomUUID()
  const attempt = { executionId, attemptId, placementHash: '', keyRevision: device ? 1 : null, authorizationRevision: device ? 1 : null }
  attempt.placementHash = sourceBindingHash(rootRecord, attempt, operationId)
  const approved = ApprovedSourceSchema.parse({ version: 1, workspaceId, ownerPrincipalId: principal.id, approvedByPrincipalId: principal.id,
    locationRevision: 1, mainId, originIdentityHash: `sha256:${'c'.repeat(64)}`, manifest, approvedAt: new Date().toISOString(), availability: 'retained' })
  let record: SourceMaterializationRecord | undefined, revoked = false, configured = true
  let reservationState: 'owned' | 'reclaiming' | 'reclaimed' = 'owned'
  // SQL persistence is modeled; production factories, policy services and private source IO are real.
  const query = vi.fn(async (text: string, values?: unknown[]) => {
    let rows: unknown[] = []
    if (['begin', 'commit', 'rollback'].includes(text)) return { rows, rowCount: 0, command: text, oid: 0, fields: [] }
    if (text.startsWith("select 'agent' kind")) rows = [{ kind: 'job' }]
    else if (text.startsWith("select operation_id,principal_id,'job' preparation_kind from job_preparations")) rows = [{ operation_id: operationId, principal_id: principal.id, preparation_kind: 'job' }]
    else if (text.startsWith('select principal_id,workspace_id,definition,created_at')) rows = values?.[0] === executionId && values?.[1] === attemptId ? [{ principal_id: principal.id, workspace_id: workspaceId, definition, created_at: new Date() }] : []
    else if (text.startsWith('select record,owner_id,owner_fence from job_admission_queue')) rows = []
    else if (text.startsWith('select version_id from job_definitions')) rows = [{ version_id: definition.versionId }]
    else if (text.startsWith('select 1 from job_executions')) rows = [{ known: true }]
    else if (text.startsWith('select 1 from source_storage_reservations')) {
      rows = values?.[0] === operationId && reservationState !== 'owned' ? [{ known: true }] : []
    }
    else if (text === 'select 1 from source_preparation_reconciliations where operation_id=$1') rows = []
    else if (text.startsWith('select id,name,audience,grants')) rows = values?.[0] === principal.id ? [{ id: principal.id, name: principal.name, audience: 'operator', grants: principal.grants, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : []
    else if (text.startsWith('with recursive owners')) rows = [{ id: principal.id }]
    else if (text.startsWith('select id from application_installation')) rows = [{ id: mainId }]
    else if (text.startsWith('select location_revision,archived_at')) rows = [{ location_revision: '1', archived_at: null }]
    else if (text.startsWith('select record,revoked_at from workspace_root_policies')) rows = [{ record: policy, revoked_at: revoked ? new Date() : null }]
    else if (text.startsWith('select c.record from workspace_root_host_configuration_heads')) rows = configured ? [{ record: configuration }] : []
    else if (text.startsWith('select record from device_registrations')) rows = [{ record: { ...registration, mainId, deviceId, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'd'.repeat(64) } }]
    else if (text.startsWith('select record from source_root_bindings')) rows = [{ record: rootRecord }]
    else if (text.startsWith('select record,state from source_execution_materializations')) rows = record ? [{ record, state: 'prepared' }] : []
    else if (text.includes('from source_snapshots')) rows = [{ record: approved, availability: 'retained' }]
    else if (text.startsWith('select spec from job_computer_selections')) rows = [{ spec }]
    else throw new Error(`Unexpected source policy SQL: ${text}`)
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
  })
  const pool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as pg.Pool
  const factory = await createProductionSources({ pool, commands: {} as PostgresCommandCoordinator, locations: {} as WorkspaceLocationService, mainId, runtimeRoot,
    endpoint: () => ({} as DeviceEndpoint), dispatch: () => ({} as PostgresJobDispatch) })
  await factory.snapshots.write(manifest.snapshotId, manifest.entries[0]!, bytes); await factory.snapshots.commit(manifest)
  const prepare = async () => {
    await factory.attempts.authorize(pool, principal, { workspaceId, root: rootRecord, attempt, operationId })
    const receipt = await factory.executions.prepare(manifest, rootRecord, attempt)
    record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId, rootPolicyRevision: '1', operationId, reservationId: randomUUID(),
      sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    return record
  }
  return { factory, pool, principal, rootRecord, attempt, operationId, bytes, prepare, configuration,
    revoke: () => { revoked = true }, withdraw: () => { configured = false }, denyWrite: () => { configuration.bases[0]!.accessModes = ['read-only'] },
    reclaim: (state: 'reclaiming' | 'reclaimed') => { reservationState = state },
    binding: { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 } }
}
describe('production execution-source current root policy fence', () => {
  it.each([
    ['revoke', 'ROOT_POLICY_UNAVAILABLE'], ['withdraw', 'ROOT_CONFIGURATION_MISSING'], ['denyWrite', 'ROOT_POLICY_CONFLICT'],
  ] as const)('rejects %s after real source preparation without changing saved facts or bytes', async (change, code) => {
    const f = await fixture(), record = await f.prepare(), original = structuredClone(record)
    const path = await f.factory.sources.verifyPreparation({ principal: f.principal, record })
    expect(await readFile(join(path, 'file.txt'))).toEqual(f.bytes)
    const verify = vi.spyOn(f.factory.executions, 'verify')
    f[change]()
    await expect(f.factory.sources.verifyPreparation({ principal: f.principal, record })).rejects.toMatchObject({ code })
    expect(verify).not.toHaveBeenCalled()
    await expect(f.factory.attempts.revalidate(f.rootRecord, f.attempt)).rejects.toMatchObject({ code })
    expect(record).toEqual(original); expect(await readFile(join(path, 'file.txt'))).toEqual(f.bytes)
  })
  it('applies the same exact-policy fence to authenticated worker owner resolution', async () => {
    const f = await fixture(true), identity = await f.factory.owners.prepareIdentity(f.rootRecord, f.attempt)
    const request = { version: 1, operation: 'sources.authorize', request: { version: 1, operation: 'sources.prepare', identity, root: f.rootRecord, attempt: f.attempt,
      github: { repository: 'example/project', commit: 'b'.repeat(40), executablePolicy: 'strip' } } }
    const frame = { binding: f.binding, signal: new AbortController().signal }
    expect((await f.factory.sourceExtension.handle!(request, frame)).payload).toMatchObject({ operation: 'sources.authorize' })
    f.revoke()
    await expect(f.factory.sourceExtension.handle!(request, frame)).rejects.toMatchObject({ code: 'ROOT_POLICY_UNAVAILABLE' })
  })

  it.each(['reclaiming', 'reclaimed'] as const)(
    'rejects a %s reservation without changing prepared source facts or bytes', async state => {
      const f = await fixture()
      const record = await f.prepare()
      const original = structuredClone(record)
      const path = await f.factory.sources.verifyPreparation({ principal: f.principal, record })
      f.reclaim(state)

      await expect(f.factory.attempts.revalidate(f.rootRecord, f.attempt))
        .rejects.toMatchObject({ code: 'SOURCE_PREPARATION_RECONCILED' })
      await expect(f.factory.sources.verifyPreparation({ principal: f.principal, record }))
        .rejects.toMatchObject({ code: 'SOURCE_PREPARATION_RECONCILED' })
      expect(record).toEqual(original)
      expect(await readFile(join(path, 'file.txt'))).toEqual(f.bytes)
    },
  )

  it.each(['reclaiming', 'reclaimed'] as const)(
    'denies authenticated worker preparation after its reservation is %s', async state => {
      const f = await fixture(true)
      const identity = await f.factory.owners.prepareIdentity(f.rootRecord, f.attempt)
      const request = { version: 1, operation: 'sources.authorize', request: {
        version: 1, operation: 'sources.prepare', identity, root: f.rootRecord, attempt: f.attempt,
        github: { repository: 'example/project', commit: 'b'.repeat(40), executablePolicy: 'strip' },
      } }
      const frame = { binding: f.binding, signal: new AbortController().signal }
      expect((await f.factory.sourceExtension.handle!(request, frame)).payload)
        .toMatchObject({ operation: 'sources.authorize' })
      f.reclaim(state)

      await expect(f.factory.owners.prepareIdentity(f.rootRecord, f.attempt))
        .rejects.toMatchObject({ code: 'SOURCE_PREPARATION_RECONCILED' })
      await expect(f.factory.sourceExtension.handle!(request, frame))
        .rejects.toMatchObject({ code: 'SOURCE_PREPARATION_RECONCILED' })
    },
  )
})
