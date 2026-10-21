import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { input } from '../../../test/fixtures/codex-test-helpers.js'
import { freezePlacement, deriveDispatch } from './binding.js'
import { remoteNativeManager } from './workerCarrier.js'
import { deviceEndpointCarrier } from './deviceEndpointCarrier.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { deviceReconnectTimeoutMs } from '../devices/deviceReconnect.js'

const capabilities = { provider: 'codex', providerVersion: '0.154.0', persistentSessions: true, reconnect: true,
  sameRequestResponses: true, cancellation: true, history: true, configurationInspection: true, mcpDetection: true,
  supportedInteractionKinds: [] }

type Delivery = (namespace: string, payload: unknown, binding: Readonly<DeviceSessionBinding>) => Promise<{ payload: unknown }>

/** Main's view of one paired Worker: the live authenticated session (if any) and its revocation fence. */
function fixture() {
  const { request } = input('/project')
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), digest = 'a'.repeat(64)
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: request.runId, nodeId: request.workflowNodeId,
    mainInstallationId: 'installation', hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: request.configuration.agentId,
      agentConfigurationVersionId: request.configuration.id, driverId: 'codex', driverRevision: '1',
      instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness', installationFingerprint: digest,
      runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: request.executionId, occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const bootId = randomUUID()
  const session = (connectionGeneration: number, boot = bootId): DeviceSessionBinding => ({ mainId, deviceId,
    workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: boot, connectionEpoch: randomUUID(), connectionGeneration })
  const state: { live?: DeviceSessionBinding; revoked: boolean } = { live: session(1), revoked: false }
  const deliver = vi.fn<Delivery>(async () => ({ payload: capabilities }))
  const endpoint = {
    captureRequest: (requested: string, namespace: string) => {
      const binding = state.live
      if (requested !== deviceId || !binding) return undefined
      return { binding, request: (payload: unknown) => deliver(namespace, payload, binding) }
    },
    isRevoked: (requested: string, authorizationRevision: number) => requested === deviceId && state.revoked
      && authorizationRevision <= 1,
  }
  const manager = remoteNativeManager({ executionId: request.executionId, agentId: request.configuration.agentId,
    configuration: request.configuration, harness: 'codex', workingDirectory: request.workingDirectory }, { intent, placement }, {
    carrier: deviceEndpointCarrier(() => endpoint),
    workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }),
    beforePrepare: vi.fn(async () => undefined), commit: vi.fn(), controlFor: vi.fn(),
  })
  /** The link drops while the request is in flight: the session is gone until `reconnect` installs another. */
  const dropDuringFirstDelivery = (reconnect: () => void) => {
    deliver.mockImplementationOnce(async () => {
      delete state.live
      setTimeout(reconnect, 300)
      throw new DeviceConnectionError('transport')
    })
  }
  return { manager, state, session, deliver, dropDuringFirstDelivery, bootId }
}

afterEach(() => { vi.useRealTimers() })

describe('in-flight native requests across a dropped device link', () => {
  it('replays an idempotent request on the reconnected session of the same Worker boot', async () => {
    const f = fixture()
    const replacement = f.session(2)
    f.dropDuringFirstDelivery(() => { f.state.live = replacement })
    await expect(f.manager.capabilities()).resolves.toEqual(capabilities)
    expect(f.deliver).toHaveBeenCalledTimes(2)
    expect(f.deliver.mock.calls[1]![0]).toBe('execution-v1')
    expect(f.deliver.mock.calls[1]![1]).toEqual(f.deliver.mock.calls[0]![1])
    expect(f.deliver.mock.calls[1]![2]).toBe(replacement)
  })

  it('fails with a retryable device-link error when the Worker does not return within the bound', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.dropDuringFirstDelivery(() => {})
    const result = f.manager.capabilities()
    let completed = false
    void result.then(() => { completed = true }, () => { completed = true })
    const settled = expect(result).rejects.toMatchObject({ code: 'DEVICE_LINK_DROPPED', status: 503,
      message: expect.stringMatching(/connection to the computer dropped/) })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(completed).toBe(false)
    expect(f.deliver).toHaveBeenCalledTimes(1)
    expect(deviceReconnectTimeoutMs).toBe(270_000)
    await vi.advanceTimersByTimeAsync(deviceReconnectTimeoutMs - 60_000 - 1)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(f.deliver).toHaveBeenCalledTimes(1)
  })

  it('does not replay onto a restarted Worker boot', async () => {
    const f = fixture()
    f.dropDuringFirstDelivery(() => { f.state.live = f.session(2, randomUUID()) })
    await expect(f.manager.capabilities()).rejects.toMatchObject({ code: 'transport' })
    expect(f.deliver).toHaveBeenCalledTimes(1)
  })

  it('stops waiting as soon as the device is revoked', async () => {
    const f = fixture()
    f.dropDuringFirstDelivery(() => { f.state.revoked = true })
    const started = Date.now()
    await expect(f.manager.capabilities()).rejects.toMatchObject({ code: 'revoked' })
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(f.deliver).toHaveBeenCalledTimes(1)
  })
})
