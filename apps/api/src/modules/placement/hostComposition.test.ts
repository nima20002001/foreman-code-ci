import { describe, expect, it, vi } from 'vitest'
import { HostAwarePlacementDispatch, type AuthorizedPlacementTransport } from './hostComposition.js'
import { freezePlacement } from './binding.js'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'

const mainId = '00000000-0000-4000-8000-000000000001'
const deviceId = '00000000-0000-4000-8000-000000000002'
const digest = 'a'.repeat(64)
const pin: AcceptedNodePlacement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run-one', nodeId: 'node-one',
  hostRef: { kind: 'device', mainId, deviceId }, mainInstallationId: 'main-installation',
  registration: { workerInstallationId: '00000000-0000-4000-8000-000000000003', keyRevision: 1, authorizationRevision: 1 },
  destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime', directoryIdentityHash: digest,
    rootPolicyId: 'root-policy', rootPolicyRevision: '1', locationRevision: '1', attestationId: 'attestation', attestationHash: digest },
  source: { revisionId: 'source-revision', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
  payload: { kind: 'agent', agentId: 'agent-one', agentConfigurationVersionId: 'config-one', driverId: 'driver-one', driverRevision: 'driver-v1',
    instanceId: 'instance-one', instanceRevision: 'instance-v1', harnessInstallationId: 'harness-one', installationFingerprint: 'fingerprint',
    runtimeContractVersion: 1, protocolRevision: 'protocol-v1', credentialScopeRefs: [] } })
const intent: DispatchIntent = { schemaVersion: 1, protocolVersion: 1, mainId, runId: pin.runId, nodeId: pin.nodeId,
  executionId: 'execution-one', occurrenceId: 'occurrence-one', occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt-one', operationId: 'operation-one',
  bindingHash: pin.bindingHash, inputDigest: `sha256:${digest}`, owner: { grantId: 'grant-one', epoch: '1' } }
function transport(): AuthorizedPlacementTransport { return { assertAuthorized: vi.fn(async () => {}), deliver: vi.fn(async () => {}),
  reconcile: vi.fn(async () => null), control: vi.fn(async () => {}) } }
describe('host-aware placement composition', () => {
  it('never defaults remote placement to main-local', async () => {
    const local = transport()
    await expect(new HostAwarePlacementDispatch(mainId, local).deliver(intent, pin)).rejects.toMatchObject({ code: 'REMOTE_DISPATCH_UNAVAILABLE' })
    expect(local.deliver).not.toHaveBeenCalled()
  })
  it('rechecks authority before delivery and preserves the original operation', async () => {
    const remote = transport(), adapter = new HostAwarePlacementDispatch(mainId, transport(), remote)
    await adapter.deliver(intent, pin); await adapter.deliver(intent, pin)
    expect(remote.deliver).toHaveBeenNthCalledWith(2, intent, pin)
    vi.mocked(remote.assertAuthorized).mockRejectedValueOnce(new Error('revoked'))
    await expect(adapter.deliver(intent, pin)).rejects.toThrow('revoked')
    expect(remote.deliver).toHaveBeenCalledTimes(2)
  })
  it('rejects forged binding and main before transport', async () => {
    const remote = transport(), adapter = new HostAwarePlacementDispatch(mainId, transport(), remote)
    await expect(adapter.deliver({ ...intent, bindingHash: 'b'.repeat(64) }, pin)).rejects.toMatchObject({ code: 'PLACEMENT_BINDING_CONFLICT' })
    await expect(new HostAwarePlacementDispatch(deviceId, transport(), remote).deliver(intent, pin)).rejects.toMatchObject({ code: 'PLACEMENT_MAIN_MISMATCH' })
    expect(remote.deliver).not.toHaveBeenCalled()
  })
  it('does not turn absence into safe replay', async () => {
    const remote = transport()
    expect(await new HostAwarePlacementDispatch(mainId, transport(), remote).reconcile(intent, pin)).toBeNull()
    expect(remote.deliver).not.toHaveBeenCalled()
  })
  it('rejects wrong-host native observation', async () => {
    const remote = transport()
    vi.mocked(remote.reconcile).mockResolvedValue({ schemaVersion: 1, protocolVersion: 1, operationId: intent.operationId,
      attemptId: intent.attemptId, executionId: intent.executionId, bindingHash: pin.bindingHash, workerIncarnationId: deviceId, sequence: '1', phase: 'running', artifactDigests: [],
      connection: { mainId, deviceId: mainId, workerInstallationId: pin.registration!.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
        bootId: deviceId, connectionGeneration: 1 } })
    await expect(new HostAwarePlacementDispatch(mainId, transport(), remote).reconcile(intent, pin)).rejects.toMatchObject({ code: 'WORKER_OBSERVATION_CONFLICT' })
  })
})
