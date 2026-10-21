import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, SessionControlStateSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { claudeConfiguration, registerOperatorChatFixture, type OperatorChatFixture } from './helpers/operatorChatFixture.js'
import { seedAgent3 } from './helpers/wave25Agent3.js'

let fixture: OperatorChatFixture
let chat: OperatorChatService
registerOperatorChatFixture(value => { fixture = value; chat = value.chat }, () => chat)

describe.skipIf(!process.env.TEST_DATABASE_URL)('chat context windows before native session creation', () => {
  it.each(['codex', 'claude'] as const)('reads the selected %s window through HTTP and authenticated MCP', async harness => {
    const { pool, access, operators, repository, manager, authority, runtimeDirectory } = fixture
    const configuration = { ...(harness === 'claude' ? claudeConfiguration : DEFAULT_HARNESS_DEFAULTS.codex),
      model: 'selected-model' }
    await operators.update(configuration, (await operators.ensure()).configuration.id)
    const modelOptions = vi.fn(async () => [
      { id: 'other-model', contextWindow: 32000, reasoningEfforts: [], variants: [], serviceTiers: [] },
      { id: 'selected-model', contextWindow: 272000, reasoningEfforts: [], variants: [], serviceTiers: [] },
      { id: 'unknown-model', reasoningEfforts: [], variants: [], serviceTiers: [] },
    ])
    const managers = Object.assign(() => manager, { modelOptions })
    chat = new OperatorChatService(repository, operators, managers, runtimeDirectory, authority)
    const workflow = makeCurrentWorkflowFixture(randomUUID(), 'single')
    workflow.configurations[0]!.harness = configuration
    const seeded = await seedAgent3(pool, runtimeDirectory, workflow, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const context = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const workspaceId = seeded.scope.workspaceId
    const agent = new AgentChatService(pool, new PostgresAgentChatRepository(pool), repository,
      new PostgresWorkflowRepository(pool), {
        getForWorkspace: async () => { throw new Error('No Run is selected') },
        getExecution: async () => { throw new Error('No execution is selected') },
        async *executionPages() { yield [] },
      }, managers, runtimeDirectory)
    const reader = await access.issue({ name: 'context reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'agent_chat:read', 'agent_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 600000) })
    const denied = await access.issue({ name: 'denied context reader', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600000) })
    const conversation = await chat.create(reader.principal)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat, agentChat: agent,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'context-window-reader', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
          { authProvider: { token: async () => token } }))
        return client
      }
      const allowedClient = await connect(reader.token)
      const deniedClient = await connect(denied.token)
      const targets = [
        { name: 'operator_chat_controls_get', arguments: { conversationId: conversation.id },
          url: `/api/operator/conversations/${conversation.id}/session-controls` },
        { name: 'agent_chat_controls_get', arguments: { workspaceId, context },
          url: `/api/workspaces/${workspaceId}/agent-chat/session-controls?${new URLSearchParams(context)}` },
      ]
      for (const target of targets) {
        const http = await app.inject({ method: 'GET', url: target.url,
          headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode, http.body).toBe(200)
        const state = SessionControlStateSchema.parse(http.json())
        expect(state).toMatchObject({ context: null, nativeSessionId: null,
          capabilities: { model: 'selected-model', modelCapacity: 272000 } })
        const mcp = await allowedClient.callTool({ name: target.name, arguments: target.arguments })
        expect(mcp.isError).not.toBe(true)
        expect(SessionControlStateSchema.parse(decodeMcpToolResult(mcp))).toEqual(state)
        expect((await app.inject({ method: 'GET', url: target.url,
          headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
        await expectMcpAccessDenied(deniedClient.callTool({ name: target.name, arguments: target.arguments }))
      }
      const admitted = await agent.changeContextControls(reader.principal, { workspaceId, ...context },
        { kind: 'mode', mode: 'plan', requestId: randomUUID(), expectedRevision: 0 })
      for (const id of [conversation.id, admitted.conversationId!]) {
        const saved = await pool.query<{ record: unknown }>(
          'select record from conversation_session_controls where conversation_id=$1', [id])
        expect(SessionControlStateSchema.parse(saved.rows[0]!.record)).toMatchObject({
          nativeSessionId: null, capabilities: { modelCapacity: 272000 } })
      }
      const persisted = await allowedClient.callTool({ name: 'agent_chat_controls_get',
        arguments: { workspaceId, conversationId: admitted.conversationId! } })
      expect(SessionControlStateSchema.parse(decodeMcpToolResult(persisted))).toMatchObject({
        desiredMode: 'plan', nativeSessionId: null, capabilities: { modelCapacity: 272000 } })
      expect(manager.sessions).toBe(0)
      expect(manager.attachments).toBe(0)
      expect(manager.turns).toBe(0)
      expect((await chat.get(conversation.id, reader.principal)).messages).toEqual([])
      expect(modelOptions).toHaveBeenCalledWith(expect.objectContaining({ harness, model: 'selected-model' }))
    } finally {
      await Promise.all(clients.map(client => client.close()))
      await app.close()
      await agent.shutdown()
    }
  })
})
