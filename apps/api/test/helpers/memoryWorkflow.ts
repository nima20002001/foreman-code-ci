import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { expect } from 'vitest'
import type { currentOperatorIntegration } from './currentOperatorIntegration.js'

export type MemoryRuntime = Awaited<ReturnType<typeof currentOperatorIntegration>>
export function memoryWorkflow(form: 'single' | 'sequential' | 'parallel' = 'sequential') {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  for (const configuration of fixture.configurations) configuration.harness = {
    harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only',
    serviceTier: 'standard', advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' },
  }
  return fixture
}
export async function memoryCall(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args })
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
  return decodeMcpToolResult(response)
}
export async function workflowMemory(runtime: MemoryRuntime, nodeIndex = 0) {
  const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
  const board = await memoryCall(runtime.client, 'memory_board_get', { scope })
  const boardId = (board.board as { id: string }).id
  const node = runtime.f.version.definition.nodes[nodeIndex]!
  const created = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId,
    card: { title: 'Tracked work', body: '', status: 'todo', completionKind: null, reason: null, assignee: null, linkedNodes: [] },
    workSelections: [{ kind: 'next_activation', node: { workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId } }],
  })
  const cardId = (created.card as { id: string }).id
  return { boardId, cardId, scope,
    read: () => memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'card', cardId }) }
}
