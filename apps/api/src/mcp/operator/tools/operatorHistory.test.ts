import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { ManagementActionSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { buildApp } from '../../../app.js'
import { PostgresAccessService } from '../../../modules/access/postgres.js'
import type { OperatorServices } from '../types.js'

it('discovers and invokes owned chat deletion and restoration through authenticated MCP', async () => {
  const owner: ManagementPrincipal = {
    id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
  }
  const reader: ManagementPrincipal = {
    ...owner, id: 'reader', grants: [{ actions: ['operator_chat:read', 'capabilities:read'], scope: {} }],
  }
  const pool = new pg.Pool()
  vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Unit tests do not connect to Postgres') })
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'owner' ? owner : reader)
  const state = OperatorConversationStateSchema.parse({
    conversation: { id: 'owned-chat', agentId: 'application-operator', scope: 'application',
      operatorConfigurationVersionId: 'configuration' },
    messages: [], turnState: 'idle', activeRequestId: null, revision: 1,
  })
  const setDeleted = vi.fn(async () => ({ conversationId: 'owned-chat' }))
  const send = vi.fn(async () => ({ state, replayed: false }))
  const recordDenied = vi.fn()
  const services = {
    commands: { recordDenied },
    operatorChat: { get: async () => state, list: async () => [state.conversation], setDeleted, send },
  } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  async function connect(token: string) {
    const client = new Client({ name: 'chat-history-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }
  try {
    const ownerClient = await connect('owner')
    const readerClient = await connect('reader')
    const names = ['operator_chat_delete', 'operator_chat_restore']
    const tools = (await ownerClient.listTools()).tools
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining(names))
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'operator_chat_create', 'operator_chat_list', 'operator_chat_get', 'operator_chat_history_get',
      'operator_chat_activity_get', 'operator_chat_send', 'operator_handoff_history_get',
    ]))
    for (const disabled of ['memory_board_get', 'browser_action', 'workflow_chat_post']) {
      expect(tools.map(tool => tool.name)).not.toContain(disabled)
      const rejected = await ownerClient.callTool({ name: disabled, arguments: {} })
        .then(result => result.isError === true, () => true)
      expect(rejected).toBe(true)
    }
    const legacySend = await ownerClient.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: 'owned-chat', ignoredField: 'normal MCP wrapper strips this',
      request: { requestId: 'legacy-send', content: 'Legacy omitted intent stays omitted', ignoredField: true },
    } })
    expect(legacySend.isError).not.toBe(true)
    expect(decodeMcpToolResult(legacySend)).toEqual({ state, replayed: false })
    expect(send).toHaveBeenCalledWith('owned-chat', {
      requestId: 'legacy-send', content: 'Legacy omitted intent stays omitted', attachments: [],
    }, owner)
    const capabilities = await ownerClient.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({
      tools: expect.arrayContaining(names),
      requirements: expect.arrayContaining(names.map(name => expect.objectContaining({
        name, actions: ['operator_chat:write'],
      }))),
    })
    for (const [name, deleted] of [['operator_chat_delete', true], ['operator_chat_restore', false]] as const) {
      const input = { conversationId: 'owned-chat', commandId: `${name}-command` }
      const result = await ownerClient.callTool({ name, arguments: input })
      expect(result.isError).not.toBe(true)
      expect(decodeMcpToolResult(result)).toEqual({ conversationId: 'owned-chat' })
      expect(setDeleted).toHaveBeenLastCalledWith('owned-chat', owner, deleted, {
        commandId: input.commandId, source: 'mcp',
      })
      const calls = setDeleted.mock.calls.length
      const denied = await readerClient.callTool({ name, arguments: input })
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect(setDeleted).toHaveBeenCalledTimes(calls)
      expect(recordDenied).toHaveBeenCalledWith(reader.id, 'mcp', name, `mcp:${name}`)
    }
    const readerTools = (await readerClient.listTools()).tools.map(tool => tool.name)
    expect(readerTools).not.toContain('operator_chat_delete')
    expect(readerTools).not.toContain('operator_chat_restore')
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
  }
})
