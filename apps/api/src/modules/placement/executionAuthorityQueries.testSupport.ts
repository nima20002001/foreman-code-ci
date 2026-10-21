import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { HarnessInstallationRegistry } from '../harnesses/installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../harnesses/instanceRegistry.js'
import { WorkspaceLocationService } from '../workspaces/location.js'
import { PostgresSourceService } from '../sources/service.js'
import { createSourceManifest } from '../sources/manifest.js'
import { createProductionRootPolicies } from '../sources/productionRootAuthority.js'
import { AgentPlacementProducer } from './agentProducer.js'
import { deriveDispatch, freezePlacement } from './binding.js'
import { createExecutionAuthorityExtension } from './executionAuthority.js'

export function authorityQueryFixture() {
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const at = '2026-10-01T00:00:00.000Z'
  const hash = 'a'.repeat(64)
  const hostRef = { kind: 'device' as const, mainId, deviceId }
  const registration = { workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const device: DeviceRegistration = { mainId, deviceId, ...registration, status: 'paired',
    publicKeyFingerprint: hash, scopes: ['connect', 'heartbeat'] }
  const grants: ManagementPrincipal['grants'] = [
    { actions: ['runs:start'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } },
    { actions: ['workspace_locations:read', 'source_roots:read', 'sources:read'], scope: { workspaceIds: ['workspace'] } },
  ]
  const principal = { id: 'run-principal', name: 'Accepted operator', audience: 'operator', grants,
    expires_at: new Date('2099-01-01T00:00:00.000Z'), revoked_at: null as Date | null,
    delegated_from: 'owner' as string | null }
  const owner = { ...principal, id: 'owner', name: 'Root operator', delegated_from: null }
  const binding = { owner_principal_id: owner.id, grant_ceiling: grants,
    accepted_expires_at: principal.expires_at, execution_state: 'running', cleanup_pending: false }
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [], entries: [] })
  const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const root: SourceRootRecord = { version: 1, source,
    selection: { hostRef, rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId, workerInstallationId, workspaceId: 'workspace', rootId: randomUUID(),
      bindingRevision: 1, locationRevision: 1, canonicalPath: '/source', filesystem,
      accessMode: 'read-only', snapshotId: source.snapshotId, manifestDigest: source.manifestDigest },
    ownerPrincipalId: owner.id, authorizedByPrincipalId: principal.id, registration,
    attestationId: randomUUID(), attestationDigest: hash, boundAt: at }
  const configuration = { schemaVersion: 1, hostRef, applicationInstallationId: workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: '/project', filesystem,
      accessModes: ['read-only'] }], managedRuntimeRoot: '/runtime', runtimeFilesystem: filesystem }
  const policy: WorkspaceRootPolicy = { schemaVersion: 1, ...root.selection, workspaceId: 'workspace',
    applicationInstallationId: workerInstallationId, registration, ownerPrincipalId: owner.id,
    allowedBaseId: configuration.bases[0]!.baseId, configurationRevision: '1', relativePath: '',
    accessMode: 'read-only', canonicalProjectRoot: '/project', filesystem, directoryIdentityHash: hash,
    managedRuntimeRoot: '/runtime', runtimeFilesystem: filesystem, attestationId: root.attestationId,
    attestationDigest: hash }
  const instanceId = randomUUID()
  const target = { hostRef, applicationInstallationId: workerInstallationId,
    harnessInstallationId: 'harness', installationFingerprint: hash }
  const override = { instanceId, revision: 1, instanceRevision: '1', target, presetId: 'fixture', enabled: true,
    driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex, configurationFingerprint: hash, qualification: 'qualified' }
  const qualification = { harness: 'codex', version: '0.156.1', binarySha256: hash, suiteRevision: 'fixture',
    profile: 'codex-0.156', status: 'qualified', checks: [{ id: 'native-check', passed: true, detail: null }],
    failureReason: null, startedAt: at, checkedAt: at }
  const connection = { mainId, deviceId, ...registration, bootId: randomUUID(), connectionGeneration: 1 }
  const proof = { target, instanceRevision: '1', configurationFingerprint: hash, driverId: 'codex',
    driverRevision: '1', protocolRevision: '1', suiteRevision: 'fixture', environmentGeneration: '1',
    connectionGeneration: '1', authenticated: true, compatible: true, qualified: true, checkedAt: at,
    completedNativeQualification: { purpose: 'explicit-host-qualification', checkId: randomUUID(), target,
      binarySha256: hash, record: qualification, binding: { ...connection, connectionEpoch: randomUUID() } } }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId,
    runId: 'run', nodeId: 'node', hostRef, registration,
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: hash, rootPolicyId: policy.rootPolicyId, rootPolicyRevision: '1', locationRevision: '1',
      attestationId: root.attestationId, attestationHash: hash },
    source: { kind: 'pending', ...source, revisionId: source.snapshotId, rootId: root.binding.rootId,
      bindingRevision: 1, materializationId: null, materializationDigest: null },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'agent-configuration', driverId: 'codex',
      driverRevision: '1', instanceId, instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: hash,
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: 'execution', operationId: 'operation', attemptId: 'attempt',
    technicalAttempt: 1, occurrenceId: null, occurrenceIndex: 0, inputDigest: `sha256:${hash}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const receipt: RemoteOperationReceipt = { schemaVersion: 1, intent, connection, workerIncarnationId: randomUUID(), sequence: 1,
    phase: 'running', entryAttempted: true, turnEntryAttempted: true, stopFence: false, controls: [],
    turnInput: { correlationId: 'execution:execution', promptDigest: hash, sessionMode: 'regular' },
    native: { sessionId: 'native-session', turnId: 'native-turn', processIdentityDigest: hash } }
  const approved = { version: 1, workspaceId: 'workspace', ownerPrincipalId: owner.id, approvedByPrincipalId: owner.id,
    locationRevision: 1, mainId, originIdentityHash: `sha256:${hash}`, manifest, approvedAt: at, availability: 'retained' }
  const state = { mainId, device, principal, owner, binding, root, policy, configuration, override, proof,
    availability: 'retained', policyRevokedAt: null as Date | null, workspaceArchivedAt: null as Date | null,
    granted: true, cleanup: false, failed: false, stopped: false, receipt: receipt as RemoteOperationReceipt | undefined,
    origin: connection, transition: null as unknown, persistedPlacement: placement, entered: true,
    afterPins: undefined as (() => void) | undefined }
  const authorityRow = () => ({ dispatch: intent, transition: state.transition, placement: state.persistedPlacement,
    operation_id: intent.operationId, execution_id: intent.executionId, run_id: intent.runId,
    node_id: intent.nodeId, binding_hash: intent.bindingHash, attempt_id: intent.attemptId,
    authorization_principal_id: principal.id, workspace_id: 'workspace', workflow_id: 'workflow', execution_state: 'running',
    stopped: state.stopped, cleanup: state.cleanup, failed: state.failed, granted: state.granted,
    connection: state.origin, receipt: state.receipt ?? null, receipt_present: !!state.receipt, entered: state.entered })
  // The catalog supplies rows; query counting happens independently at the pool boundary.
  const catalog: GraphSqlClient = { async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]) {
    let rows: unknown[] = []
    if (text.startsWith('select i.record as dispatch')) rows = [authorityRow()]
    else if (text.includes('as authorization_read')) rows = [{ authorization_read: {
      main_id: state.mainId, device: state.device, principals: [state.principal, state.owner],
      principal_id: principal.id, run_authority: state.binding, workspace_id: 'workspace',
      workspace: { location_revision: '1', archived_at: state.workspaceArchivedAt },
      source: { record: approved, availability: state.availability }, source_root: { record: state.root },
      root_policy: { record: state.policy, revoked_at: state.policyRevokedAt },
      root_configuration: { record: state.configuration },
    } }]
    else if (text.includes('from management_principals where id=$1')) {
      rows = [state.principal, state.owner].filter(row => row.id === values?.[0])
    } else if (text.includes('from run_authority_principals')) rows = [state.binding]
    else if (text.includes('with recursive owners')) rows = [{ id: owner.id }]
    else if (text.includes('from application_installation')) rows = [{ id: state.mainId }]
    else if (text.includes('from device_registrations')) rows = [{ record: state.device }]
    else if (text.includes('from source_snapshots')) rows = [{ record: approved, availability: state.availability }]
    else if (text.includes('from source_root_bindings')) rows = [{ record: state.root }]
    else if (text.includes('from workspace_root_policies')) rows = [{ record: state.policy, revoked_at: state.policyRevokedAt }]
    else if (text.includes('from workspace_root_host_configuration_heads')) rows = [{ record: state.configuration }]
    else if (text.includes('from workspaces')) rows = [{ location_revision: '1', archived_at: state.workspaceArchivedAt }]
    else if (text.includes('from harness_instance_settings')) rows = [{ record: state.override }]
    else if (text.includes('from harness_instance_profile_evidence')) rows = [{ instance_revision: '1', record: state.proof }]
    // PostgreSQL JSON columns encode timestamps as strings, unlike direct timestamp columns.
    const records = text.includes('as authorization_read') ? JSON.parse(JSON.stringify(rows)) : structuredClone(rows)
    return { rows: records as R[], rowCount: rows.length, fields: [], command: 'SELECT', oid: 0 }
  } }
  let queries = 0
  let leases = 0
  const pool = { async connect() {
    leases++
    return { async query(text: string, values?: unknown[]) {
      queries++
      return catalog.query(text, values)
    }, on() {}, removeListener() {}, release() {} }
  } } as unknown as pg.Pool
  const { policies } = createProductionRootPolicies({ pool, mainId, runtimeRoot: '/runtime',
    endpoint: () => { throw new Error('Authorization must not perform host I/O') } })
  const sources = new PostgresSourceService(...[pool, {}, {}, {}, mainId, {}, {}, {}] as unknown as
    ConstructorParameters<typeof PostgresSourceService>)
  const installations = new HarnessInstallationRegistry(new HarnessInstanceRegistry(localHarnessDrivers))
  installations.refresh([{ hostRef, harnessInstallationId: 'harness', installationFingerprint: hash,
    driverId: 'codex', driverRevision: '1', protocolRevision: '1', environmentGeneration: '1', connectionGeneration: '1',
    observedVersion: '0.156.1', installed: true, authenticated: true, compatible: true, qualified: true,
    launcher: { requested: '/installed/codex', resolvedLauncher: '/installed/codex', fingerprint: hash,
      payloadFingerprints: [{ path: '/installed/codex', fingerprint: hash }], status: 'installed', interpreter: null,
      diagnostics: [], checkedAt: at, environment: { generation: '1', provenance: 'worker', cwd: '/project', path: '/installed' } } }])
  class ObservedProducer extends AgentPlacementProducer {
    override async assertPinsCurrent(...args: Parameters<AgentPlacementProducer['assertPinsCurrent']>) {
      await super.assertPinsCurrent(...args)
      state.afterPins?.()
    }
  }
  const producer: AgentPlacementProducer = new ObservedProducer(pool, mainId, sources, policies,
    { installations } as ConstructorParameters<typeof AgentPlacementProducer>[4], { codex: 'fixture' })
  const locations = new WorkspaceLocationService(pool, {} as ConstructorParameters<typeof WorkspaceLocationService>[1])
  const extension = createExecutionAuthorityExtension(pool, locations, producer)
  const request = (action: 'read' | 'control' | 'stop' = 'read', authenticated = connection) => extension.handle!(
    { version: 1, action, intent, placement },
    { binding: authenticated } as Parameters<NonNullable<typeof extension.handle>>[1])
  return { state, request, intent, placement, connection, catalog, producer, locations,
    assertDevice: () => assertDeviceHostInstallation(catalog, hostRef, workerInstallationId),
    counts: () => ({ queries, leases }) }
}
