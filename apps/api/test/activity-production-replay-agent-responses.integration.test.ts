import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { AgentChatStateSchema, AgentChatSendResponseSchema } from '@foreman-code/contracts/agent-chat'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: agent-responses', { timeout: 120000 }, () => {
  for (const uncertain of [false, true]) it(`Agent response ${uncertain ? 'uncertain' : 'acknowledged'}: exact recorded choice, HTTP/MCP retry and revoked action`, async () => {
    const f = await setup(), workspaceId = f.saved.scope.workspaceId, workflowId = f.saved.scope.workflowId
    const node = f.saved.version.definition.nodes[0]!, query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const base = `/api/workspaces/${workspaceId}/agent-chat`
    const first = await f.http('POST', `${base}/messages`, { requestId: 'approval-owner', content: 'recorded waiting message',
      intent: 'next_turn', expectedConversationId: null, context: query })
    expect(first.statusCode, first.body).toBe(202)
    const sent = AgentChatSendResponseSchema.parse(first.json())
    expect('receipt' in sent).toBe(true)
    if (!('state' in sent) || !sent.state || !('conversation' in sent.state) || !sent.state.conversation) {
      throw new Error('The accepted message must retain its exact Agent conversation.')
    }
    const id = sent.state.conversation.id
    const read = async () => AgentChatStateSchema.parse((await f.http('GET',
      `${base}?workflowId=${workflowId}&workflowNodeId=${node.id}&agentId=${node.agentId}`)).json())
    const active = await eventually(read, (state) => !!state.activeTurn?.nativeTurnId)
    const native = active.activitySnapshot!.active[0]!.native!
    await f.replay.ask(native.sessionId, native.turnId!)
    const waiting = await eventually(read, (state) => !!state.pendingInteraction)
    expect(waiting.responseAvailability?.available).toBe(true)
    const pending = waiting.pendingInteraction!, choice = pending.responseOptions.find((option) => option.semantic === 'approve_once')!
    const request = { requestId: 'answer-control', nativeRequestId: pending.turn.nativeRequestId!, optionId: choice.optionId }
    if (uncertain) f.replay.nextResponse = 'uncertain'
    const answered = await f.http('POST', `${base}/conversations/${id}/responses`, request)
    expect(answered.statusCode, answered.body).toBe(uncertain ? 409 : 200)
    expect(f.replay.responses).toHaveLength(1)
    const result = (await f.db.pool.query(`select result from management_command_receipts
      where principal_id=$1 and operation='agent_chat_control' and command_id=$2`, [f.writer.principal.id, request.requestId])).rows[0]!.result
    expect(result).toMatchObject({ status: uncertain ? 'uncertain' : 'completed', acceptedControl: { modelRequestId: 'approval-owner',
      conversationId: id, scope: waiting.activitySnapshot!.scope, native: { sessionId: native.sessionId, turnId: native.turnId,
        requestId: request.nativeRequestId }, choice: { optionId: choice.optionId, semantic: choice.semantic } } })
    const retried = await f.call('agent_chat_respond', { workspaceId, conversationId: id, ...request })
    expect(retried.isError === true).toBe(uncertain)
    expect(f.replay.responses).toHaveLength(1)
    const settled = await read()
    const recorded = settled.activitySnapshot!.pendingInteractions.find((entry) => entry.native?.requestId === request.nativeRequestId)
      ?? settled.activitySnapshot!.activities.filter((item) => item.kind === 'interaction').map((item) => item.interaction)
        .find((entry) => entry.native?.requestId === request.nativeRequestId)
    expect(recorded).toMatchObject({ answerRecorded: true, providerAcknowledged: !!result.providerAcknowledgment, workerAcknowledged: false,
      delivery: uncertain ? 'uncertain' : result.providerAcknowledgment ? 'delivered' : 'answer_recorded' })
    if (uncertain) expect(settled.responseAvailability?.available).toBe(false)
    await f.db.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
      JSON.stringify([{ actions: ['agent_chat:read'], scope: {} }])])
    // A fresh MCP session omits actions removed from the principal's live grants.
    await expectMcpAccessDenied(f.call('agent_chat_respond', { workspaceId, conversationId: id, ...request }))
    const denied = await f.http('POST', `${base}/conversations/${id}/responses`, request)
    expect(denied.statusCode, denied.body).toBe(403)
    expect(f.replay.responses).toHaveLength(1)
  })
})
