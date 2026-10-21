import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('Memory board application composition', () => {
  let db: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterAll(async () => { await db?.close() })

  it('mounts migrated boards in HTTP, authenticated MCP and capability discovery with persisted readback', async () => {
    const access = new PostgresAccessService(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const owner = await access.issue({ name: 'Board editor', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: [
        'workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update', 'capabilities:read',
      ], scope: {} }] })
    const reader = await access.issue({ name: 'Board reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['workflows:read'], scope: {} }] })
    const memory = memoryFixture(db.pool, owner.principal)
    const services = { commands, memoryBoards: memory.service } as unknown as OperatorServices
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      async function connect(token: string) {
        const client = new Client({ name: 'memory-composition-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const client = await connect(owner.token)
      const readOnly = await connect(reader.token)
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('memory_card_create')
      const snapshot = decodeMcpToolResult(await client.callTool({ name: 'memory_board_get', arguments: { scope: memory.scope } }))
      const boardId = (snapshot.board as { id: string }).id
      const created = decodeMcpToolResult(await client.callTool({ name: 'memory_card_create', arguments: {
        kind: 'card_create', boardId,
        card: { title: 'Composed board', body: 'Saved through MCP', status: 'todo', completionKind: null,
          reason: null, assignee: null, linkedNodes: [] },
      } }))
      const card = created.card as { id: string }
      const response = await app.inject({ method: 'GET',
        url: `/api/memory-boards?boardId=${boardId}&view=card&cardId=${card.id}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(response.statusCode).toBe(200)
      expect(response.json().card).toEqual(created.card)
      expect((await readOnly.listTools()).tools.map(tool => tool.name)).not.toContain('memory_card_create')
      expect((await readOnly.callTool({ name: 'memory_card_update', arguments: {
        kind: 'card_update', boardId, cardId: card.id, patch: { body: 'Denied' },
      } })).isError).toBe(true)
      const capabilities = decodeMcpToolResult(await client.callTool({ name: 'operator_get_capabilities', arguments: {} }))
      expect(capabilities.tools).toContain('memory_card_create')
      expect((await memory.card(boardId, card.id)).card.body).toBe('Saved through MCP')
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
    }
  }, 60000)
})
