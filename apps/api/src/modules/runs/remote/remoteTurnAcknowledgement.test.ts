import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { RemoteExecutionRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { readUntil } from '../../../../test/helpers/observableCondition.js'
import { runningInstalledFixture } from './__tests__/installedWorkflowHost.js'

describe('lost native turn acknowledgement', () => {
  it('retries accepted work through the execution host without another native submission', async () => {
    const f = await runningInstalledFixture('generation', { deferTurn: true })
    let delivered = 0
    let lostReceipt: unknown
    const proxy = new RemoteNativeSessionManager({ intent: f.intent, placement: f.placement,
      harness: 'codex', configuration: f.request.configuration,
      observeReceipt: async () => {},
      controlFor: async () => { throw new Error('No controls expected') },
      transport: { request: async (method, payload) => {
        const frame = RemoteExecutionRpcRequestSchema.parse(payload)
        const reply = await f.call(method, { ...frame, executionPlacement: f.nativePlacement })
        if (method === 'start-turn') {
          delivered++
          if (delivered === 1) {
            // Drop only the reply: native submission and journal acknowledgement have already happened.
            lostReceipt = await readUntil(() => f.journal.status(f.intent.operationId),
              status => status.status === 'known' && status.receipt.native?.turnId === 'original-turn',
              { timeoutMs: 2000, description: 'native turn acknowledgement persisted before reply loss' })
            throw new DeviceApplicationError('timeout')
          }
          f.finish('succeeded')
        }
        return reply.payload
      } } })
    try {
      const session = await proxy.createSession({ request: f.request, correlationId: 'execution:execution',
        environment: { agentId: 'agent', variables: { GRAPHQL_MCP_TOKEN: 'original-token' } } })
      const events: NativeHarnessEvent[] = []
      for await (const frame of proxy.startTurn(session, {
        prompt: 'original prompt', clientCorrelationId: 'execution:execution',
      })) events.push(frame)
      expect(lostReceipt).toMatchObject({ status: 'known', receipt: {
        native: { sessionId: session.nativeSessionId, turnId: 'original-turn' }, turnEntryAttempted: true,
      } })
      expect(delivered).toBe(2)
      expect(f.turns).toHaveBeenCalledOnce()
      expect(f.create).toHaveBeenCalledOnce()
      expect(events).toEqual(f.history.events)
      await f.settled
      await f.host.close()
      await f.journal.close()
      const reopened = await RemoteOperationJournal.open(join(f.root, 'workflow-journal'))
      try {
        expect(await reopened.status(f.intent.operationId)).toMatchObject({ status: 'known', receipt: {
          native: { sessionId: session.nativeSessionId, turnId: 'original-turn' },
          turnEntryAttempted: true, terminal: { kind: 'completed' },
        } })
      } finally { await reopened.close() }
    } finally {
      f.finish('succeeded')
      await f.host.close()
    }
  })
})
