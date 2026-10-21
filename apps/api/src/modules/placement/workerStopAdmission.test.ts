import { expect, it, vi } from 'vitest'
import { remoteStopChannel, flushChannel } from '../../../test/helpers/remoteStopChannel.js'
import { deviceEndpointCarrier } from './deviceEndpointCarrier.js'
import { remoteNativeManager } from './workerCarrier.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'

it.each(['paged receipt', 'older Worker'] as const)('cancels the original session with a %s', async scenario => {
  const legacy = scenario === 'older Worker'
  const f = remoteStopChannel({ paged: !legacy, legacy })
  const manager = remoteNativeManager({ executionId: f.intent.executionId, agentId: f.configuration.agentId,
    configuration: f.configuration, workingDirectory: '/project', harness: 'codex' },
  { intent: f.intent, placement: f.placement }, {
    carrier: deviceEndpointCarrier(() => f.endpoint), commit: () => f.commit,
    beforePrepare: async () => {}, workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'settings' }),
    controlFor: async input => ({ schemaVersion: 1, protocolVersion: 1, commandId: 'stop',
      operationId: f.intent.operationId, attemptId: f.intent.attemptId, executionId: f.intent.executionId,
      bindingHash: f.intent.bindingHash, owner: f.intent.owner, native: input.native, action: { kind: 'stop' } }),
  })
  let occupied: Awaited<ReturnType<typeof f.occupy>> | undefined
  let cancellation: Promise<boolean> | undefined
  try {
    const session = await manager.createSession({ correlationId: 'execution:execution', request: {
      executionId: f.intent.executionId, runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node',
      workingDirectory: '/project', runtimeDirectory: '/runtime', configuration: f.configuration, input: {},
    } })
    const before = f.requests.length
    if (!legacy) {
      occupied = await f.occupy()
      expect(occupied.releases).toHaveLength(8)
    }
    cancellation = manager.cancel(session)
    await flushChannel()
    // The complete Stop, including every receipt page, finishes while ordinary slots remain occupied.
    if (!legacy) await vi.waitFor(() => {
      expect(f.requests.slice(before).some(frame => frame.method === 'receipt-continuation')).toBe(true)
      expect(f.requests.slice(before).some(frame => frame.method === 'control')).toBe(true)
    })
    await expect(cancellation).resolves.toBe(true)
    expect(f.facts.lastReceipt).toMatchObject({ phase: 'confirmed_terminal', terminal: { kind: 'cancelled' } })
    expect(f.requests.filter(frame => frame.method === 'control')).toHaveLength(1)
    if (legacy) expect(f.requests.every(frame => !('forStop' in frame))).toBe(true)
    else expect(f.requests.slice(before).filter(frame => frame.method === 'receipt-continuation'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ forStop: true })]))
  } finally {
    await f.close()
    await Promise.allSettled([...(occupied?.busy ?? []), ...(cancellation ? [cancellation] : [])])
  }
})
