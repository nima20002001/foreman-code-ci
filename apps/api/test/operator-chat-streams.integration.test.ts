import type { OperatorServices } from '../src/mcp/operator/types.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { createStreamFixture } from './claude-streams.testSupport.js'
import { type OperatorConversationState } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildApp } from '../src/app.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL

let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let owner: OperatorChatFixture['owner']
let operators: OperatorChatFixture['operators']
let repository: OperatorChatFixture['repository']
let authority: OperatorChatFixture['authority']
let chat: OperatorChatFixture['chat']
let runtimeDirectory: OperatorChatFixture['runtimeDirectory']

registerOperatorChatFixture(fixture => {
  ({ pool, access, owner, operators, repository, authority, chat, runtimeDirectory } = fixture)
}, () => chat)

describe.skipIf(!connectionString)('Operator chat bounded Claude streams', () => {
  it('preserves truncation in persisted messages, HTTP, SSE data and authenticated MCP', async () => {
    const f = createStreamFixture({ workingDirectory: runtimeDirectory })
    await operators.update({ harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/profile',
      permissionMode: 'default', sandbox: 'read-only', tools: ['Read'], permissionRules: [], instructions: '', mcpServers: {},
    }, (await operators.ensure()).configuration.id)
    chat = new OperatorChatService(repository, operators, () => f.manager, runtimeDirectory, authority)
    const writer = await access.issue({ name: 'truncation owner', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const conversation = await chat.create(writer.principal)
    const reader = await access.issue({ name: 'truncation reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      localHuman: { current: () => access.currentOperator(writer.principal.id) },
      operator: { access, services: { operatorChat: chat, commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    registerOperatorChatRoutes(app, chat)
    const streamed: unknown[] = []
    const unsubscribe = chat.events.subscribe(conversation.id, event => { if (event.type === 'delta') streamed.push(event.data) })
    try {
      await chat.send(conversation.id, { requestId: 'truncated', content: 'Return a long answer' }, writer.principal)
      await vi.waitFor(() => expect(f.queries).toHaveLength(1))
      const query = f.queries[0]!
      const message = (await query.messages.next()).value!
      await query.frames.offer({ type: 'system', subtype: 'init', session_id: 'native-session',
        claude_code_version: '2.1.284', cwd: runtimeDirectory })
      const text = 'é'.repeat(24_010)
      await query.frames.offer(f.frame({ type: 'assistant', uuid: 'truncated-answer', message: { id: 'answer',
        content: [{ type: 'text', text }] } }, message.uuid))
      await query.frames.offer(f.frame({ type: 'result', uuid: 'terminal', subtype: 'success', is_error: false, result: 'done' }, message.uuid))
      await waitFor(async () => !(await chat.get(conversation.id, writer.principal)).activeRequestId)
      const truncation = { truncated: true, originalBytes: Buffer.byteLength(text) }
      const stored = (await pool.query("select record from operator_conversation_messages where conversation_id=$1 and role='assistant'",
        [conversation.id])).rows[0]?.record
      expect(stored).toMatchObject({ content: 'é'.repeat(24_000), truncation })
      const deniedHttp = await app.inject({ method: 'GET', url: `/api/operator/conversations/${conversation.id}`,
        headers: { authorization: `Bearer ${reader.token}` } })
      expect(deniedHttp.statusCode).toBe(404)
      const deniedMcp = await graphRpc(app, reader.token, 'tools/call', {
        name: 'operator_chat_get', arguments: { conversationId: conversation.id },
      })
      expect(deniedMcp.result?.isError).toBe(true)
      const http = await app.inject({ method: 'GET', url: `/api/operator/conversations/${conversation.id}` })
      expect(http.statusCode).toBe(200)
      expect(http.json().messages).toContainEqual(expect.objectContaining({ content: stored.content, truncation }))
      const mcp = await graphRpc(app, writer.token, 'tools/call', { name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
      expect(mcp.result?.isError).not.toBe(true)
      expect((graphRpcValue(mcp.result) as OperatorConversationState).messages)
        .toContainEqual(expect.objectContaining({ content: stored.content, truncation }))
      expect(streamed).toContainEqual(expect.objectContaining({ activityChange: expect.objectContaining({
        change: expect.objectContaining({ text: stored.content, truncation }),
      }) }))
    } finally { unsubscribe(); await app.close(); await f.manager.dispose?.() }
  })

  it('persists the bounded prefix and terminal result after message storage pauses both event queues', async () => {
    const harness = { harness: 'claude' as const, model: 'fixture', authMode: 'subscription' as const,
      configDirectory: '/profile', permissionMode: 'default' as const, sandbox: 'read-only' as const,
      tools: ['Read'], permissionRules: [], instructions: '', mcpServers: {} }
    await operators.update(harness, (await operators.ensure()).configuration.id)
    const f = createStreamFixture({ outputCapacity: 2, workingDirectory: runtimeDirectory })
    chat = new OperatorChatService(repository, operators, () => f.manager, runtimeDirectory, authority)
    const conversation = await chat.create(owner)
    let resume!: () => void
    const paused = new Promise<void>(resolve => { resume = resolve })
    let blocked = false
    const save = repository.appendAssistantTextOperation.bind(repository)
    const storage = vi.spyOn(repository, 'appendAssistantTextOperation').mockImplementation(async (...args) => {
      if (!blocked) {
        blocked = true
        await paused
      }
      return save(...args)
    })
    try {
      await chat.send(conversation.id, { requestId: 'bounded-stream', content: 'Stream text' }, owner)
      await vi.waitFor(() => expect(f.queries).toHaveLength(1))
      const query = f.queries[0]!
      const message = (await query.messages.next()).value!
      await query.frames.offer({ type: 'system', subtype: 'init', session_id: 'native-session',
        claude_code_version: '2.1.284', cwd: runtimeDirectory })
      const prefix = 'é'.repeat(24000)
      await query.frames.offer(f.frame({ type: 'assistant', uuid: 'public-parts', message: { id: 'public-message',
        content: [{ type: 'text', text: prefix + 'tail' },
          ...Array.from({ length: 299 }, (_, index) => ({ type: 'text', text: `part-${index}` }))] } }, message.uuid))
      let finished = false
      const producer = (async () => {
        for (let index = 0; index < 10; index++) {
          await query.frames.offer(f.frame({ type: 'assistant', uuid: `next-${index}`,
            message: { id: 'public-message', content: [{ type: 'text', text: `next-${index}` }] } }, message.uuid))
        }
        await query.frames.offer(f.frame({ type: 'result', uuid: 'native-terminal', subtype: 'success',
          is_error: false, result: 'done' }, message.uuid))
        finished = true
      })()
      await vi.waitFor(() => {
        expect(blocked).toBe(true)
        expect(query.reads).toBeGreaterThanOrEqual(4)
      })
      expect(query.reads).toBeLessThanOrEqual(5)
      expect(finished).toBe(false)
      expect(query.closed).toBe(false)
      expect(await repository.submittedMessageId(conversation.id, 'bounded-stream')).toBe(message.uuid)
      resume()
      await producer
      await vi.waitFor(async () => expect((await chat.get(conversation.id, owner)).turnState).toBe('idle'),
        { timeout: 30000 })
      let page = await chat.history(conversation.id, owner, { limit: 100 })
      const messages = page.entries.map(entry => entry.message)
      while (page.nextCursor) {
        page = await chat.history(conversation.id, owner, { limit: 100, before: page.nextCursor })
        messages.push(...page.entries.map(entry => entry.message))
      }
      expect(messages.some(item => item.role === 'assistant' && item.content === prefix)).toBe(true)
      const result = await pool.query('select result,payload from operator_conversation_turns where conversation_id=$1 and request_id=$2',
        [conversation.id, 'bounded-stream'])
      expect(result.rows[0]?.result).toEqual({ outcome: 'succeeded', output: 'done' })
      expect(result.rows[0]?.payload.nativeSubmission.nativeMessageId).toBe(message.uuid)
    } finally {
      resume()
      storage.mockRestore()
      await f.manager.dispose?.()
    }
  }, 30000)
})
