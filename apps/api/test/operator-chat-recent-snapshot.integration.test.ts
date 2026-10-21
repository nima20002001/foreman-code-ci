import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OPERATOR_SNAPSHOT_MESSAGE_BYTES } from '../src/modules/conversations/operatorChatRepository.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { registerOperatorChatFixture, type OperatorChatFixture } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL
let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let owner: OperatorChatFixture['owner']
let repository: OperatorChatFixture['repository']
let chat: OperatorChatFixture['chat']

registerOperatorChatFixture(fixture => {
  ({ pool, access, owner, repository, chat } = fixture)
}, () => chat)

describe.skipIf(!connectionString)('Operator recent snapshot newest message retention', () => {
  it('retains an oversized newest message through HTTP and MCP with accurate earlier-history metadata', async () => {
    const writer = await access.issue({ name: 'large snapshot owner', audience: 'operator', grants: owner.grants,
      expiresAt: new Date(Date.now() + 600_000) })
    const denied = await access.issue({ name: 'denied snapshot reader', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600_000) })
    const conversation = await chat.create(writer.principal)
    const requestId = 'large-message'
    const userContent = 'é'.repeat(OPERATOR_SNAPSHOT_MESSAGE_BYTES / 2 + 1)
    // Public persistence APIs seed data that can already exist, regardless of
    // the current input limit or a provider's individual text-frame limit.
    await repository.beginTurn(conversation.id, { requestId, content: userContent }, writer.principal.id)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const url = `/api/operator/conversations/${conversation.id}`
    async function readBoth() {
      const response = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${writer.token}` } })
      expect(response.statusCode).toBe(200)
      const http = OperatorConversationStateSchema.parse(response.json())
      const result = await graphRpc(app, writer.token, 'tools/call', {
        name: 'operator_chat_get', arguments: { conversationId: conversation.id },
      })
      expect(result.result?.isError).not.toBe(true)
      const mcp = OperatorConversationStateSchema.parse(graphRpcValue(result.result))
      expect(mcp.messages).toEqual(http.messages)
      expect(mcp.hasEarlierMessages).toBe(http.hasEarlierMessages)
      return http
    }
    try {
      const first = await readBoth()
      expect(first.messages).toHaveLength(1)
      expect(first.messages[0]).toMatchObject({ role: 'user', requestId, content: userContent })
      expect(first.hasEarlierMessages).toBe(false)

      const assistantContent = 'newest answer '.repeat(OPERATOR_SNAPSHOT_MESSAGE_BYTES / 8)
      expect(await repository.appendAssistantMessage(conversation.id, requestId, 'large-answer', assistantContent)).toBe(true)
      const recent = await readBoth()
      expect(recent.messages).toHaveLength(1)
      expect(recent.messages[0]).toMatchObject({ role: 'assistant', requestId, content: assistantContent,
        nativeMessageId: 'large-answer' })
      expect(recent.hasEarlierMessages).toBe(true)
      const latest = await chat.history(conversation.id, writer.principal, { limit: 1 })
      expect(latest.entries[0]?.message).toEqual(recent.messages[0])
      expect(latest.nextCursor).not.toBeNull()
      const earlier = await chat.history(conversation.id, writer.principal, { before: latest.nextCursor!, limit: 1 })
      expect(earlier.entries[0]?.message).toEqual(first.messages[0])
      expect(earlier.nextCursor).toBeNull()

      expect((await app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      const deniedMcp = await graphRpc(app, denied.token, 'tools/call', {
        name: 'operator_chat_get', arguments: { conversationId: conversation.id },
      })
      expect(deniedMcp.result?.isError).toBe(true)
    } finally { await app.close() }
  })
})
