import { randomUUID } from 'node:crypto'
import { managedProviderEnvironment, resolveRuntimeProviderAccount } from '../providerAccountRuntime.js'
import { describe, expect, it, vi } from 'vitest'
import { getSessionMessages, type SessionStore } from '@anthropic-ai/claude-agent-sdk'
import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import type { NativeSessionStart } from '../port.js'
import { ClaudeInteractionBridge, type ClaudeCallbackIdentity } from './interactions.js'
import { claudeNativeEvent } from './nativeEvents.js'
import { createClaudeEventNormalizer } from './normalization.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from './port.js'
import { ClaudeBoundedQueue } from './queue.js'
import { createClaudeSdkRunner } from './runner.js'
import { createClaudeSdkCallbacks } from './sdkCallbacks.js'
import { memoryClaudeCallbackJournal } from '../../../../test/support/claudeCallbackJournal.js'
import {
  claudePromptUuid, createClaudeNativeSessionManager, type ClaudeMessageTurnInput,
} from './sessionManager.js'

const scope = { deviceId: 'device', profilePath: '/profile', configRevision: 'revision', cwd: '/work' }
const qualification = {
  sdkVersion: '0.3.284', cliVersion: '2.1.284', basicTurns: true, resume: true, fork: false, history: true,
}
const start = {
  kind: 'operator', correlationId: 'first-request', configuration: {}, workingDirectory: scope.cwd,
} as NativeSessionStart
const saved: NativeSessionReference = {
  harness: 'claude', providerVersion: qualification.cliVersion, nativeSessionId: 'native-session',
}
const configuration: ClaudeHarnessConfiguration = {
  harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: scope.profilePath,
  permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'], permissionRules: [],
  instructions: '', mcpServers: {},
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function drain(events: AsyncIterable<NativeHarnessEvent>) {
  const result: NativeHarnessEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

function fixture(sdkOptions: Record<string, unknown> = {}, nativeSession = saved) {
  let frames = new ClaudeBoundedQueue<unknown>(32)
  let queryCount = 0
  const receipts = new Map<string, string>()
  const validate = vi.fn(async (identity: ClaudeCallbackIdentity) => {
    expect(identity.ownerPrincipalId).toBe('sender')
    expect(identity.attemptId).toBe(identity.clientCorrelationId)
    expect(identity.nativeMessageId).toBe(receipts.get(identity.clientCorrelationId!))
    expect(identity.nativeSessionId).toBe(nativeSession.nativeSessionId)
  })
  const bridge = new ClaudeInteractionBridge(configuration, {
    callbackJournal: memoryClaudeCallbackJournal(),
    validate,
    request: async () => ({ outcome: 'allow_once' }),
    validateResponse: async identity => validate(identity),
  })
  const callbacks = createClaudeSdkCallbacks({ manager: () => manager, bridge })
  let messages: AsyncIterator<ClaudeSdkUserMessage>
  let ready!: () => void
  const opened = new Promise<void>(resolve => { ready = resolve })
  const close = vi.fn(() => undefined)
  const query = vi.fn<ClaudeSdkClient['query']>(input => {
    if (queryCount++ > 0) frames = new ClaudeBoundedQueue<unknown>(32)
    const output = frames
    messages = input.prompt[Symbol.asyncIterator]()
    ready()
    void frames.offer({ type: 'system', subtype: 'init', session_id: nativeSession.nativeSessionId,
      claude_code_version: qualification.cliVersion, cwd: scope.cwd })
    return {
      [Symbol.asyncIterator]: () => output[Symbol.asyncIterator](),
      interrupt: async () => undefined, initializationResult: async () => ({}),
      close: () => { close(); output.close() },
    }
  })
  const transcript: unknown[] = []
  const client: ClaudeSdkClient = {
    sdkVersion: qualification.sdkVersion, query, getSessionInfo: async sessionId => ({ sessionId }),
    getSessionMessages: async (_sessionId, page) => transcript.slice(page.offset, (page.offset ?? 0) + (page.limit ?? 256)), forkSession: async () => ({ sessionId: 'unused' }),
  }
  const runner = createClaudeSdkRunner({ loadClient: async () => client })
  const offers = vi.fn()
  const open = runner.open
  runner.open = async input => {
    const session = await open(input)
    const offer = session.offer
    session.offer = (message, signal) => {
      offers(message)
      return offer(message, signal)
    }
    return session
  }
  const manager = createClaudeNativeSessionManager({
    runner, scope, sdkOptions: { ...sdkOptions, ...callbacks }, qualification,
    cancelPendingRequests: () => bridge.cancelPendingRequests(),
    decodeFactory() {
      const normalizer = createClaudeEventNormalizer({
        owner: { ownerId: 'sender', attemptId: 'conversation', generation: 'fixture' },
        observedAt: () => '2026-10-04T00:00:00.000Z',
      })
      return raw => normalizer.ingest(raw).map(event => claudeNativeEvent(event, 0))
    },
  })
  const input = (correlationId: string, prompt = 'Read files'): ClaudeMessageTurnInput => ({
    clientCorrelationId: correlationId, prompt,
    callbackAuthority: { ownerPrincipalId: 'sender', attemptId: correlationId },
    onMessageSubmitted: async receipt => { receipts.set(correlationId, receipt.nativeMessageId) },
  })
  const nextMessage = async () => {
    await opened
    const message = (await messages.next()).value!
    transcript.push({ ...message, session_id: nativeSession.nativeSessionId })
    return message
  }
  const assistant = (id: string, content: unknown[], promptUuid?: string) => {
    const frame = {
    type: 'assistant', session_id: nativeSession.nativeSessionId, uuid: `frame-${id}`, parent_tool_use_id: null,
    message: { id, content }, ...(promptUuid ? { user_message_uuid: promptUuid } : {}),
    }
    if (!promptUuid || promptUuid === (transcript.findLast(entry => (entry as { type: string }).type === 'user') as { uuid: string })?.uuid) transcript.push(frame)
    return frames.offer(frame)
  }
  const result = (promptUuid: string, extra: Record<string, unknown> = {}) => frames.offer({
    type: 'result', session_id: nativeSession.nativeSessionId, uuid: `result-${promptUuid}`,
    user_message_uuid: promptUuid, subtype: 'success', is_error: false, result: 'done', ...extra,
  })
  return { get frames() { return frames }, client, manager, callbacks, bridge, validate, close, query, offers, input,
    nextMessage, assistant, result, transcript }
}

describe('Claude response ownership through SDK callbacks', () => {
  it('retires settled turn resources across rollover and rejects an evicted input using persisted history', async () => {
    const f = fixture()
    try {
      let session = await f.manager.attachSession(saved, start)
      for (let index = 0; index < 300; index++) {
        session = await f.manager.attachSession(session, start)
        const correlationId = `settled-${index}`
        const output = drain(f.manager.startTurn(session, f.input(correlationId)))
        const message = await f.nextMessage()
        await f.assistant(`answer-${index}`, [{ type: 'text', text: 'settled answer' }], message.uuid)
        await f.result(message.uuid)
        await output
        await f.manager.retireTurn!(session, correlationId)
        const history = await f.manager.reconcile(session, correlationId)
        expect(history.terminalResult).toBeUndefined()
        expect(history.nativeSubmission?.nativeMessageId).toBe(message.uuid)
      }
      expect(f.query).toHaveBeenCalledTimes(2)
      const replay = drain(f.manager.startTurn(session, f.input('settled-0')))
      await expect(replay).rejects.toThrow('already submitted')
      expect(f.offers).toHaveBeenCalledTimes(300)
      const resumedHistory = await f.manager.reconcile(session, 'settled-0')
      expect(resumedHistory.nativeSubmission?.nativeMessageId).toBe(claudePromptUuid('settled-0'))
      expect(resumedHistory.terminalResult).toBeUndefined()
    } finally { await f.manager.dispose?.() }
  }, 30_000)

  it('keeps tool callbacks and replies owned through a parent-linked compaction summary', async () => {
    const nativeSession = { ...saved, nativeSessionId: '0d60d9a0-e091-4bdb-b63f-8ed8f761720c' }
    const f = fixture({}, nativeSession)
    const sessionStore: SessionStore = {
      append: async () => {},
      load: async () => f.transcript.map((raw, index) => {
        const row = raw as Record<string, unknown>
        return { ...row, type: String(row.type), uuid: String(row.uuid), sessionId: row.session_id,
          parentUuid: row.parentUuid ?? (index ? (f.transcript[index - 1] as { uuid: string }).uuid : null) }
      }),
    }
    f.client.getSessionMessages = (id, page) => getSessionMessages(id, { ...page, sessionStore })
    try {
      const session = await f.manager.attachSession(nativeSession, start)
      const output = drain(f.manager.startTurn(session, f.input('compacted')))
      const message = await f.nextMessage()
      await f.assistant('before-compaction', [{ type: 'text', text: 'Before compaction' }], message.uuid)
      f.transcript.push({ type: 'user', uuid: 'compact-summary', session_id: session.nativeSessionId,
        parent_tool_use_id: null, parentUuid: 'frame-before-compaction', isCompactSummary: true,
        message: { role: 'user', content: 'Summary of earlier context' } })
      f.transcript.push({ type: 'assistant', uuid: 'frame-after-compaction', session_id: session.nativeSessionId,
        parent_tool_use_id: null, parentUuid: 'compact-summary', message: { id: 'after-compaction' } })
      const permission = f.callbacks.canUseTool!('Read', { file_path: '/work/file' }, {
        signal: new AbortController().signal, toolUseID: 'compacted-tool', requestId: 'compacted-control',
      })
      await f.frames.offer({ type: 'assistant', uuid: 'frame-after-compaction', session_id: session.nativeSessionId,
        parent_tool_use_id: null, message: { id: 'after-compaction', content: [
          { type: 'tool_use', id: 'compacted-tool', name: 'Read', input: { file_path: '/work/file' } },
        ] } })
      expect(await permission).toMatchObject({ behavior: 'allow' })
      f.transcript.push({ type: 'assistant', uuid: 'frame-final-compacted', session_id: session.nativeSessionId,
        parent_tool_use_id: null, parentUuid: 'frame-after-compaction', message: { id: 'final-compacted' } })
      await f.frames.offer({ type: 'assistant', uuid: 'frame-final-compacted', session_id: session.nativeSessionId,
        parent_tool_use_id: null, message: { id: 'final-compacted', content: [{ type: 'text', text: 'After compaction' }] } })
      await f.result(message.uuid)
      expect((await output).find(event => event.payload.text === 'After compaction')?.payload.clientCorrelationId)
        .toBe('compacted')
      expect(f.validate.mock.calls.some(([identity]) => identity.toolUseId === 'compacted-tool'
        && identity.nativeMessageId === message.uuid)).toBe(true)
    } finally { await f.manager.dispose?.() }
  })

  it('owns distinct tool-round messages while preserving delayed older and foreign event identities', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      const old = drain(f.manager.startTurn(session, f.input('older')))
      const oldMessage = await f.nextMessage()
      void f.assistant('older-reply', [{ type: 'text', text: 'older' }], oldMessage.uuid)
      void f.result(oldMessage.uuid)
      await old

      const output = drain(f.manager.startTurn(session, f.input('request')))
      const message = await f.nextMessage()
      const signal = new AbortController().signal
      const permission = (toolUseID: string) => f.callbacks.canUseTool!('Read', { file_path: '/work/file' }, {
        signal, toolUseID, requestId: `control-${toolUseID}`,
      })
      const first = permission('tool-1')
      void f.assistant('A1', [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/work/file' } }], message.uuid)
      expect(await first).toMatchObject({ behavior: 'allow' })
      void f.frames.offer({ type: 'user', session_id: session.nativeSessionId, uuid: 'tool-result-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file' }] } })
      // A previously owned API message can arrive during the new response without moving its boundary.
      void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'late-older',
        message: { id: 'older-reply', content: [{ type: 'text', text: 'late older' }] } })
      void f.assistant('new-older-id', [{ type: 'text', text: 'late echoed older' }], oldMessage.uuid)
      // This unseen delayed frame has no native ancestry and must never inherit the new request.
      void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'unknown-delayed',
        message: { id: 'unknown-delayed', content: [{ type: 'tool_use', id: 'delayed-tool', name: 'Read', input: {} }] } })
      void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'unrelated-wake',
        subtype: 'success', is_error: false, result: 'wake' })
      const second = permission('tool-2')
      void f.assistant('A2', [{ type: 'tool_use', id: 'tool-2', name: 'Read', input: { file_path: '/work/file' } }])
      const hook = f.callbacks.hooks!.PreToolUse![0]!.hooks[0]!
      expect(await hook({ hook_event_name: 'PreToolUse', session_id: session.nativeSessionId,
        transcript_path: '/profile/transcript', cwd: scope.cwd, tool_use_id: 'tool-2',
        tool_name: 'Read', tool_input: { file_path: '/work/file' } }, 'tool-2', { signal }))
        .toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse' } })
      expect(await second).toMatchObject({ behavior: 'allow' })
      void f.assistant('A3', [{ type: 'text', text: 'final answer' }])
      void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'frame-A3',
        subtype: 'success', is_error: false, result: 'result without an input echo' })
      await tick()
      expect((await f.manager.reconcile(session, 'request')).terminalResult).toBeUndefined()
      void f.result(message.uuid)
      const events = await output
      expect(events.filter(event => event.type === 'claude.tool').map(event => event.payload.toolUseId))
        .toEqual(['tool-1', 'tool-1', 'tool-2'])
      expect(events.some(event => ['late older', 'late echoed older'].includes(String(event.payload.text)))).toBe(false)
      expect(events.find(event => event.payload.text === 'final answer')?.payload.clientCorrelationId).toBe('request')
      expect(f.manager.nativeCallbackContext(session.nativeSessionId, 'delayed-tool')).toBeUndefined()
      expect(f.validate.mock.calls.filter(([identity]) => identity.toolUseId === 'tool-2')).not.toHaveLength(0)
      expect((await f.manager.reconcile(session, 'older')).events.some(event => event.payload.text === 'late older')).toBe(true)

      const next = f.manager.startTurn(session, f.input('next'))[Symbol.asyncIterator]()
      await f.nextMessage()
      void f.assistant('foreign', [{ type: 'tool_use', id: 'foreign-tool', name: 'Read', input: {} }], 'foreign-input')
      await tick()
      expect(f.manager.nativeCallbackContext(session.nativeSessionId, 'foreign-tool')).toBeUndefined()
      await next.return?.()
    } finally { await f.manager.dispose?.() }
  })

  it('keeps the response owner across distinct stream message starts', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      const output = drain(f.manager.startTurn(session, f.input('streamed')))
      const message = await f.nextMessage()
      const stream = (id: string, event: unknown, promptUuid?: string) => f.frames.offer({
        type: 'stream_event', session_id: session.nativeSessionId, uuid: id, event,
        ...(promptUuid ? { user_message_uuid: promptUuid } : {}),
      })
      void stream('start-1', { type: 'message_start', message: { id: 'stream-1' } })
      void stream('text-1', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'first' } }, message.uuid)
      void f.assistant('stream-2', [{ type: 'tool_use', id: 'stream-tool', name: 'Read', input: {} }])
      void stream('start-2', { type: 'message_start', message: { id: 'stream-2' } })
      void stream('tool-start', { type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'stream-tool', name: 'Read' } })
      const signal = new AbortController().signal
      const decision = await f.callbacks.canUseTool!('Read', {}, {
        signal, toolUseID: 'stream-tool', requestId: 'stream-control',
      })
      expect(decision).toMatchObject({ behavior: 'allow' })
      void f.assistant('stream-3', [{ type: 'text', text: 'third' }])
      void f.result(message.uuid)
      const events = await output
      expect(events.filter(event => event.type === 'claude.text').map(event => event.payload.text)).toEqual(['first', 'third'])
      expect(events.every(event => event.payload.clientCorrelationId === 'streamed')).toBe(true)
    } finally { await f.manager.dispose?.() }
  })
})

describe('Claude local command results', () => {
  it('delivers literal slash-prefixed content through the ordinary reply and result lifecycle', async () => {
    const f = fixture({ verbatimPrompts: true })
    try {
      const session = await f.manager.attachSession(saved, start)
      const output = drain(f.manager.startTurn(session, f.input('literal-slash', '/cost means pricing')))
      const message = await f.nextMessage()
      expect(message.message.content).toBe('/cost means pricing')
      expect(f.query.mock.calls[0]?.[0].options.verbatimPrompts).toBe(true)
      void f.assistant('literal-reply', [{ type: 'text', text: 'Pricing explanation' }], message.uuid)
      void f.result(message.uuid)
      expect((await output).some(event => event.payload.text === 'Pricing explanation')).toBe(true)
      expect((await f.manager.reconcile(session, 'literal-slash')).terminalResult?.outcome).toBe('succeeded')
    } finally { await f.manager.dispose?.() }
  })

  it.each(['success', 'error_during_execution'])('settles a result-only command with %s and accepts another request', async subtype => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      const output = drain(f.manager.startTurn(session, f.input('command', '/cost')))
      const message = await f.nextMessage()
      void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'unrelated-wake',
        subtype: 'success', is_error: false, local_command: 'cost', result: 'wake' })
      await tick()
      expect((await f.manager.reconcile(session, 'command')).terminalResult).toBeUndefined()
      void f.result(message.uuid, { local_command: 'cost', subtype, is_error: subtype !== 'success', errors: ['command error'] })
      await output
      expect((await f.manager.reconcile(session, 'command')).terminalResult?.outcome)
        .toBe(subtype === 'success' ? 'succeeded' : 'failed')
      const next = drain(f.manager.startTurn(session, f.input('after-command')))
      const nextMessage = await f.nextMessage()
      void f.assistant('after-command', [{ type: 'text', text: 'answer' }], nextMessage.uuid)
      void f.result(nextMessage.uuid)
      await next
      expect(f.offers).toHaveBeenCalledTimes(2)
    } finally { await f.manager.dispose?.() }
  })

  it.each([
    { prompt: '/cost is literal content', options: { verbatimPrompts: true }, command: 'cost' },
    { prompt: 'Explain /cost', options: {}, command: 'cost' },
    { prompt: '/cost', options: {}, command: 'usage' },
    { prompt: '/cost', options: {}, command: undefined },
  ])('keeps unqualified result-only content uncertain for $prompt with $command', async ({ prompt, options, command }) => {
    const f = fixture(options)
    try {
      const session = await f.manager.attachSession(saved, start)
      const observer = f.manager.startTurn(session, f.input('literal', prompt))[Symbol.asyncIterator]()
      const message = await f.nextMessage()
      void f.result(message.uuid, { local_command: command })
      await tick()
      expect((await f.manager.reconcile(session, 'literal')).terminalResult).toBeUndefined()
      expect(() => f.manager.startTurn(session, f.input('blocked'))).toThrow('still active or uncertain')
      await observer.return?.()
    } finally { await f.manager.dispose?.() }
  })
})

describe('Claude resident attach and history reconciliation', () => {
  it('resumes a failed idle query with the same manager and retains receipts without replay', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      expect(await f.manager.attachSession(saved, { ...start, correlationId: 'later' })).toEqual(session)
      await expect(f.manager.attachSession(saved, { ...start, environment: { agentId: 'other', variables: {} } }))
        .rejects.toMatchObject({ result: { error: { code: 'CLAUDE_SESSION_CONTEXT_CONFLICT' } } })
      await expect(f.manager.attachSession(saved, { ...start, workingDirectory: '/other' } as NativeSessionStart))
        .rejects.toThrow('another accepted configuration')
      const output = drain(f.manager.startTurn(session, f.input('completed')))
      const message = await f.nextMessage()
      void f.assistant('reply', [{ type: 'text', text: 'done' }], message.uuid)
      void f.result(message.uuid)
      await output
      f.frames.close(new Error('native query failed'))
      await vi.waitFor(() => expect(f.close).toHaveBeenCalled())
      expect((await f.manager.reconcile(session, 'completed')).terminalResult).toEqual({ outcome: 'succeeded', output: 'done' })
      f.client.getSessionInfo = vi.fn<typeof f.client.getSessionInfo>()
        .mockRejectedValueOnce(new Error('Native history unavailable'))
        .mockImplementation(async sessionId => ({ sessionId }))
      await expect(f.manager.attachSession(saved, start)).rejects.toThrow('Native history unavailable')
      expect((await f.manager.reconcile(session, 'completed')).terminalResult).toEqual({ outcome: 'succeeded', output: 'done' })
      expect(f.offers).toHaveBeenCalledTimes(1)
      const resumed = await f.manager.attachSession(saved, start)
      expect(resumed).toEqual(saved)
      expect(f.query).toHaveBeenCalledTimes(2)
      expect(f.query.mock.calls[1]?.[0].options.resume).toBe(saved.nativeSessionId)
      expect(f.offers).toHaveBeenCalledTimes(1)
      expect((await f.manager.reconcile(resumed, 'completed')).terminalResult).toEqual({ outcome: 'succeeded', output: 'done' })
      expect((await f.manager.history(resumed)).events).toContainEqual(expect.objectContaining({
        type: 'claude.session.failed', payload: expect.objectContaining({ error: {
          code: 'CLAUDE_NATIVE_STREAM_ERROR', message: 'native query failed',
        } }),
      }))
      expect(() => f.manager.startTurn(resumed, f.input('completed'))).toThrow('already offered')
      const continued = drain(f.manager.startTurn(resumed, f.input('continued')))
      const next = await f.nextMessage()
      void f.assistant('continued-tool', [{ type: 'tool_use', id: 'continued-tool', name: 'Read', input: {} }], next.uuid)
      expect(await f.callbacks.canUseTool!('Read', {}, {
        signal: new AbortController().signal, toolUseID: 'continued-tool', requestId: 'continued-control',
      })).toMatchObject({ behavior: 'allow' })
      void f.result(next.uuid)
      await continued
      expect(f.offers).toHaveBeenCalledTimes(2)
    } finally { await f.manager.dispose?.() }
  })

  it('resumes an ended resident query without offering input', async () => {
    const f = fixture()
    try {
      await f.manager.attachSession(saved, start)
      f.frames.close()
      await tick()
      expect(await f.manager.attachSession(saved, start)).toEqual(saved)
      expect(f.query).toHaveBeenCalledTimes(2)
      expect(f.query.mock.calls[1]?.[0].options.resume).toBe(saved.nativeSessionId)
      expect(f.offers).not.toHaveBeenCalled()
    } finally { await f.manager.dispose?.() }
  })

  it('keeps an uncertain active input fenced when its query fails', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      const observer = f.manager.startTurn(session, f.input('active'))[Symbol.asyncIterator]()
      await f.nextMessage()
      f.frames.close(new Error('native query failed'))
      await expect(observer.next()).rejects.toThrow('native query failed')
      await expect(f.manager.attachSession(saved, start)).rejects.toMatchObject({
        result: { error: { code: 'CLAUDE_TURN_ACTIVE' } },
      })
      expect(f.query).toHaveBeenCalledTimes(1)
      expect(f.offers).toHaveBeenCalledTimes(1)
    } finally { await f.manager.dispose?.() }
  })

  it('recovers beyond eight history pages, caches the receipt, and proves a complete miss without replay', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      const expected = claudePromptUuid('old-request')
      const rows = Array.from({ length: 2600 }, (_, index) => ({
        type: 'user', session_id: index === 2048 ? 'foreign' : session.nativeSessionId,
        uuid: index === 2305 || index === 2048 ? expected : `other-${index}`, parent_tool_use_id: null,
      }))
      const history = vi.fn<ClaudeSdkClient['getSessionMessages']>(async (_sessionId, page) =>
        rows.slice(page.offset, (page.offset ?? 0) + (page.limit ?? 256)))
      f.client.getSessionMessages = history
      const recovered = await f.manager.reconcile(session, 'old-request')
      expect(recovered.nativeSubmission?.nativeMessageId).toBe(expected)
      expect(recovered.terminalResult).toBeUndefined()
      expect(history).toHaveBeenLastCalledWith(session.nativeSessionId, { dir: scope.cwd, offset: 2304, limit: 256 })
      await f.manager.reconcile(session, 'old-request')
      expect(history).toHaveBeenCalledTimes(10)
      expect(() => f.manager.startTurn(session, f.input('old-request'))).toThrow('already offered')
      const missing = await f.manager.reconcile(session, 'missing')
      expect(missing.nativeSubmission).toBeUndefined()
      expect(history).toHaveBeenLastCalledWith(session.nativeSessionId, { dir: scope.cwd, offset: 2560, limit: 256 })
      expect(f.offers).not.toHaveBeenCalled()
    } finally { await f.manager.dispose?.() }
  })

  it('reports retained event bounds and rejects an interrupted scan instead of reporting a miss', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession(saved, start)
      for (let index = 0; index < 300; index += 1) {
        void f.frames.offer({ type: 'system', subtype: 'compact_boundary',
          session_id: session.nativeSessionId, uuid: `compact-${index}` })
        await tick()
      }
      const retained = await f.manager.history(session)
      const missing = await f.manager.reconcile(session, 'missing')
      expect(missing.firstRetainedSequence).toBe(retained.firstRetainedSequence)
      expect(missing.firstRetainedSequence).toBeGreaterThan(0)
      expect(missing.nextSequence).toBe(retained.nextSequence)
      const abort = new AbortController()
      f.client.getSessionMessages = async (_sessionId, page) => {
        if (page.offset === 0) return Array.from({ length: 256 }, (_, index) => ({
          type: 'user', uuid: `unrelated-${index}`, session_id: session.nativeSessionId,
        }))
        abort.abort(new Error('scan canceled'))
        return []
      }
      await expect(f.manager.reconcile(session, 'interrupted', abort.signal)).rejects.toThrow('scan canceled')
      const resumed = vi.fn<ClaudeSdkClient['getSessionMessages']>(async () => [{
        type: 'user', uuid: claudePromptUuid('interrupted'), session_id: session.nativeSessionId,
      }])
      f.client.getSessionMessages = resumed
      expect((await f.manager.reconcile(session, 'interrupted')).nativeSubmission?.nativeMessageId)
        .toBe(claudePromptUuid('interrupted'))
      expect(resumed).toHaveBeenCalledWith(session.nativeSessionId, { dir: scope.cwd, offset: 256, limit: 256 })
      expect(f.offers).not.toHaveBeenCalled()
    } finally { await f.manager.dispose?.() }
  })
})

describe('Claude initial observer lease', () => {
  it('rejects duplicate readers without detaching the owner and transfers the lease after return', async () => {
    const f = fixture()
    try {
      const submitted = vi.fn(async () => undefined)
      const input = { ...f.input(start.correlationId!), onMessageSubmitted: submitted, onSessionObserved: async () => undefined }
      const initial = f.manager.startInitialTurn(start, input)
      const first = initial[Symbol.asyncIterator]()
      const message = await f.nextMessage()
      const duplicateAbort = new AbortController()
      const duplicate = f.manager.startInitialTurn(start, input, duplicateAbort.signal)
      expect(() => duplicate[Symbol.asyncIterator]()).toThrow('already has an observer')
      expect(() => initial[Symbol.asyncIterator]()).toThrow('already has an observer')
      duplicateAbort.abort()
      void f.assistant('first', [{ type: 'text', text: 'first text' }], message.uuid)
      const events: NativeHarnessEvent[] = []
      while (!events.some(event => event.payload.text === 'first text')) {
        events.push((await first.next()).value!)
      }
      const pending = first.next()
      await first.return?.()
      expect((await pending).done).toBe(true)
      const replacement = drain(f.manager.startInitialTurn(start, input))
      void f.assistant('later', [{ type: 'text', text: 'later text' }])
      void f.result(message.uuid)
      const later = await replacement
      expect(later.some(event => event.payload.text === 'later text')).toBe(true)
      expect(later.at(-1)?.type).toBe('turn.completed')
      expect(submitted).toHaveBeenCalledTimes(1)
      expect(f.query).toHaveBeenCalledTimes(1)
      expect(f.offers).toHaveBeenCalledTimes(1)
    } finally { await f.manager.dispose?.() }
  })
})


it('keeps the accepted Claude account and real HOME through exact idle rollover after a default change', async () => {
  const accountId = randomUUID()
  let defaultId = accountId
  const resolve = vi.fn(async (_provider: 'codex' | 'claude', id?: string) => ({ accountId: id ?? defaultId,
    homePath: scope.profilePath, authMode: 'subscription' as const }))
  const account = await resolveRuntimeProviderAccount({ resolve }, 'claude', accountId)
  if (!account) throw new Error('Accepted account required')
  const environment = managedProviderEnvironment({ HOME: '/human-context' }, account, 'claude')
  const f = fixture({ env: environment })
  try {
    const session = await f.manager.attachSession(saved, start)
    const events = drain(f.manager.startTurn(session, f.input('account-completed')))
    const message = await f.nextMessage()
    void f.assistant('account-reply', [{ type: 'text', text: 'done' }], message.uuid)
    void f.result(message.uuid)
    await events
    defaultId = randomUUID()
    f.frames.close(new Error('native query disconnected'))
    await vi.waitFor(() => expect(f.close).toHaveBeenCalled())
    expect(await f.manager.attachSession(saved, start)).toEqual(saved)
    expect(f.query).toHaveBeenCalledTimes(2)
    for (const [query] of f.query.mock.calls) {
      expect(query.options).toMatchObject({ resume: saved.nativeSessionId,
        env: { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: scope.profilePath } })
    }
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0]?.[1]).toBe(accountId)
    expect(f.offers).toHaveBeenCalledTimes(1)
    expect((await f.manager.reconcile(saved, 'account-completed')).nativeSubmission?.nativeMessageId).toBe(message.uuid)
  } finally { await f.manager.dispose?.() }
})

it('retains an uncertain initial Claude input under its accepted account after the default changes', async () => {
  const accountId = randomUUID()
  let defaultId = accountId
  const resolve = vi.fn(async (_provider: 'codex' | 'claude', id?: string) => ({ accountId: id ?? defaultId,
    homePath: scope.profilePath, authMode: 'subscription' as const }))
  const account = await resolveRuntimeProviderAccount({ resolve }, 'claude', accountId)
  if (!account) throw new Error('Accepted account required')
  const f = fixture({ env: managedProviderEnvironment({ HOME: '/human-context' }, account, 'claude') })
  try {
    const acceptedStart = { ...start, correlationId: 'account-initial' }
    const observing = drain(f.manager.startInitialTurn(acceptedStart, { ...f.input('account-initial'),
      onSessionObserved: async () => undefined }))
    const message = await f.nextMessage()
    defaultId = randomUUID()
    f.frames.close(new Error('native input acknowledgement lost'))
    await expect(observing).rejects.toThrow('native input acknowledgement lost')
    expect(f.query).toHaveBeenCalledTimes(1)
    expect(f.offers).toHaveBeenCalledTimes(1)
    expect(message.uuid).toBe(claudePromptUuid('account-initial'))
    expect(resolve).toHaveBeenCalledTimes(1)
    await expect(f.manager.attachSession(saved, acceptedStart)).rejects.toThrow()
    expect(f.query).toHaveBeenCalledTimes(1)
  } finally { await f.manager.dispose?.() }
})
