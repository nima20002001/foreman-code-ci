import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, expect, it, vi } from 'vitest'
import { OperatorChatService, type NativeManagerResolver } from '../src/modules/conversations/operatorChat.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { buildApp } from '../src/app.js'
import { createClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { ChatManager, registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL
const nativeFailure = { outcome: 'failed' as const, error: { code: 'CLAUDE_NATIVE_RESULT_ERROR',
  message: 'Recorded native failure.', retryable: false } }

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

function settlingClaude() {
  const prompts: string[] = []
  const managers: ReturnType<typeof createClaudeNativeSessionManager>[] = []
  const persistedMessages: unknown[] = []
  let frames: ClaudeBoundedQueue<unknown>
  let promptUuid: string
  let closed = 0
  let failClosure = false
  const sdk: ClaudeSdkClient = {
    sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async () => persistedMessages, forkSession: async () => ({ sessionId: 'unused-fork' }),
    query(input) {
      const output = new ClaudeBoundedQueue<unknown>(64)
      frames = output
      if (input.options.resume) void output.offer({ type: 'system', subtype: 'init', session_id: 'settling-session',
        claude_code_version: '2.1.284', cwd: runtimeDirectory })
      void (async () => {
        for await (const message of input.prompt) {
          prompts.push(message.message.content)
          promptUuid = message.uuid
          persistedMessages.push({ type: 'user', uuid: message.uuid, session_id: 'settling-session', parent_tool_use_id: null })
          void output.offer({ type: 'system', subtype: 'init', session_id: 'settling-session',
            claude_code_version: '2.1.284', cwd: runtimeDirectory })
          const reply = { type: 'assistant', uuid: `reply:${message.uuid}`, session_id: 'settling-session',
            parent_tool_use_id: null, user_message_uuid: message.uuid,
            message: { id: `answer:${message.uuid}`, content: [{ type: 'text', text: 'Text alone is not completion.' }] } }
          persistedMessages.push(reply)
          void output.offer(reply)
        }
      })().catch(error => output.close(error))
      return { [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](), close: () => output.close(),
        joinClosed: async () => {
          if (failClosure) throw new Error('Native closure unavailable')
          closed++
        },
        initializationResult: async () => ({}), mcpServerStatus: async () => [],
        setMcpServers: async () => ({ added: [], removed: [], errors: {} }), interrupt: async () => undefined }
    },
  }
  const manager = () => {
    const created = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => sdk }),
      scope: { deviceId: 'main', profilePath: '/synthetic/profile', configRevision: '1', cwd: runtimeDirectory },
      sdkOptions: {}, qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true,
        resume: true, fork: false, history: true } })
    managers.push(created)
    return created
  }
  return { manager, managers, prompts, closed: () => closed,
    failClosure: (value: boolean) => { failClosure = value },
    result: () => frames.offer({ type: 'result', uuid: `result:${promptUuid}`, session_id: 'settling-session',
      user_message_uuid: promptUuid, subtype: 'error_during_execution', is_error: true, errors: ['Recorded native failure.'] }) }
}

async function configureSettlingClaude(claude: ReturnType<typeof settlingClaude>) {
  await operators.update({ harness: 'claude', model: 'synthetic-claude', authMode: 'subscription',
    configDirectory: '/synthetic/profile', permissionMode: 'default', sandbox: 'danger-full-access',
    tools: [], permissionRules: [], instructions: '',
    mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:3050/mcp' } } },
  (await operators.ensure()).configuration.id)
  chat = new OperatorChatService(repository, operators, claude.manager, runtimeDirectory, authority)
}

async function startSettlingClaude(claude: ReturnType<typeof settlingClaude>) {
  await configureSettlingClaude(claude)
  const conversation = await chat.create(owner)
  await chat.send(conversation.id, { requestId: 'terminal-request', content: 'Run once.' }, owner)
  await waitFor(async () => Boolean(await repository.submittedMessageId(conversation.id, 'terminal-request')))
  return conversation
}

describe.skipIf(!connectionString)('Operator failed-turn terminal persistence', () => {
  it('finishes a successful turn after retirement releases its exited runtime and cold resumes the following turn', async () => {
    const manager = Object.assign(new ChatManager(), {
      retireTurn: async () => ({ runtimeReleased: true as const }),
    })
    chat = new OperatorChatService(repository, operators, () => manager, runtimeDirectory, authority)
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'saved-result', content: 'First task' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const saved = await pool.query(`select native_closure_state as "closureState" from operator_conversation_turns
      where conversation_id=$1 and request_id=$2`, [conversation.id, 'saved-result'])
    expect(saved.rows).toEqual([{ closureState: 'closed' }])
    expect(manager.disposals).toBe(1)
    await chat.send(conversation.id, { requestId: 'following-result', content: 'Following task' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    expect(manager.attachments).toBe(1)
    expect(manager.sessions).toBe(1)
    expect(manager.turns).toBe(2)
  })

  it('recovers a pre-query profile failure after restart without inventing process closure', async () => {
    const claude = settlingClaude()
    await configureSettlingClaude(claude)
    const conversation = await chat.create(owner)
    const allocation = claude.manager()
    const resolver: NativeManagerResolver = () => allocation
    const closeOwner = vi.fn<NonNullable<NativeManagerResolver['closeRecoveredRuntime']>>(async () => false)
    resolver.closeRecoveredRuntime = closeOwner
    const preparing = { ...authority, prepare: async () => { throw new Error('Profile admission failed before query') } }
    chat = new OperatorChatService(repository, operators, resolver, runtimeDirectory, preparing)
    const fault = vi.spyOn(repository, 'closurePending').mockRejectedValue(new Error('Crash after saving setup failure'))
    const previous = chat
    try {
      await chat.send(conversation.id, { requestId: 'setup-failure', content: 'Start once' }, owner)
      await waitFor(async () => Boolean(await repository.terminal(conversation.id, 'setup-failure')))
      expect((await repository.terminal(conversation.id, 'setup-failure'))?.observation.requiresRuntimeClosure).toBe(false)
      expect(allocation.requiresRuntimeClosure!()).toBe(false)
      fault.mockRestore()
      chat = new OperatorChatService(repository, operators, resolver, runtimeDirectory, authority)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBeNull()
      expect((await chat.get(conversation.id, owner)).lastResult?.outcome).toBe('failed')
      expect(closeOwner).not.toHaveBeenCalled()
      expect(claude.prompts).toEqual([])
    } finally { fault.mockRestore(); await previous.shutdown() }
  })

  it.each(['journalTerminal', 'closurePending', 'closureProven', 'finish'] as const)(
    'recovers a failed %s without replaying the native prompt', async method => {
      const claude = settlingClaude()
      const conversation = await startSettlingClaude(claude)
      const finish = repository.finish.bind(repository)
      const fault = vi.spyOn(repository, method).mockRejectedValue(new Error(`Failed ${method}`))
      try {
        void claude.result()
        await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
        const terminal = await repository.terminal(conversation.id, 'terminal-request')
        expect(terminal?.closureState).toBe({ journalTerminal: undefined, closurePending: 'observed',
          closureProven: 'pending', finish: 'closed' }[method])
        expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
        expect(claude.closed()).toBe(['closureProven', 'finish'].includes(method) ? 1 : 0)
        if (terminal) {
          expect(terminal.observation.result).toEqual(nativeFailure)
          await expect(finish(conversation.id, 'terminal-request', { outcome: 'canceled' }))
            .rejects.toMatchObject({ code: 'OPERATOR_CLOSURE_PENDING' })
        }
        fault.mockRestore()
        if (method === 'finish') {
          chat = new OperatorChatService(repository, operators, claude.manager, runtimeDirectory, authority)
        }
        await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
        expect((await chat.get(conversation.id, owner)).lastResult).toEqual(nativeFailure)
        expect(claude.prompts).toEqual(['Run once.'])
        expect(claude.managers).toHaveLength(1)
        expect(claude.closed()).toBe(1)
      } finally { fault.mockRestore() }
    }, 30_000)

  it('keeps the terminal saved and the request fenced while native closure fails', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    claude.failClosure(true)
    try {
      void claude.result()
      await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
      expect((await repository.terminal(conversation.id, 'terminal-request'))?.closureState).toBe('pending')
      expect((await chat.get(conversation.id, owner)).lastResult).toBeUndefined()
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
      claude.failClosure(false)
      await waitFor(async () => { await chat.reconcileActive(); return !(await chat.get(conversation.id, owner)).activeRequestId })
      expect(claude.prompts).toEqual(['Run once.'])
      expect(claude.closed()).toBe(1)
    } finally { claude.failClosure(false) }
  })

  it.each(['closurePending', 'nativeClosure', 'closureProven'] as const)(
    'does not fabricate old-runtime closure after a restart at %s', async method => {
      const claude = settlingClaude()
      const conversation = await startSettlingClaude(claude)
      const fault = method === 'nativeClosure' ? undefined
        : vi.spyOn(repository, method).mockRejectedValue(new Error('Server stopped'))
      if (method === 'nativeClosure') claude.failClosure(true)
      const previous = chat
      try {
        void claude.result()
        await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
        fault?.mockRestore()
        chat = new OperatorChatService(repository, operators, claude.manager, runtimeDirectory, authority)
        await chat.reconcileActive()
        const state = await chat.get(conversation.id, owner)
        expect(state.activeRequestId).toBe('terminal-request')
        expect(state.turnState).toBe('uncertain')
        expect(state.lastResult).toBeUndefined()
        expect((await repository.terminal(conversation.id, 'terminal-request'))?.observation.result.outcome).toBe('failed')
        expect(claude.prompts).toEqual(['Run once.'])
        expect(claude.managers).toHaveLength(1)
      } finally { fault?.mockRestore(); claude.failClosure(false); await previous.shutdown() }
    })

  it('does not reconstruct a terminal from assistant text after a crash before journaling', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    const fault = vi.spyOn(repository, 'journalTerminal').mockRejectedValue(new Error('Server stopped before journal'))
    const previous = chat
    try {
      void claude.result()
      await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
      fault.mockRestore()
      chat = new OperatorChatService(repository, operators, claude.manager, runtimeDirectory, authority)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
      expect((await chat.get(conversation.id, owner)).lastResult).toBeUndefined()
      expect(await repository.terminal(conversation.id, 'terminal-request')).toBeUndefined()
      expect(claude.prompts).toEqual(['Run once.'])
    } finally { fault.mockRestore(); await previous.shutdown() }
  }, 30_000)

  it('recovers a saved native result only after the original process owner confirms closure', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    const fault = vi.spyOn(repository, 'closureProven').mockRejectedValue(new Error('Closure write unavailable'))
    const previous = chat
    try {
      void claude.result()
      await waitFor(async () => (await repository.active(conversation.id))?.turn_state === 'uncertain')
      expect(claude.closed()).toBe(1)
      fault.mockRestore()
      const resolver: NativeManagerResolver = claude.manager
      const closeOwner = vi.fn<NonNullable<NativeManagerResolver['closeRecoveredRuntime']>>(async () => false)
      resolver.closeRecoveredRuntime = closeOwner
      chat = new OperatorChatService(repository, operators, resolver, runtimeDirectory, authority)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
      expect((await repository.terminal(conversation.id, 'terminal-request'))?.closureState).toBe('pending')
      closeOwner.mockImplementation(async id => id === conversation.id && claude.closed() === 1)
      await chat.reconcileActive()
      expect((await chat.get(conversation.id, owner)).lastResult).toEqual(nativeFailure)
      expect((await chat.get(conversation.id, owner)).activeRequestId).toBeNull()
      expect(closeOwner).toHaveBeenCalledWith(conversation.id, expect.any(AbortSignal))
      expect(claude.managers).toHaveLength(1)
      expect(claude.prompts).toEqual(['Run once.'])
    } finally { fault.mockRestore(); await previous.shutdown() }
  })

  it('requires saved terminal and closure before native settlement through the repository', async () => {
    const claude = settlingClaude()
    const conversation = await startSettlingClaude(claude)
    await expect(repository.finish(conversation.id, 'terminal-request', { outcome: 'succeeded', output: 'Guess' }))
      .rejects.toMatchObject({ code: 'OPERATOR_CLOSURE_PENDING' })
    expect((await chat.get(conversation.id, owner)).activeRequestId).toBe('terminal-request')
    void claude.result()
    await waitFor(async () => !(await chat.get(conversation.id, owner)).activeRequestId)
  })

  it('recovers final persistence through authenticated MCP without granting a reader write access', async () => {
    const claude = settlingClaude()
    await configureSettlingClaude(claude)
    const writer = await access.issue({ name: 'terminal writer', audience: 'operator',
      grants: [{ actions: ['operator_chat:read', 'operator_chat:write', 'harnesses:read'], scope: {} }],
      expiresAt: new Date(Date.now() + 60_000) })
    const reader = await access.issue({ name: 'terminal reader', audience: 'operator',
      grants: [{ actions: ['operator_chat:read'], scope: {} }], expiresAt: new Date(Date.now() + 60_000) })
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
      operator: { access, services: { operatorChat: chat,
        commands: new PostgresCommandCoordinator(pool) } as unknown as OperatorServices } })
    const clients: Client[] = []
    const fault = vi.spyOn(repository, 'finish').mockRejectedValue(new Error('Final persistence unavailable'))
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'terminal-test', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
        return client
      }
      const allowed = await connect(writer.token)
      const denied = await connect(reader.token)
      const created = await allowed.callTool({ name: 'operator_chat_create', arguments: { commandId: randomUUID() } })
      expect(created.isError, JSON.stringify(created)).not.toBe(true)
      const conversationId = (decodeMcpToolResult(created) as { conversation: { id: string } }).conversation.id
      const input = { requestId: 'mcp-terminal-request', content: 'Run once.' }
      const send = { name: 'operator_chat_send', arguments: { conversationId, request: input } }
      expect((await denied.listTools()).tools.map(tool => tool.name)).not.toContain('operator_chat_send')
      await expectMcpAccessDenied(denied.callTool(send))
      expect(claude.prompts).toHaveLength(0)
      expect((await allowed.callTool(send)).isError).not.toBe(true)
      await waitFor(async () => Boolean(await repository.submittedMessageId(conversationId, input.requestId)))
      void claude.result()
      await waitFor(async () => (await repository.active(conversationId))?.turn_state === 'uncertain')
      const get = () => allowed.callTool({ name: 'operator_chat_get', arguments: { conversationId } })
      expect(decodeMcpToolResult((await get()))).toMatchObject({ activeRequestId: input.requestId, turnState: 'uncertain' })
      expect((await repository.terminal(conversationId, input.requestId))?.closureState).toBe('closed')
      expect(decodeMcpToolResult((await allowed.callTool(send)))).toMatchObject({ replayed: true })
      fault.mockRestore()
      await waitFor(async () => { await chat.reconcileActive(); return !(await repository.active(conversationId))?.active_request_id })
      expect(decodeMcpToolResult((await get()))).toMatchObject({ activeRequestId: null,
        lastResult: nativeFailure })
      const persisted = (await pool.query('select result from operator_conversation_turns where conversation_id=$1 and request_id=$2',
        [conversationId, input.requestId])).rows[0]?.result
      expect(persisted).toEqual(nativeFailure)
      expect(claude.prompts).toEqual(['Run once.'])
      expect(claude.managers).toHaveLength(1)
    } finally {
      fault.mockRestore()
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
    }
  }, 30_000)
})
