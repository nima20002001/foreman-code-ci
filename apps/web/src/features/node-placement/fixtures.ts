import { AcceptedNodePlacementSchema, SavedNodePlacementSchema, WorkerObservationSchema } from '@foreman-code/contracts/node-placement'

const mainId = '10000000-0000-4000-8000-000000000001'
const deviceId = '20000000-0000-4000-8000-000000000001'
const workerInstallationId = '30000000-0000-4000-8000-000000000001'
const digest = 'a'.repeat(64)
export const savedPlacementFixture = SavedNodePlacementSchema.parse({ schemaVersion: 1,
  hostRef: { kind: 'device', mainId, deviceId }, rootPolicyId: 'root-policy', rootPolicyRevision: '2', locationRevision: '3',
  projectRoot: '/synthetic/project', cwdPolicy: 'project-root', relativeCwd: '', instanceId: 'instance-a', instanceRevision: '4', harnessInstallationId: 'installation-a' })
export const acceptedPlacementFixture = AcceptedNodePlacementSchema.parse({ schemaVersion: 1, mainId, runId: 'run-a', nodeId: 'node-a',
  hostRef: savedPlacementFixture.hostRef, labelAtAcceptance: 'Laptop at acceptance', registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 2 }, mainInstallationId: 'main-installation',
  destination: { canonicalProjectRoot: '/synthetic/accepted', canonicalCwd: '/synthetic/accepted', managedRuntimeRoot: '/synthetic/runtime', directoryIdentityHash: digest,
    rootPolicyId: 'root-policy', rootPolicyRevision: '2', locationRevision: '3', attestationId: 'attestation-a', attestationHash: digest },
  source: { revisionId: 'source-a', manifestDigest: digest, materializationId: 'materialization-a', materializationDigest: digest },
  payload: { kind: 'agent', agentId: 'shared-agent', agentConfigurationVersionId: 'configuration-old', driverId: 'codex', driverRevision: '1',
    instanceId: 'instance-a', instanceRevision: '4', harnessInstallationId: 'installation-a', installationFingerprint: 'fingerprint', runtimeContractVersion: 1,
    protocolRevision: '1', credentialScopeRefs: [] }, bindingHash: digest })
export const workerObservationFixture = WorkerObservationSchema.parse({ schemaVersion: 1, protocolVersion: 1, operationId: 'operation-a', attemptId: 'attempt-a', executionId: 'execution-a', bindingHash: digest,
  connection: { mainId, deviceId, workerInstallationId, bootId: '40000000-0000-4000-8000-000000000001', keyRevision: 1, authorizationRevision: 2, connectionGeneration: 1 },
  workerIncarnationId: '50000000-0000-4000-8000-000000000001', sequence: '1', phase: 'accepted', artifactDigests: [] })
