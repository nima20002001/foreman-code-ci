import { afterEach, expect, it } from 'vitest'
import { ReadAgentChatResponseSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { closeActivityReplay, completedRun, eventually, setup } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

it('routes a completed Run follow-up through a source-pinned AgentChat fork and preserves the Run', async () => {
  const f = await setup()
  const source = await completedRun(f)
  const execution = source.executions[0]!
  const { workspaceId, workflowId } = f.saved.scope
  const query = { workflowId, workflowNodeId: execution.workflowNodeId, agentId: execution.agentId, runId: source.run.id }
  const before = (await f.db.pool.query('select record from harness_executions where id=$1', [execution.id])).rows[0]!.record
  const read = await f.call('agent_chat_read', { workspaceId, query })
  expect(read.isError, JSON.stringify(read)).not.toBe(true)
  const initial = ReadAgentChatResponseSchema.parse(decodeMcpToolResult(read))
  expect(initial.sourceTranscript?.executionId).toBe(execution.id)
  expect(initial.availability.canSend).toBe(true)
  const request = { context: query, expectedConversationId: null, requestId: 'historical-followup',
    intent: 'next_turn', content: 'Explain the saved result' }
  const response = await f.call('agent_chat_send', { workspaceId, request })
  expect(response.isError, JSON.stringify(response)).not.toBe(true)
  const admitted = SendAgentChatMessageResponseSchema.parse(decodeMcpToolResult(response))
  expect(admitted.turn).toMatchObject({ requestId: request.requestId, intent: 'next_turn' })
  expect(admitted.state.conversation?.origin).toEqual({ kind: 'run_execution', runId: source.run.id,
    executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId })
  const fork = await eventually(async () => {
    const result = await f.call('agent_chat_read', { workspaceId, query })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    return ReadAgentChatResponseSchema.parse(decodeMcpToolResult(result))
  }, state => !!state.activeTurn?.nativeTurnId)
  expect(fork.conversation?.origin).toEqual({ kind: 'run_execution', runId: source.run.id,
    executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId })
  expect(fork.conversation?.nativeSession?.nativeSessionId).not.toBe(execution.nativeSessionId)
  expect((await f.db.pool.query('select record from harness_executions where id=$1', [execution.id])).rows[0]!.record).toEqual(before)
  const replay = await f.call('agent_chat_send', { workspaceId, request })
  expect(replay.isError, JSON.stringify(replay)).not.toBe(true)
  expect(SendAgentChatMessageResponseSchema.parse(decodeMcpToolResult(replay))).toMatchObject({
    turn: { requestId: request.requestId }, state: { conversation: { id: fork.conversation!.id } },
  })
}, 60_000)
