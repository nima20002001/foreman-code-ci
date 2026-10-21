import assert from 'node:assert/strict'
import { CODEX_INTERACTION_SUPPORT, type InteractionResponseValue } from '@foreman-code/contracts'
import { describe, it, onTestFailed } from 'vitest'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { isObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { codexResponseSurfaceFixtures } from './fixtures/codex-response-surfaces.js'
import { agentMessage, collect, emit, finish, processesForRequests, state, until } from './fixtures/codex-test-helpers.js'
import {
  CodexAppServerSessionManager,
  managers,
  f,
  manager,
  source,
  makeManager,
  codex,
  flag,
  wire,
  start,
  pending,
  inject,
  responseQuery,
  respond,
  assertCode,
  useCodexFixture,
} from './codex-app-server.test-support.js'

describe.skipIf(process.platform === 'win32')('Codex app-server regressions against the real manager', () => {
  useCodexFixture()

  it('accepts a delayed turn reply without treating submission as uncertain', async () => {
    const session = await manager.createSession(source)
    for await (const event of manager.startTurn(session, {
      prompt: 'late-start', clientCorrelationId: 'delayed-reply',
    })) {
      if (event.type === 'turn.started') await finish(f.directory, session.nativeSessionId)
    }
    assert.equal((await manager.history(session)).terminalResult?.outcome, 'succeeded')
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('F15: native resolution clears the addressed prompt and a duplicate cannot reopen it', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const original = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!
    await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 901 } })
    await until(async () => (await manager.history(session)).pendingInteractions.length === 0)
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'command-901', command: 'printf harmless', cwd: f.directory, availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }, 901)
    await emit(f.directory, { method: 'item/started', params: {
      threadId: session.nativeSessionId, turnId: original.id, startedAtMs: 1,
      item: agentMessage('after-duplicate', '', 'commentary'),
    } })
    await until(async () => (await manager.history(session)).events.some((event) =>
      event.type === 'item.started' && isObject(event.payload.item) && event.payload.item.id === 'after-duplicate'))
    assert.equal(await manager.pending(session), undefined)
    assert.equal((await wire()).filter((message) => message.id === 901 && message.error).length, 0)
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: { ...original, status: 'completed' } } })
    await result
    assert(value.turn.nativeRequestId)
  })

  for (const surface of ['workflow', 'operator', 'agent-chat', 'selected-run-continuation']) {
    it(`inspects a current ${surface} callback from its explicit native startup shape`, async () => {
      const fixtureSource = codexResponseSurfaceFixtures(f.directory).find((entry) => entry.surface === surface)!
      const scoped = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, fixtureSource.appMcpAccess)
      managers.push(scoped)
      const session = await scoped.createSession(fixtureSource.source)
      const events = collect(scoped.startTurn(session, { prompt: 'approval', clientCorrelationId: `${surface}-fixture-turn` }))
      const value = await until(() => scoped.pending(session))
      const lifetime = scoped.originalSessionLifetime(session, fixtureSource.source)!
      assert(lifetime)
      assert.equal(lifetime.residency.nativeTurnId, value.turn.nativeTurnId)
      assert.deepEqual(await scoped.reattachOriginalSession(session, fixtureSource.source, lifetime.residency), session)
      lifetime.assertCurrent()
      const query = responseQuery(value)
      const before = await wire()
      const inspected = await scoped.inspectResponseAvailability(session, query)
      assert.equal(inspected.state, 'available')
      assert.equal(inspected.path, 'live_callback')
      assert(inspected.generation)
      assert.deepEqual(await wire(), before)
      if (fixtureSource.appMcpAccess === 'none') assert.equal(fixtureSource.source.environment, undefined)
      if (fixtureSource.surface === 'selected-run-continuation') assert.equal(fixtureSource.runtimeRole, 'agent-chat')
      const current = await state(f.directory, session.nativeSessionId)
      await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId,
        turn: { ...current.turns.at(-1)!, status: 'completed', completedAt: 2 } } }, fixtureSource.inboxAgentId)
      await events
      assert.equal((await scoped.inspectResponseAvailability(session, query)).state, 'unavailable')
    })
  }

  it('inspects only the exact live response callback without native writes or history changes', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    const beforeWire = await wire()
    const beforeHistory = await manager.history(session)
    const available = await manager.inspectResponseAvailability(session, query)
    assert.equal(available.state, 'available')
    assert.equal(available.path, 'live_callback')
    assert.equal(available.reason, 'live_callback')
    assert.equal(available.qualified, true)
    assert(available.generation)
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(manager.inspectResponseAvailability(session, query, aborted.signal))
    for (const [changed, reason] of [
      [{ ...query, nativeRequestId: 'not-the-callback' }, 'callback_lost'],
      [{ ...query, nativeRequestType: 'item/fileChange/requestApproval' }, 'identity_mismatch'],
      [{ ...query, expectedNativeTurnId: 'older-turn' }, 'identity_mismatch'],
    ] as const) {
      const rejected = await manager.inspectResponseAvailability(session, changed)
      assert.equal(rejected.state, 'unavailable')
      assert.equal(rejected.reason, reason)
    }
    assert.equal((await manager.inspectResponseAvailability({ ...session, nativeSessionId: 'another-thread' }, query)).state, 'unavailable')
    assert.deepEqual(await wire(), beforeWire)
    assert.deepEqual(await manager.history(session), beforeHistory)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('fences a conflicting exact RPC identity without replying to either approval', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    const before = await wire()
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'different-command', command: 'printf conflicting-command', cwd: f.directory,
      availableDecisions: ['accept', 'decline'],
    }, 901)
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'protocol.conflicting_request_identity'))
    const availability = await manager.inspectResponseAvailability(session, query)
    assert.equal(availability.state, 'recovery_required')
    assert.equal(availability.reason, 'identity_mismatch')
    await assertCode(manager.respond(session, query.nativeRequestId, value.responseOptions[0]!), 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    assert.deepEqual(await wire(), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('requires response recovery after submission or uncertainty instead of offering the callback again', async () => {
    await flag('no-resolution')
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    const controller = new AbortController()
    const response = manager.respond(session, query.nativeRequestId, value.responseOptions[0]!, controller.signal)
    void response.catch(() => { /* ignore: the abandoned response settles after the assertions; its outcome is not under test. */ })
    assert.equal((await manager.inspectResponseAvailability(session, query)).state, 'recovery_required')
    await until(async () => (await manager.history(session)).interactionDeliveries?.[0]?.state === 'submitted')
    assert.equal((await manager.inspectResponseAvailability(session, query)).state, 'recovery_required')
    assert.equal((await manager.inspectResponseAvailability(session, query)).reason, 'response_in_flight')
    controller.abort(new Error('stop waiting for delivery confirmation'))
    await assert.rejects(response)
    // The fake server records receipt after the manager's pipe write completes.
    const before = await until(async () => {
      const messages = await wire()
      return messages.some((message) => message.id === 901 && message.result) && messages
    })
    assert.deepEqual(before.filter((message) => message.id === 901 && message.result), [
      { id: 901, result: { decision: 'accept' } },
    ])
    assert.equal((await manager.inspectResponseAvailability(session, query)).state, 'recovery_required')
    assert.deepEqual(await wire(), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('reports a consumed exact callback without inferring which response was delivered', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const query = responseQuery(value)
    await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 901 } })
    await until(async () => (await manager.history(session)).pendingInteractions.length === 0)
    const before = await wire()
    const consumed = await manager.inspectResponseAvailability(session, query)
    assert.equal(consumed.state, 'unavailable')
    assert.equal(consumed.reason, 'request_consumed')
    assert.equal(consumed.path, null)
    assert.deepEqual(await wire(), before)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('requires a fresh callback after same-manager native reconnection', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const old = await pending(session)
    const oldQuery = responseQuery(old)
    const original = await manager.inspectResponseAvailability(session, oldQuery)
    const launched = (await processesForRequests(f.directory, 'thread/start'))[0]
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'transport.disconnected'))
    await result
    await manager.reconcile(session, 'turn-correlation')
    const recovered = await manager.inspectResponseAvailability(session, oldQuery)
    assert.equal(recovered.state, 'recovery_required')
    assert.equal(recovered.path, null)
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'command-901', command: 'printf harmless', cwd: f.directory,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }, 901)
    const fresh = await pending(session)
    assert.notEqual(fresh.turn.nativeRequestId, old.turn.nativeRequestId)
    const available = await manager.inspectResponseAvailability(session, responseQuery(fresh))
    assert.equal(available.state, 'available')
    assert.notEqual(available.generation, original.generation)
    assert.equal((await manager.inspectResponseAvailability(session, oldQuery)).state, 'recovery_required')
  })

  it('does not alias a saved callback after cold attach reuses the same turn and native RPC ID', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const old = await pending(session)
    const oldQuery = responseQuery(old)
    await manager.closeForRestart(session)
    await result
    assert.equal((await manager.inspectResponseAvailability(session, oldQuery)).state, 'unavailable')
    const replacement = makeManager()
    await replacement.attachSession(session, source)
    await replacement.reconcile(session, 'turn-correlation')
    assert.equal((await replacement.inspectResponseAvailability(session, oldQuery)).reason, 'callback_lost')
    await inject(session, 'item/commandExecution/requestApproval', {
      itemId: 'different-command-901', command: 'printf fresh-command', cwd: f.directory,
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    }, 901)
    const fresh = await until(() => replacement.pending(session))
    assert.equal(fresh.turn.nativeTurnId, old.turn.nativeTurnId)
    assert.notEqual(fresh.turn.nativeRequestId, old.turn.nativeRequestId)
    assert.notEqual(fresh.responseOptions[0]!.optionId, old.responseOptions[0]!.optionId)
    const before = await wire()
    assert.equal((await replacement.inspectResponseAvailability(session, oldQuery)).state, 'unavailable')
    assert.equal((await replacement.inspectResponseAvailability(session, responseQuery(fresh))).state, 'available')
    await assertCode(replacement.respond(session, oldQuery.nativeRequestId, old.responseOptions[0]!), 'NATIVE_RESPONSE_UNKNOWN_REQUEST')
    assert.deepEqual(await wire(), before)
    assert.equal((await wire('thread/start')).length, 1)
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('closing a session during capacity backoff cancels the wait without resubmitting', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const current = await state(f.directory, session.nativeSessionId)
    await emit(f.directory, { method: 'turn/completed', params: { threadId: session.nativeSessionId, turn: {
      ...current.turns.at(-1), status: 'failed', completedAt: 2,
      error: { message: 'Selected model is at capacity.', codexErrorInfo: 'serverOverloaded', additionalDetails: null },
    } } })
    await until(async () => (await manager.history(session)).events.some(event => event.type === 'turn.capacity_wait'))
    await manager.close(session)
    const events = await result
    assert.equal(events.filter(event => event.type === 'turn.retry_canceled').length, 1)
    assert.equal((await wire('turn/start')).length, 1)
  })

  it('F16/F17: pipe submission keeps the mapping; uncertain responses cannot be retransmitted', async () => {
    await flag('no-resolution')
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const value = await pending(session)
    const option = value.responseOptions[0]!
    const abort = new AbortController()
    const response = manager.respond(session, value.turn.nativeRequestId!, option, abort.signal)
    void response.catch(() => { /* ignore: the abandoned response settles after the assertions; its outcome is not under test. */ })
    await until(async () => (await manager.history(session)).interactionDeliveries?.[0]?.state === 'submitted')
    assert.equal(await manager.pending(session), undefined)
    assert.equal((await manager.history(session)).pendingInteractions.length, 1)
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.responded'))
    abort.abort(new Error('stop awaiting confirmation'))
    await assert.rejects(response)
    await assertCode(manager.respond(session, value.turn.nativeRequestId!, option), 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    await manager.reconcile(session, 'turn-correlation')
    await assertCode(manager.respond(session, value.turn.nativeRequestId!, option), 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
    assert.equal((await wire()).filter((message) => message.id === 901 && message.result).length, 1)
    await emit(f.directory, { method: 'serverRequest/resolved', params: { threadId: session.nativeSessionId, requestId: 901 } })
    await until(async () => (await manager.history(session)).pendingInteractions.length === 0)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('restart closes a pending approval without selecting or widening a native permission', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    await pending(session)
    await manager.closeForRestart(session)
    await result.catch(() => { /* ignore: closing for restart ends the turn; only the absence of a replayed answer is under test. */ })
    assert.equal((await wire()).filter((message) => message.id === 901 && message.result).length, 0)
    assert.equal((await wire()).filter((message) => message.id === 901 && message.error).length, 0)
  })

  it('F18/F32: duplicate native requests are idempotent and legitimate concurrent requests are retained', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'multi')
    await until(async () => (await manager.history(session)).pendingInteractions.length === 2)
    const first = await pending(session)
    await respond(session, first)
    const second = await pending(session)
    assert.notEqual(first.turn.nativeRequestId, second.turn.nativeRequestId)
    await respond(session, second)
    await result
    assert.equal((await wire()).filter((message) => [901, 1901].includes(message.id as number) && message.error).length, 0)
    assert.equal((await wire()).filter((message) => [901, 1901].includes(message.id as number) && message.result).length, 2)
  })

  it('F19/F10: qualified tool approval choices have exact semantics and empty descriptions are safe', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'mcp_tool_call_approval_tool', header: 'Approve app tool call?', question: 'Allow?', isOther: false, isSecret: false,
      options: ['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel'].map((label) => ({ label, description: '' })),
    }] })
    const value = await pending(session)
    assert.deepEqual(value.responseOptions.map((option) => option.semantic), ['approve_once', 'allow_session', 'persistent_policy_change', 'cancel'])
    assert(value.responseOptions.every((option) => option.scopeSummary === undefined))
    assert.equal(value.responseOptions.at(-1)!.interruptsCurrentTurn, false)
    await respond(session, value, 'cancel')
    const response = (await wire()).find((entry) => entry.id === 4000 && entry.result)!
    assert.deepEqual(response.result, { answers: { mcp_tool_call_approval_tool: { answers: ['Cancel'] } } })
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('keeps generic questions pending until an explicit valid answer is supplied', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'generic', header: 'Question', question: 'Choose', isOther: false, isSecret: false,
      options: ['Decline', 'Cancel'].map((label) => ({ label, description: '' })),
    }] })
    const value = await pending(session)
    const option = value.responseOptions[0]!
    assert.equal(option.input?.kind, 'questions')
    assert.equal((await wire()).filter((message) => message.id === 4000 && message.result).length, 0)
    await assert.rejects(manager.respond(session, value.turn.nativeRequestId!, { ...option,
      response: { generic: { answers: ['invented'] } } }))
    assert.equal((await manager.pending(session))?.turn.nativeRequestId, value.turn.nativeRequestId)
    await manager.respond(session, value.turn.nativeRequestId!, { ...option,
      response: { generic: { answers: ['Decline'] } } })
    assert.deepEqual((await wire()).find((message) => message.id === 4000 && message.result)!.result,
      { answers: { generic: { answers: ['Decline'] } } })
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    assert.equal(await manager.pending(session), undefined)
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('answers the supported MCP approval question only after an explicit offered choice', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'mcp_tool_call_approval_tool', header: 'Approve app tool call?', question: 'Allow?',
        isOther: false, isSecret: false, options: ['Allow', 'Cancel'].map((label) => ({ label, description: '' })) }] })
    const value = await pending(session)
    assert.equal((await wire()).filter((message) => message.id === 4000 && (message.result || message.error)).length, 0)
    await respond(session, value)
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result,
      { answers: { mcp_tool_call_approval_tool: { answers: ['Allow'] } } })
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    await finish(f.directory, session.nativeSessionId); await result
  })

  for (const mode of ['url', 'form'] as const) it(`F20: ${mode} confirmation has an exact native acceptance path`, async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const extra = mode === 'url' ? { url: 'https://example.invalid/authorize', elicitationId: 'authorization-1' } : { requestedSchema: { type: 'object', properties: {} } }
    await inject(session, 'mcpServer/elicitation/request', { mode, message: 'Confirm', serverName: 'app', _meta: null, ...extra })
    const value = await pending(session)
    await respond(session, value)
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result, { action: 'accept', content: mode === 'url' ? null : {}, _meta: null })
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('F20: qualified elicitation scope metadata is preserved, not guessed from labels', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', {
      mode: 'form', message: 'Allow tool', serverName: 'app', requestedSchema: { type: 'object', properties: {} },
      _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'] },
    })
    const value = await pending(session)
    assert(value.responseOptions.some((option) => option.semantic === 'persistent_policy_change' && option.mutatesPersistentPolicy))
    await respond(session, value, 'allow_session')
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result, { action: 'accept', content: {}, _meta: { persist: 'session' } })
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('answers standalone elicitations explicitly without attaching them to an old turn', async () => {
    const session = await manager.createSession(source)
    for (const afterTurn of [false, true]) {
      if (afterTurn) await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'old' }))
      const id = afterTurn ? 4001 : 4000
      await emit(f.directory, { id, method: 'mcpServer/elicitation/request', params: { threadId: session.nativeSessionId, turnId: null,
        mode: 'url', url: 'https://example.invalid/', elicitationId: 'standalone', serverName: 'app', message: 'Authorize', _meta: null } })
      const value = await pending(session)
      assert.equal(value.turn.nativeTurnId, undefined)
      assert.equal((await wire()).filter((entry) => entry.id === id && entry.result).length, 0)
      const availability = await manager.inspectResponseAvailability(session, {
        nativeRequestId: value.turn.nativeRequestId!, nativeRequestType: value.nativeRequestType,
      })
      assert.equal(availability.state, 'available')
      await respond(session, value)
      assert.deepEqual((await wire()).find((entry) => entry.id === id && entry.result)!.result,
        { action: 'accept', content: null, _meta: null })
      assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
      assert.equal(await manager.pending(session), undefined)
    }
  })

  it.each(['form', 'openai/form', 'openaiForm'])('validates %s data-entry forms before writing the user response', async (mode) => {
    let phase = 'creating session'
    onTestFailed(() => { console.error(`Codex ${mode} data-entry failure during ${phase}`) })
    const session = await manager.createSession(source)
    phase = 'starting turn'
    const { result } = await start(session)
    phase = 'injecting form'
    const requestedSchema = { type: 'object', properties: { email: { type: 'string', format: 'email' } },
      required: ['email'], ...(mode === 'form' ? {} : { additionalProperties: false }) }
    await inject(session, 'mcpServer/elicitation/request', { mode, serverName: 'app', message: 'Enter email', _meta: null,
      requestedSchema }, 4002)
    phase = 'waiting for form'
    const value = await pending(session)
    const option = value.responseOptions[0]!
    assert.equal((await wire()).filter((entry) => entry.id === 4002 && entry.result).length, 0)
    const invalidResponses: InteractionResponseValue[] = [{}, { email: 'invalid' }, { email: 42 },
      ...(mode === 'form' ? [] : [{ email: 'user@example.com', extra: true }])]
    for (const response of invalidResponses) {
      phase = `rejecting invalid form: ${JSON.stringify(response)}`
      await assert.rejects(manager.respond(session, value.turn.nativeRequestId!, { ...option, response }))
    }
    assert.equal((await manager.pending(session))?.turn.nativeRequestId, value.turn.nativeRequestId)
    assert.equal((await wire()).filter((entry) => entry.id === 4002 && entry.result).length, 0)
    const response: InteractionResponseValue = { email: 'user@example.com', ...(mode === 'form' ? { extra: true } : {}) }
    phase = 'delivering valid form'
    await manager.respond(session, value.turn.nativeRequestId!, { ...option, response })
    phase = 'reading delivered form'
    assert.deepEqual((await wire()).find((entry) => entry.id === 4002 && entry.result)!.result,
      { action: 'accept', content: response, _meta: null })
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    assert.equal(await manager.pending(session), undefined)
    phase = 'finishing turn'
    await finish(f.directory, session.nativeSessionId)
    phase = 'draining terminal turn'
    await result
  })

  it('rejects a malformed standard form envelope before offering input', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Enter email',
      requestedSchema: { type: 'object', additionalProperties: false,
        properties: { email: { type: 'string', format: 'email' } }, required: ['email'] } }, 4003)
    const rejected = await until(async () => (await wire()).find((entry) => entry.id === 4003 && entry.error))
    assert(isObject(rejected.error))
    assert.equal(rejected.error.code, -32602)
    assert.equal(await manager.pending(session), undefined)
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('does not resend answered questions for repeated or conflicting callback identities', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const question = { itemId: 'question', isBlocking: true, autoResolutionMs: null, questions: [{
      id: 'generic', header: 'Question', question: 'Choose', isOther: true, isSecret: false, options: null,
    }] }
    await inject(session, 'item/tool/requestUserInput', question)
    const value = await pending(session)
    await manager.respond(session, value.turn.nativeRequestId!, { ...value.responseOptions[0]!,
      response: { generic: { answers: ['User-entered answer'] } } })
    await inject(session, 'item/tool/requestUserInput', question)
    await inject(session, 'item/tool/requestUserInput', { ...question, itemId: 'conflicting-question' })
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'protocol.conflicting_request_identity'))
    assert.equal((await wire()).filter((entry) => entry.id === 4000 && (entry.result || entry.error)).length, 1)
    assert.equal((await manager.history(session)).events.filter((event) => event.type === 'interaction.unsupported').length, 0)
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('advertises question and schema-validated form support', async () => {
    const capabilities = await manager.capabilities()
    assert.deepEqual(capabilities.interactionSupport, CODEX_INTERACTION_SUPPORT)
    assert(capabilities.supportedInteractionKinds.includes('mcp_tool_call_approval_question'))
    assert(capabilities.supportedInteractionKinds.includes('mcp_confirmation'))
    assert(capabilities.supportedInteractionKinds.includes('tool_user_input'))
    assert(capabilities.supportedInteractionKinds.includes('mcp_elicitation'))
  })

  it.each(['foreign-thread', 'old-turn'])('keeps form responses behind the %s ownership fence', async (target) => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    await inject(session, 'mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Enter email',
      _meta: null, requestedSchema: { type: 'object', properties: { email: { type: 'string' } } },
      ...(target === 'foreign-thread' ? { threadId: 'foreign-thread' } : { turnId: 'old-turn' }) })
    await until(async () => (await wire()).some((entry) => entry.id === 4000 && entry.error))
    assert.equal((await wire()).filter((entry) => entry.id === 4000 && entry.result).length, 0)
    assert(!(await manager.history(session)).events.some((event) => event.type === 'interaction.unsupported'))
    await finish(f.directory, session.nativeSessionId); await result
  })

  it('F22: distinct network and exec policy amendments retain distinct option IDs and targets', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const decisions = [
      { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'allow', host: 'a.example' } } },
      { applyNetworkPolicyAmendment: { network_policy_amendment: { action: 'deny', host: 'b.example' } } },
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'status'] } },
      { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['git', 'diff'] } },
    ]
    await inject(session, 'item/commandExecution/requestApproval', { itemId: 'cmd', availableDecisions: decisions })
    const value = await pending(session)
    assert.equal(new Set(value.responseOptions.map((option) => option.optionId)).size, 4)
    assert(value.responseOptions[0]!.label.includes('allow') && value.responseOptions[0]!.label.includes('a.example'))
    assert(value.responseOptions[1]!.label.includes('deny') && value.responseOptions[1]!.label.includes('b.example'))
    await manager.respond(session, value.turn.nativeRequestId!, value.responseOptions[1]!)
    assert.deepEqual((await wire()).find((entry) => entry.id === 4000 && entry.result)!.result, { decision: decisions[1] })
    await finish(f.directory, session.nativeSessionId); await result
  })

  for (const kind of ['command', 'file', 'permissions', 'tool', 'elicitation']) it(`F23: ephemeral ${kind} requests never offer session grants`, async () => {
    codex().advanced!.sessionPersistence = 'ephemeral'
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const requests: Record<string, [string, JsonObject]> = {
      command: ['item/commandExecution/requestApproval', { itemId: 'cmd', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] }],
      file: ['item/fileChange/requestApproval', { itemId: 'file', reason: null, grantRoot: null }],
      permissions: ['item/permissions/requestApproval', { itemId: 'permission', cwd: f.directory, permissions: {} }],
      tool: ['item/tool/requestUserInput', { itemId: 'tool', isBlocking: true, autoResolutionMs: null, questions: [{ id: 'mcp_tool_call_approval_t', header: 'Approve app tool call?', question: 'Allow?', isOther: false, isSecret: false, options: ['Allow', 'Allow for this session', 'Cancel'].map((label) => ({ label, description: '' })) }] }],
      elicitation: ['mcpServer/elicitation/request', { mode: 'form', serverName: 'app', message: 'Confirm', requestedSchema: { type: 'object', properties: {} }, _meta: { codex_approval_kind: 'mcp_tool_call', persist: 'session' } }],
    }
    const [method, params] = requests[kind]!
    await inject(session, method, params)
    const value = await pending(session)
    assert(!value.responseOptions.some((option) => option.semantic === 'allow_session'))
    await manager.respond(session, value.turn.nativeRequestId!, value.responseOptions[0]!)
    await finish(f.directory, session.nativeSessionId); await result
  })
})
