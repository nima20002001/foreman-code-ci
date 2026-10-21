import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { WorkflowChatPostResponseSchema } from '@foreman-code/contracts'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'
import { PostgresWorkflowChatRepository } from '../src/modules/workflow-chat/repository.js'
import { agent3Database } from './helpers/wave25Agent3.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('makes channel storage available through application migrations', async () => {
  const database = await agent3Database()
  cleanup.push(() => database.close())
  const repository = new PostgresWorkflowChatRepository(database.pool)
  await expect(repository.channel({ workspaceId: 'workspace', workflowId: 'workflow' })).resolves.toBeUndefined()
})

it('discovers, posts, wakes a mentioned Agent and reads back through the application MCP endpoint', async () => {
  const fixture = await conversationDeliveryFixture()
  cleanup.push(() => fixture.close())
  const services = {
    agentChat: fixture.agent, operatorChat: fixture.operator,
    workflowChat: fixture.feature.service, chatDelivery: fixture.feature.router,
    commands: new PostgresCommandCoordinator(fixture.database.pool),
  } as unknown as OperatorServices
  const app = buildApp({ logger: false, operator: { access: fixture.access, services },
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
  cleanup.push(() => app.close())
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const issued = await fixture.access.issue({ name: 'Group sender', audience: 'operator',
    grants: [{ scope: { workspaceIds: [fixture.scope.workspaceId], workflowIds: [fixture.scope.workflowId] }, actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'capabilities:read'] }] })
  const client = new Client({ name: 'Group client', version: '1' })
  cleanup.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
    authProvider: { token: async () => issued.token },
  }))
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('workflow_chat_post')
  const capabilities = await client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
  expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.arrayContaining(['workflow_chat_post', 'workflow_chat_read']) })
  const read = ReadAgentChatResponseSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'agent_chat_read',
    arguments: { workspaceId: fixture.scope.workspaceId, query: fixture.query } })))
  const target = read.deliveryTarget
  if (target?.kind !== 'agent_conversation') throw new Error('Expected an exact outside-run target.')
  const request = { ...fixture.scope, commandId: randomUUID(), body: '@Agent check this',
    mentions: [{ workflowNodeId: fixture.query.workflowNodeId, start: 0, end: 6 }],
    deliveries: [{ workflowNodeId: fixture.query.workflowNodeId, target, intent: 'auto' }], cardIds: [] }
  const result = await client.callTool({ name: 'workflow_chat_post', arguments: request })
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  const posted = WorkflowChatPostResponseSchema.parse(decodeMcpToolResult(result))
  expect(posted.receipts).toHaveLength(1)
  await fixture.feature.router.drainPrepared()
  await expect.poll(() => fixture.native(target.conversationId).inputs.length).toBe(1)
  expect(fixture.native(target.conversationId).inputs[0]?.prompt).toContain(request.body)
  const persisted = await client.callTool({ name: 'workflow_chat_read', arguments: fixture.scope })
  expect(decodeMcpToolResult(persisted)).toMatchObject({ items: [posted.post] })
  const http = await app.inject({ url: `/api/workspaces/${fixture.scope.workspaceId}/workflows/${fixture.scope.workflowId}/chat`,
    headers: { authorization: `Bearer ${issued.token}` } })
  expect(http.statusCode).toBe(200)
  expect(http.json()).toMatchObject({ items: [posted.post] })
  const denied = await fixture.access.issue({ name: 'Unrelated reader', audience: 'operator',
    grants: [{ scope: { workspaceIds: ['another-workspace'] }, actions: ['agent_chat:read', 'agent_chat:write'] }] })
  const other = new Client({ name: 'Denied Group client', version: '1' })
  cleanup.push(() => other.close())
  await other.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
    authProvider: { token: async () => denied.token },
  }))
  const denial = await other.callTool({ name: 'workflow_chat_post', arguments: { ...request, commandId: randomUUID() } })
  expect(denial.isError).toBe(true)
  expect(JSON.stringify(denial)).toContain('ACCESS_DENIED')
  expect(fixture.native(target.conversationId).inputs).toHaveLength(1)
  expect(decodeMcpToolResult(await client.callTool({ name: 'workflow_chat_read', arguments: fixture.scope })))
    .toMatchObject({ items: [posted.post] })
})
