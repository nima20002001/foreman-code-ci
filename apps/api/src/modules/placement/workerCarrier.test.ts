import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { remoteNativeManager, rootWorkerCarrier } from './workerCarrier.js'
import type { AcceptedExecutionBinding } from './nativeComposition.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import { input } from '../../../test/fixtures/codex-test-helpers.js'

function fixture() {
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID(), host = { kind: 'device' as const, mainId, deviceId }
  const registration = { workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const request = vi.fn(async () => ({ payload: { proof: 'synthetic-host-response' } }))
  const capture = vi.fn(() => ({ identity: { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1 }, request }))
  const payload = { version: 1 as const, operation: 'workspace-roots.attest' as const, selection: { workspaceId: 'workspace', hostRef: host,
    allowedBaseId: randomUUID(), configurationRevision: '1', relativePath: 'project', accessMode: 'read-only' as const, expectedLocationRevision: 0, expectedRootPolicyRevision: 0 } }
  return { host, registration, request, capture, payload }
}
describe('selected-main signed root carrier composition', () => {
  it('uses the exact captured connection and actual negotiated root namespace', async () => {
    const f = fixture()
    expect(await rootWorkerCarrier({ capture: f.capture }).request(f.host, f.registration, f.payload)).toEqual({ proof: 'synthetic-host-response' })
    expect(f.capture).toHaveBeenCalledWith(f.host.deviceId)
    expect(f.request).toHaveBeenCalledWith('workspace-roots-v1', f.payload)
  })
  it('rejects mismatched device/registration before request delivery', async () => {
    const f = fixture()
    await expect(rootWorkerCarrier({ capture: f.capture }).request(f.host, { ...f.registration, authorizationRevision: 2 }, f.payload)).rejects.toMatchObject({ code: 'REMOTE_CONNECTION_CONFLICT' })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('rejects unexpected binary metadata responses', async () => {
    const f = fixture(), request = vi.fn(async () => ({ payload: {}, bytes: new Uint8Array([1]) }))
    const capture = () => ({ ...f.capture(), request })
    await expect(rootWorkerCarrier({ capture }).request(f.host, f.registration, f.payload)).rejects.toMatchObject({ code: 'REMOTE_ROOT_RESPONSE_INVALID' })
  })
})

it('blocks a new remote native session before capturing a Worker connection', async () => {
  const { request } = input('/approved-project')
  const context = {
    agentId: request.configuration.agentId,
    configuration: request.configuration,
    harness: 'codex',
  } as NativeManagerResolutionContext
  const binding = {
    intent: { executionId: request.executionId },
    placement: {
      hostRef: { kind: 'device' },
      payload: {
        kind: 'agent',
        agentId: context.agentId,
        agentConfigurationVersionId: context.configuration.id,
      },
    },
  } as AcceptedExecutionBinding
  const capture = vi.fn()
  const beforePrepare = vi.fn()
  const manager = remoteNativeManager(context, binding, {
    carrier: { capture },
    beforePrepare,
    commit: vi.fn(),
    controlFor: vi.fn(),
  })
  await expect(manager.createSession({ request, correlationId: `execution:${request.executionId}` }))
    .rejects.toMatchObject({ code: 'WORKER_EXECUTION_DISABLED' })
  expect(capture).not.toHaveBeenCalled()
  expect(beforePrepare).not.toHaveBeenCalled()
})
