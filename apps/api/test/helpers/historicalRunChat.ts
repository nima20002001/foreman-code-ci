import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { SelectedRunChatTarget } from '@foreman-code/contracts/selected-run-chat'
import { readSelected, selectedPath, targetFor, type HistoricalApi } from './sch12HistoricalRuns.js'

export function chatTarget(api: HistoricalApi, execution: HarnessExecution): SelectedRunChatTarget {
  return { ...targetFor(api.f, execution.runId), workflowNodeId: execution.workflowNodeId }
}
export async function retainedChatRows(api: HistoricalApi) {
  return {
    conversations: (await api.pool.query("select * from operator_conversations where kind='agent' order by id")).rows,
    messages: (await api.pool.query(`select m.* from operator_conversation_messages m join operator_conversations c
      on c.id=m.conversation_id where c.kind='agent' order by m.conversation_id,m.id`)).rows,
    turns: (await api.pool.query(`select t.* from operator_conversation_turns t join operator_conversations c
      on c.id=t.conversation_id where c.kind='agent' order by t.conversation_id,t.request_id`)).rows,
  }
}
export async function assertExactOrigin(api: HistoricalApi, execution: HarnessExecution, id: string) {
  const row = await api.repository.get(id)
  expect(row).toMatchObject({ workspace_id: api.f.f.scope.workspaceId, workflow_id: api.f.f.scope.workflowId,
    workflow_node_id: execution.workflowNodeId, agent_id: execution.agentId,
    agent_configuration_version_id: execution.agentConfigurationVersionId,
    origin_run_id: execution.runId, origin_execution_id: execution.id,
    record: { origin: { kind: 'run_execution', runId: execution.runId, executionId: execution.id,
      sourceNativeSessionId: execution.nativeSessionId } } })
  const selected = await readSelected(api, chatTarget(api, execution), execution.id)
  expect(selected).toMatchObject({ kind: 'selected', key: { ...chatTarget(api, execution),
    agentId: execution.agentId, executionId: execution.id, conversationId: id },
    state: { conversation: { nativeSession: { nativeSessionId: row!.native_session_id } } } })
  return row!
}
/** Unregistered tools and schema-invalid calls may be JSON-RPC errors rather
 * than domain-error tool results. Both are denial; unrelated transport failures
 * must still fail this test. Domain errors on registered tools use parity below. */
export async function expectProtocolDenial(operation: () => Promise<{ isError?: boolean | undefined; structuredContent?: unknown }>) {
  let result: Awaited<ReturnType<typeof operation>>
  try { result = await operation() } catch (error) {
    expect(error).toHaveProperty('code')
    expect([-32601, -32602]).toContain((error as { code: number }).code)
    return
  }
  expect(result.isError, JSON.stringify(result)).toBe(true)
  expect(result.structuredContent).toBeUndefined()
}
export async function rejectedSend(api: HistoricalApi, target: SelectedRunChatTarget, executionId: string,
  expectedConversationId: string | null, code: string, token = api.f.writer.token, client = api.client,
  requestId: string = randomUUID(), content = 'This message must not be admitted.') {
  const message = { requestId, content, expectedConversationId }
  const http = await api.app.inject({ method: 'POST', url: `${selectedPath(target)}/messages`,
    headers: { authorization: `Bearer ${token}` }, payload: { executionId, ...message } })
  expect(http.statusCode, http.body).toBe(409)
  expect(http.json()).toMatchObject({ error: { code } })
  const { workspaceId, ...selection } = target
  const mcp = await client.callTool({ name: 'agent_chat_send', arguments: {
    workspaceId, selection: { ...selection, executionId }, message,
  } })
  expect(mcp.isError, JSON.stringify(mcp)).toBe(true)
  expect(mcp.structuredContent).toBeUndefined()
  expect(JSON.stringify(mcp)).toContain(code)
}
