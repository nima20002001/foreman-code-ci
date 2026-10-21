import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'

it('ends repeated physical database-timeout retries when the execution owner stops', async () => {
  const f = await physicalFixture()
  const configuration = { id: 'configuration', agentId: f.execution.agentId, workspaceId: 'workspace',
    version: 1, prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex,
    contentHash: 'fixture', createdAt: '2026-10-01T00:00:00.000Z' }
  const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
    harness: 'codex', configuration,
    transport: { request: async () => ({ session: f.session,
      status: { status: 'known', receipt: f.readout.receipt } }) },
    observeReceipt: async () => {}, controlFor: async () => { throw new Error('Unexpected control') },
    observeOriginalSource: async (receipt, source, signal) => {
      await f.producer.prefetch(receipt, f.placement, source, signal)
    },
  })
  f.request.mockRejectedValue(new DeviceApplicationError('DATABASE_READ_TIMEOUT'))
  const controller = new AbortController()
  const stopped = new Error('Execution owner stopped')
  vi.useFakeTimers()
  const task = proxy.createSession({ correlationId: `execution:${f.intent.executionId}`, request: {
    executionId: f.execution.id, runId: f.execution.runId, workflowNodeId: f.execution.workflowNodeId,
    workspaceId: 'workspace', configuration, input: {}, workingDirectory: f.readout.source.workingTree.canonicalCwd,
    runtimeDirectory: f.readout.runtimeLeaf.canonicalRuntimeDirectory,
  } }, controller.signal)
  const outcome = task.then(() => undefined, error => error)
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(f.request.mock.calls.length).toBeGreaterThan(5)
    const requests = f.request.mock.calls.length
    controller.abort(stopped)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(f.request).toHaveBeenCalledTimes(requests)
    expect(await outcome).toBe(stopped)
  } finally {
    f.request.mockRejectedValue(new Error('Request owner disposed'))
    await vi.advanceTimersByTimeAsync(2_000)
    await outcome
    vi.useRealTimers()
    await f.sqlConnection.close()
  }
})
