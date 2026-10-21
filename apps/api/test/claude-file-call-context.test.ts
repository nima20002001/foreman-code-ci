import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { createClaudeFileCallResolver } from '../src/modules/files/claude/callResolver.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'
import { createClaudeSdkRunner } from '../src/modules/harnesses/claudeSdk/runner.js'
import { createClaudeNativeSessionManager } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { ClaudeMessageTurnInput } from '../src/modules/harnesses/claudeSdk/sessionManager.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from '../src/modules/harnesses/claudeSdk/port.js'

const Frame = z.object({ type: z.string(), parent_tool_use_id: z.string().optional(),
  message: z.object({ id: z.string(), content: z.array(z.object({ id: z.string() }).passthrough()) }).optional(),
}).passthrough()

async function nativeFixture() {
  const frames = new ClaudeBoundedQueue<unknown>(32)
  let messages: AsyncIterator<ClaudeSdkUserMessage> | undefined
  const client: ClaudeSdkClient = { sdkVersion: '0.3.284', query: input => {
    messages = input.prompt[Symbol.asyncIterator]()
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => undefined,
      close: () => frames.close(), initializationResult: async () => ({}), mcpServerStatus: async () => [] }
  }, getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'unused' }) }
  const manager = createClaudeNativeSessionManager({ runner: createClaudeSdkRunner({ loadClient: async () => client }),
    scope: { deviceId: 'main', profilePath: '/profile', configRevision: 'revision', cwd: '/work' }, sdkOptions: {},
    qualification: { sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: true, history: true },
    decodeFactory: () => raw => {
      const frame = Frame.parse(raw)
      return frame.type === 'assistant' && frame.message?.content[0] ? [{ type: 'claude.tool', payload: {
        toolUseId: frame.message.content[0].id, messageId: frame.message.id,
        ...(frame.parent_tool_use_id ? { parentToolUseId: frame.parent_tool_use_id } : {}),
      } }] : []
    } })
  const configuration = OperatorConfigurationVersionSchema.parse({ id: 'version', operatorId: 'operator', version: 1,
    contentHash: 'sha256:fixture', createdAt: '2026-10-01T00:00:00.000Z', harness: {
      harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/profile',
      permissionMode: 'default', sandbox: 'read-only', tools: [], permissionRules: [], instructions: '', mcpServers: {},
    } })
  const session = await manager.attachSession({ harness: manager.harness, providerVersion: '2.1.284', nativeSessionId: 'observed-session' },
    { kind: 'operator', correlationId: 'owner', configuration, workingDirectory: '/work' })
  let admit!: () => void
  const persisted = new Promise<void>(resolve => { admit = resolve })
  const submitted = vi.fn(async () => persisted)
  const turn: ClaudeMessageTurnInput = { prompt: 'files', clientCorrelationId: 'accepted-request',
    callbackAuthority: { ownerPrincipalId: 'accepted-sender', attemptId: 'accepted-attempt' },
    onMessageSubmitted: submitted }
  const output = manager.startTurn(session, turn)[Symbol.asyncIterator]()
  const firstEvent = output.next()
  await vi.waitFor(() => expect(messages).toBeDefined())
  const message = (await messages!.next()).value!
  void frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId, claude_code_version: '2.1.284', cwd: '/work' })
  const lifetime = new AbortController()
  const resolver = createClaudeFileCallResolver({ manager: () => manager, signal: lifetime.signal })
  const extra = (toolUseId: string, signal = new AbortController().signal) => ({ signal, _meta: { 'claudecode/toolUseId': toolUseId } })
  return { manager, frames, session, message, admit, firstEvent, output, lifetime, resolver, extra, submitted }
}

describe('Claude file resolver with real native owner map', () => {
  it('waits for persisted positive ACK, resolves root identity, and denies child and terminal contexts', async () => {
    const f = await nativeFixture()
    try {
      const resolution = f.resolver.resolve('files.read', f.extra('root-tool'))
      const resolved = vi.fn()
      void resolution.then(resolved)
      void f.frames.offer({ type: 'assistant', session_id: f.session.nativeSessionId, uuid: 'root-frame',
        user_message_uuid: f.message.uuid, message: { id: 'root-api', content: [{ type: 'tool_use', id: 'root-tool', name: 'Read', input: {} }] } })
      await vi.waitFor(() => expect(f.submitted).toHaveBeenCalledOnce())
      expect(resolved).not.toHaveBeenCalled()
      expect(f.manager.nativeCallbackContext(f.session.nativeSessionId, 'root-tool')).toBeUndefined()
      f.admit()
      await f.firstEvent
      const identity = await resolution
      expect(identity).toMatchObject({ nativeSessionId: f.session.nativeSessionId, nativeMessageId: f.message.uuid,
        clientCorrelationId: 'accepted-request', ownerPrincipalId: 'accepted-sender', attemptId: 'accepted-attempt', toolUseId: 'root-tool' })
      await f.output.next()
      void f.frames.offer({ type: 'assistant', session_id: f.session.nativeSessionId, uuid: 'child-frame', parent_tool_use_id: 'root-tool',
        message: { id: 'child-api', content: [{ type: 'tool_use', id: 'child-tool', name: 'Read', input: {} }] } })
      await f.output.next()
      expect(f.manager.nativeCallbackContext(f.session.nativeSessionId, 'child-tool')).toBeUndefined()
      void f.frames.offer({ type: 'result', session_id: f.session.nativeSessionId, uuid: 'native-result', user_message_uuid: f.message.uuid,
        subtype: 'success', is_error: false, result: 'done' })
      await f.output.next()
      expect(f.manager.nativeCallbackContext(f.session.nativeSessionId, 'root-tool')).toBeUndefined()
      const afterTerminal = f.resolver.resolve('files.read', f.extra('root-tool', f.lifetime.signal))
      f.lifetime.abort()
      expect(await afterTerminal).toBeUndefined()
    } finally { f.admit(); f.lifetime.abort(); await f.manager.dispose?.() }
  })

  it('rejects inherited metadata, wrong types and transport IDs without native ownership lookup', async () => {
    const manager = { waitNativeCallbackContext: vi.fn(), nativeCallbackContext: vi.fn(), callbackAuthority: vi.fn() }
    const signal = new AbortController().signal
    const resolver = createClaudeFileCallResolver({ manager: () => manager, signal })
    for (const extra of [undefined, { signal, requestId: 'native-tool', sessionId: 'native-session' },
      { signal, _meta: { 'claudecode/toolUseId': 1 } },
      { signal, _meta: Object.create({ 'claudecode/toolUseId': 'inherited' }) },
      Object.create({ signal, _meta: { 'claudecode/toolUseId': 'inherited' } })]) {
      expect(await resolver.resolve('files.read', extra)).toBeUndefined()
    }
    expect(manager.waitNativeCallbackContext).not.toHaveBeenCalled()
  })
})
