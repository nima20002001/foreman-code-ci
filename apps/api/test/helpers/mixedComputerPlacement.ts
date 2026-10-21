import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { ApprovedRootAllowlistSchema, WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import { AgentPlacementProducer } from '../../src/modules/placement/agentProducer.js'
import { RunPlacementReadService } from '../../src/modules/placement/readService.js'
import { readRemoteObservations } from '../../src/modules/runs/remote/persistence.js'
import { PostgresWorkspaceRootPolicies, workspaceRootHostScope } from '../../src/modules/sources/rootPolicies.js'
import type { WorkspaceRootHostPort } from '../../src/modules/sources/rootPolicyPorts.js'
import { PostgresSourceService } from '../../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../../src/modules/sources/store.js'
import { RegisteredWorkspaceSourceRoots } from '../../src/modules/sources/registeredSourceRoots.js'
import { createSourceManifest, sourceSha256 } from '../../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'
import { attestWorkspaceRoot } from '../../src/modules/sources/rootAttestation.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { assertDeviceHostInstallation } from '../../src/modules/devices/hostAuthorization.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../../src/modules/harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../../src/modules/harnesses/instanceRegistry.js'
import { harnessHostKey } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { qualificationIdentity } from '../../src/modules/harnesses/qualification/identity.js'
import { HarnessQualificationRepository } from '../../src/modules/harnesses/qualification/repository.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import type { currentOperatorIntegration } from './currentOperatorIntegration.js'

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>

/** Persisted source/root/profile fixtures over the real authorization services.
 * Device filesystem and native qualification records are fixture data. No native
 * execution, remote physical qualification or process result is produced here. */
export async function mixedComputerPlacement(f: Fixture, directory: string, options: {
  git?: SourceManifest['git']
  sourceAccessMode?: SourceRootRecord['binding']['accessMode']
  unconfiguredDeviceRoot?: boolean
  unconfiguredFirstDeviceRoot?: boolean
  unboundFirstDeviceSource?: boolean
  deviceCount?: 1 | 2
} = {}) {
  const mainId = (await f.db.pool.query<{ id: string }>(
    'select id from application_installation where singleton=true')).rows[0]!.id
  const project = join(directory, 'project')
  const runtime = join(directory, 'runtime')
  await mkdir(project, { mode: 0o700 })
  await mkdir(runtime, { mode: 0o700 })
  const located = await f.services.locations.set(f.writer.principal, 'http', {
    workspaceId: f.f.scope.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
    runnerId: f.locations.runnerId, rootPath: project,
  })
  const locationRevision = located.value.locationRevision
  const hosts = { authorize: async (sql, _principal, host, installationId) => {
    const registered = await assertDeviceHostInstallation(sql, host, installationId)
    return registered ? { workerInstallationId: registered.workerInstallationId,
      keyRevision: registered.keyRevision, authorizationRevision: registered.authorizationRevision } : null
  }, attest: root => attestWorkspaceRoot(root.allowlist, root.selection),
  sourceNamespace: async (policy, rootPolicyId) => {
    const canonicalPath = join(policy.managedRuntimeRoot, 'source-materializations', rootPolicyId)
    return { canonicalPath, filesystem, attestationId: randomUUID(), attestationDigest: 'a'.repeat(64) }
  } } satisfies Pick<WorkspaceRootHostPort, 'authorize' | 'attest' | 'sourceNamespace'>
  const policies = new PostgresWorkspaceRootPolicies(mainId, hosts as WorkspaceRootHostPort)
  const bytes = Buffer.from('export const approved = true\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    ...(options.git ? { git: options.git } : {}),
    entries: [{ path: 'source.ts', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }] })
  const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  await f.db.pool.query(`insert into source_approvals(approved_source_id,snapshot_id,workspace_id,
    owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
    values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`, [source.approvedSourceId, source.snapshotId,
    f.f.scope.workspaceId, f.writer.principal.id, randomUUID(), source.manifestDigest])
  await f.db.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
    values($1,$2,$3,$4,$5::jsonb)`, [source.snapshotId, source.approvedSourceId, f.f.scope.workspaceId,
    source.manifestDigest, JSON.stringify({ version: 1, workspaceId: f.f.scope.workspaceId,
      ownerPrincipalId: f.writer.principal.id, approvedByPrincipalId: f.writer.principal.id,
      locationRevision, mainId, originIdentityHash: `sha256:${'a'.repeat(64)}`,
      manifest, approvedAt: f.f.createdAt, availability: 'retained' })])
  const handle = await openPrivateRoot(project)
  const filesystem = await identity(handle).finally(() => handle.close())
  const runtimeHandle = await openPrivateRoot(runtime)
  const runtimeFilesystem = await identity(runtimeHandle).finally(() => runtimeHandle.close())
  const instanceValues: Parameters<HarnessInstanceRegistry['reload']>[0][number][] = []
  const inventory: HarnessInstallationRecord[] = []
  const placements: ReturnType<typeof SavedNodePlacementSchema.parse>[] = []
  const hostKinds = ['main', ...Array<'device'>(options.deviceCount ?? 1).fill('device')] as const
  for (const kind of hostKinds) {
    const deviceId = randomUUID()
    const registration = { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
    if (kind === 'device') {
      await f.db.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
        values($1,$2,$3,$4,$5::jsonb)`, [deviceId, mainId, registration.workerInstallationId,
        'pairing-fixture', JSON.stringify({ mainId, deviceId, ...registration,
          publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] })])
    }
    const hostRef = kind === 'main' ? { kind, mainId } : { kind, mainId, deviceId }
    const applicationInstallationId = kind === 'main' ? mainId : registration.workerInstallationId
    const canonicalProjectRoot = kind === 'main' ? project : '/worker/project'
    const managedRuntimeRoot = kind === 'main' ? runtime : '/worker/runtime'
    const unconfiguredRoot = kind === 'device' && (options.unconfiguredDeviceRoot
      || options.unconfiguredFirstDeviceRoot && placements.length === 1)
    const allowlist = ApprovedRootAllowlistSchema.parse({ schemaVersion: 1, hostRef, applicationInstallationId,
      configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: canonicalProjectRoot,
        filesystem, accessModes: ['read-only', 'read-write'],
        ...(unconfiguredRoot ? { managedBy: 'worker-pairing' } : {}) }],
      managedRuntimeRoot, runtimeFilesystem: kind === 'main' ? runtimeFilesystem : filesystem })
    const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
      workspaceId: f.f.scope.workspaceId, hostRef, applicationInstallationId,
      registration: kind === 'main' ? null : registration, locationRevision: String(locationRevision),
      ownerPrincipalId: f.writer.principal.id, allowedBaseId: allowlist.bases[0]!.baseId, configurationRevision: '1',
      relativePath: '', accessMode: 'read-write', canonicalProjectRoot, filesystem,
      directoryIdentityHash: 'a'.repeat(64), managedRuntimeRoot, runtimeFilesystem: filesystem,
      attestationId: randomUUID(), attestationDigest: 'a'.repeat(64) })
    await withTransaction(f.db.pool, async sql => {
      await policies.publishApprovedHostConfiguration(sql, allowlist, { mainId, hostRef, applicationInstallationId,
        configurationRevision: '1', configurationDigest: sourceSha256(Buffer.from(JSON.stringify(allowlist))) })
      if (unconfiguredRoot) return
      const scope = workspaceRootHostScope(hostRef)
      await sql.query(`insert into workspace_root_policies(root_policy_id,root_policy_revision,workspace_id,
        host_scope,location_revision,record) values($1,1,$2,$3,$4,$5::jsonb)`,
      [policy.rootPolicyId, policy.workspaceId, scope, locationRevision, JSON.stringify(policy)])
      await sql.query(`insert into workspace_root_policy_heads(workspace_id,host_scope,root_policy_id,root_policy_revision)
        values($1,$2,$3,1)`, [policy.workspaceId, scope, policy.rootPolicyId])
    })
    const root = SourceRootRecordSchema.parse({ version: 1, source, selection: {
      hostRef, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: '1', locationRevision: String(locationRevision) },
    binding: { version: 1, mainId, deviceId: kind === 'main' ? null : deviceId,
      workerInstallationId: kind === 'main' ? null : registration.workerInstallationId, workspaceId: policy.workspaceId,
      rootId: randomUUID(), bindingRevision: 1, locationRevision,
      canonicalPath: join(managedRuntimeRoot, 'source-materializations', policy.rootPolicyId), filesystem,
      accessMode: options.sourceAccessMode ?? 'read-only',
      snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: f.writer.principal.id, authorizedByPrincipalId: f.writer.principal.id,
    registration: policy.registration, attestationId: randomUUID(), attestationDigest: 'a'.repeat(64), boundAt: f.f.createdAt })
    const unboundSource = kind === 'device' && options.unboundFirstDeviceSource && placements.length === 1
    if (!unconfiguredRoot && !unboundSource) {
      await f.db.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
        values($1,$2,$3,1)`, [root.binding.rootId, policy.workspaceId, sourceSha256(Buffer.from(JSON.stringify({
          workspaceId: policy.workspaceId, hostRef, rootPolicyId: policy.rootPolicyId,
        })))])
      await f.db.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, policy.workspaceId, source.snapshotId, JSON.stringify(root)])
    }
    const configuration = f.f.configurations[kind === 'main' ? 0 : 1]!
    const instanceId = randomUUID()
    const harnessInstallationId = 'installed-codex'
    const target = { hostRef, applicationInstallationId, harnessInstallationId, installationFingerprint: 'a'.repeat(64) }
    const override = HostHarnessOverrideSchema.parse({ instanceId, revision: 1, instanceRevision: '1', target,
      presetId: 'codex', enabled: true, driverId: 'codex', configuration: configuration.harness,
      configurationFingerprint: 'a'.repeat(64), qualification: 'unqualified' })
    const proof = HostHarnessProfileEvidenceSchema.parse({ target, instanceRevision: '1',
      configurationFingerprint: override.configurationFingerprint, driverId: 'codex', driverRevision: '1',
      protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-live-4', environmentGeneration: '1',
      connectionGeneration: '1', authenticated: true, compatible: true, qualified: true, checkedAt: f.f.createdAt })
    await f.db.pool.query(`insert into harness_instance_settings(instance_id,revision,host_key,application_installation_id,
      record,configuration_fingerprint,created_by) values($1,1,$2,$3,$4::jsonb,$5,$6)`, [instanceId,
    harnessHostKey(hostRef), applicationInstallationId, JSON.stringify(override), override.configurationFingerprint, f.writer.principal.id])
    await f.db.pool.query(`insert into harness_instance_profile_evidence(check_id,instance_id,instance_revision,record)
      values($1,$2,1,$3::jsonb)`, [randomUUID(), instanceId, JSON.stringify(proof)])
    instanceValues.push({ instanceId, instanceRevision: '1', driverId: 'codex', enabled: true,
      configuration: configuration.harness })
    inventory.push({ hostRef, harnessInstallationId, installationFingerprint: target.installationFingerprint,
      driverId: 'codex', driverRevision: '1', protocolRevision: proof.protocolRevision, environmentGeneration: '1',
      connectionGeneration: '1', observedVersion: '0.156.1', installed: true, authenticated: null, compatible: null, qualified: null,
      launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex', fingerprint: target.installationFingerprint,
        payloadFingerprints: [{ path: '/installed/codex', fingerprint: target.installationFingerprint }],
        status: 'installed', interpreter: null, diagnostics: [], checkedAt: f.f.createdAt,
        environment: { generation: '1', provenance: 'worker', cwd: canonicalProjectRoot, path: '/installed' } } })
    placements.push(SavedNodePlacementSchema.parse({ schemaVersion: 1, ...root.selection,
      projectRoot: canonicalProjectRoot, cwdPolicy: 'project-root', relativeCwd: '', instanceId,
      instanceRevision: '1', harnessInstallationId, source, rootBinding: { rootId: root.binding.rootId, bindingRevision: 1 } }))
  }
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  instances.reload(instanceValues)
  const installations = new HarnessInstallationRegistry(instances)
  installations.refresh(inventory)
  const mainPlacement = placements[0]!
  const mainHarness = installations.pin({ instanceId: mainPlacement.instanceId,
    hostRef: mainPlacement.hostRef, harnessInstallationId: mainPlacement.harnessInstallationId,
    connectionGeneration: '1', environmentGeneration: '1' })
  const qualification = HarnessQualificationSchema.parse({ harness: 'codex', version: '0.156.1',
    binarySha256: 'a'.repeat(64), suiteRevision: 'codex-live-4', profile: 'codex-0.156', status: 'qualified',
    checks: [{ id: 'fixture-check', passed: true, detail: null }], failureReason: null,
    startedAt: f.f.createdAt, checkedAt: f.f.createdAt })
  await new HarnessQualificationRepository(f.db.pool).save(qualification, {
    qualificationIdentity: qualificationIdentity(mainHarness, qualification.suiteRevision),
  })
  const unused = async (): Promise<never> => { throw new Error('No native source operation in the admission fixture') }
  const sources = new PostgresSourceService(f.db.pool, f.commands, f.locations,
    new PrivateSourceSnapshotStore(join(directory, 'snapshots')), mainId, new RegisteredWorkspaceSourceRoots(policies, hosts as WorkspaceRootHostPort),
    { authorize: unused, prepare: unused, verify: unused, verifyWorkingDirectory: unused,
      releaseClaim: unused, authorizeFinal: unused }, { confirmedClosed: unused })
  const producer = new AgentPlacementProducer(f.db.pool, mainId, sources, policies, {
    installations,
    pinOverride: value => installations.pin({ instanceId: value.instanceId,
      hostRef: value.target.hostRef, harnessInstallationId: value.target.harnessInstallationId,
      connectionGeneration: '1', environmentGeneration: '1' }),
  },
    { codex: 'codex-live-4' }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
  return { producer, locationRevision, source, sources, policies, hosts, installations,
    local: placements[0]!, remote: placements[1]!, remotes: placements.slice(1),
    reads: new RunPlacementReadService(f.db.pool, readRemoteObservations) }
}
