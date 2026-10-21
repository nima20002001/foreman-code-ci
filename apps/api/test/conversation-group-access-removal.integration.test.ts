import { afterEach, expect, it } from 'vitest'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { closeActivityReplay, eventually, setup } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

it.each(['resident', 'cold'] as const)('continues a %s conversation after removing its previously bound Group tools', async mode => {
  const f = await setup({ chatTools: true })
  const { workspaceId, workflowId } = f.saved.scope
  const node = f.saved.version.definition.nodes[0]!
  const query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
  const read = async () => {
    const response = await f.call('agent_chat_read', { workspaceId, query })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return ReadAgentChatResponseSchema.parse(decodeMcpToolResult(response))
  }
  const send = async (requestId: string, expectedConversationId: string | null) => {
    f.replay.nextStart = 'active'
    const response = await f.call('agent_chat_send', { workspaceId, request: {
      context: query, requestId, expectedConversationId, intent: 'next_turn', content: requestId,
    } })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const started = await eventually(read, value => value.activeTurn?.requestId === requestId && !!value.activeTurn.nativeTurnId
      || value.turns.some(turn => turn.requestId === requestId && ['failed', 'canceled'].includes(turn.delivery)))
    if (started.activeTurn?.requestId === requestId && started.activeTurn.nativeTurnId) {
      f.replay.complete(started.conversation!.nativeSession!.nativeSessionId, started.activeTurn.nativeTurnId,
        `Answer to ${requestId}`, `answer-${requestId}`)
    }
    const state = await eventually(read, value => value.turns.some(turn => turn.requestId === requestId
      && ['completed', 'failed', 'canceled'].includes(turn.delivery))).catch(async cause => {
      const latest = await read()
      throw new Error(JSON.stringify({ turns: latest.turns, availability: latest.availability,
        starts: f.replay.starts, calls: f.replay.calls.slice(-12), closes: f.replay.closes }), { cause })
    })
    expect(state.turns.find(turn => turn.requestId === requestId)).toMatchObject({ delivery: 'completed' })
    return state
  }
  const first = await send('with-group-access', null)
  const conversation = first.conversation!
  const native = conversation.nativeSession!.nativeSessionId
  const token = f.replay.appTokens.get(native)!
  expect(token).toBeTruthy()
  const allowed = await f.call('workflow_chat_read', { workspaceId, workflowId }, token)
  expect(allowed.isError, JSON.stringify(allowed)).not.toBe(true)
  if (mode === 'cold') await f.restart()
  const credentials = () => f.db.pool.query('select principal_id from agent_conversation_credentials where conversation_id=$1', [conversation.id])
  const issued = (await credentials()).rows
  const saved = CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(
    await f.call('workflow_saved_get_v3', { workspaceId, workflowId })))
  const update = await f.call('workflow_save_v3', { workspaceId, workflowId, executionSemanticsVersion: 3,
    expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map(value => value.id === node.id
      ? { ...value, graphqlTools: { add: [], remove: ['workflow_chat_read', 'workflow_chat_post'] } } : value) },
  })
  expect(update.isError, JSON.stringify(update)).not.toBe(true)
  const second = await send('after-group-removal', conversation.id)
  expect(second.conversation).toMatchObject({ id: conversation.id, nativeSession: { nativeSessionId: native } })
  expect(f.replay.starts.filter(start => start.sessionId === native)).toHaveLength(2)
  const denied = await fetch(`${f.origin}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 'removed-credential', method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'removed-group-access', version: '1' },
  } }) })
  expect(denied.status).toBe(401)
  expect((await credentials()).rows).toEqual(issued)
  expect(second.turns.find(turn => turn.requestId === 'with-group-access')).toMatchObject({ delivery: 'completed' })
}, 60_000)
