import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import Fastify from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'
import { settingsTools } from '../src/mcp/operator/tools/settings.js'
import { registerOperatorToolGroup } from '../src/mcp/operator/server.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import type { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'

const state = OperatorConversationStateSchema.parse({ conversation: { id: 'conversation', agentId: 'operator', scope: 'application', operatorConfigurationVersionId: 'pinned-configuration' },
  messages: [], revision: 12, turnState: 'idle', activeRequestId: null })
function principal(actions: ManagementAction[], scope = {}): ManagementPrincipal {
  return { id: 'control-owner', name: 'Control owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions, scope }] }
}
function controls(owner: ManagementPrincipal) {
  const chat = { cancel: vi.fn(async () => state), respond: vi.fn(async () => state) }
  const context = { principal: owner, services: { operatorChat: chat } } as unknown as OperatorRequestContext
  const tools = new Map<string, (input: unknown) => Promise<{ structuredContent?: unknown }>>()
  const server = { registerTool: (name: string, _definition: unknown, callback: (input: unknown) => Promise<{ structuredContent?: unknown }>) => {
    tools.set(name, callback)
  } } as unknown as McpServer
  registerOperatorToolGroup(server, context, settingsTools)
  return { chat, tools }
}

describe('mounted Operator control parity source ports', () => {
  it.each([
    { actions: ['operator_chat:read'], expected: [] },
    { actions: ['operator_chat:cancel', 'operator_chat:respond'], expected: [] },
    { actions: ['operator_chat:read', 'operator_chat:cancel'], expected: ['operator_chat_cancel'] },
    { actions: ['operator_chat:read', 'operator_chat:respond'], expected: ['operator_chat_respond'] },
  ] satisfies Array<{ actions: ManagementAction[]; expected: string[] }>)('requires overlapping read and control grants: $actions', ({ actions, expected }) => {
    expect([...controls(principal(actions)).tools.keys()].filter((name) => ['operator_chat_cancel', 'operator_chat_respond'].includes(name))).toEqual(expected)
  })
  it('does not advertise global Operator controls from a workspace-only grant', () => {
    const owner = principal(['operator_chat:read', 'operator_chat:cancel', 'operator_chat:respond'], { workspaceIds: ['workspace'] })
    expect([...controls(owner).tools.keys()]).toEqual([])
  })
  it('preserves the explicit cancellation command ID and same readback through the actual HTTP and registered MCP adapters', async () => {
    const owner = principal(['operator_chat:read', 'operator_chat:cancel']), { chat, tools } = controls(owner)
    const app = Fastify()
    app.addHook('preHandler', async (request) => { request.operatorPrincipal = owner })
    registerOperatorChatRoutes(app, chat as unknown as OperatorChatService)
    try {
      const input = { requestId: 'exact-model-request', commandId: 'explicit-cancel-command' }
      const response = await app.inject({ method: 'POST', url: '/api/operator/conversations/conversation/cancel', payload: input })
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ state })
      expect(chat.cancel.mock.calls).toEqual([['conversation', input.requestId, owner, input.commandId]])
      expect(decodeMcpToolResult((await tools.get('operator_chat_cancel')!({ conversationId: 'conversation', request: input })))).toEqual({ state })
      expect(chat.cancel.mock.calls[1]).toEqual(['conversation', input.requestId, owner, input.commandId, 'mcp'])
    } finally { await app.close() }
  })
  it('preserves the exact native choice and command ID through the actual HTTP and registered MCP adapters', async () => {
    const owner = principal(['operator_chat:read', 'operator_chat:respond']), { chat, tools } = controls(owner)
    const app = Fastify()
    app.addHook('preHandler', async (request) => { request.operatorPrincipal = owner })
    registerOperatorChatRoutes(app, chat as unknown as OperatorChatService)
    try {
      const input = { requestId: 'exact-model-request', nativeRequestId: 'exact-native-question', optionId: 'approve-once', commandId: 'explicit-response-command' }
      const response = await app.inject({ method: 'POST', url: '/api/operator/conversations/conversation/responses', payload: input })
      expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ state })
      expect(chat.respond.mock.calls).toEqual([['conversation', input, owner]])
      expect(decodeMcpToolResult((await tools.get('operator_chat_respond')!({ conversationId: 'conversation', request: input })))).toEqual({ state })
      expect(chat.respond.mock.calls[1]).toEqual(['conversation', input, owner, 'mcp'])
    } finally { await app.close() }
  })
})
