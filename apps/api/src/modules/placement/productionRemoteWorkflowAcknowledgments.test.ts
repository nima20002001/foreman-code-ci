import type pg from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { WorkflowNativeCapture, WorkflowOriginalNativeSource } from '../interactions/workflowNativeCapture.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { remoteNativeManager } from './workerCarrier.js'
import type { RemoteReceiptDomain } from './remoteReceiptCommit.js'
import type { RunOwnership } from '../runs/ownership.js'
import { DomainError } from '../errors.js'

const ports = vi.hoisted(() => ({
  factory: vi.fn(),
  acknowledge: vi.fn(),
  acknowledgeReply: vi.fn(),
  publish: vi.fn(),
  prefetch: vi.fn(),
  releaseExecution: vi.fn(),
  intent: { runId: 'run', nodeId: 'node', executionId: 'execution', operationId: 'operation', technicalAttempt: 1 },
  connection: { mainId: 'main', deviceId: 'device', workerInstallationId: 'worker', bootId: 'boot',
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
}))
vi.mock('./persistence.js', () => ({
  readDispatchIntent: async () => ports.intent,
  readAcceptedPlacement: async () => ({ hostRef: { kind: 'device' } }),
  readNativePlacement: async () => ({}),
}))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: async () => ports.intent }))
vi.mock('./executionBinding.js', () => ({
  readNativeExecutionBinding: () => ({ workingTree: { canonicalCwd: '/original/source' } }),
}))
vi.mock('./workerCarrier.js', () => ({ remoteNativeManager: ports.factory }))
vi.mock('./remoteReceiptCommit.js', () => ({
  OwnedRemoteReceiptCommit: class {
    constructor(_owner: unknown, _receipt: unknown, _connection: unknown, domain: RemoteReceiptDomain) {
      ports.publish.mockImplementation(domain.publishNative)
    }
  },
}))
vi.mock('../runs/remote/workflowPhysicalVerification.js', () => ({
  createRemoteWorkflowPhysicalVerification: () => ({
    prefetch: ports.prefetch,
    releaseExecution: ports.releaseExecution,
    bind: vi.fn(),
    acknowledge: ports.acknowledge,
    acknowledgeReply: ports.acknowledgeReply,
  }),
}))
vi.mock('./remoteNativeSource.js', async () => {
  const { remoteWorkflowSourceDigest } = await import('../runs/remote/workflowPhysicalReadout.js')
  return { createRemoteNativeSourceChannel: () => {
    const sources = new Map()
    return {
      observe(verified: { receipt: unknown }, source: WorkflowOriginalNativeSource) {
        const sourceDigest = remoteWorkflowSourceDigest(source)
        sources.set(sourceDigest, { verified, source, sourceDigest, assertCurrent() {} })
      },
      capture(_id: string, source: WorkflowOriginalNativeSource) { return sources.get(remoteWorkflowSourceDigest(source)) },
      verify: { read: (original: unknown) => original },
      release: vi.fn(),
    }
  } }
})
import { createProductionRemoteWorkflow } from './productionRemoteWorkflow.js'

beforeEach(() => {
  vi.clearAllMocks()
  ports.prefetch.mockResolvedValue({ kind: 'original-remote-physical' })
  ports.releaseExecution.mockReturnValue(false)
  ports.acknowledge.mockReset()
  ports.acknowledgeReply.mockReset()
  ports.acknowledgeReply.mockResolvedValue({})
})

// The queue uses explicit physical-verifier and authenticated-receipt port doubles.
// Physical validation and committed publication are covered by the verifier tests.
async function fixture() {
  const composition = createProductionRemoteWorkflow({
    pool: {} as pg.Pool,
    locations: {} as Parameters<typeof createProductionRemoteWorkflow>[0]['locations'],
    endpoint: () => ({ currentBinding: () => ports.connection }) as unknown as ReturnType<
      Parameters<typeof createProductionRemoteWorkflow>[0]['endpoint']>,
    producer: () => undefined,
    execution: async () => HarnessExecutionSchema.parse({ id: 'execution', runId: ports.intent.runId,
      workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: 'configuration', attempt: 1,
      input: {}, state: 'running', createdAt: '2026-10-04T00:00:00.000Z', workingDirectory: '/original/source' }),
  })
  await composition.prepare('execution')
  const owner = { runId: 'run', assertOwned() {} } as RunOwnership
  composition.manager({ executionId: 'execution' } as NativeManagerResolutionContext, () => owner)
  const callbacks = ports.factory.mock.calls[0]![2] as Parameters<typeof remoteNativeManager>[2]
  const receipt = { intent: ports.intent } as unknown as RemoteOperationReceipt
  await callbacks.commit(receipt, ports.connection, {})
  await ports.publish({}, owner, { receipt })
  async function capture(sequence: number) {
    const source: WorkflowOriginalNativeSource = { type: 'history', history: {
      events: [], pendingInteractions: [], correlationId: `observation:${sequence}`,
    } }
    await callbacks.observeOriginalSource!(receipt, source)
    const captured = { execution: { id: 'execution' }, source, closureGeneration: '1' } as WorkflowNativeCapture
    composition.capture({ owner } as Parameters<typeof composition.capture>[0], captured)
    return captured
  }
  return { composition, capture, callbacks, receipt }
}

it('retires 32 obsolete originals and acknowledges a newer current observation', async () => {
  const f = await fixture()
  ports.acknowledge.mockRejectedValue(new Error('Temporary transport failure'))
  for (let sequence = 0; sequence < 32; sequence++) {
    await f.composition.afterCommit(await f.capture(sequence))
  }
  const current = await f.capture(32)
  ports.acknowledge.mockImplementation(async original => {
    if (original.source.history.correlationId !== 'observation:32') {
      throw new DomainError('REMOTE_NATIVE_ACK_OBSOLETE', 'Expired observation', 409)
    }
    return {}
  })
  ports.acknowledge.mockClear()
  await f.composition.afterCommit(current)
  expect(ports.acknowledge).toHaveBeenCalledTimes(33)
  expect(ports.acknowledgeReply).toHaveBeenCalledOnce()
  expect(ports.acknowledgeReply.mock.calls[0]![0].source).toEqual(current.source)
  ports.acknowledge.mockClear()
  await f.composition.afterCommit(await f.capture(33))
  expect(ports.acknowledge).toHaveBeenCalledOnce()
})

it('rotates transient failures so the retry budget cannot starve later originals', async () => {
  const f = await fixture()
  ports.acknowledge.mockRejectedValue(new Error('Temporary transport failure'))
  for (let sequence = 0; sequence < 32; sequence++) {
    await f.composition.afterCommit(await f.capture(sequence))
  }
  const waiting = await f.capture(32)
  await f.composition.afterCommit(waiting)
  ports.acknowledge.mockClear()
  await f.composition.afterCommit(await f.capture(33))
  expect(ports.acknowledge).toHaveBeenCalledTimes(32)
  expect(ports.acknowledge.mock.calls[0]![0].source).toEqual(waiting.source)
})

it('retries a failed history acknowledgment rather than treating it as delivered', async () => {
  const f = await fixture()
  ports.acknowledge.mockResolvedValue({})
  ports.acknowledgeReply.mockRejectedValueOnce(new DomainError(
    'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', 'ACK identity mismatch', 409, { reason: 'ack_identity' },
  ))
  const original = await f.capture(0)
  await f.composition.afterCommit(original)
  await f.composition.afterCommit(await f.capture(1))
  expect(ports.acknowledgeReply.mock.calls.map(([item]) => item.source.history.correlationId))
    .toEqual(['observation:0', 'observation:0', 'observation:1'])
})

it('passes the execution lifetime into physical prefetch', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const source: WorkflowOriginalNativeSource = { type: 'boundary' }
  await f.callbacks.observeOriginalSource!(f.receipt, source, controller.signal)
  expect(ports.prefetch).toHaveBeenLastCalledWith(f.receipt, expect.anything(), source, controller.signal)
})

it('releases execution bindings only after final settlement and both acknowledgments', async () => {
  const f = await fixture()
  ports.acknowledge.mockResolvedValue({})
  const capture = await f.capture(0)
  await f.composition.afterCommit(capture)
  expect(f.composition.isRemote('execution')).toBe(true)
  ports.releaseExecution.mockReturnValue(true)
  ports.acknowledgeReply.mockRejectedValueOnce(new Error('Link lost'))
  await f.composition.afterCommit(capture)
  expect(f.composition.isRemote('execution')).toBe(true)
  await f.composition.afterCommit(capture)
  expect(f.composition.binding('execution')).toBeUndefined()
  expect(f.composition.isRemote('execution')).toBe(false)
  expect(() => f.composition.capture({} as Parameters<typeof f.composition.capture>[0], capture)).not.toThrow()
})
