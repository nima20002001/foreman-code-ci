import { performance } from 'node:perf_hooks'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { OperatorConversationState } from '@foreman-code/contracts'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { registerOperatorChatFixture, type OperatorChatFixture, claudeConfiguration, waitFor } from './helpers/operatorChatFixture.js'
import { operatorClaudeReplay } from './helpers/operatorClaudeReplay.js'

let f: OperatorChatFixture
let chat: OperatorChatService
registerOperatorChatFixture(fixture => { f = fixture; chat = f.chat }, () => chat)

describe.skipIf(!process.env.TEST_DATABASE_URL)('Operator warm Claude SDK sessions', () => {
  it('reuses one SDK query for two authenticated turns and cold-resumes after shutdown', async () => {
    await f.operators.update({ ...claudeConfiguration, configDirectory: '/recorded/profile' },
      (await f.operators.ensure()).configuration.id)
    const replay = operatorClaudeReplay(f.runtimeDirectory)
    const makeService = () => new OperatorChatService(f.repository, f.operators, replay.manager,
      f.runtimeDirectory, f.authority)
    chat = makeService()
    const writer = await f.access.issue({ name: 'Session writer', audience: 'operator', grants: f.owner.grants })
    const services = { operatorChat: chat, commands: new PostgresCommandCoordinator(f.pool) } as unknown as OperatorServices
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: f.access, services } })
    const client = new Client({ name: 'operator-session-reuse', version: '1' })
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => writer.token } }))
      const created = await client.callTool({ name: 'operator_chat_create', arguments: {} })
      expect(created.isError).not.toBe(true)
      const id = (decodeMcpToolResult(created) as { conversation: { id: string } }).conversation.id
      const read = async () => {
        const result = await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: id } })
        expect(result.isError).not.toBe(true)
        return decodeMcpToolResult(result) as OperatorConversationState
      }
      const turn = async (requestId: string) => {
        const startedAt = performance.now()
        let observed!: (milliseconds: number) => void
        const output = new Promise<number>(resolve => { observed = resolve })
        const unsubscribe = chat.events.subscribe(id, event => {
          if (event.type === 'delta' && event.data.requestId === requestId) observed(performance.now() - startedAt)
        })
        try {
          const result = await client.callTool({ name: 'operator_chat_send', arguments: {
            conversationId: id, request: { requestId, content: 'Reply once' },
          } })
          expect(result.isError).not.toBe(true)
          const milliseconds = await output
          await waitFor(async () => (await read()).turnState === 'idle')
          return milliseconds
        } finally { unsubscribe() }
      }
      const coldMs = await turn('cold')
      const sessionId = (await f.repository.active(id))!.native_session_id
      const warmMs = await turn('warm')
      console.info('Operator Claude SDK timing', { coldMs, warmMs, queryStarts: replay.queries() })
      expect(replay.queries()).toBe(1)
      expect(replay.closures()).toBe(0)
      expect((await read()).messages.map(message => message.requestId)).toEqual(['cold', 'cold', 'warm', 'warm'])
      const fault = vi.spyOn(f.repository, 'finish').mockRejectedValue(new Error('Terminal save unavailable'))
      try {
        const sent = await client.callTool({ name: 'operator_chat_send', arguments: {
          conversationId: id, request: { requestId: 'retired-before-restart', content: 'Reply once' },
        } })
        expect(sent.isError).not.toBe(true)
        await waitFor(async () => (await read()).turnState === 'uncertain')
        expect((await read()).activeRequestId).toBe('retired-before-restart')
        const blocked = await client.callTool({ name: 'operator_chat_send', arguments: {
          conversationId: id, request: { requestId: 'blocked', content: 'Must wait for saved completion' },
        } })
        expect(blocked.isError).toBe(true)
        expect(replay.queries()).toBe(1)
        expect(replay.closures()).toBe(0)
        await chat.shutdown()
      } finally { fault.mockRestore() }
      expect(replay.closures()).toBe(1)
      chat = makeService()
      services.operatorChat = chat
      await waitFor(async () => { await chat.reconcileActive(); return (await read()).turnState === 'idle' })
      expect((await read()).lastResult?.outcome).toBe('succeeded')
      expect(replay.queries()).toBe(1)
      await turn('resumed')
      expect(replay.queries()).toBe(2)
      expect((await f.repository.active(id))!.native_session_id).toBe(sessionId)
      expect(replay.prompts).toEqual(['Reply once', 'Reply once', 'Reply once', 'Reply once'])
    } finally { await client.close(); await app.close() }
  })
})
