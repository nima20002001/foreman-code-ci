import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { OperatorActivityPageSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

let fixture: OperatorChatFixture
registerOperatorChatFixture(value => { fixture = value }, () => fixture?.chat, migratedDatabase)

describe.skipIf(!process.env.TEST_DATABASE_URL)('Operator activity item reads', () => {
  it('reads persisted completion beyond the recent window through HTTP and MCP with ownership and grant checks', async () => {
    const { chat, access, repository, manager, pool } = fixture
    const issued = await access.issue({ name: 'activity reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000) })
    const conversation = await chat.create(issued.principal)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'request', content: 'Read fixture' }, issued.principal)
    await waitFor(async () => (await chat.get(conversation.id, issued.principal)).turnState === 'active')
    const running = { id: 'old-tool', requestId: 'request', kind: 'tool' as const,
      title: 'Old tool', status: 'running' as const }
    await repository.activity.append(conversation.id, 'request', running)
    for (let index = 0; index < 105; index++) {
      await repository.activity.append(conversation.id, 'request', { ...running, id: `newer-${index}`, status: 'completed' })
    }
    const settled = await repository.activity.append(conversation.id, 'request', {
      ...running, status: 'completed', output: 'Persisted completion',
    })
    expect(settled).toBeDefined()
    expect((await chat.get(conversation.id, issued.principal)).activities?.some(item => item.id === running.id)).toBe(false)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices },
    })
    registerOperatorChatRoutes(app, chat)
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'activity-reader', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const mcp = await connect(issued.token)
      const query = { requestId: running.requestId, activityId: running.id }
      const url = `/api/operator/conversations/${conversation.id}/activity?${new URLSearchParams(query)}`
      const read = async (token: string) => app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${token}` } })
      const response = await read(issued.token)
      expect(response.statusCode).toBe(200)
      const page = OperatorActivityPageSchema.parse(response.json())
      expect(page.activities).toEqual([settled!.activity])
      expect(page.nextCursor).toBeNull()
      const result = await mcp.callTool({ name: 'operator_chat_activity_get',
        arguments: { conversationId: conversation.id, ...query } })
      expect(result.isError).not.toBe(true)
      expect(OperatorActivityPageSchema.parse(decodeMcpToolResult(result))).toEqual(page)
      const denied = await access.issue({ name: 'denied activity reader', audience: 'operator', grants: [],
        expiresAt: new Date(Date.now() + 60_000) })
      expect((await read(denied.token)).statusCode).toBe(403)
      const deniedMcp = await connect(denied.token)
      await expectMcpAccessDenied(deniedMcp.callTool({ name: 'operator_chat_activity_get',
        arguments: { conversationId: conversation.id, ...query } }))
      const other = await access.issue({ name: 'other activity owner', audience: 'operator',
        grants: issued.principal.grants, expiresAt: new Date(Date.now() + 60_000) })
      expect((await read(other.token)).statusCode).toBe(404)
      const foreignMcp = await connect(other.token)
      expect((await foreignMcp.callTool({ name: 'operator_chat_activity_get',
        arguments: { conversationId: conversation.id, ...query } })).isError).toBe(true)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
    }
  })
})
