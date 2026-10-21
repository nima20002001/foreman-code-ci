import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { NativeSessionStart } from '../port.js'
import { ClaudeBoundedQueue } from './queue.js'
import { claudePromptUuid, createClaudeNativeSessionManager, type ClaudeMessageTurnInput } from './sessionManager.js'
import type { ClaudeSdkUserMessage } from './port.js'
import { saveClaudeCompactionResult } from './compactionResults.js'
import { scope, qualification, start, fixture, workflowRequest, deferred, drain } from './__tests__/sessionManager.js'

describe('Claude native session manager admission', () => {
  it.each([false, true])('resumes workflow history before the reactivation turn (inspected=%s)', async inspected => {
    const f = fixture()
    const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
    const acceptedStart = { kind: 'workflow' as const, request: workflowRequest(), correlationId: 'execution:reactivated' }
    let frames = f.frames
    let nextMessage = f.nextMessage
    try {
      if (inspected) {
        await f.manager.prepareInspection(acceptedStart)
        frames = new ClaudeBoundedQueue<unknown>(8)
        let messages!: AsyncIterator<ClaudeSdkUserMessage>
        f.client.query = input => {
          f.queries(input)
          messages = input.prompt[Symbol.asyncIterator]()
          return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => {},
            initializationResult: async () => ({ models: [], account: {} }), mcpServerStatus: f.statuses,
            close: () => frames.close() }
        }
        nextMessage = async () => (await messages.next()).value!
      }
      const resumed = await f.manager.createSession({ ...acceptedStart,
        sessionContinuation: { previousExecutionId: 'previous', session } })
      expect(resumed).toEqual(session)
      expect(f.queries.mock.calls.at(-1)?.[0].options.resume).toBe(session.nativeSessionId)
      const output = drain(f.manager.startTurn(session,
        { prompt: 'Address the review feedback', clientCorrelationId: 'execution:reactivated' }))
      const message = await nextMessage()
      await frames.offer({ type: 'assistant', session_id: session.nativeSessionId,
        uuid: 'reply', user_message_uuid: message.uuid })
      await frames.offer({ type: 'result', session_id: session.nativeSessionId,
        uuid: 'result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'revised' })
      await output
      expect((await f.manager.reconcile(session, 'execution:reactivated')).terminalResult?.output).toBe('revised')
    } finally { await f.manager.dispose?.() }
  })
  it.each(['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD', 'GRAPHQL_PRODUCTION_DB_PASSWORD',
    'FOREMAN_CODE_PRODUCTION_DB_PASSWORD'])(
    'rejects scoped %s before SDK inspection or resume', async key => {
      const selected = { ...start, environment: { agentId: 'operator', variables: { [key]: 'test-only-credential' } } }
      for (const operation of ['inspection', 'resume']) {
        const f = fixture()
        try {
          const opening = operation === 'inspection' ? f.manager.prepareInspection(selected)
            : f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
              nativeSessionId: 'native-session' }, selected)
          await expect(opening).rejects.toMatchObject({ result: {
            outcome: 'failed', error: { code: 'CLAUDE_ENVIRONMENT_INVALID', retryable: false },
          } })
          expect(f.queries).not.toHaveBeenCalled()
          expect(f.offers).not.toHaveBeenCalled()
          const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
          expect(await f.manager.attachSession(session, start)).toEqual(session)
          expect(f.queries).toHaveBeenCalledOnce()
          expect(f.offers).not.toHaveBeenCalled()
        } finally { await f.manager.dispose?.() }
      }
    },
  )

  it('freezes the accepted terminal message identity while persistence is retried after delayed replies', async () => {
    const f = fixture()
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      const saved = vi.fn<NonNullable<ClaudeMessageTurnInput['onTerminal']>>(async () => {
        throw new Error('Terminal save interrupted')
      })
      const output = drain(f.manager.startTurn(session, { prompt: 'first', clientCorrelationId: 'frozen-result',
        onTerminal: saved }))
      const failure = expect(output).rejects.toThrow('Terminal save interrupted')
      const message = await f.nextMessage()
      await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'accepted-answer',
        user_message_uuid: message.uuid, message: { id: 'accepted-message' } })
      await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'accepted-result',
        user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'accepted output' })
      await failure
      await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'delayed-answer',
        user_message_uuid: message.uuid, message: { id: 'delayed-message' } })
      await new Promise<void>(resolve => setImmediate(resolve))
      const recovered = await f.manager.reconcile(session, 'frozen-result')
      expect(recovered.nativeMessageId).toBe('accepted-message')
      expect(recovered.terminalResult).toEqual(saved.mock.calls[0]![0].result)
      expect(saved).toHaveBeenCalledTimes(1)
    } finally { await f.manager.dispose?.() }
  })

  it('keeps factory allocation I/O-free and blocks unqualified capabilities before native effects', async () => {
    const runner = { open: vi.fn(), history: vi.fn(), fork: vi.fn(), dispose: vi.fn(async () => undefined) }
    const manager = createClaudeNativeSessionManager({ runner, scope, sdkOptions: {}, qualification: { ...qualification, basicTurns: false } })
    expect(runner.open).not.toHaveBeenCalled()
    await expect(manager.createSession(start)).rejects.toThrow('atomic initial-turn')
    expect(() => manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined })).toThrow('not been qualified')
    expect((await manager.capabilities()).cancellation).toBe(false)
    expect(manager.steerTurn).toBeUndefined()
    await manager.dispose?.()
  })

  it('persists exact echoed native message receipt before submitted events, then reuses the session', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const submit = vi.fn(async () => undefined)
    const turn: ClaudeMessageTurnInput = { prompt: 'first', clientCorrelationId: 'request-1', onMessageSubmitted: submit }
    const output = drain(f.manager.startTurn(session, turn))
    const first = await f.nextMessage()
    expect(submit).not.toHaveBeenCalled()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'assistant-1', user_message_uuid: first.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-1', user_message_uuid: first.uuid, subtype: 'success', is_error: false, result: 'done' })
    const events = await output
    expect(submit).toHaveBeenCalledWith({ kind: 'message', nativeSessionId: 'native-session', nativeMessageId: first.uuid, clientCorrelationId: 'request-1' })
    expect(events.map((event) => event.type)).toEqual(['message.submitted', 'turn.completed'])
    const history = await f.manager.reconcile(session, 'request-1')
    expect(history.nativeTurnId).toBeUndefined()
    expect(history.nativeMessageId).toBe('assistant-1')
    expect(history.terminalTurn?.providerId).toBe(first.uuid)
    expect(f.close).not.toHaveBeenCalled()
    const second = drain(f.manager.startTurn(session, { prompt: 'second', clientCorrelationId: 'request-2' }))
    const secondMessage = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-2', user_message_uuid: secondMessage.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-2', user_message_uuid: secondMessage.uuid, subtype: 'success', is_error: false, result: 'again' })
    await second
    expect((await f.manager.reconcile(session, 'request-2')).terminalResult?.output).toBe('again')
    await f.manager.close(session); await f.manager.close(session); await f.manager.dispose?.()
  })

  it.each(['settings persistence', 'mode control'])(
    'reports %s failure before offer as definite and accepts a later task', async stage => {
      const f = fixture()
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      const input: ClaudeMessageTurnInput = { prompt: 'unoffered task', clientCorrelationId: 'before-offer',
        ...(stage === 'mode control' ? { sessionMode: 'plan' } : {}),
        onSettingsApplied: async () => { if (stage === 'settings persistence') throw new Error('Storage failed') },
      }
      await expect(drain(f.manager.startTurn(session, input))).rejects.toMatchObject({
        certainty: 'definite', deliveryState: 'not-delivered',
      })
      expect(f.offers).not.toHaveBeenCalled()
      const output = drain(f.manager.startTurn(session, { prompt: 'next task', clientCorrelationId: 'next-offer',
        sessionPreferences: SessionPreferencesSchema.parse({}) }))
      const message = await f.nextMessage()
      await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'next-reply', user_message_uuid: message.uuid })
      await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'next-result', user_message_uuid: message.uuid,
        subtype: 'success', is_error: false, result: 'done' })
      await output
      expect(f.offers).toHaveBeenCalledTimes(1)
      await f.manager.dispose?.()
    })

  it('recovers safe-resume failure before offer and accepts the next task on the saved session', async () => {
    const f = fixture()
    const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
      nativeSessionId: 'native-session' }, start)
    const open = f.runner.open.bind(f.runner)
    vi.spyOn(f.runner, 'open').mockRejectedValueOnce(new Error('Resume failed')).mockImplementation(open)
    await expect(drain(f.manager.startTurn(session, { prompt: 'unoffered', clientCorrelationId: 'resume-failure',
      sessionPreferences: SessionPreferencesSchema.parse({ autoCompact: 'off' }) }))).rejects.toMatchObject({
      certainty: 'definite', deliveryState: 'not-delivered',
    })
    expect(f.offers).not.toHaveBeenCalled()
    const frames = new ClaudeBoundedQueue<unknown>(8)
    let messages!: AsyncIterator<ClaudeSdkUserMessage>
    f.client.query = input => {
      messages = input.prompt[Symbol.asyncIterator]()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), interrupt: async () => {},
        initializationResult: async () => ({ models: [], account: {} }), close: () => frames.close() }
    }
    const output = drain(f.manager.startTurn(session, { prompt: 'follow-up', clientCorrelationId: 'resume-follow-up',
      sessionPreferences: SessionPreferencesSchema.parse({}) }))
    await vi.waitFor(() => expect(messages).toBeDefined())
    const message = (await messages.next()).value!
    await frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'resumed-reply', user_message_uuid: message.uuid })
    await frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'resumed-result', user_message_uuid: message.uuid,
      subtype: 'success', is_error: false, result: 'done' })
    await output
    expect(f.offers).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('accepts newer native init behavior and keeps the observed version as provenance', async () => {
    const f = fixture(undefined, {}, '2.2.0')
    let session: import('@foreman-code/contracts').NativeSessionReference | undefined
    const output = drain(f.manager.startInitialTurn({ ...start, correlationId: 'newer-native' }, { prompt: 'first', clientCorrelationId: 'newer-native',
      onSessionObserved: async value => { session = value } }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: message.uuid,
      subtype: 'success', is_error: false, result: 'compatible' })
    await output
    expect(session?.providerVersion).toBe('2.2.0')
    await f.manager.dispose?.()
  })

  it.each(['before', 'after'] as const)('keeps saved resume provenance when newer init arrives %s its control ACK', async order => {
    const f = fixture()
    const acknowledged = deferred<unknown>()
    const consumed = deferred<void>()
    const query = f.client.query
    f.client.query = input => ({ ...query(input), initializationResult: () => acknowledged.promise })
    const open = f.runner.open
    f.runner.open = async input => {
      const sdk = await open(input)
      return { ...sdk, output: (async function* () {
        for await (const observation of sdk.output) {
          yield observation
          if ((observation.raw as { type?: string }).type === 'system') consumed.resolve()
        }
      })() }
    }
    const saved = { harness: 'claude' as const, providerVersion: '2.1.280', nativeSessionId: 'native-session' }
    const attaching = f.manager.attachSession(saved, start)
    await vi.waitFor(() => expect(f.queries).toHaveBeenCalledOnce())
    const init = { type: 'system', subtype: 'init', session_id: saved.nativeSessionId,
      claude_code_version: '2.2.0', cwd: '/work' }
    if (order === 'before') {
      void f.frames.offer(init)
      await consumed.promise
    }
    acknowledged.resolve({ models: [], account: {} })
    expect(await attaching).toEqual(saved)
    if (order === 'after') {
      void f.frames.offer(init)
      await consumed.promise
    }
    expect((await f.manager.capabilities()).providerVersion).toBe('2.2.0')
    await f.manager.dispose?.()
  })

  it('interrupts only the exact active message and settles its aborted result as canceled', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    expect((await f.manager.capabilities()).cancellation).toBe(true)
    expect(await f.manager.cancel(session)).toBe(false)
    const output = drain(f.manager.startTurn(session, { prompt: 'long task', clientCorrelationId: 'request-stop' }))
    const message = await f.nextMessage()
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(false) // Not yet natively echoed.
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-stop', user_message_uuid: message.uuid })
    await vi.waitFor(async () => expect((await f.manager.reconcile(session, 'request-stop')).nativeSubmission).toBeDefined())
    expect(await f.manager.cancel(session, undefined, 'another-message')).toBe(false)
    expect(f.interrupt).not.toHaveBeenCalled()
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(true)
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(true)
    expect(f.interrupt).toHaveBeenCalledTimes(1)
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-stop', user_message_uuid: message.uuid, subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: [] })
    expect((await output).at(-1)?.type).toBe('turn.completed')
    const history = await f.manager.reconcile(session, 'request-stop')
    expect(history.terminalResult).toEqual({ outcome: 'canceled' })
    expect(history.terminalTurn?.providerId).toBe(message.uuid)
    const next = drain(f.manager.startTurn(session, { prompt: 'next', clientCorrelationId: 'request-next' }))
    const nextMessage = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-next', user_message_uuid: nextMessage.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-next', user_message_uuid: nextMessage.uuid, subtype: 'success', is_error: false, result: 'ok' })
    await next
    expect((await f.manager.reconcile(session, 'request-next')).terminalResult).toEqual({ outcome: 'succeeded', output: 'ok' })
    await f.manager.dispose?.()
  })

  it('keeps a success that raced the interrupt succeeded', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const output = drain(f.manager.startTurn(session, { prompt: 'quick', clientCorrelationId: 'request-race' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-race', user_message_uuid: message.uuid })
    await vi.waitFor(async () => expect((await f.manager.reconcile(session, 'request-race')).nativeSubmission).toBeDefined())
    expect(await f.manager.cancel(session, undefined, message.uuid)).toBe(true)
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-race', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done first' })
    await output
    expect((await f.manager.reconcile(session, 'request-race')).terminalResult).toEqual({ outcome: 'succeeded', output: 'done first' })
    await f.manager.dispose?.()
  })

  it('does not correlate a queued native wake result with the new message', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const output = f.manager.startTurn(session, { prompt: 'new', clientCorrelationId: 'request-new' })[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'wake-result', subtype: 'success', is_error: false, result: 'wake' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await f.manager.reconcile(session, 'request-new')).terminalResult).toBeUndefined()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'new-reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'new-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'new' })
    expect((await output.next()).value?.type).toBe('message.submitted')
    expect((await output.next()).value?.type).toBe('turn.completed')
    await f.manager.dispose?.()
  })

  it('never replays uncertain correlations, and result then throw preserves failure', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const result = drain(f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'failure-result', user_message_uuid: message.uuid, subtype: 'error_during_execution', is_error: true, errors: ['native refusal'] })
    f.frames.close(new Error('throw after result'))
    await result
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult?.error?.message).toBe('native refusal')
    expect(() => f.manager.startTurn(session, { prompt: 'retry', clientCorrelationId: 'request-one' })).toThrow()
    await f.manager.dispose?.()
  })

  it('subscriber return and abort detach observation without closing accepted native work', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const abort = new AbortController()
    const subscriber = f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }, abort.signal)[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    const read = subscriber.next()
    abort.abort(new Error('subscriber gone'))
    await expect(read).rejects.toThrow('subscriber gone')
    expect(f.close).not.toHaveBeenCalled()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult?.output).toBe('done')
    await f.manager.dispose?.()
  })

  it('does not complete a parent result while unsupported native background work lives', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const result = drain(f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'system', subtype: 'task_started', session_id: session.nativeSessionId, task_id: 'background-native', is_backgrounded: true })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'parent-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'parent' })
    await expect(result).rejects.toThrow('background work')
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult).toBeUndefined()
    expect(f.close).toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('retains result-only consumption as uncertain instead of attributing a wake result to the offered message', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const submit = vi.fn(async () => undefined)
    const subscriber = f.manager.startTurn(session, { prompt: 'new', clientCorrelationId: 'request-new', onMessageSubmitted: submit } as ClaudeMessageTurnInput)[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'wake-folded-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'wake' })
    expect((await subscriber.next()).value?.type).toBe('message.submitted')
    expect((await subscriber.next()).value?.type).toBe('claude.result.unattributed')
    expect(submit).toHaveBeenCalledTimes(1)
    expect((await f.manager.reconcile(session, 'request-new')).terminalResult).toBeUndefined()
    expect(() => f.manager.startTurn(session, { prompt: 'again', clientCorrelationId: 'another-request' })).toThrow('still active or uncertain')
    await subscriber.return?.()
    await f.manager.dispose?.()
  })

  it('retains malformed or future result variants as uncertain', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const subscriber = f.manager.startTurn(session, { prompt: 'new', clientCorrelationId: 'request-new' })[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'unknown-result', user_message_uuid: message.uuid, subtype: 'future_variant', is_error: false, result: 'unknown' })
    expect((await subscriber.next()).value?.type).toBe('message.submitted')
    expect((await subscriber.next()).value?.type).toBe('claude.result.unattributed')
    expect((await f.manager.reconcile(session, 'request-new')).terminalResult).toBeUndefined()
    await subscriber.return?.(); await f.manager.dispose?.()
  })

  it('stamps only proven root/child/tool correlations, retaining late A without assigning it to B', async () => {
    const f = fixture(() => (raw) => {
      const frame = raw as Record<string, unknown>
      if (frame.type === 'result' || frame.type === 'system') return []
      const message = frame.message as { id?: string }
      return [{ type: frame.tool_use_id ? 'claude.tool' : 'claude.text', payload: {
        nativeSessionId: frame.session_id, messageId: message?.id,
        ...(frame.parent_tool_use_id ? { parentToolUseId: frame.parent_tool_use_id } : {}),
        ...(frame.tool_use_id ? { toolUseId: frame.tool_use_id } : {}), text: frame.text,
      } }]
    })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const a = drain(f.manager.startTurn(session, { prompt: 'A', clientCorrelationId: 'request-A' }))
    const messageA = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'frame-A', message: { id: 'api-A' }, user_message_uuid: messageA.uuid, tool_use_id: 'tool-A', text: 'A tool' })
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'frame-A-2', message: { id: 'api-A' }, text: 'A canonical block' })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-A', user_message_uuid: messageA.uuid, subtype: 'success', is_error: false, result: 'A done' })
    await a
    const b = drain(f.manager.startTurn(session, { prompt: 'B', clientCorrelationId: 'request-B' }))
    const messageB = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'frame-B', message: { id: 'api-B' }, user_message_uuid: messageB.uuid, text: 'B' })
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'child-A', parent_tool_use_id: 'tool-A', message: { id: 'child-api-A' }, text: 'late A child' })
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'unowned-child', parent_tool_use_id: 'unknown-tool', message: { id: 'unknown-child' }, text: 'unowned' })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-B', user_message_uuid: messageB.uuid, subtype: 'success', is_error: false, result: 'B done' })
    const eventsB = await b
    expect(eventsB.some((event) => event.payload.text === 'late A child' || event.payload.text === 'unowned')).toBe(false)
    const historyA = await f.manager.reconcile(session, 'request-A')
    expect(historyA.events.filter((event) => event.type.startsWith('claude.')).map((event) => event.payload.text)).toEqual(['A tool', 'A canonical block', 'late A child'])
    expect(historyA.events.every((event) => event.payload.clientCorrelationId === 'request-A')).toBe(true)
    await f.manager.dispose?.()
  })

  it.each(['tool_deferred', 'background_requested'])('does not settle native continuation reason %s as successful work', async (reason) => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const result = drain(f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', message: { id: 'api-reply' }, user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'deferred-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'parent', terminal_reason: reason })
    await expect(result).rejects.toThrow('background work')
    expect((await f.manager.reconcile(session, 'request-one')).terminalResult).toBeUndefined()
    await f.manager.dispose?.()
  })

  it('recovers exact lost-ACK input identity from native history without replaying a prompt or inferring terminal outcome', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const expected = claudePromptUuid('request-lost-ack')
    f.client.getSessionMessages = vi.fn(async () => [
      { type: 'user', uuid: expected, session_id: session.nativeSessionId, parent_tool_use_id: null, message: { role: 'user', content: 'already sent' } },
      { type: 'assistant', uuid: 'old-reply', session_id: session.nativeSessionId, parent_tool_use_id: null, message: { role: 'assistant', stop_reason: 'end_turn', content: 'reply without native result evidence' } },
    ])
    const history = await f.manager.reconcile(session, 'request-lost-ack')
    expect((history as typeof history & { nativeSubmission?: unknown }).nativeSubmission).toEqual({ kind: 'message', nativeSessionId: session.nativeSessionId, nativeMessageId: expected, clientCorrelationId: 'request-lost-ack' })
    expect(history.nativeTurnId).toBeUndefined(); expect(history.terminalResult).toBeUndefined()
    expect(f.client.getSessionMessages).toHaveBeenCalledWith('native-session', { dir: '/work', limit: 256, offset: 0 })
    expect(() => f.manager.startTurn(session, { prompt: 'retry', clientCorrelationId: 'request-lost-ack' })).toThrow('already offered')
    const input = f.nextMessage()
    expect(await Promise.race([input.then(() => 'offered'), new Promise<string>((resolve) => setTimeout(() => resolve('idle'), 0))])).toBe('idle')
    await f.manager.dispose?.(); await input
  })

  it('does not acknowledge missing or foreign history, and validates actual native init version', async () => {
    const f = fixture(); const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const expected = claudePromptUuid('unknown-request')
    f.client.getSessionMessages = vi.fn(async () => [{ type: 'user', uuid: expected, session_id: 'foreign-session', parent_tool_use_id: null }])
    const history = await f.manager.reconcile(session, 'unknown-request')
    expect(history.correlationId).toBeUndefined(); expect(history.terminalResult).toBeUndefined()
    await f.manager.dispose?.()
    const changed = fixture()
    changed.client.query = () => {
      void changed.frames.offer({ type: 'system', subtype: 'init', session_id: 'wrong', claude_code_version: '2.1.286', cwd: '/foreign' })
      return { [Symbol.asyncIterator]: () => changed.frames[Symbol.asyncIterator](), close: () => changed.frames.close(),
        initializationResult: async () => ({ models: [], account: {} }), interrupt: async () => undefined }
    }
    const changedResult = drain(changed.manager.startInitialTurn(start, { prompt: 'one', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
    await expect(changedResult).rejects.toThrow('Claude Code 2.1.286 does not satisfy the init version/cwd contract')
    await changed.manager.dispose?.()
  })
})

describe('Claude native instruction delivery', () => {
  it.each(['workflow', 'agent-chat', 'operator'] as const)(
    'launches %s with its accepted application system prompt policy before the first user input', async kind => {
      const snapshot = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
      const request = workflowRequest()
      request.configuration = { ...request.configuration,
        instructionDelivery: 'native-v1', prompt: { system: 'Agent instructions.' } }
      request.systemPrompt = snapshot
      let selected: NativeSessionStart
      if (kind === 'workflow') {
        selected = { request, correlationId: 'prompt-launch' }
      } else if (kind === 'agent-chat') {
        selected = { kind, conversationId: 'prompt-chat', workflowId: 'workflow', workflowNodeId: 'node',
          correlationId: 'prompt-launch', configuration: request.configuration, systemPrompt: snapshot,
          workingDirectory: '/work' }
      } else {
        selected = { ...start, correlationId: 'prompt-launch', systemPrompt: snapshot,
          configuration: { instructionDelivery: 'native-v1', prompt: { system: 'Operator instructions.' },
            assignedSkills: [] } } as unknown as NativeSessionStart
      }
      const f = fixture(undefined, { sdkOptions: { systemPrompt: 'Harness instructions.' } })
      try {
        const output = drain(f.manager.startInitialTurn(selected, { prompt: 'first user input',
          clientCorrelationId: 'prompt-launch', onSessionObserved: async () => undefined }))
        const message = await f.nextMessage()
        const expected = kind === 'operator' ? 'Operator instructions.' : 'App instructions.\n\nAgent instructions.'
        expect(f.queries.mock.calls[0]![0].options.systemPrompt).toBe(`Harness instructions.\n\n${expected}`)
        expect(message.message.content).toBe('first user input')
        await f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'prompt-reply',
          user_message_uuid: message.uuid })
        await f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'prompt-result',
          user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
        await output
      } finally {
        await f.manager.dispose?.()
      }
    },
  )

  it('keeps the accepted application system prompt when an existing Claude query resumes', async () => {
    const f = fixture(undefined, { sdkOptions: { systemPrompt: 'Harness instructions.' } })
    const request = workflowRequest()
    request.systemPrompt = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, { request })
      await f.manager.applySessionPreferences!(session, SessionPreferencesSchema.parse({ autoCompact: 'off' }))
      for (const [query] of f.queries.mock.calls) {
        expect(query.options.systemPrompt).toBe('Harness instructions.\n\nApp instructions.')
      }
      expect(f.offers).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it('rejects changing the pinned application prompt when attaching a resident Agent chat', async () => {
    const f = fixture()
    const request = workflowRequest()
    const selected: NativeSessionStart = {
      kind: 'agent-chat', conversationId: 'prompt-chat', workflowId: 'workflow', workflowNodeId: 'node',
      correlationId: 'prompt-chat', configuration: request.configuration, workingDirectory: '/work',
      systemPrompt: { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' },
    }
    const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
    try {
      await f.manager.attachSession(session, selected)
      const changed = structuredClone(selected)
      changed.systemPrompt!.revision = 4
      await expect(f.manager.attachSession(session, changed)).rejects.toMatchObject({ result: {
        outcome: 'failed', error: { code: 'CLAUDE_SESSION_CONTEXT_CONFLICT', retryable: false },
      } })
      const missing = { ...selected }
      delete missing.systemPrompt
      await expect(f.manager.attachSession(session, missing)).rejects.toMatchObject({ result: {
        outcome: 'failed', error: { code: 'CLAUDE_SESSION_CONTEXT_CONFLICT', retryable: false },
      } })
      expect(await f.manager.attachSession(session, structuredClone(selected))).toEqual(session)
      expect(f.queries).toHaveBeenCalledOnce()
      expect(f.offers).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it('delivers native-v1 Agent instructions as the Claude system prompt after the harness instructions', async () => {
    const f = fixture(undefined, { sdkOptions: { systemPrompt: 'Harness instructions.' } })
    const configured = { ...start, configuration: { instructionDelivery: 'native-v1', prompt: { system: 'Reply exactly COORDINATOR_READY.' }, assignedSkills: [] } } as unknown as NativeSessionStart
    void f.manager.prepareInspection(configured).catch(() => undefined)
    await vi.waitFor(() => expect(f.queries).toHaveBeenCalled())
    expect(f.queries.mock.calls[0]![0].options.systemPrompt).toBe('Harness instructions.\n\nReply exactly COORDINATOR_READY.')
  })
  it('keeps only the harness instructions for configurations accepted before native delivery', async () => {
    const f = fixture(undefined, { sdkOptions: { systemPrompt: 'Harness instructions.' } })
    const legacy = { ...start, configuration: { prompt: { system: 'Delivered in the task prompt instead.' }, assignedSkills: [] } } as unknown as NativeSessionStart
    void f.manager.prepareInspection(legacy).catch(() => undefined)
    await vi.waitFor(() => expect(f.queries).toHaveBeenCalled())
    expect(f.queries.mock.calls[0]![0].options.systemPrompt).toBe('Harness instructions.')
  })
})

it('applies preferences by idle exact-session resume and retains the admitted security configuration', async () => {
  const security = { model: 'sonnet', permissionMode: 'default', tools: ['Read'],
    sandbox: { enabled: true, allowUnsandboxedCommands: false }, settingSources: [], strictMcpConfig: true,
    systemPrompt: 'Harness instructions.', env: { HARNESS_SETTING: 'accepted' },
    mcpServers: { accepted: { type: 'http', url: 'http://127.0.0.1:9876/mcp' } } }
  const f = fixture(undefined, { sdkOptions: security })
  let frames = f.frames
  f.client.query = input => {
    f.queries(input)
    frames = new ClaudeBoundedQueue(32)
    return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](),
      initializationResult: async () => ({ models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet' },
        { value: 'sonnet[1m]', resolvedModel: 'claude-sonnet', displayName: 'Sonnet (1M)' }] }),
      getContextUsage: async () => ({ rawMaxTokens: input.options.model === 'sonnet[1m]' ? 1000000 : 200000,
        maxTokens: 200000, totalTokens: 10,
        model: input.options.model === 'sonnet[1m]' ? 'Sonnet (1M)' : String(input.options.model),
        isAutoCompactEnabled: (input.options.env as Record<string, string>)?.DISABLE_AUTO_COMPACT !== '1' }),
      interrupt: f.interrupt, close: () => frames.close(), setPermissionMode: async () => {},
    }
  }
  const skillBody = 'Pinned skill body with all accepted instructions.'
  const configured = { ...start,
    environment: { agentId: 'operator', variables: { WORKSPACE_SETTING: 'accepted' } },
    configuration: { instructionDelivery: 'native-v1', prompt: { system: 'Agent instructions.' },
      assignedSkills: [{ skillId: 'skill', version: '1' }],
      resolvedSkills: [{ skillId: 'skill', version: '1', name: 'Pinned skill', instructions: skillBody,
        contentHash: `sha256:${createHash('sha256').update(skillBody).digest('hex')}` }] },
  } as unknown as NativeSessionStart
  const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
    nativeSessionId: 'native-session' }, configured)
  const systemPrompt = 'Harness instructions.\n\nAgent instructions.\n\n# Skill: Pinned skill (skill@1)\n\n' + skillBody
  expect(f.queries.mock.calls[0]![0].options.systemPrompt).toBe(systemPrompt)
  const desired = SessionPreferencesSchema.parse({ autoCompact: 'off', autoCompactTokens: 150000 })
  await f.manager.applySessionPreferences!(session, desired)
  expect(f.manager.appliedSessionPreferences!(session)).toEqual(desired)
  const resumed = f.queries.mock.calls.at(-1)![0]
  expect(resumed.options).toMatchObject({ ...security, systemPrompt, resume: 'native-session',
    env: { DISABLE_AUTO_COMPACT: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '150000' } })
  await f.manager.applySessionPreferences!(session, SessionPreferencesSchema.parse({
    autoCompact: 'on', contextProfile: 'sonnet[1m]', autoCompactTokens: 500000,
  }))
  expect(f.manager.appliedSessionPreferences!(session)?.contextProfile).toBe('sonnet[1m]')
  expect((await f.manager.sessionControlCapabilities!(session)).modelCapacity).toBe(1000000)
  expect(f.queries.mock.calls.at(-1)![0].options).toMatchObject({
    ...security, systemPrompt, model: 'sonnet[1m]', resume: 'native-session',
  })
  await f.manager.applySessionPreferences!(session, SessionPreferencesSchema.parse({}))
  for (const [query] of f.queries.mock.calls) {
    expect(query.options.systemPrompt).toBe(systemPrompt)
    expect(query.options.env).toMatchObject({ HARNESS_SETTING: 'accepted', WORKSPACE_SETTING: 'accepted' })
    expect(query.options.mcpServers).toEqual(security.mcpServers)
  }
  expect(f.queries.mock.calls.at(-1)![0].options.env).not.toHaveProperty('DISABLE_AUTO_COMPACT')
  await f.manager.dispose!()
})

it('rejects an oversized fresh budget before the first model input', async () => {
  const f = fixture(undefined, { sdkOptions: { model: 'sonnet' } })
  const query = f.client.query
  f.client.query = input => ({ ...query(input), getContextUsage: async () => ({ rawMaxTokens: 200000,
    maxTokens: 200000, totalTokens: 0, model: 'sonnet', isAutoCompactEnabled: true }) })
  await f.manager.configureSessionPreferences!(SessionPreferencesSchema.parse({ autoCompactTokens: 1000000 }))
  const events = drain(f.manager.startInitialTurn(start, { prompt: 'task', clientCorrelationId: 'operator:one',
    onSessionObserved: async () => {} }))
  await expect(events).rejects.toThrow('context capacity')
  await expect(events).rejects.toMatchObject({ certainty: 'definite', deliveryState: 'not-delivered' })
  expect(f.offers).not.toHaveBeenCalled()
  await f.manager.dispose!()
})

for (const result of ['completed', 'no-op', 'failed'] as const) it(`recovers a lost ${result} compaction result while resident and after restart`, async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'claude-controls-'))
  const localScope = { ...scope, profilePath }
  const f = fixture(undefined, { scope: localScope })
  const open = f.runner.open
  f.runner.open = async input => {
    const sdk = await open(input)
    return { ...sdk, output: { async *[Symbol.asyncIterator]() {
      for await (const output of sdk.output) {
        if ((output.raw as { type?: string }).type !== 'result') yield output
      }
    } } }
  }
  f.runner.compactionHistory = async () => ({ cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] })
  const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
  await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
    cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
  await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
  const abort = new AbortController()
  let state: import('@foreman-code/contracts').CompactionState | undefined
  const compact = f.manager.compactSession!(session, { requestId: 'compact-request', clientCorrelationId: 'compact-correlation',
    onProgress: async value => { state = value } }, abort.signal)
  const message = await f.nextMessage()
  if (result !== 'no-op') {
    await f.frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: session.nativeSessionId,
      uuid: 'manual-boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12000 } })
    await vi.waitFor(() => expect(state?.nativeOperationId).toBe('manual-boundary'))
    expect((await f.manager.reconcileCompaction!(session, state!)).status).toBe('running')
    expect(() => f.manager.startTurn(session, { prompt: 'too early', clientCorrelationId: 'early' })).toThrow()
  }
  await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
    is_error: result === 'failed', subtype: result === 'failed' ? 'error_during_execution' : 'success', result: 'Nothing to compact' })
  await vi.waitFor(async () => expect(await f.runner.compactionOutcome!({ ...localScope, nativeSessionId: session.nativeSessionId },
    localScope, message.uuid)).toMatchObject({ status: result }))
  abort.abort(new Error('Native notification was lost'))
  await expect(compact).rejects.toThrow('lost')
  const pending = { ...state!, status: 'uncertain' as const }
  expect((await f.manager.reconcileCompaction!(session, pending)).status).toBe(result)
  await f.manager.dispose!()
  const restarted = fixture(undefined, { scope: localScope })
  const rebound = await restarted.manager.attachSession(session, start)
  expect((await restarted.manager.reconcileCompaction!(rebound, pending)).status).toBe(result)
  await restarted.manager.dispose!()
  await rm(profilePath, { recursive: true, force: true })
})

it.each(['completed', 'failed'] as const)(
  'waits for the terminal %s result after a manual boundary before unlocking input', async status => {
    const profilePath = await mkdtemp(join(tmpdir(), 'claude-boundary-result-'))
    const f = fixture(undefined, { scope: { ...scope, profilePath } })
    f.runner.compactionHistory = async () => ({
      cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [],
    })
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
        cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
      await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
      let state: import('@foreman-code/contracts').CompactionState | undefined
      const compact = f.manager.compactSession!(session, { requestId: 'manual-request', clientCorrelationId: 'manual',
        onProgress: async value => { state = value } })
      const message = await f.nextMessage()
      await f.frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: session.nativeSessionId,
        uuid: 'manual-boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12000 } })
      await vi.waitFor(() => expect(state?.nativeOperationId).toBe('manual-boundary'))
      expect(state?.status).toBe('running')
      expect((await f.manager.reconcileCompaction!(session, state!)).status).toBe('running')
      expect(() => f.manager.startTurn(session, { prompt: 'early', clientCorrelationId: 'early' })).toThrow()
      await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, user_message_uuid: message.uuid,
        is_error: status === 'failed', subtype: status === 'failed' ? 'error_during_execution' : 'success' })
      expect(await compact).toMatchObject({ status, nativeOperationId: 'manual-boundary', beforeTokens: 12000 })
      expect(await f.runner.compactionOutcome!({ ...scope, profilePath, nativeSessionId: session.nativeSessionId },
        { ...scope, profilePath }, message.uuid)).toMatchObject({ status })
      const followup = drain(f.manager.startTurn(session, { prompt: 'next task', clientCorrelationId: 'followup' }))
      const next = await f.nextMessage()
      await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: next.uuid })
      await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'followup-result', user_message_uuid: next.uuid,
        subtype: 'success', is_error: false, result: 'done' })
      await followup
    } finally {
      await f.manager.dispose!()
      await rm(profilePath, { recursive: true, force: true })
    }
  },
)

it('releases its runtime fence after a failed pre-dispatch save without offering compact', async () => {
  const f = fixture()
  f.runner.compactionHistory = async () => ({ cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] })
  const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
  await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId, cwd: '/work',
    claude_code_version: '2.1.284', slash_commands: ['compact'] })
  await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
  await expect(f.manager.compactSession!(session, { requestId: 'compact-request', clientCorrelationId: 'control-request',
    onProgress: async () => {}, onDispatch: async () => { throw new Error('Dispatch storage failed') } }))
    .rejects.toThrow('Dispatch storage failed')
  expect(f.offers).not.toHaveBeenCalled()
  const output = drain(f.manager.startTurn(session, { prompt: 'follow-up', clientCorrelationId: 'next-task' }))
  const message = await f.nextMessage()
  await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
  await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'next-result', user_message_uuid: message.uuid,
    subtype: 'success', is_error: false, result: 'done' })
  await output
  await f.manager.dispose!()
})

it('releases Claude input after a definite compaction non-delivery following dispatch bookkeeping', async () => {
  const f = fixture()
  f.runner.compactionHistory = async () => ({ cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] })
  const open = f.runner.open
  f.runner.open = async input => {
    const sdk = await open(input)
    const offer = sdk.offer
    sdk.offer = async (message, signal) => {
      if (message.content === '/compact') throw Object.assign(new Error('Not delivered'), { deliveryState: 'not-delivered' })
      return offer(message, signal)
    }
    return sdk
  }
  try {
    const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
      nativeSessionId: 'native-session' }, start)
    await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
      cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
    await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
    const dispatch = vi.fn(async () => {})
    await expect(f.manager.compactSession!(session, { requestId: 'rejected-control', clientCorrelationId: 'rejected-control',
      onProgress: async () => {}, onDispatch: dispatch })).rejects.toMatchObject({ deliveryState: 'not-delivered' })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(f.offers).not.toHaveBeenCalled()
    const output = drain(f.manager.startTurn(session, { prompt: 'follow-up', clientCorrelationId: 'followup' }))
    const message = await f.nextMessage()
    await f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply', user_message_uuid: message.uuid })
    await f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'followup-result', user_message_uuid: message.uuid,
      subtype: 'success', is_error: false, result: 'done' })
    await output
  } finally { await f.manager.dispose!() }
})

it.each(['timeout', 'disconnect'] as const)(
  'keeps a Claude boundary pending after %s and restart until the terminal result is available', async outcome => {
    const profilePath = await mkdtemp(join(tmpdir(), 'claude-pending-control-'))
    const localScope = { ...scope, profilePath }
    const f = fixture(undefined, { scope: localScope })
    const history = { cursor: { scope: 'scope', identity: 'identity', offset: 0 }, boundaries: [] as Record<string, unknown>[] }
    f.runner.compactionHistory = async () => history
    const restarted = fixture(undefined, { scope: localScope })
    restarted.runner.compactionHistory = async () => history
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284',
        nativeSessionId: 'native-session' }, start)
      await f.frames.offer({ type: 'system', subtype: 'init', session_id: session.nativeSessionId,
        cwd: '/work', claude_code_version: '2.1.284', slash_commands: ['compact'] })
      await vi.waitFor(async () => expect((await f.manager.sessionControlCapabilities!(session)).compact.supported).toBe(true))
      const abort = new AbortController()
      let state: import('@foreman-code/contracts').CompactionState | undefined
      const compact = f.manager.compactSession!(session, { requestId: 'pending-request', clientCorrelationId: 'pending',
        onProgress: async value => { state = value } }, abort.signal)
      const rejected = expect(compact).rejects.toThrow()
      const message = await f.nextMessage()
      await f.frames.offer({ type: 'system', subtype: 'compact_boundary', session_id: session.nativeSessionId,
        uuid: 'manual-boundary', compact_metadata: { trigger: 'manual', pre_tokens: 12000 } })
      await vi.waitFor(() => expect(state?.nativeOperationId).toBe('manual-boundary'))
      history.boundaries.push({ type: 'system', subtype: 'compact_boundary', sessionId: session.nativeSessionId,
        uuid: 'manual-boundary', compactMetadata: { trigger: 'manual', preTokens: 12000 } })
      if (outcome === 'timeout') abort.abort(new DOMException('Response timed out', 'TimeoutError'))
      else f.frames.close()
      await rejected
      const pending = { ...state!, status: 'uncertain' as const }
      expect((await f.manager.reconcileCompaction!(session, pending)).status).toBe('uncertain')
      await f.manager.dispose!()
      const rebound = await restarted.manager.attachSession(session, start)
      expect((await restarted.manager.reconcileCompaction!(rebound, pending)).status).toBe('uncertain')
      expect(() => restarted.manager.startTurn(rebound, { prompt: 'early', clientCorrelationId: 'early' })).toThrow()
      await saveClaudeCompactionResult({ ...localScope, nativeSessionId: session.nativeSessionId }, message.uuid, 'completed')
      expect((await restarted.manager.reconcileCompaction!(rebound, pending)).status).toBe('completed')
      expect(f.offers).toHaveBeenCalledOnce()
      expect(restarted.offers).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose!()
      await restarted.manager.dispose!()
      await rm(profilePath, { recursive: true, force: true })
    }
  },
)
