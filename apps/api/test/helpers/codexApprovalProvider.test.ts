import { expect, it } from 'vitest'
import { object, type JsonObject, type RpcRequest } from '../../src/modules/harnesses/codexStdioTransport.js'
import { fixtureProtocol } from '../fixtures/codex-test-helpers.js'
import { CodexApprovalProvider } from './codexApprovalProvider.js'

it('publishes the final answer and terminal turn after an approved workflow command', async () => {
  const executionId = 'workflow-execution'
  const output = JSON.stringify({ routing: { kind: 'finish' }, data: { latestDeliverable: 'finished' } })
  const provider = new CodexApprovalProvider(executionId, false, { workflowOutput: async () => output })
  const requests: RpcRequest[] = []
  const notifications: Array<{ method: string; payload: JsonObject }> = []
  const transport = provider.dependencies().transport(
    '/recorded-no-native-codex', '/recorded-workspace', {}, fixtureProtocol,
    async request => { requests.push(request) },
    (method, payload) => { notifications.push({ method, payload }) },
    error => { throw error },
  )
  try {
    await transport.start()
    const started = object(await transport.request('thread/start', { cwd: '/recorded-workspace' }))
    const sessionId = String(object(started.thread).id)
    const result = object(await transport.request('turn/start', {
      threadId: sessionId, clientUserMessageId: `execution:${executionId}`, input: [],
    }))
    const turnId = String(object(result.turn).id)
    await provider.flush()
    expect(requests).toHaveLength(1)
    const request = requests[0]!
    expect(request.method).toBe('item/commandExecution/requestApproval')
    await transport.respond(request.id, request.method, { decision: 'accept' })
    await provider.flush()

    expect(notifications).toContainEqual({ method: 'item/completed', payload: {
      threadId: sessionId, turnId,
      item: { type: 'agentMessage', id: `answer-${turnId}`, text: output, phase: 'final_answer' },
    } })
    expect(notifications).toContainEqual({ method: 'turn/completed', payload: {
      threadId: sessionId, turn: expect.objectContaining({ id: turnId, status: 'completed',
        items: expect.arrayContaining([expect.objectContaining({ text: output, phase: 'final_answer' })]) }),
    } })
    const history = object(await transport.request('thread/read', { threadId: sessionId, includeTurns: true }))
    expect(object(history.thread).turns).toEqual([
      expect.objectContaining({ id: turnId, status: 'completed' }),
    ])
  } finally {
    await provider.flush()
    await transport.close()
  }
})
