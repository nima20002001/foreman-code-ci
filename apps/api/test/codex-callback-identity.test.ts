import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { CodexHarnessConfiguration, NativeSessionReference } from '@foreman-code/contracts'
import { CodexAppServerSessionManager, type CodexSessionDependencies, type CodexTransport } from '../src/modules/harnesses/codexAppServer.js'
import { randomUUID } from 'node:crypto'
import { APP_MCP_SERVER_NAME } from '../src/modules/harnesses/appMcpLauncher.js'
import { CodexRuntimeFileTurn } from '../src/modules/harnesses/codexFiles/runtime.js'
import type { CodexFileTurn } from '../src/modules/harnesses/codexFiles/turn.js'
import type { RpcRequest } from '../src/modules/harnesses/codexStdioTransport.js'
import { translateCodexInteraction } from '../src/modules/harnesses/codexInteractions.js'
import { errorCode, fixtureProtocol, input } from './fixtures/codex-test-helpers.js'

type Runtime = ReturnType<CodexAppServerSessionManager['requireRuntime']>
type Prepared = Parameters<CodexAppServerSessionManager['runtime']>[0]
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve }); return { promise, release } }
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

async function fixture(id: string | number = 901, files = true) {
  const session = { harness: 'codex' as const, providerVersion: RECORDED_CODEX_VERSION, nativeSessionId: 'callback-thread' }
  const source = input('/callback-no-io')
  const forbidden = async () => { throw new Error('Native IO is forbidden in this memory fixture.') }
  const dependencies: Extract<CodexSessionDependencies, { mode: 'replay' }> = {
    mode: 'replay', qualify: forbidden, assertUnchanged: forbidden, runCommand: forbidden, qualifyModel: forbidden,
    withDiagnostics: forbidden, environment: () => { throw new Error('Native environment IO is forbidden.') },
    transport: () => { throw new Error('Native transport IO is forbidden.') },
    id: randomUUID, now: () => new Date('2026-10-01T00:00:00Z'), schedule: setTimeout, cancelTimer: clearTimeout,
  }
  const manager = new CodexAppServerSessionManager('not-executed', undefined, undefined, undefined, undefined, undefined, dependencies)
  const writes: Array<{ operation: string; id: string | number; method?: string }> = []
  let heldResponse: ReturnType<typeof gate> | undefined
  let closes = 0
  let failClose = false
  const transport: CodexTransport = { start: async () => undefined, request: async (method, params) => {
    if (method === 'mcpServerStatus/list') {
      assert.deepEqual(params, { threadId: session.nativeSessionId, detail: 'toolsAndAuthOnly' })
      return { data: [{ name: APP_MCP_SERVER_NAME, runtimeStatus: 'connected', toolsError: null,
        tools: { context_get: { name: 'context_get', inputSchema: { type: 'object' } } },
        resources: [], resourceTemplates: [], authStatus: 'bearerToken' }], nextCursor: null }
    }
    assert.equal(method, 'turn/start')
    return { turn: { id: 'next-callback-turn', status: 'inProgress', itemsView: 'full', items: [],
      error: null, startedAt: 1, completedAt: null, durationMs: null } }
  }, close: async () => { closes += 1; if (failClose) { failClose = false; throw new Error('fixture transport closure unconfirmed') } },
    reject: async (id) => { writes.push({ operation: 'reject', id }) },
    respond: async (id, method) => { writes.push({ operation: 'respond', id, method }); await heldResponse?.promise }, isConnected: () => true }
  const seam = manager as unknown as {
    runtime(prepared: Prepared, session: NativeSessionReference, transport: CodexTransport): Runtime
    runtimes: Map<string, Runtime>; transports: Set<CodexTransport>
    handleRequest(runtime: Runtime, request: RpcRequest): Promise<void>
    handleNotification(runtime: Runtime, method: string, params: Record<string, unknown>): void
  }
  const runtime = seam.runtime({ input: source, harnessConfiguration: source.request.configuration.harness as CodexHarnessConfiguration,
    workingDirectory: '/callback-no-io', scopedCredentialVariable: undefined, strippedCredentialVariable: undefined,
    environment: {}, disabledMcpServerNames: [], qualified: {
      binary: 'not-executed', identity: 'fixture-identity', providerVersion: RECORDED_CODEX_VERSION, protocol: fixtureProtocol,
      schemaManifestSha256: 'fixture-schema', stableSchemaGitBlob: 'fixture-stable', referenceSchemaManifestSha256: 'fixture-reference',
    } }, session, transport)
  runtime.phase = 'active'; runtime.activeTurnId = 'callback-turn'
  seam.runtimes.set(session.nativeSessionId, runtime); seam.transports.add(transport)
  const completion = gate()
  let calls = 0
  if (files) {
    const bridge = new CodexRuntimeFileTurn({ activate: async () => undefined, close: async () => undefined,
      call: async () => { calls += 1; await completion.promise; return { success: true, contentItems: [{ type: 'inputText', text: 'fixture result' }] } },
    } as unknown as CodexFileTurn, session.nativeSessionId)
    await bridge.activate(runtime.activeTurnId)
    runtime.files = bridge
  }
  const approval: RpcRequest = { id, method: 'item/commandExecution/requestApproval', params: {
    threadId: session.nativeSessionId, turnId: runtime.activeTurnId, itemId: 'command-item', command: 'printf fixture',
    cwd: '/callback-no-io', availableDecisions: ['accept', 'decline'],
  } }
  const file: RpcRequest = { id, method: 'item/tool/call', params: { threadId: session.nativeSessionId,
    turnId: runtime.activeTurnId, callId: 'file-call', tool: 'files_read', arguments: { fileId: 'fixture-file' } } }
  const translated = translateCodexInteraction({ session, configuration: runtime.configuration,
    connectionId: runtime.connectionId, generation: runtime.generation }, approval)!
  const pending = translated.pending
  const query = { nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType,
    expectedNativeTurnId: pending.turn.nativeTurnId! }
  return { manager, session, runtime, seam, writes, completion, approval, file, query, pending, calls: () => calls,
    closes: () => closes,
    failNextClose: () => { failClose = true },
    holdResponse: () => { heldResponse = gate(); return heldResponse },
    cleanup: async () => { completion.release(); heldResponse?.release(); await flush(); await manager.shutdown() } }
}

async function nextTurn(f: Awaited<ReturnType<typeof fixture>>) {
  const turnId = f.runtime.activeTurnId!
  f.seam.handleNotification(f.runtime, 'turn/completed', { threadId: f.session.nativeSessionId,
    turn: { id: turnId, status: 'completed', itemsView: 'full', items: [], error: null, startedAt: 1, completedAt: 2, durationMs: 1 } })
  await flush()
  assert.equal(f.runtime.files?.closed, true)
  const iterator = f.manager.startTurn(f.session, { prompt: 'in-memory next turn', clientCorrelationId: 'next-correlation' })[Symbol.asyncIterator]()
  assert.equal((await iterator.next()).value?.type, 'turn.started')
  assert.equal(f.runtime.activeTurnId, 'next-callback-turn')
  assert.equal(f.runtime.fileRequests.size, 0)
  return iterator
}

describe('connection-scoped typed callback identity across files and approvals', () => {
  for (const id of [901, '901']) it(`approval-first collision on ${typeof id} ID fences approval before file execution or reply`, async () => {
    const f = await fixture(id)
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 0)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'recovery_required')
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).reason, 'identity_mismatch')
      await assert.rejects(f.manager.respond(f.session, f.query.nativeRequestId, f.pending.responseOptions[0]!),
        (error) => errorCode(error) === 'NATIVE_RESPONSE_RECONCILIATION_REQUIRED')
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  for (const id of [901, '901']) it(`file-first collision on ${typeof id} ID fences the original in-flight response`, async () => {
    const f = await fixture(id)
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 1)
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.notEqual((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [])
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 1)
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('never automatically denies a colliding file call under the pending approval ID', async () => {
    const f = await fixture(901, false)
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'recovery_required')
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('retains resolved approval identity before any file effect', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      f.seam.handleNotification(f.runtime, 'serverRequest/resolved', { threadId: f.session.nativeSessionId, requestId: 901 })
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).reason, 'request_consumed')
      await f.seam.handleRequest(f.runtime, f.file)
      assert.equal(f.calls(), 0)
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('does not conflate numeric and string RPC IDs', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      await f.seam.handleRequest(f.runtime, { ...f.file, id: '901' })
      assert.equal(f.calls(), 1)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [{ operation: 'respond', id: '901', method: 'item/tool/call' }])
    } finally { await f.cleanup() }
  })

  it('retains a denied file callback identity before a later approval', async () => {
    const f = await fixture(901, false)
    try {
      await f.seam.handleRequest(f.runtime, f.file); await flush()
      assert.deepEqual(f.writes, [{ operation: 'respond', id: 901, method: 'item/tool/call' }])
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.notEqual((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'available')
      assert.equal(f.writes.length, 1)
    } finally { await f.cleanup() }
  })

  it('retains consumed file identity after the per-turn file receipt cache is cleared', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      f.completion.release(); await flush()
      assert.equal(f.writes.length, 1)
      // This cache is cleared by the existing next-turn admission; the connection
      // still owns the consumed raw RPC ID in its bounded resolved inventory.
      f.runtime.fileRequests.clear()
      await f.seam.handleRequest(f.runtime, f.approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.equal(f.writes.length, 1)
    } finally { await f.cleanup() }
  })

  it('fences changed file payloads but coalesces an equivalent in-flight envelope', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      await f.seam.handleRequest(f.runtime, { ...f.file, params: { ...f.file.params } })
      assert.equal(f.calls(), 1)
      await f.seam.handleRequest(f.runtime, { ...f.file, params: { ...f.file.params, arguments: { fileId: 'another-file' } } })
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('fences a colliding foreign-thread envelope without replying under the legitimate callback ID', async () => {
    const f = await fixture()
    try {
      await f.seam.handleRequest(f.runtime, f.approval)
      await f.seam.handleRequest(f.runtime, { ...f.file, params: { ...f.file.params, threadId: 'foreign-thread' } })
      assert.equal(f.calls(), 0)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, f.query)).state, 'recovery_required')
      assert.deepEqual(f.writes, [])
    } finally { await f.cleanup() }
  })

  it('keeps a fresh cold connection independent while refusing the predecessor callback ID', async () => {
    const first = await fixture()
    const replacement = await fixture()
    try {
      await first.seam.handleRequest(first.runtime, first.approval)
      await replacement.seam.handleRequest(replacement.runtime, replacement.approval)
      assert.notEqual(first.query.nativeRequestId, replacement.query.nativeRequestId)
      assert.equal((await replacement.manager.inspectResponseAvailability(replacement.session, first.query)).state, 'unavailable')
      assert.equal((await replacement.manager.inspectResponseAvailability(replacement.session, replacement.query)).state, 'available')
      assert.deepEqual(first.writes, [])
      assert.deepEqual(replacement.writes, [])
    } finally { await Promise.all([first.cleanup(), replacement.cleanup()]) }
  })

  for (const id of [901, '901']) it(`reserves the ${typeof id} file ID across actual turn cleanup while its response write is held`, async () => {
    const f = await fixture(id)
    const held = f.holdResponse()
    let iterator: Awaited<ReturnType<typeof nextTurn>> | undefined
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      f.completion.release(); await flush()
      assert.deepEqual(f.writes, [{ operation: 'respond', id, method: 'item/tool/call' }])
      iterator = await nextTurn(f)
      await f.seam.handleRequest(f.runtime, { ...f.approval, params: { ...f.approval.params, turnId: f.runtime.activeTurnId } })
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.equal(f.writes.length, 1)
      held.release(); await flush()
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.equal(f.writes.length, 1)
    } finally { held.release(); await iterator?.return?.(); await f.cleanup() }
  })

  it('separates numeric/string IDs and fresh connections while a predecessor response remains held across turns', async () => {
    const f = await fixture(901)
    const replacement = await fixture(901)
    const held = f.holdResponse()
    let iterator: Awaited<ReturnType<typeof nextTurn>> | undefined
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      f.completion.release(); await flush()
      iterator = await nextTurn(f)
      const independent = { ...f.approval, id: '901', params: { ...f.approval.params, turnId: f.runtime.activeTurnId } }
      await f.seam.handleRequest(f.runtime, independent)
      const pending = await f.manager.pending(f.session)
      assert.ok(pending)
      assert.equal((await f.manager.inspectResponseAvailability(f.session, { nativeRequestId: pending.turn.nativeRequestId!,
        nativeRequestType: pending.nativeRequestType, expectedNativeTurnId: pending.turn.nativeTurnId! })).state, 'available')
      await replacement.seam.handleRequest(replacement.runtime, replacement.approval)
      assert.equal((await replacement.manager.inspectResponseAvailability(replacement.session, replacement.query)).state, 'available')
      assert.equal(f.writes.length, 1)
      assert.deepEqual(replacement.writes, [])
    } finally { held.release(); await iterator?.return?.(); await Promise.all([f.cleanup(), replacement.cleanup()]) }
  })

  it('preserves a held response reservation under bounded completed-callback retention pressure', async () => {
    const f = await fixture()
    const held = f.holdResponse()
    let iterator: Awaited<ReturnType<typeof nextTurn>> | undefined
    try {
      await f.seam.handleRequest(f.runtime, f.file)
      f.completion.release(); await flush()
      iterator = await nextTurn(f)
      for (let id = 1_000; id < 2_050; id += 1) {
        await f.seam.handleRequest(f.runtime, { ...f.approval, id, params: { ...f.approval.params, turnId: f.runtime.activeTurnId } })
        f.seam.handleNotification(f.runtime, 'serverRequest/resolved', { threadId: f.session.nativeSessionId, requestId: id })
      }
      assert.ok(f.runtime.resolvedRequests.size <= 1_024)
      await f.seam.handleRequest(f.runtime, { ...f.approval, params: { ...f.approval.params, turnId: f.runtime.activeTurnId } })
      assert.equal(await f.manager.pending(f.session), undefined)
      assert.equal(f.writes.length, 1)
    } finally { held.release(); await iterator?.return?.(); await f.cleanup() }
  })

  for (const uncertainCleanup of [false, true]) it(`bounds pending responses and fences overflow approval (cleanup uncertain=${uncertainCleanup})`, async () => {
    const f = await fixture()
    const held = f.holdResponse()
    let iterator: Awaited<ReturnType<typeof nextTurn>> | undefined
    try {
      for (let id = 1_000; id < 1_128; id += 1) await f.seam.handleRequest(f.runtime, { ...f.file, id })
      f.completion.release(); await flush()
      assert.equal(f.writes.length, 128)
      iterator = await nextTurn(f)
      if (uncertainCleanup) f.failNextClose()
      await f.seam.handleRequest(f.runtime, { ...f.file, id: 9_090,
        params: { ...f.file.params, turnId: f.runtime.activeTurnId, callId: 'new-file-call' } })
      assert.equal(f.writes.length, 128)
      assert.equal(f.runtime.resolvedRequests.size, 128)
      assert.ok((await f.manager.history(f.session)).events.some((event) => event.type === 'files.response_capacity_exceeded'))
      const approval = { ...f.approval, id: 9_090, params: { ...f.approval.params, turnId: f.runtime.activeTurnId } }
      await f.seam.handleRequest(f.runtime, approval)
      assert.equal(await f.manager.pending(f.session), undefined)
      const translated = translateCodexInteraction({ session: f.session, configuration: f.runtime.configuration,
        connectionId: f.runtime.connectionId, generation: f.runtime.generation }, approval)!.pending
      const availability = await f.manager.inspectResponseAvailability(f.session, { nativeRequestId: translated.turn.nativeRequestId!,
        nativeRequestType: translated.nativeRequestType, expectedNativeTurnId: translated.turn.nativeTurnId! })
      assert.notEqual(availability.state, 'available')
      await assert.rejects(f.manager.respond(f.session, translated.turn.nativeRequestId!, translated.responseOptions[0]!))
      assert.equal(f.runtime.closed, true)
      assert.ok(f.closes() >= 1)
      assert.equal(f.writes.length, 128)
      if (uncertainCleanup) {
        await flush()
        assert.ok((await f.manager.history(f.session)).events.some((event) => event.type === 'transport.close_unconfirmed'))
        assert.ok(f.seam.transports.size > 0)
        await f.manager.close(f.session)
        assert.ok(f.closes() >= 2)
        assert.equal(f.writes.length, 128)
      }
    } finally { held.release(); await iterator?.return?.(); await f.cleanup() }
  })
})
