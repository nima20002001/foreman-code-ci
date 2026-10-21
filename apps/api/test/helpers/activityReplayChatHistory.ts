import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { AgentChatHistoryPageSchema, AgentChatSendResponseSchema, AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { expect } from 'vitest'
import { setup, completedRun, eventually, eventStream } from './activityReplayFixture.js'

export async function replayChatHistory(options: { selectedRun: boolean }) {
  const selected = options.selectedRun
  const f = await setup(), workspaceId = f.saved.scope.workspaceId, workflowId = f.saved.scope.workflowId
  const node = f.saved.version.definition.nodes[0]!
  const origin = selected ? await completedRun(f) : undefined
  const execution = origin ? origin.executions.find((entry) => entry.workflowNodeId === node.id) : undefined
  if (origin && !execution) throw new Error('Selected Run has no exact recorded node execution.')
  const query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
  const base = selected ? `/api/workspaces/${workspaceId}/agent-chat/workflows/${workflowId}/runs/${origin!.run.id}/nodes/${node.id}`
    : `/api/workspaces/${workspaceId}/agent-chat`
  const selection = selected ? { workflowId, runId: origin!.run.id, workflowNodeId: node.id, executionId: execution!.id } : undefined
  const read = async () => {
    const response = await f.http('GET', selected ? `${base}?executionId=${execution!.id}`
      : `${base}?workflowId=${workflowId}&workflowNodeId=${node.id}&agentId=${node.agentId}`)
    expect(response.statusCode, response.body).toBe(200)
    const value = selected ? ReadSelectedRunChatResponseSchema.parse(response.json()) : undefined
    if (value && value.kind !== 'selected') throw new Error('Exact recorded source was substituted.')
    return value ? value.state : AgentChatStateSchema.parse(response.json())
  }
  if (origin) {
    // The terminal outcome is committed before the original writer finishes cleanup.
    await eventually(async () => {
      const result = await f.db.pool.query<{ pending: boolean; attempts: number }>(
        'select pending,attempts from run_cleanup_intents where run_id=$1', [origin.run.id])
      return result.rows[0]
    }, (intent) => intent?.pending === false && intent.attempts > 0)
    const ready = await read()
    expect(ready.availability.canSend).toBe(true)
    expect(ready.conversation).toBeNull()
  }
  const message = (requestId: string, expectedConversationId: string | null) => ({ requestId, content: 'recorded active message', intent: 'next_turn', expectedConversationId })
  const first = await f.http('POST', `${base}/messages`, selected ? { ...message('active-A', null), executionId: execution!.id }
    : { ...message('active-A', null), context: query })
  expect(first.statusCode, first.body).toBe(202)
  // An explicit intent is a shared delivery command; standalone Agent readback returns its receipt with the state.
  const id = AgentChatStateSchema.parse(AgentChatSendResponseSchema.parse(first.json()).state).conversation!.id
  const active = await eventually(read, (state) => !!state.activeTurn?.nativeTurnId)
  const native = active.activitySnapshot!.active.find((owner) => owner.ref.kind === 'chat_request')!.native!
  const second = await f.http('POST', `${base}/messages`, selected ? { ...message('queued-B', id), executionId: execution!.id }
    : { ...message('queued-B', id), context: query })
  expect(second.statusCode, second.body).toBe(202)
  const queued = await read()
  expect(queued.activitySnapshot!.active[0]!.ref).toMatchObject({ requestId: 'active-A' })
  expect(queued.activitySnapshot!.queued).toContainEqual({ kind: 'chat_request', conversationId: id, requestId: 'queued-B' })
  expect(queued.activitySnapshot!.latest).toMatchObject({ requestId: 'queued-B' })
  const canceled = await f.http('POST', `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/turns/queued-B/cancel`, { requestId: 'cancel-B-control' })
  expect(canceled.statusCode, canceled.body).toBe(200)
  const calls = f.replay.starts.length
  const retried = await f.call('agent_chat_cancel_queued', { workspaceId, conversationId: id, turnRequestId: 'queued-B', requestId: 'cancel-B-control' })
  expect(retried.isError).not.toBe(true); expect(f.replay.starts.length).toBe(calls)
  expect((await read()).activitySnapshot!.active[0]!.ref).toMatchObject({ requestId: 'active-A' })
  const stream = await eventStream(`${f.origin}/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/events`, f.writer.token)
  const bootstrap = await stream.next((event) => event.type === 'snapshot')
  expect((bootstrap.data as Record<string, unknown>).activitySnapshot).toMatchObject({ scope: active.activitySnapshot!.scope })
  f.replay.commandRunning(native.sessionId, native.turnId!)
  await eventually(read, (state) => state.activitySnapshot!.activities.some((item) => item.kind === 'tool' && item.status === 'running'))
  f.replay.append(native.sessionId, native.turnId!, 'provisional answer longer than final')
  await eventually(read, (state) => state.messages.some((entry) => entry.role === 'assistant' && entry.content.includes('provisional')))
  const emitted = await stream.next((event) => event.type === 'delta' && !!(event.data as Record<string, unknown>)?.activityChange)
  expect(emitted.data).toMatchObject({ activityChange: { schemaVersion: 1, scope: active.activitySnapshot!.scope,
    owner: { kind: 'chat_request', conversationId: id, requestId: 'active-A' },
    native: { sessionId: native.sessionId, turnId: native.turnId }, change: { kind: 'text.append', channel: 'assistant' } } })
  expect(typeof (emitted.data as Record<string, unknown>).scopeRevision).toBe('string')
  await stream.close()
  const oversized = '界'.repeat(150000)
  f.replay.append(native.sessionId, native.turnId!, oversized)
  const historyUrl = `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/history`
  const largeHistory = await eventually(async () => {
    const response = await f.http('GET', `${historyUrl}?limit=1`)
    expect(response.statusCode, response.body).toBe(200)
    return AgentChatHistoryPageSchema.parse(response.json())
  }, (page) => page.messages.some((entry) => entry.content.endsWith(oversized)))
  expect(largeHistory.messages[0]!.content).toBe(`provisional answer longer than final${oversized}`)
  const bounded = await read()
  expect(JSON.stringify(bounded).length).toBeLessThan(400000)
  const mcpHistory = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }), history: { limit: 1 } })
  expect(mcpHistory.isError).not.toBe(true)
  expect((decodeMcpToolResult(mcpHistory) as { history: unknown }).history).toEqual(largeHistory)
  expect(f.replay.starts.length).toBe(calls)
  f.replay.complete(native.sessionId, native.turnId!, '')
  const finished = await eventually(read, (state) => state.activeTurn === null)
  const finalText = finished.activitySnapshot!.activities.filter((item) => item.kind === 'text' && item.owner.kind === 'chat_request' && item.owner.requestId === 'active-A')
  expect(finalText.filter((item) => item.kind === 'text' && item.text === '').length).toBe(1)
  expect(finished.activitySnapshot!.active.some((item) => item.ref.kind === 'tool')).toBe(true)
  f.replay.commandCompleted(native.sessionId, native.turnId!)
  const childSettled = await eventually(read, (state) => state.activitySnapshot!.activities.some((item) => item.kind === 'tool' && item.status === 'completed'))
  expect(childSettled.activeTurn).toBeNull()
  expect(childSettled.activitySnapshot!.latest).toMatchObject({ requestId: 'queued-B' })
  expect(childSettled.activitySnapshot!.activities.find((item) => item.kind === 'tool')).toMatchObject({ owner: { requestId: 'active-A' }, native: { sessionId: native.sessionId, turnId: native.turnId } })
  const revision = childSettled.revision
  f.replay.complete(native.sessionId, native.turnId!, '')
  expect((await read()).revision).toBe(revision)
  f.replay.append(native.sessionId, native.turnId!, 'late stale delta')
  const cold = await read()
  expect(cold.revision).toBe(revision)
  expect(cold.messages.some((entry) => entry.content.includes('late stale delta'))).toBe(false)
  const mcp = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }) })
  expect(mcp.isError).not.toBe(true)
  const mcpState = selected ? ReadSelectedRunChatResponseSchema.parse(decodeMcpToolResult(mcp)) : AgentChatStateSchema.parse(decodeMcpToolResult(mcp))
  const equivalent = 'kind' in mcpState ? (mcpState.kind === 'selected' ? mcpState.state : undefined) : mcpState
  expect(equivalent?.activitySnapshot).toEqual(cold.activitySnapshot)
  const denied = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }) }, f.denied.token)
  expect(denied.isError).toBe(true)
  await f.restart()
  const restarted = (await read()).activitySnapshot!
  const { observation, ...persisted } = cold.activitySnapshot!
  expect(observation).toMatchObject({ status: 'available', lastError: null, consecutiveFailures: 0 })
  expect(restarted).toEqual(persisted)
  const counts = await f.db.pool.query('select count(*)::int as count from management_command_receipts where principal_id=$1 and command_id=$2',
    [f.writer.principal.id, 'cancel-B-control'])
  expect(counts.rows[0]!.count).toBe(1)
  const foreignCreated = await f.http('POST', '/api/operator/conversations', { title: 'Foreign cursor source' })
  expect(foreignCreated.statusCode, foreignCreated.body).toBe(201)
  const foreignId = foreignCreated.json().conversation.id
  expect((await f.http('POST', `/api/operator/conversations/${foreignId}/messages`, { requestId: 'foreign-source', content: 'Own separate history' })).statusCode).toBe(202)
  const foreign = (await f.db.pool.query('select turn_sequence::text as cursor from operator_conversation_turns where conversation_id=$1 and request_id=$2', [foreignId, 'foreign-source'])).rows[0]!.cursor
  const receiptUrl = `/api/workspaces/${workspaceId}/agent-chat/conversations/${id}/turns?before=${foreign}&limit=1`
  const foreignHttp = await f.http('GET', receiptUrl)
  expect(foreignHttp.statusCode, foreignHttp.body).toBe(409)
  expect(foreignHttp.json().error.code).toBe('TURN_HISTORY_CURSOR_SCOPE_CONFLICT')
  const foreignMcp = await f.call('agent_chat_read', { workspaceId, ...(selection ? { selection } : { query }), receipts: { before: foreign, limit: 1 } })
  expect(foreignMcp.isError).toBe(true)
}
