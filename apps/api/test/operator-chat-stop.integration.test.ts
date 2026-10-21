import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { type OperatorConversationState } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildApp } from '../src/app.js'
import { createClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL

let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let operators: OperatorChatFixture['operators']
let repository: OperatorChatFixture['repository']
let authority: OperatorChatFixture['authority']
let chat: OperatorChatFixture['chat']
let runtimeDirectory: OperatorChatFixture['runtimeDirectory']

registerOperatorChatFixture(fixture => {
  ({ pool, access, operators, repository, authority, chat, runtimeDirectory } = fixture)
}, () => chat)

/** Real Claude session manager over a synthetic SDK: the turn runs until interrupted. */
function interruptibleClaude() {
  const interrupts: string[] = []
  const sdk: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'unused-fork' }),
    query(input) {
      const frames = new ClaudeBoundedQueue<unknown>(64)
      let active: string | undefined
      let initialized = false
      void (async () => {
        for await (const message of input.prompt) {
          if (!initialized) void frames.offer({ type: 'system', subtype: 'init', session_id: 'claude-session', claude_code_version: '2.1.284', cwd: runtimeDirectory })
          initialized = true
          active = message.uuid
          void frames.offer({ type: 'assistant', uuid: `reply:${message.uuid}`, session_id: 'claude-session', parent_tool_use_id: null, user_message_uuid: message.uuid,
            message: { id: `msg:${message.uuid}`, content: [{ type: 'text', text: 'working' }] } })
        }
      })().catch(error => frames.close(error))
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), close: () => frames.close(),
        initializationResult: async () => ({}), mcpServerStatus: async () => [], setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
        interrupt: async () => {
          interrupts.push(active!)
          void frames.offer({ type: 'result', uuid: `result:${active}`, session_id: 'claude-session', user_message_uuid: active,
            subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })
          return { still_queued: [] }
        } }
    },
  }
  // Like production, each Operator runtime gets its own manager; completion disposes it.
  const managers: ReturnType<typeof createClaudeNativeSessionManager>[] = []
  const manager = () => {
    const created = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'main', profilePath: '/synthetic/profile', configRevision: '1', cwd: runtimeDirectory }, sdkOptions: {},
      qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: false, history: false } })
    managers.push(created)
    return created
  }
  return { manager, managers, interrupts }
}

describe.skipIf(!connectionString)('Operator chat Stop on Claude', () => {
  it('interrupts the exact Claude message over HTTP service and MCP, settles canceled and accepts the next message', async () => {
    const claude = interruptibleClaude()
    const harness = { harness: 'claude' as const, model: 'synthetic-claude', authMode: 'subscription' as const, configDirectory: '/synthetic/profile',
      permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '',
      mcpServers: { graphql: { type: 'http' as const, url: 'http://127.0.0.1:3050/mcp' } } }
    await operators.update(harness, (await operators.ensure()).configuration.id)
    chat = new OperatorChatService(repository, operators, claude.manager, runtimeDirectory, authority)
    const user = await access.issue({ name: 'Claude stop owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'operator_chat:cancel'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const owner = user.principal
    const conversation = await chat.create(owner)
    const active = async (requestId: string) => {
      await chat.send(conversation.id, { requestId, content: 'long task' }, owner)
      await waitFor(async () => Boolean(await repository.submittedMessageId(conversation.id, requestId)))
    }
    await active('claude-http-stop')
    const receipt = await repository.submittedMessageId(conversation.id, 'claude-http-stop')
    await chat.cancel(conversation.id, 'claude-http-stop', owner)
    expect(claude.interrupts).toEqual([receipt])
    await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
    expect((await pool.query(`select result from operator_conversation_turns where conversation_id=$1 and request_id=$2`,
      [conversation.id, 'claude-http-stop'])).rows[0]?.result).toEqual({ outcome: 'canceled' })

    await active('claude-mcp-stop')
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'claude-stop', version: '1' }); clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const reader = await access.issue({ name: 'Claude stop reader', audience: 'operator',
        grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
      const denied = await connect(reader.token)
      const refused = await denied.callTool({ name: 'operator_chat_cancel', arguments: { conversationId: conversation.id, request: { requestId: 'claude-mcp-stop' } } })
      expect(refused.isError).toBe(true)
      expect(JSON.stringify(refused.content)).toContain('ACCESS_DENIED')
      expect(claude.interrupts).toHaveLength(1)
      const ownerClient = await connect(user.token)
      const result = await ownerClient.callTool({ name: 'operator_chat_cancel', arguments: { conversationId: conversation.id, request: { requestId: 'claude-mcp-stop' } } })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      expect(claude.interrupts).toHaveLength(2)
      await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
      const read = await ownerClient.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
      expect((decodeMcpToolResult(read) as OperatorConversationState).activeRequestId).toBeNull()
    } finally { await Promise.allSettled(clients.map(client => client.close())); await app.close() }

    await chat.send(conversation.id, { requestId: 'claude-after-stop', content: 'next' }, owner)
    await waitFor(async () => Boolean(await repository.submittedMessageId(conversation.id, 'claude-after-stop')))
    await chat.cancel(conversation.id, 'claude-after-stop', owner)
    await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
    expect(claude.interrupts).toHaveLength(3)
  }, 60_000)
})
