import { SessionPreferencesSchema, type CompactionState } from '@foreman-code/contracts'
import { appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { describe, it, vi } from 'vitest'
import type { WorkflowNativeSessionStart, AgentChatNativeSessionStart } from '../src/modules/harnesses/port.js'
import type { ThreadItem, Turn } from '../src/modules/harnesses/codexMethodTypes.js'
import type { JsonObject } from '../src/modules/harnesses/codexStdioTransport.js'
import { codexResponseSurfaceFixtures } from './fixtures/codex-response-surfaces.js'
import {
  calls,
  collect,
  emit,
  errorCode,
  finish,
  fixtureProtocol,
  input,
  nativeThread,
  processesForRequests,
  state,
  until,
} from './fixtures/codex-test-helpers.js'
import {
  CodexAppServerSessionManager,
  managers,
  f,
  manager,
  source,
  makeManager,
  codex,
  flag,
  unflag,
  json,
  wire,
  start,
  pending,
  assertCode,
  assertDead,
  assertSpawnedEnvironment,
  assertMetadataProcessesClosed,
  useCodexFixture,
  setManager,
  setSource,
} from './codex-app-server.test-support.js'

describe('Codex fixture user-message contract', () => {
  const userMessage = {
    type: 'userMessage', id: 'native-item-123', clientId: 'application-request-456',
    content: [{ type: 'text', text: 'hello', text_elements: [] }],
  } satisfies ThreadItem
  const turn = {
    id: 'native-turn-1', items: [userMessage], itemsView: 'full', status: 'inProgress',
    error: null, startedAt: 1, completedAt: null, durationMs: null,
  } satisfies Turn
  const surfaces: Array<{ name: string; validate(item: JsonObject): void }> = [
    { name: 'turn/start response', validate: (item) => fixtureProtocol.response('turn/start', {
      turn: { ...turn, items: [item] },
    }) },
    { name: 'thread/read response', validate: (item) => fixtureProtocol.response('thread/read', {
      thread: nativeThread({ turns: [{ ...turn, items: [item as ThreadItem] }] }),
    }) },
    { name: 'thread/turns/list response', validate: (item) => fixtureProtocol.response('thread/turns/list', {
      data: [{ ...turn, items: [item] }], nextCursor: null, prevCursor: null,
    }) },
    ...['turn/started', 'turn/completed'].map((method) => ({
      name: `${method} notification`, validate: (item: JsonObject) => fixtureProtocol.notification({
        method, params: { threadId: 'native-thread-1', turn: { ...turn, items: [item] } },
      }),
    })),
    ...['item/started', 'item/completed'].map((method) => ({
      name: `${method} notification`, validate: (item: JsonObject) => fixtureProtocol.notification({
        method, params: { threadId: 'native-thread-1', turnId: turn.id, item, startedAtMs: 1, completedAtMs: 2 },
      }),
    })),
  ]

  for (const surface of surfaces) {
    it(`validates separate native/app identities and nullable clientId on ${surface.name}`, () => {
      assert.doesNotThrow(() => surface.validate(userMessage))
      const uncorrelated = { ...userMessage, clientId: null } satisfies ThreadItem
      assert.doesNotThrow(() => surface.validate(uncorrelated))
      const noClientId: JsonObject = { ...userMessage }
      delete noClientId.clientId
      assert.doesNotThrow(() => surface.validate(noClientId))
      assert.doesNotThrow(() => surface.validate({ ...userMessage, id: userMessage.clientId }))
    })

    it(`rejects malformed user-message identities and content on ${surface.name}`, () => {
      const missingId: JsonObject = { ...userMessage }
      delete missingId.id
      for (const item of [
        missingId,
        { ...userMessage, id: 123 },
        { ...userMessage, clientId: 456 },
        { ...userMessage, content: {} },
        { ...userMessage, content: [{ type: 'text', text: 123 }] },
        { ...userMessage, content: [{ type: 'localImage', path: 123 }] },
        { ...userMessage, content: [{ type: 'text', text: 'hello', text_elements: [
          { byteRange: { start: 'bad', end: 1 } },
        ] }] },
      ]) assert.throws(() => surface.validate(item))
    })

    it(`validates other thread item variants on ${surface.name}`, () => {
      const agentMessage = { type: 'agentMessage', id: 'assistant-item', text: 'hello', phase: 'commentary' }
      const command = { type: 'commandExecution', id: 'command-item', command: 'printf hello',
        commandActions: [], cwd: process.cwd(), status: 'completed' }
      assert.doesNotThrow(() => surface.validate(agentMessage))
      assert.doesNotThrow(() => surface.validate(command))
      assert.throws(() => surface.validate({ ...agentMessage, text: 123 }))
      assert.throws(() => surface.validate({ ...agentMessage, memoryCitation: { entries: [{}], threadIds: [] } }))
      assert.throws(() => surface.validate({ ...command, commandActions: [{}] }))
      assert.throws(() => surface.validate({ type: 'inventedItem', id: 'unknown-item' }))
    })
  }

  it('validates the native turn identity in steer acknowledgements', () => {
    assert.doesNotThrow(() => fixtureProtocol.response('turn/steer', { turnId: turn.id }))
    assert.throws(() => fixtureProtocol.response('turn/steer', {}))
    assert.throws(() => fixtureProtocol.response('turn/steer', { turnId: 123 }))
  })
})

describe.skipIf(process.platform === 'win32')('Codex app-server regressions against the real manager', () => {
  useCodexFixture()

  it('starts one session process after model inspection and retains it for the first turn', async () => {
    const session = await manager.createSession(source)
    const launched = await processesForRequests(f.directory, 'thread/start')
    const inspections = await processesForRequests(f.directory, 'model/list')
    assert.equal(launched.length, 1)
    assert.equal(inspections.length, 1)
    assert.notEqual(launched[0]!.pid, inspections[0]!.pid)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'first-turn' }))
    const turnProcesses = await processesForRequests(f.directory, 'turn/start')
    assert.equal(turnProcesses.length, 1)
    assert.equal(turnProcesses[0]!.pid, launched[0]!.pid)
    assert.equal((await processesForRequests(f.directory, 'thread/start')).length, 1)
  })

  it('lets an unattended workflow Agent call only its App MCP tools without native prompts', async () => {
    await manager.createSession(source)
    const chats = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none')
    managers.push(chats)
    await chats.createSession({ kind: 'agent-chat', conversationId: 'attended-chat', workflowId: 'saved-workflow',
      workflowNodeId: 'chat-node', correlationId: 'chat-request', configuration: source.request.configuration,
      workingDirectory: f.directory })
    const [workflow, chat] = (await wire('thread/start')).map(frame => (frame.params as JsonObject).config as JsonObject)
    assert.equal(workflow!['mcp_servers.graphql.default_tools_approval_mode'], 'approve')
    assert.deepEqual(Object.keys(workflow!).filter(key => key.endsWith('.default_tools_approval_mode')),
      ['mcp_servers.graphql.default_tools_approval_mode'])
    assert.equal(chat!['mcp_servers.graphql.default_tools_approval_mode'], undefined)
  })

  it('owns two node chats independently with one Agent configuration and no workflow execution descriptor', async () => {
    const chats = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none')
    managers.push(chats)
    const first: AgentChatNativeSessionStart = { kind: 'agent-chat', conversationId: 'node-chat-one',
      workflowId: 'saved-workflow', workflowNodeId: 'first-node', correlationId: 'same-request',
      configuration: source.request.configuration, workingDirectory: f.directory }
    const second = { ...first, conversationId: 'node-chat-two', workflowNodeId: 'second-node' }
    const one = await chats.createSession(first)
    const two = await chats.createSession(second)
    assert.notEqual(one.nativeSessionId, two.nativeSessionId)
    assert.deepEqual(await chats.createSession(first), one)
    await assert.rejects(chats.attachSession(one, second), errorCode('CODEX_SESSION_OWNER_MISMATCH'))
    const starts = await wire('thread/start')
    assert.equal(starts.length, 2)
    for (const frame of starts) {
      assert.equal((frame.params as JsonObject).sandbox, codex().sandbox)
      assert.equal((frame.params as JsonObject).cwd, f.directory)
    }
  })

  it('releases the native fence when dispatch metadata cannot be saved before sending', async () => {
    const session = await manager.createSession(source)
    await assert.rejects(manager.compactSession(session, { requestId: 'compact-request', clientCorrelationId: 'control-request',
      onProgress: async () => {}, onDispatch: async () => { throw new Error('Dispatch storage failed') } }), /Dispatch storage failed/)
    assert.equal((await wire('thread/compact/start')).length, 0)
    const task = await start(session, 'follow-up', 'after-preflight')
    await finish(f.directory, session.nativeSessionId)
    await task.result
  })

  it('recovers a resident compaction from native history when completion notifications are lost', async () => {
    const session = await manager.createSession(source)
    await flag('drop-compact-events')
    const abort = new AbortController()
    let control: CompactionState | undefined
    const operation = manager.compactSession(session, { requestId: 'compact-request', clientCorrelationId: 'control-request',
      onProgress: async value => { control = value } }, abort.signal)
    await until(async () => (await wire('thread/compact/start')).length === 1)
    abort.abort(new Error('Completion notification lost'))
    await assert.rejects(operation)
    const recovered = await manager.reconcileCompaction(session, { ...control!, status: 'uncertain' })
    assert.equal(recovered.status, 'completed')
    assert.equal((await wire('thread/compact/start')).length, 1)
    const turn = await start(session, 'follow-up', 'after-compaction')
    await finish(f.directory, session.nativeSessionId)
    await turn.result
  })

  it('preserves definite compaction rejection and permits another command and follow-up turn', async () => {
    const session = await manager.createSession(source)
    await flag('reject-compact')
    let control: CompactionState | undefined
    await assert.rejects(manager.compactSession(session, { requestId: 'rejected-control', clientCorrelationId: 'rejected-control',
      onProgress: async value => { control = value } }), error => {
      assert.equal((error as { uncertain: boolean }).uncertain, false)
      return true
    })
    assert.equal((await manager.reconcileCompaction(session, { ...control!, status: 'uncertain' })).status, 'failed')
    await unflag('reject-compact')
    const completed = await manager.compactSession(session, { requestId: 'next-control', clientCorrelationId: 'next-control',
      onProgress: async () => {} })
    assert.equal(completed.status, 'completed')
    const followup = await start(session, 'next task', 'after-rejection')
    await finish(f.directory, session.nativeSessionId)
    await followup.result
  })

  it.each(['timeout', 'disconnect'] as const)(
    'recovers a cold compaction after %s through thread read without another dispatch', async outcome => {
    const session = await manager.createSession(source)
    await flag('drop-compact-events')
    if (outcome === 'disconnect') await flag('disconnect-compact')
    const abort = new AbortController()
    let control: CompactionState | undefined
    const operation = manager.compactSession(session, { requestId: 'cold-compact-request', clientCorrelationId: 'cold-control',
      onProgress: async value => { control = value } }, abort.signal)
    const rejected = assert.rejects(operation)
    await until(async () => (await wire('thread/compact/start')).length === 1)
    if (outcome === 'timeout') abort.abort(new DOMException('Native response timed out', 'TimeoutError'))
    await rejected
    await manager.shutdown()
    const before = (await wire()).length
    const cold = makeManager()
    const recovered = await cold.readCompaction(session, source, { ...control!, status: 'uncertain' })
    assert.equal(recovered.status, 'completed')
    const reads = (await wire()).slice(before).map(entry => entry.method)
    assert(reads.includes('thread/read'))
    assert(!reads.includes('thread/resume'))
    assert(!reads.includes('turn/start'))
    assert.equal((await wire('thread/compact/start')).length, 1)
  })

  it('offers budgets from native default usage and retains the capacity while an override is applied', async () => {
    const session = await manager.createSession(source)
    assert.deepEqual((await manager.sessionControlCapabilities(session)).contextBudgets, [])
    await assertCode(manager.applySessionPreferences(session,
      SessionPreferencesSchema.parse({ contextBudget: 100000 })), 'CODEX_CONTEXT_BUDGET_INVALID')
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'default-window' }))
    const turnId = (await state(f.directory, session.nativeSessionId)).turns.at(-1)!.id
    const usage = { inputTokens: 900, cachedInputTokens: 0, outputTokens: 100,
      reasoningOutputTokens: 0, totalTokens: 1000 }
    await emit(f.directory, { method: 'thread/tokenUsage/updated', params: {
      threadId: session.nativeSessionId, turnId,
      tokenUsage: { last: usage, total: usage, modelContextWindow: 200000 },
    } })
    await until(async () => manager.contextSnapshot(session)?.capacityTokens === 200000)
    assert.deepEqual((await manager.sessionControlCapabilities(session)).contextBudgets, [100000, 200000])
    await manager.applySessionPreferences(session, SessionPreferencesSchema.parse({ contextBudget: 100000 }))
    assert.equal(manager.appliedSessionPreferences(session)?.contextBudget, 100000)
    await emit(f.directory, { method: 'thread/tokenUsage/updated', params: {
      threadId: session.nativeSessionId, turnId,
      tokenUsage: { last: usage, total: usage, modelContextWindow: 100000 },
    } })
    await until(async () => manager.contextSnapshot(session)?.capacityTokens === 100000)
    const capabilities = await manager.sessionControlCapabilities(session)
    assert.equal(capabilities.modelCapacity, 200000)
    assert.deepEqual(capabilities.contextBudgets, [100000, 200000])
    const last = (await wire('thread/resume')).at(-1)!
    assert.equal((last.params as { config: Record<string, unknown> }).config.model_context_window, 100000)
  })

  it('preserves a saved budget on creation and cold resume without inventing model capacity', async () => {
    setSource({ ...source, sessionPreferences: SessionPreferencesSchema.parse({ contextBudget: 100000 }) })
    const session = await manager.createSession(source)
    const capabilities = await manager.sessionControlCapabilities(session)
    assert.deepEqual(capabilities.contextBudgets, [])
    assert.equal(capabilities.modelCapacity, null)
    assert(capabilities.contextBudgetReason)
    assert.equal(manager.appliedSessionPreferences(session)?.contextBudget, 100000)
    const creation = (await wire('thread/start')).at(-1)!
    assert.equal((creation.params as { config: Record<string, unknown> }).config.model_context_window, 100000)
    await manager.closeForRestart(session)
    const resumed = makeManager()
    assert.deepEqual(await resumed.attachSession(session, source), session)
    assert.equal(resumed.appliedSessionPreferences(session)?.contextBudget, 100000)
    assert.deepEqual((await resumed.sessionControlCapabilities(session)).contextBudgets, [])
    const resumes = (await wire('thread/resume')).length
    await assertCode(resumed.applySessionPreferences(session,
      SessionPreferencesSchema.parse({ contextBudget: 200000 })), 'CODEX_CONTEXT_BUDGET_INVALID')
    assert.equal((await wire('thread/resume')).length, resumes)
    await resumed.applySessionPreferences(session, SessionPreferencesSchema.parse({}))
    assert.equal(resumed.appliedSessionPreferences(session)?.contextBudget, null)
    const last = (await wire('thread/resume')).at(-1)!
    assert.equal((last.params as { config: Record<string, unknown> }).config.model_context_window, undefined)
  })

  it('reattaches an original resident without launching, resuming, replaying or reading turn history', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session, 'approval')
    const waiting = await pending(session)
    const lifetime = manager.originalSessionLifetime(session, source)!
    assert(lifetime.residency.nativeTurnId)
    lifetime.assertCurrent()
    const launches = (await calls(f.directory)).filter((entry) => typeof entry.pid === 'number').length
    assert.deepEqual(await manager.reattachOriginalSession(session, source, lifetime.residency), session)
    assert.equal((await wire('thread/resume')).length, 0)
    assert.equal((await wire('turn/start')).length, 1)
    assert.equal((await wire('thread/turns/list')).length, 0)
    assert.equal((await calls(f.directory)).filter((entry) => typeof entry.pid === 'number').length, launches)
    const read = (await wire('thread/read')).at(-1)!.params as JsonObject
    assert.equal(read.includeTurns, false)
    await manager.respondOriginal(session, source, lifetime.residency, waiting.turn.nativeRequestId!, waiting.responseOptions[0]!)
    await result
  })

  it('refuses cold original recovery before launching and never labels a resumed saved thread original', async () => {
    const session = await manager.createSession(source)
    const pin = manager.originalSessionLifetime(session, source)!.residency
    await manager.closeForRestart(session)
    const replacement = makeManager()
    const before = await calls(f.directory)
    assert.equal(replacement.originalSessionLifetime(session, source), undefined)
    await assertCode(replacement.reattachOriginalSession(session, source, pin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    assert.deepEqual(await calls(f.directory), before)
    await replacement.attachSession(session, source)
    assert.equal(replacement.originalSessionLifetime(session, source), undefined)
    await assertCode(replacement.reattachOriginalSession(session, source, pin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
  })

  it('never restores original residency after a disconnected manager resumes in a new generation', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const lifetime = manager.originalSessionLifetime(session, source)!
    const launched = (await processesForRequests(f.directory, 'thread/start'))[0]
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await until(async () => (await manager.history(session)).events.some((event) => event.type === 'transport.disconnected'))
    await result
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    await manager.reconcile(session, 'turn-correlation')
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    assert.throws(lifetime.assertCurrent)
    const before = await wire()
    await assertCode(manager.cancelOriginalTurn(session, source, lifetime.residency), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    assert.deepEqual(await wire(), before)
  })

  it('fences original controls by owner, accepted configuration, environment, connection and exact turn', async () => {
    const session = await manager.createSession(source)
    const { result } = await start(session)
    const lifetime = manager.originalSessionLifetime(session, source)!
    const pin = lifetime.residency
    const before = await wire()
    await assertCode(manager.cancelOriginalTurn(session, input(f.directory, 'other-agent'), pin), 'CODEX_SESSION_OWNER_MISMATCH')
    const changed = structuredClone(source); codex(changed).sandbox = 'danger-full-access'
    await assertCode(manager.cancelOriginalTurn(session, changed, pin), 'CODEX_SESSION_CONFIGURATION_MISMATCH')
    const changedEnvironment = structuredClone(source)
    changedEnvironment.environment = { agentId: changedEnvironment.environment!.agentId,
      variables: { ...changedEnvironment.environment!.variables, GRAPHQL_MCP_TOKEN: 'different-token' } }
    await assertCode(manager.cancelOriginalTurn(session, changedEnvironment, pin), 'CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED')
    for (const changedPin of [{ ...pin, connectionId: 'other' }, { ...pin, runtimeGeneration: 1 },
      { ...pin, nativeTurnId: 'other-turn' }, { ...pin, session: { ...session, nativeSessionId: 'other-session' } }]) {
      await assertCode(manager.cancelOriginalTurn(session, source, changedPin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    }
    await assertCode(manager.cancelOriginalTurn(session, { ...source, nativeTurnId: 'other-turn' }, pin), 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    assert.deepEqual(await wire(), before)
    assert.equal(await manager.cancelOriginalTurn(session, source, pin), true)
    await result
  })

  it('does not expose original turn control before durable ACK admission completes', async () => {
    const session = await manager.createSession(source)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered = false
    const events = collect(manager.startTurn(session, { prompt: 'wait', clientCorrelationId: 'blocked-admission',
      onSubmitted: async () => { entered = true; await gate } }))
    await until(async () => entered)
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    release()
    await until(async () => manager.originalSessionLifetime(session, source))
    const pin = manager.originalSessionLifetime(session, source)!.residency
    assert.equal(await manager.cancelOriginalTurn(session, source, pin), true)
    await events
  })

  it('captured original lifetime cannot be retargeted by mutable readbacks or a later turn', async () => {
    const session = await manager.createSession(source)
    const lifetime = manager.originalSessionLifetime(session, source)!
    lifetime.residency.session.nativeSessionId = 'caller-mutation'
    lifetime.assertCurrent()
    const { result } = await start(session)
    assert.throws(lifetime.assertCurrent, (error: unknown) => errorCode(error) === 'CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE')
    await finish(f.directory, session.nativeSessionId)
    await result
  })

  it('rejects late original reattachment after its live channel disconnects', async () => {
    const session = await manager.createSession(source)
    const lifetime = manager.originalSessionLifetime(session, source)!
    await flag('read-delay')
    const read = manager.reattachOriginalSession(session, source, lifetime.residency)
    void read.catch(() => {
      // ignore: this only prevents an unhandled rejection; the read outcome is asserted below.
    })
    await until(async () => (await wire('thread/read')).length > 0)
    const launched = (await processesForRequests(f.directory, 'thread/start'))[0]
    assert(launched && typeof launched.pid === 'number')
    process.kill(launched.pid, 'SIGTERM')
    await assert.rejects(read)
    assert.equal(manager.originalSessionLifetime(session, source), undefined)
    assert.throws(lifetime.assertCurrent)
    assert.equal((await wire('thread/resume')).length, 0)
  })

  it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])(
    'recognizes a managed worker launcher using %s and permits only its scoped execution credential', async tokenName => {
    const entry = nativeConnection({ ...appLauncherConnection(), environmentVariables: [tokenName] })
    await json('mcp.json', { enabled: true, transport: { ...entry, type: 'stdio' } })
    const inspected = await manager.inspectMcpConfiguration(f.directory)
    assert.equal(inspected.configured.automaticEndpoint, true)
    assert.equal(inspected.configured.bearerTokenEnvironmentVariable, tokenName)
    assert.equal((await manager.inspectMcp()).endpointMatches, true)
    const session = await manager.createSession(source)
    assert.equal(session.harness, 'codex')
    assert(session.nativeSessionId)
  })

  it('filters inherited database secrets on launch, credential refresh and cold resume', async () => {
    const environment = source.environment!
    const inherited = {
      DATABASE_URL: 'postgresql://test-only-owner:test-only-password@localhost/test-only-database',
      TEST_DATABASE_URL: 'postgresql://test-only-owner:test-only-password@localhost/test-only-database',
      PGPASSWORD: 'test-only-password',
      GRAPHQL_PRODUCTION_DB_PASSWORD: 'test-only-production-password',
      OPERATOR_TOKEN: 'test-only-operator-token',
      GRAPHQL_OPERATOR_TOKEN: 'test-only-operator-token',
      GRAPHQL_APP_TOKEN: 'test-only-app-token',
      GRAPHQL_MCP_TOKEN: 'test-only-ambient-token',
      TEST_VISIBLE_SETTING: 'retained-setting',
      NO_COLOR: 'ambient-color',
    }
    const expected: Record<string, string | null> = {
      ...Object.fromEntries(Object.keys(inherited).map((key) => [key, null])),
      GRAPHQL_MCP_TOKEN: environment.variables.GRAPHQL_MCP_TOKEN!,
      TEST_VISIBLE_SETTING: inherited.TEST_VISIBLE_SETTING,
      TEST_AGENT_ID: 'agent-a',
      NO_COLOR: '1',
    }
    for (const [key, value] of Object.entries(inherited)) vi.stubEnv(key, value)
    try {
      await json('expected-environment.json', expected)
      const session = await manager.createSession(source)
      await assertSpawnedEnvironment(expected, 1)

      source.environment = {
        agentId: environment.agentId,
        variables: { ...environment.variables, GRAPHQL_MCP_TOKEN: 'replacement-scoped-token' },
      }
      expected.GRAPHQL_MCP_TOKEN = 'replacement-scoped-token'
      await json('expected-environment.json', expected)
      await manager.refreshProcessEnvironment(session, source.environment!)
      await assertSpawnedEnvironment(expected, 2)
      assert.equal((await wire('thread/resume')).length, 1)

      await manager.closeForRestart(session)
      const replacement = makeManager()
      assert.deepEqual(await replacement.attachSession(session, source), session)
      await assertSpawnedEnvironment(expected, 3)
      assert.equal((await wire('thread/start')).length, 1)
      assert.equal((await wire('thread/resume')).length, 2)
      await collect(replacement.startTurn(session, { prompt: 'complete', clientCorrelationId: 'environment-recovered' }))
      assert.equal((await replacement.history(session)).terminalResult?.outcome, 'succeeded')
      for (const [key, value] of Object.entries(inherited)) assert.equal(process.env[key], value)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 15_000)

  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'PGPASSWORD',
    'FOREMAN_CODE_PRODUCTION_DB_PASSWORD', 'GRAPHQL_PRODUCTION_DB_PASSWORD']) {
    it(`rejects ${key} reinjection on launch, credential refresh and cold resume`, async () => {
      const invalid = structuredClone(source)
      invalid.environment = {
        agentId: source.environment!.agentId,
        variables: { ...source.environment!.variables, [key]: 'test-only-database-secret' },
      }
      await assertCode(manager.createSession(invalid), 'CODEX_ENVIRONMENT_INVALID')
      assert.equal((await calls(f.directory)).length, 0)

      const session = await manager.createSession(source)
      const beforeRefresh = await calls(f.directory)
      await assertCode(manager.refreshProcessEnvironment(session, invalid.environment!), 'CODEX_ENVIRONMENT_INVALID')
      assert.deepEqual(await calls(f.directory), beforeRefresh)
      assert.equal((await processesForRequests(f.directory, 'thread/start')).length, 1)
      await assertMetadataProcessesClosed()
      assert.equal((await wire('thread/resume')).length, 0)
      await manager.inspectConfiguration(session)

      await manager.closeForRestart(session)
      const replacement = makeManager()
      const before = await calls(f.directory)
      await assertCode(replacement.attachSession(session, invalid), 'CODEX_ENVIRONMENT_INVALID')
      assert.deepEqual(await calls(f.directory), before)
      assert.deepEqual(await replacement.attachSession(session, source), session)
      await collect(replacement.startTurn(session, { prompt: 'complete', clientCorrelationId: 'valid-environment' }))
      assert.equal((await replacement.history(session)).terminalResult?.outcome, 'succeeded')
    }, 15_000)
  }

  it('resumes saved sessions on a newer compatible binary without rewriting their provenance', async () => {
    const session = await manager.createSession(source)
    await manager.dispose()
    await json('version.json', 'codex-cli 0.160.0')
    const replacement = makeManager()
    assert.deepEqual(await replacement.attachSession(session, source), session)
    assert.equal((await replacement.capabilities()).providerVersion, 'codex-cli 0.160.0')
    const fork = await replacement.forkSession(session, source)
    assert.equal(fork.providerVersion, 'codex-cli 0.160.0')
    assert.equal(session.providerVersion, 'codex-cli 0.154.0')
  })

  it('reports the installed version and model/list contract when discovery returns an invalid model identity', async () => {
    await json('version.json', 'codex-cli 0.160.0')
    await json('models.json', { models: [{ slug: '', supported_reasoning_levels: [{ effort: 'medium' }] }] })
    await assert.rejects(manager.discoverModels(f.directory), error => error instanceof Error
      && errorCode(error) === 'CODEX_MODEL_CATALOG_INVALID' && error.message.includes('0.160.0')
      && error.message.includes('model/list catalog response contract'))
    assert.equal((await wire('model/list')).length, 1)
    assert.equal((await wire('thread/start')).length, 0)
    await assertMetadataProcessesClosed()
  })

  it('F01: refuses another Agent, workspace, run, or workflow-node owner on loaded attachment', async () => {
    const session = await manager.createSession(source)
    await assertCode(manager.attachSession(session, input(f.directory, 'agent-b')), 'CODEX_SESSION_OWNER_MISMATCH')
    for (const key of ['workspaceId', 'runId', 'workflowNodeId'] as const) {
      const changed = structuredClone(source); changed.request[key] = 'other'
      await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_OWNER_MISMATCH')
    }
    assert.equal((await wire('thread/resume')).length, 0)
  })

  it('rejects a foreign qualified release identity for an already loaded session', async () => {
    const session = await manager.createSession(source)
    const foreign = { ...session, providerVersion: 'codex-cli 0.156.1' }
    await assertCode(manager.attachSession(foreign, source), 'CODEX_SESSION_VERSION_MISMATCH')
    await assertCode(collect(manager.startTurn(foreign, { prompt: 'no turn', clientCorrelationId: 'foreign' })), 'CODEX_SESSION_VERSION_MISMATCH')
    await assertCode(manager.close(foreign), 'CODEX_SESSION_VERSION_MISMATCH')
    assert.equal((await manager.history(session)).terminalResult, undefined)
  })

  it('preserves observed version provenance and rejects altered loaded references', async () => {
    const pinned = new CodexAppServerSessionManager(f.binary)
    managers.push(pinned)
    const session = await pinned.createSession(source)
    assert.equal(session.providerVersion, 'codex-cli 0.154.0')
    assert.equal((await pinned.history(session)).terminalResult, undefined)
    assert.equal((await pinned.sessionControlCapabilities(session)).compact.supported, true)
    await assertCode(pinned.history({ ...session, providerVersion: '0.154.0' }), 'CODEX_SESSION_VERSION_MISMATCH')
    await assertCode(pinned.history({ ...session, providerVersion: 'codex-cli 0.156.1' }), 'CODEX_SESSION_VERSION_MISMATCH')
  })

  it('refuses every accepted configuration change, not just model/effort/cwd', async () => {
    codex().sandbox = 'danger-full-access'
    const session = await manager.createSession(source)
    const mutations: Array<(value: WorkflowNativeSessionStart) => void> = [
      (value) => { value.request.configuration.id = 'another-version' },
      (value) => { value.request.configuration.version += 1 },
      (value) => { value.request.configuration.contentHash = 'sha256:other' },
      (value) => { value.request.configuration.prompt.system = 'different instructions' },
      (value) => { codex(value).sandbox = 'read-only' },
      (value) => { codex(value).serviceTier = 'priority' },
      (value) => { codex(value).advanced!.approvalPolicy = 'on-request' },
      (value) => { codex(value).advanced!.approvalsReviewer = 'auto_review' },
      (value) => { codex(value).advanced!.additionalWritableDirectories = ['/other'] },
      (value) => { codex(value).advanced!.sessionPersistence = 'ephemeral' },
      (value) => { codex(value).advanced!.shellEnvironment.inherit = 'none' },
      (value) => { codex(value).advanced!.webSearch = 'disabled' },
      (value) => { codex(value).advanced!.mcpServers = { other: { enabled: false, required: false } } },
    ]
    for (const mutate of mutations) {
      const changed = structuredClone(source); mutate(changed)
      assert.notDeepEqual(changed.request.configuration, source.request.configuration,
        'Each mutation must change the accepted configuration')
      await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_CONFIGURATION_MISMATCH')
    }
    const changed = structuredClone(source)
    changed.environment = { agentId: 'agent-a', variables: { ...changed.environment!.variables, GRAPHQL_MCP_TOKEN: 'new-token' } }
    await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED')
    assert.equal((await wire('thread/read')).length, 0)
  })

  it('F02: snapshots caller-owned input and returned history without mutable aliases', async () => {
    const accepted = structuredClone(source)
    const session = await manager.createSession(source)
    codex().sandbox = 'danger-full-access'
    assert.deepEqual(await manager.attachSession(session, accepted), session)
    const history = await manager.history(session)
    ;(history.events as unknown[]).length = 0
    assert((await manager.history(session)).events.length > 0)
  })

  it('proves a freshly created owned thread is idle without remote history recovery', async () => {
    const session = await manager.createSession(source)
    const history = await manager.reconcile(session, 'prospective-turn')
    assert.equal(history.terminalResult, undefined)
    assert.deepEqual(history.pendingInteractions, [])
    assert.doesNotThrow(() => canonicalGraphJson(history))
    assert.equal((await wire('thread/read')).length, 0)
    assert.equal((await wire('thread/turns/list')).length, 0)
  })

  it('F24: fresh logged-out login uses a control transport with no execution thread', async () => {
    await flag('logged-out')
    await assertCode(manager.createSession(source), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    const result = await manager.startDeviceCodeLogin()
    assert.equal(result.loginId, 'login-1')
    assert.equal((await wire('thread/start')).length, 0)
    await manager.cancelLogin(undefined, 'login-1')
    const pid = (await calls(f.directory)).find((entry) => typeof entry.pid === 'number')!.pid as number
    await assertDead(pid)
    await unflag('logged-out')
    await manager.createSession(source)
  })

  it('F25: native approval_mode and unordered tool sets normalize semantically', async () => {
    codex().advanced!.mcpServers = { 'graphql': {
      enabled: true, required: true, enabledTools: ['a', 'b'], disabledTools: ['c', 'd'], defaultToolsApprovalMode: 'prompt',
      tools: { b: { approvalMode: 'writes', enabled: false }, a: { approvalMode: 'prompt' } },
    } }
    await json('mcp.json', { enabled: true, required: true, enabled_tools: ['b', 'a'], disabled_tools: ['d', 'c'],
      default_tools_approval_mode: 'prompt', tools: { a: { approval_mode: 'prompt', enabled: true }, b: { enabled: false, approval_mode: 'writes' } },
      transport: { type: 'streamable_http', bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } })
    await manager.createSession(source)
    const changed = input(f.directory, 'agent-b'); codex(changed).advanced = structuredClone(codex().advanced!)
    codex(changed).advanced!.mcpServers['graphql']!.tools!.a!.approvalMode = 'auto'
    await assertCode(manager.createSession(changed), 'CODEX_MCP_POLICY_MISMATCH')
  })

  it('accepts the native priority response for requested fast mode on start and resume', async () => {
    await flag('native-priority-tier')
    codex().serviceTier = 'priority'
    const session = await manager.createSession(source)
    await manager.dispose()
    setManager(makeManager())
    await manager.attachSession(session, source)
    assert.equal(((await wire('thread/resume')).at(-1)?.params as JsonObject).serviceTier, 'fast')
    const native = await state(f.directory, session.nativeSessionId)
    assert.equal(native.settings.serviceTier, 'priority')
  })

  for (const setting of ['model', 'effort', 'fast']) it(`F26: rejects unsupported model catalog ${setting} before thread creation`, async () => {
    if (setting === 'model') codex().model = 'unavailable'
    if (setting === 'effort') codex().reasoningEffort = 'xhigh'
    if (setting === 'fast') {
      codex().serviceTier = 'priority'
      await json('models.json', { models: [{ slug: 'test-model', supported_reasoning_levels: [{ effort: 'medium' }], additional_speed_tiers: [] }] })
    }
    await assert.rejects(manager.createSession(source))
    assert.equal((await wire('thread/start')).length, 0)
  })

  it('rechecks observed version and authentication after a compatible replacement', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await json('version.json', 'codex-cli 0.155.0')
    const compatible = await manager.createSession(input(f.directory, 'agent-b'))
    assert.equal(compatible.providerVersion, 'codex-cli 0.155.0')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'auth-recover' }))
    await flag('logged-out')
    await assertCode(manager.createSession(input(f.directory, 'agent-c')), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await assertCode(manager.reconcile(session, 'auth-recover'), 'CODEX_APP_SERVER_AUTH_UNQUALIFIED')
    await unflag('logged-out')
    assert.equal((await manager.reconcile(session, 'auth-recover')).terminalResult?.outcome, 'succeeded')
  })

  it('resumes a saved thread across compatible Codex releases while retaining its provenance', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    await json('version.json', 'codex-cli 0.156.1')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
    assert.equal((await wire('thread/resume')).length, 1)
    assert.equal(session.providerVersion, 'codex-cli 0.154.0')
    await unflag('version.json')
    assert.equal((await manager.reconcile(session, 'recover')).terminalResult?.outcome, 'succeeded')
  })

  it('F29: the manager accepts contract-valid Windows writable paths rather than checking only slash prefixes', async () => {
    codex().sandbox = 'workspace-write'; codex().advanced!.additionalWritableDirectories = ['C:\\work']
    const session = await manager.createSession(source)
    const params = (await wire('thread/start'))[0]!.params as JsonObject
    assert.deepEqual((params.config as JsonObject).sandbox_workspace_write, {
      writable_roots: ['C:\\work'], network_access: false, exclude_tmpdir_env_var: false, exclude_slash_tmp: false,
    })
    assert(session.nativeSessionId)
  })

  it('F30: refresh can add credentials to an owner-bound session with no original environment', async () => {
    await flag('no-mcp'); delete source.environment
    const session = await manager.createSession(source)
    await unflag('no-mcp')
    await assertCode(manager.refreshProcessEnvironment(session, { agentId: 'agent-a', variables: {} }), 'CODEX_SCOPED_ENVIRONMENT_REQUIRED')
    assert.equal((await wire('thread/resume')).length, 0)
    await manager.refreshProcessEnvironment(session, { agentId: 'agent-a', variables: { TEST_AGENT_ID: 'agent-a', GRAPHQL_MCP_TOKEN: 'new' } })
    assert.equal((await wire('thread/resume')).length, 1)
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'refreshed' }))
  })

  it('F31: restart reapplies accepted settings after persisted native drift, and rejects unapplied drift', async () => {
    const session = await manager.createSession(source)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'recover' }))
    const native = await state(f.directory, session.nativeSessionId)
    native.settings.sandbox = { type: 'dangerFullAccess' }; native.settings.model = 'other-model'; native.settings.serviceTier = 'fast'
    await json(`state-${session.nativeSessionId}.json`, native)
    await flag('ignore-resume-settings')
    await assertCode(manager.reconcile(session, 'recover'), 'CODEX_EFFECTIVE_SETTINGS_MISMATCH')
    await unflag('ignore-resume-settings')
    await manager.reconcile(session, 'recover')
    const params = (await wire('thread/resume')).at(-1)!.params as JsonObject
    assert.equal(params.sandbox, 'read-only'); assert.equal(params.model, 'test-model'); assert.equal(params.serviceTier, 'default')
    assert.equal(params.developerInstructions, source.request.configuration.prompt.system)
    assert((params.config as JsonObject).shell_environment_policy)
  })

  it('SKL-05: developerInstructions carries the pinned Agent instructions and skills once; resume keeps the accepted bundle', async () => {
    const body = 'End every answer with the token ORCHID.'
    const contentHash = `sha256:${createHash('sha256').update(body, 'utf8').digest('hex')}`
    source.request.configuration = { ...source.request.configuration, prompt: { system: 'Agent rules.' }, instructionDelivery: 'native-v1',
      assignedSkills: [{ skillId: 'skill-a', version: '2' }], resolvedSkills: [{ skillId: 'skill-a', version: '2', name: 'Orchid', instructions: body, contentHash }] }
    const expected = 'Agent rules.\n\n# Skill: Orchid (skill-a@2)\n\nEnd every answer with the token ORCHID.'
    const session = await manager.createSession(source)
    const started = (await wire('thread/start'))[0]!.params as JsonObject
    assert.equal(started.developerInstructions, expected)
    assert.equal(Object.hasOwn(started, 'baseInstructions'), false)
    await collect(manager.startTurn(session, { prompt: 'crash-completed', clientCorrelationId: 'skill-turn' }))
    const turn = (await wire('turn/start'))[0]!.params as JsonObject
    assert.deepEqual(turn.input, [{ type: 'text', text: 'crash-completed', text_elements: [] }])
    // A backend restart resumes with the configuration accepted for this execution.
    const restarted = makeManager()
    await restarted.attachSession(session, source)
    const resumed = (await wire('thread/resume')).at(-1)!.params as JsonObject
    assert.equal(resumed.developerInstructions, expected)
    // Corrupt pinned instructions fail before any native thread is created.
    const corrupt = structuredClone(source)
    corrupt.request.configuration.resolvedSkills![0]!.instructions = 'Tampered'
    const threads = (await wire('thread/start')).length
    await assertCode(makeManager().createSession(corrupt), 'SKILL_SNAPSHOT_INVALID')
    assert.equal((await wire('thread/start')).length, threads)
  })
  it('launches workflow Agents with the application system prompt before Agent instructions', async () => {
    source.request.systemPrompt = {
      value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3',
    }
    source.request.configuration = { ...source.request.configuration,
      instructionDelivery: 'native-v1', prompt: { system: 'Agent instructions.' } }
    const session = await manager.createSession(source)
    const started = (await wire('thread/start'))[0]!.params as JsonObject
    assert.equal(started.developerInstructions, 'App instructions.\n\nAgent instructions.')
    const changed = structuredClone(source)
    changed.request.systemPrompt!.revision = 4
    await assertCode(manager.createSession(changed), 'CODEX_SESSION_CONFIGURATION_MISMATCH')
    await assertCode(manager.attachSession(session, changed), 'CODEX_SESSION_CONFIGURATION_MISMATCH')
    await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'app-prompt-turn' }))
    const turn = (await wire('turn/start'))[0]!.params as JsonObject
    assert.deepEqual(turn.input, [{ type: 'text', text: 'complete', text_elements: [] }])
    const restarted = makeManager()
    await restarted.attachSession(session, source)
    const resumed = (await wire('thread/resume')).at(-1)!.params as JsonObject
    assert.equal(resumed.developerInstructions, 'App instructions.\n\nAgent instructions.')
  })

  it('launches Agent chat with the application system prompt and excludes it from Operator instructions', async () => {
    const snapshot = { value: { text: 'App instructions.' }, revision: 3, versionId: 'prompt-version-3' }
    const configuration = { ...source.request.configuration,
      instructionDelivery: 'native-v1' as const, prompt: { system: 'Agent instructions.' } }
    const chat = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, 'none')
    managers.push(chat)
    await chat.createSession({ kind: 'agent-chat', conversationId: 'prompt-chat', workflowId: 'workflow',
      workflowNodeId: 'chat-node', correlationId: 'chat-prompt', configuration,
      systemPrompt: snapshot, workingDirectory: f.directory })
    const operator = codexResponseSurfaceFixtures(f.directory).find(item => item.surface === 'operator')!
    const scoped = new CodexAppServerSessionManager(f.binary, undefined, undefined, undefined, operator.appMcpAccess)
    managers.push(scoped)
    await scoped.createSession({ ...operator.source, systemPrompt: snapshot } as typeof operator.source)
    const [chatLaunch, operatorLaunch] = (await wire('thread/start')).map(frame => frame.params as JsonObject)
    assert.equal(chatLaunch!.developerInstructions, 'App instructions.\n\nAgent instructions.')
    assert.equal(String(operatorLaunch!.developerInstructions).includes('App instructions.'), false)
  })

  it('adds no native text for an empty application system prompt', async () => {
    source.request.systemPrompt = { value: { text: '' }, revision: 3, versionId: 'prompt-version-3' }
    source.request.configuration = { ...source.request.configuration,
      instructionDelivery: 'native-v1', prompt: { system: 'Agent instructions.' } }
    await manager.createSession(source)
    const started = (await wire('thread/start'))[0]!.params as JsonObject
    assert.equal(started.developerInstructions, 'Agent instructions.')
  })

})
