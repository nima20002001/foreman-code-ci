import assert from 'node:assert/strict'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import { describe, it } from 'vitest'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { CodexRuntimeNativeOutputTurn, codexNativeOutputDeclarations, type CodexNativeOutputs,
  type CodexNativeOutputCallback, type CodexNativeOutputTurnPin } from '../src/modules/harnesses/codexNativeOutput.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { input } from './fixtures/codex-test-helpers.js'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import { graphSourceDigest } from '../src/modules/run-graph/publication.js'

// Explicit recorded protocol/authority ports only, never protected-store qualification.
const command = { operation: 'create' as const, commandId: 'output-command-1', filename: 'result.md', mediaType: 'text/markdown' as const }
async function fixture(options: { qualified?: boolean; onSubmitted?: () => Promise<void> } = {}) {
  const replay = new ActivityProductionReplay(), infrastructure = replay.infrastructure()
  assert(infrastructure.mode === 'replay')
  const observed: string[] = [], calls: CodexNativeOutputCallback[] = []
  let pin: CodexNativeOutputTurnPin | undefined
  const outputs: CodexNativeOutputs = {
    assertQualified: async (value) => {
      observed.push('qualification')
      assert.equal(value.configuration.sandbox, 'workspace-write')
      if (options.qualified === false) throw new Error('Recorded absent protected-store proof')
    },
    prepare: async (value) => {
      observed.push('prepare')
      assert.equal(value.effectiveSandbox.cwd, '/recorded-workspace')
      assert.equal(value.effectiveSandbox.excludeSlashTmp, true)
      return {
        activate: async (value) => { value.assertCurrent(); pin = value; observed.push('activate') },
        dispatch: async (value, callback) => {
          callback.assertCurrent(); calls.push(callback); observed.push('dispatch')
          assert.equal(value.operation, 'create')
          return { operation: 'create', artifactId: 'recorded-artifact', byteSize: 0 }
        },
        close: async () => { observed.push('close') },
      }
    },
  }
  // Retain only the fixture's synthetic scoped token; no ambient credential is used.
  const source = input('/recorded-workspace')
  const config = source.request.configuration.harness
  assert(config.harness === 'codex')
  config.sandbox = 'workspace-write'
  config.advanced!.workspaceWrite = { networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined, undefined, 'scoped', undefined,
    infrastructure.codex, {}, outputs)
  return { replay, source, manager, observed, calls, config, outputs, pin: () => pin }
}
const wait = async (check: () => boolean) => {
  for (let count = 0; count < 100; count++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)) }
  throw new Error('Recorded callback did not settle')
}
async function request(f: Awaited<ReturnType<typeof fixture>>, sessionId: string, turnId: string, extra: Record<string, unknown> = {}) {
  const rpcId = `output-rpc-${f.replay.requests.size + f.replay.responses.length}`
  f.replay.requests.set(rpcId, sessionId)
  await f.replay.channels.get(sessionId)!.request({ id: rpcId, method: 'item/tool/call', params: {
    threadId: sessionId, turnId, callId: 'original-output-call', tool: 'files_native_output_create', arguments: command, ...extra,
  } })
  return rpcId
}

describe('separate Codex native output group alongside scoped App MCP', () => {
  it('bounds observation history while delivering every frame of a long turn', async () => {
    const f = await fixture()
    try {
      const session = await f.manager.createSession(f.source)
      const correlationId = 'execution:long-execution'
      const iterator = f.manager.startTurn(session, { prompt: 'Long session', clientCorrelationId: correlationId,
        onSubmitted: async () => {} })[Symbol.asyncIterator]()
      await iterator.next()
      const turnId = f.replay.starts[0]!.nativeTurnId
      const delivered: NativeHarnessEvent[] = []
      const details = Array.from({ length: 128 }, (_, index) => ({ index, value: 'recorded' }))
      for (let index = 0; index < 2377; index += 1) {
        f.replay.channels.get(session.nativeSessionId)!.notify('item/agentMessage/delta', {
          threadId: session.nativeSessionId, turnId, itemId: 'recorded-context', delta: 'x', details,
        })
        const frame = await iterator.next()
        assert.equal(frame.done, false)
        delivered.push(frame.value!)
      }
      // The delivery buffer fits in bytes but its aggregate exceeds the graph's traversal budget.
      const deliveryWindow = delivered.slice(-1024)
      assert(Buffer.byteLength(JSON.stringify(deliveryWindow)) < 8 * 1024 * 1024)
      assert.throws(() => canonicalGraphJson(deliveryWindow), /GRAPH_JSON_LIMIT/)
      f.replay.complete(session.nativeSessionId, turnId, '{"original":true}')
      for (let frame = await iterator.next(); !frame.done; frame = await iterator.next()) delivered.push(frame.value)
      assert.equal(delivered.filter(event => event.type === 'native.notification').length, 2377)
      const history = await f.manager.reconcile(session, correlationId)
      assert.equal(history.terminalTurn?.providerId, turnId)
      assert.equal(history.terminalTurn?.result.outcome, 'succeeded')
      assert(Buffer.byteLength(canonicalGraphJson(history)) < 256 * 1024)
      assert.equal(history.firstRetainedSequence, history.events[0]?.sequence)
      assert.equal(history.nextSequence, history.events.at(-1)!.sequence + 1)
      assert(history.firstRetainedSequence! > delivered[0]!.sequence)
      assertOriginalWorkflowTerminal({ id: 'long-execution', agentId: f.source.request.configuration.agentId }, session, history)
      assert.match(graphSourceDigest({ original: { type: 'history', history } }), /^sha256:/)
      assert.equal(f.replay.starts.length, 1)
    } finally { await f.manager.dispose() }
  })

  it('keeps the original terminal read when reconciliation appends metadata beyond the observation window', async () => {
    const f = await fixture()
    try {
      const session = await f.manager.createSession(f.source)
      const correlationId = 'execution:recovered-execution'
      const iterator = f.manager.startTurn(session, { prompt: 'Recover original', clientCorrelationId: correlationId,
        onSubmitted: async () => {} })[Symbol.asyncIterator]()
      await iterator.next()
      const turnId = f.replay.starts[0]!.nativeTurnId
      const turn = f.replay.threads.get(session.nativeSessionId)!.turns[0]!
      turn.status = 'completed'
      turn.items = [{ type: 'agentMessage', id: 'original-answer', phase: 'final_answer',
        text: 'x'.repeat(256 * 1024) }]
      f.replay.disconnect(session.nativeSessionId)
      await iterator.return?.()
      const history = await f.manager.reconcile(session, correlationId)
      assert.equal(history.terminalTurn?.providerId, turnId)
      assertOriginalWorkflowTerminal({ id: 'recovered-execution', agentId: f.source.request.configuration.agentId }, session, history)
      for (let index = 0; index < 12; index += 1) {
        f.replay.channels.get(session.nativeSessionId)!.notify('thread/status/changed', {
          threadId: session.nativeSessionId, status: 'idle', padding: 'x'.repeat(16 * 1024),
        })
      }
      const later = await f.manager.history(session)
      assertOriginalWorkflowTerminal({ id: 'recovered-execution', agentId: f.source.request.configuration.agentId }, session,
        { ...history, ...later })
      assert.equal(later.gap?.reason, 'retention')
      assert.equal(later.firstRetainedSequence, later.events[0]?.sequence)
      assert(later.gap!.fromSequence > later.firstRetainedSequence!)
      assert.equal(f.replay.starts.length, 1)
      assert.match(graphSourceDigest({ original: { type: 'history', history } }), /^sha256:/)
    } finally { await f.manager.dispose() }
  })

  it('discovers only the configured recorded MCP entry without creating a native thread', async () => {
    const f = await fixture()
    try {
      const inspected = await f.manager.inspectMcpConfiguration('/recorded-workspace')
      assert.equal(inspected.serverName, 'graphql')
      assert.equal(inspected.configured.enabled, true)
      assert.equal(inspected.configured.required, true)
      assert.equal(f.replay.calls.length, 0)
      assert.deepEqual(f.observed, [])
    } finally { await f.manager.dispose() }
  })

  it('detects the recorded legacy MCP entry through named configuration reads', async () => {
    const f = await fixture()
    try {
      const detection = await f.manager.inspectMcp()
      assert.equal(detection.serverName, 'graphql')
      assert.equal(detection.state, 'status_unavailable')
      assert.equal(detection.endpointMatches, true)
    } finally { await f.manager.dispose() }
  })

  it('reconciles an observed terminal after output cleanup closes its provider without starting a replacement', async () => {
    const f = await fixture()
    try {
      const session = await f.manager.createSession(f.source)
      const iterator = f.manager.startTurn(session, { prompt: 'Recorded output', clientCorrelationId: 'original-output',
        onSubmitted: async () => {} })[Symbol.asyncIterator]()
      await iterator.next()
      const turn = f.replay.starts[0]!.nativeTurnId
      f.replay.complete(session.nativeSessionId, turn, '{"original":true}')
      f.replay.disconnect(session.nativeSessionId)
      await iterator.return?.()
      const starts = f.replay.calls.filter(call => call.method === 'thread/start' || call.method === 'thread/resume').length
      const history = await f.manager.reconcile(session, 'original-output')
      assert.equal(history.terminalTurn?.providerId, turn)
      assert.deepEqual(history.terminalTurn?.result, { outcome: 'succeeded', output: { text: '{"original":true}' } })
      assert.equal(f.replay.calls.filter(call => call.method === 'thread/start' || call.method === 'thread/resume').length, starts)
      assert.equal(f.replay.starts.length, 1)
    } finally { await f.manager.dispose() }
  })
  it('requires genuine qualification before a native thread start or tool declaration', async () => {
    const f = await fixture({ qualified: false })
    try {
      await assert.rejects(f.manager.createSession(f.source), /absent protected-store/)
      assert.equal(f.replay.calls.some(call => call.method === 'thread/start'), false)
      assert.deepEqual(f.observed, ['qualification'])
    } finally { await f.manager.dispose() }
  })
  it('keeps read-only/full-access promotion and chatFiles isolation prohibited', async () => {
    const f = await fixture()
    try {
      for (const sandbox of ['read-only', 'danger-full-access'] as const) {
        f.config.sandbox = sandbox
        delete f.config.advanced!.workspaceWrite
        await assert.rejects(f.manager.createSession(f.source), (error: unknown) =>
          error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_NATIVE_OUTPUT_UNQUALIFIED')
        assert.throws(() => codexNativeOutputDeclarations(f.config, 'codex-cli 0.154.0'))
      }
      const chat = new CodexAppServerSessionManager('/unused', undefined, undefined, undefined, 'scoped',
        { prepare: async () => undefined })
      try {
        await assert.rejects(chat.createSession(f.source), (error: unknown) =>
          error instanceof HarnessExecutionError && error.result.error?.code === 'CODEX_FILE_CHAT_ISOLATION_REQUIRED')
      } finally { await chat.dispose() }
      assert.equal(f.replay.starts.length, 0)
    } finally { await f.manager.dispose() }
  })
  it('activates only after awaited original ACK and returns a typed native callback reply', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    try {
      const session = await f.manager.createSession(f.source)
      assert.equal(codexNativeOutputDeclarations(f.config, session.providerVersion).length, 4)
      let submitted = false
      const iterator = f.manager.startTurn(session, { prompt: 'Recorded output', clientCorrelationId: 'original-output',
        onSubmitted: async () => { submitted = true; await gate } })[Symbol.asyncIterator]()
      const first = iterator.next()
      await wait(() => submitted)
      assert.deepEqual(f.observed, ['qualification', 'prepare'])
      release(); await first
      const turn = f.replay.starts[0]!.nativeTurnId
      const rpc = await request(f, session.nativeSessionId, turn)
      await wait(() => f.replay.toolReplies.has(rpc))
      assert.equal(f.replay.toolReplies.get(rpc)!.success, true)
      assert.equal(f.calls[0]!.callId, 'original-output-call')
      assert.equal(f.calls[0]!.rpcId, rpc)
      assert.equal(f.calls[0]!.nativeTurnId, turn)
      assert.equal(f.calls[0]!.runtimeGeneration, 0)
      f.replay.complete(session.nativeSessionId, turn, '')
      await iterator.return?.()
      assert.throws(() => f.pin()!.assertCurrent())
      assert.throws(() => f.calls[0]!.assertCurrent())
      assert.equal(f.replay.starts.length, 1)
    } finally { await f.manager.dispose() }
  })
  for (const [name, change] of [
    ['wrong turn', { turnId: 'foreign' }], ['path import', { arguments: { ...command, path: '/arbitrary' } }],
    ['operation/tool conflict', { arguments: { operation: 'seal', artifactId: 'foreign', commandId: 'conflict' } }],
    ['foreign namespace', { namespace: 'foreign' }],
  ] as const) it(`denies ${name} without a registry effect`, async () => {
    const f = await fixture()
    try {
      const session = await f.manager.createSession(f.source)
      const iterator = f.manager.startTurn(session, { prompt: 'Recorded output', clientCorrelationId: 'denials', onSubmitted: async () => {} })[Symbol.asyncIterator]()
      await iterator.next()
      const rpc = await request(f, session.nativeSessionId, f.replay.starts[0]!.nativeTurnId, change)
      await wait(() => f.replay.toolReplies.has(rpc))
      assert.equal(f.replay.toolReplies.get(rpc)!.success, false)
      assert.equal(f.calls.length, 0)
      f.replay.complete(session.nativeSessionId, f.replay.starts[0]!.nativeTurnId, '')
      await iterator.return?.()
    } finally { await f.manager.dispose() }
  })
  it('dispatches the closed create/append/seal/publish group with original callback pins', async () => {
    const f = await fixture()
    const original = f.outputs.prepare
    const seen: string[] = []
    f.outputs.prepare = async (...args) => {
      const bridge = await original(...args)
      return { ...bridge, dispatch: async (command, callback) => {
        callback.assertCurrent(); seen.push(command.operation)
        if (command.operation === 'create') return { operation: 'create', artifactId: 'original-artifact', byteSize: 0 }
        if (command.operation === 'append') return { operation: 'append', artifactId: command.artifactId, byteSize: 1 }
        if (command.operation === 'seal') return { operation: 'seal', artifactId: command.artifactId, byteSize: 1, sha256: 'a'.repeat(64) }
        const fileId = '11111111-1111-4111-8111-111111111111', revisionId = '22222222-2222-4222-8222-222222222222'
        const createdAt = '2026-10-02T00:00:00.000Z'
        return { operation: 'publish', result: { replayed: false, value: {
          file: { fileId, currentRevisionId: revisionId, createdAt, state: 'ready', retentionDurationSeconds: 3600,
            expiresAt: '2026-10-02T01:00:00.000Z', scope: { kind: 'temporary', chat: { kind: 'agent',
              conversationId: 'recorded-conversation', agentId: 'recorded-agent', workspaceId: 'recorded-workspace', workflowId: 'recorded-workflow' } } },
          revision: { fileId, revisionId, createdAt, filename: 'result.md', mediaType: 'text/markdown', byteSize: 1, sha256: 'a'.repeat(64), origin: 'agent_output' },
        } } }
      } }
    }
    try {
      const session = await f.manager.createSession(f.source)
      const iterator = f.manager.startTurn(session, { prompt: 'Recorded output', clientCorrelationId: 'all-operations', onSubmitted: async () => {} })[Symbol.asyncIterator]()
      await iterator.next()
      for (const args of [command,
        { operation: 'append', commandId: 'append-command', artifactId: 'original-artifact', offset: 0, contentBase64: 'YQ==' },
        { operation: 'seal', commandId: 'seal-command', artifactId: 'original-artifact' },
        { operation: 'publish', publication: { commandId: 'publish-command', artifactId: 'original-artifact', filename: 'result.md', mediaType: 'text/markdown' } },
      ]) {
        const rpc = await request(f, session.nativeSessionId, f.replay.starts[0]!.nativeTurnId, {
          callId: `native-${args.operation}`, tool: `files_native_output_${args.operation}`, arguments: args,
        })
        await wait(() => f.replay.toolReplies.has(rpc))
        assert.equal(f.replay.toolReplies.get(rpc)!.success, true)
      }
      assert.deepEqual(seen, ['create', 'append', 'seal', 'publish'])
      assert.equal(f.replay.starts.length, 1)
      f.replay.complete(session.nativeSessionId, f.replay.starts[0]!.nativeTurnId, '')
      await iterator.return?.()
    } finally { await f.manager.dispose() }
  })

  it('withdraws an in-flight original callback before late effect completion/reply', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let captured: CodexNativeOutputCallback | undefined
    const original = f.outputs.prepare
    f.outputs.prepare = async (...args) => {
      const bridge = await original(...args)
      return { ...bridge, dispatch: async (command, callback, signal) => {
        captured = callback; await gate; callback.assertCurrent()
        return bridge.dispatch(command, callback, signal)
      } }
    }
    try {
      const session = await f.manager.createSession(f.source)
      const iterator = f.manager.startTurn(session, { prompt: 'Recorded output', clientCorrelationId: 'late-output', onSubmitted: async () => {} })[Symbol.asyncIterator]()
      await iterator.next()
      const turn = f.replay.starts[0]!.nativeTurnId
      const rpc = await request(f, session.nativeSessionId, turn)
      await wait(() => captured !== undefined)
      f.replay.complete(session.nativeSessionId, turn, '')
      assert.throws(() => captured!.assertCurrent())
      release(); await iterator.return?.()
      await new Promise<void>(resolve => setImmediate(resolve))
      assert.equal(f.calls.length, 0)
      assert.equal(f.replay.toolReplies.has(rpc), false)
    } finally { release(); await f.manager.dispose() }
  })
  it('fences a terminal frame buffered while original output activation awaits', async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let activating = false
    const original = f.outputs.prepare
    f.outputs.prepare = async (...args) => {
      const bridge = await original(...args)
      return { ...bridge, activate: async (pin, signal) => {
        await bridge.activate(pin, signal); activating = true; await gate; pin.assertCurrent()
      } }
    }
    try {
      const session = await f.manager.createSession(f.source)
      const iterator = f.manager.startTurn(session, { prompt: 'Recorded output', clientCorrelationId: 'terminal-during-activation',
        onSubmitted: async () => {} })[Symbol.asyncIterator]()
      const first = iterator.next()
      const rejected = assert.rejects(first)
      await wait(() => activating)
      const turn = f.replay.starts[0]!.nativeTurnId
      await request(f, session.nativeSessionId, turn)
      f.replay.complete(session.nativeSessionId, turn, '')
      assert.throws(() => f.pin()!.assertCurrent())
      release(); await rejected
      assert.equal(f.calls.length, 0)
      assert.equal(f.replay.starts.length, 1)
      await iterator.return?.()
    } finally { release(); await f.manager.dispose() }
  })
  it('re-enters registry authority for duplicate callbacks and rejects changed callID content', async () => {
    const f = await fixture()
    const pin: CodexNativeOutputCallback = { session: { harness: 'codex', nativeSessionId: 'native', providerVersion: 'codex-cli 0.154.0' },
      connectionId: 'original', runtimeGeneration: 0, nativeTurnId: 'turn', rpcId: 1, callId: 'same', assertCurrent: () => {} }
    let authorized = true, dispatches = 0
    const runtime = new CodexRuntimeNativeOutputTurn({ activate: async () => {}, close: async () => {}, dispatch: async () => {
      dispatches++; if (!authorized) throw new Error('Recorded revoked grant')
      return { operation: 'create', artifactId: 'original', byteSize: 0 }
    } })
    try {
      await runtime.activate(pin, new AbortController().signal)
      assert.equal((await runtime.dispatch('files_native_output_create', command, pin)).success, true)
      authorized = false
      assert.equal((await runtime.dispatch('files_native_output_create', command, { ...pin, rpcId: 2 })).success, false)
      assert.equal(dispatches, 2) // Actual W09 registry owns effect idempotency; current authority is never cached.
      assert.equal((await runtime.dispatch('files_native_output_create', { ...command, filename: 'different.md' }, pin)).success, false)
      assert.equal(dispatches, 2)
      assert.equal((await runtime.dispatch('files_native_output_create', command, { ...pin, runtimeGeneration: 1 })).success, false)
      assert.equal(dispatches, 2)
    } finally { await runtime.close(); await f.manager.dispose() }
  })
})
