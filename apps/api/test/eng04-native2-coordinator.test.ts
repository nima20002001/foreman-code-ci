import assert from 'node:assert/strict'
import { test } from 'vitest'
import { HarnessExecutionRequestSchema, ScopedMcpDetectionSchema } from '@foreman-code/contracts'
import { DomainError } from '../src/modules/errors.js'
import { native2Fixture } from './eng04-native2-fixtures.js'
import { nativeEventBatches } from '../src/modules/interactions/nativeEventBatches.js'

const pending = (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'REPEAT_CLEANUP_PENDING')

test('NATIVE-2 terminal SQL-only replay has zero physical or allocation calls', async () => {
  const f = native2Fixture(); f.settled()
  assert.equal((await f.observe()).state, 'completed')
  assert.deepEqual(f.calls, [`read:${f.get().id}`, `settle:${f.get().id}`])
})

test('NATIVE-2 missing closure is not permission to resolve/start a cleanup process', async () => {
  const f = native2Fixture()
  await assert.rejects(f.observe(), pending)
  assert.ok(!f.calls.some((call) => /resolve|startTurn|createSession|attachSession|capabilities|revoke/.test(call)))
})

test('NATIVE-2 captured close, durable receipt and principal revocation precede settlement', async () => {
  const f = native2Fixture(); f.installResident()
  assert.equal((await f.observe()).state, 'completed')
  const close = f.calls.indexOf(`close:${f.session.nativeSessionId}`)
  assert.ok(close >= 0)
  assert.ok(f.calls.indexOf('closure:41') > close)
  assert.ok(f.calls.indexOf('revoke:principal-native2-captured') > f.calls.indexOf('closure:41'))
  assert.ok(f.calls.lastIndexOf(`settle:${f.get().id}`) > f.calls.indexOf('release-manager'))
  assert.ok(!f.calls.some((call) => call.startsWith('revoke-execution:')))
})

test('NATIVE-2 lost revocation reply retries the captured principal without another close', async () => {
  const f = native2Fixture(); f.installResident()
  const revoke = f.credentials.revoke
  let first = true
  f.credentials.revoke = async (identity) => {
    if (first) { first = false; throw new Error('synthetic revocation reply gap') }
    await revoke(identity)
  }
  await assert.rejects(f.observe())
  assert.equal((await f.observe()).state, 'completed')
  assert.equal(f.calls.filter((call) => call.startsWith('close:')).length, 1)
  assert.equal(f.calls.filter((call) => call === 'revoke:principal-native2-captured').length, 1)
})

test('NATIVE-2 close/receipt gap never manufactures closure and retries only the same close', async () => {
  const f = native2Fixture(); f.installResident()
  const record = f.closures.record
  let first = true
  f.closures.record = async (...args) => {
    if (first) { first = false; throw new Error('synthetic close receipt COMMIT gap') }
    return record(...args)
  }
  await assert.rejects(f.observe())
  assert.equal(f.getProof(), undefined)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke:')))
  await f.observe()
  assert.deepEqual(f.calls.filter((call) => call.startsWith('close:')), Array(2).fill(`close:${f.session.nativeSessionId}`))
})

test('NATIVE-2 owner loss after physical close cannot revoke or release replacement authority', async () => {
  const f = native2Fixture(); f.installResident()
  f.manager.close = async () => { f.loseOwner() }
  await assert.rejects(f.observe())
  assert.ok(!f.calls.some((call) => call.startsWith('revoke') || call === 'release-manager'))
})

test('NATIVE-2 manager generation replacement rejects late close publication', async () => {
  const f = native2Fixture(); f.installResident()
  f.manager.close = async () => { f.resident.generation++ }
  await assert.rejects(f.observe())
  assert.equal(f.getProof(), undefined)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
})

test('NATIVE-2 durable close and prior revocation repair a budget/finalization gap after crash', async () => {
  const f = native2Fixture(); f.closed(); f.revoked()
  await f.observe()
  assert.ok(f.calls.includes(`budget:${f.get().id}`))
  assert.ok(!f.calls.some((call) => /resolve|startTurn|createSession|attachSession|close:|revoke/.test(call)))
})

test('NATIVE-2 cold unfinalized credential gap cannot broadly revoke a replacement lifetime', async () => {
  const f = native2Fixture(); f.closed()
  await assert.rejects(f.observe(), pending)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
})

test('NATIVE-2 finalized reviewer credential is never broadly revoked by requester replay', async () => {
  const f = native2Fixture(); f.closed()
  f.interactions.coordination.workflowSession = async () => ({ session: f.session, finalized: true, reviewerActive: true })
  await assert.rejects(f.observe(), pending)
  assert.ok(!f.calls.some((call) => call.startsWith('revoke')))
})

function liveRequest(f: ReturnType<typeof native2Fixture>) {
  return HarnessExecutionRequestSchema.parse({ executionId: f.get().id, runId: f.run.id,
    workspaceId: f.run.workspaceId, workflowNodeId: f.get().workflowNodeId,
    workingDirectory: f.get().workingDirectory, runtimeDirectory: f.get().runtimeDirectory,
    configuration: f.configuration, input: f.get().input })
}

test('NATIVE-2 nonterminal missing permit cannot prepare credentials or start native work', async () => {
  const f = native2Fixture(false); f.set({ ...f.get(), nativeSessionId: undefined })
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'needs_start' })
  f.store.authorizeNativeSubmission = async () => { throw new DomainError('NATIVE_ENTRY_CONFLICT', 'Missing committed entry permit', 409) }
  await assert.rejects(f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal }),
  (error: unknown) => error instanceof DomainError && error.code === 'NATIVE_ENTRY_CONFLICT')
  assert.ok(!f.calls.some((call) => /credential-prepare|createSession|startTurn/.test(call)))
  assert.ok(!f.calls.some((call) => call.startsWith('terminal:')))
})

test('NATIVE-2 recovery rejects a wrong exact native session before manager resolution', async () => {
  const f = native2Fixture(false)
  f.store.exactSession = async () => ({ ...f.session, nativeSessionId: 'session-other-occurrence' })
  await assert.rejects(f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal }),
  (error: unknown) => error instanceof DomainError && error.code === 'NATIVE_SESSION_IDENTITY_MISMATCH')
  assert.ok(!f.calls.includes('resolve'))
  assert.ok(!f.calls.some((call) => call.startsWith('terminal:')))
})

test('NATIVE-2 resident recovery observes the same turn, records terminal, closes and settles', async () => {
  const f = native2Fixture(false); f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  const observed = await f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal })
  assert.equal(observed.state, 'completed')
  assert.ok(f.calls.includes('terminal:succeeded'))
  assert.ok(!f.calls.some((call) => /startTurn|attachSession|createSession|capabilities|respond/.test(call)))
})

test('NATIVE-2 approval receipt wait preserves native lifetime and pauses active budget', async () => {
  const f = native2Fixture(false); f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  f.runs.updateExecution = async () => { throw new DomainError('APPROVAL_SETTLEMENT_PENDING', 'graph.resume or qualified acknowledgement pending', 409) }
  await assert.rejects(f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal }),
  (error: unknown) => error instanceof DomainError && error.code === 'APPROVAL_SETTLEMENT_PENDING')
  assert.ok(f.calls.includes('pause-budget'))
  assert.ok(!f.calls.some((call) => /close:|revoke:|respond|startTurn|unqualified-finalize/.test(call)))
})

test('NATIVE-2 raw provider payload keeps exact source tuple, session and continuation evidence', async () => {
  const f = native2Fixture(false); f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  const raw = { executionId: f.get().id, connectionId: 'connection-occurrence-1', sequence: 17,
    occurredAt: f.at, type: 'native2.raw.telemetry', payload: { message: 'unaltered provider carrier', extra: { count: 9 } } }
  let reads = 0
  f.manager.reconcile = async () => ++reads === 1
    ? JSON.parse(JSON.stringify({ ...f.history(), terminalTurn: undefined, events: [raw] })) : f.history()
  await f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal })
  assert.deepEqual(f.persisted[0]?.event, raw)
  assert.equal(f.persisted[0]?.owner, f.owner)
  assert.deepEqual(f.persisted[0]?.lease, { id: 'lane-native2-exact', token: 'lease-native2-exact', providerId: 'turn-native2-exact', live: false })
  const captured = f.persisted[0]?.evidence as { evidence: { source: unknown; session: unknown; lifetimeGeneration: number } }
  assert.deepEqual(captured.evidence.source, { type: 'event', event: raw })
  assert.deepEqual(captured.evidence.session, f.session)
  assert.equal(captured.evidence.lifetimeGeneration, 7)
})

test('NATIVE-2 first launch and terminal replay use one exact session and one turn', async () => {
  const f = native2Fixture(false)
  f.set({ ...f.get(), nativeSessionId: undefined })
  let creates = 0, turns = 0, permits = 0
  f.store.consumeLaunch = () => ++permits === 1
  const startTurn = async function* (session: unknown, input: { clientCorrelationId: string }) {
    assert.deepEqual(session, f.session)
    assert.equal(f.get().nativeSessionId, f.session.nativeSessionId)
    assert.equal(input.clientCorrelationId, `execution:${f.get().id}`)
    turns++
    yield { executionId: f.get().id, connectionId: 'connection-first-occurrence', sequence: 1,
      occurredAt: f.at, type: 'native2.raw.telemetry', payload: { source: 'synthetic-native' } }
  }
  const physical = { ...f.manager,
    createSession: async () => { creates++; return f.session },
    startTurn,
    async *startTurnBatches(session: unknown, input: {
      clientCorrelationId: string; onSessionReady?(): Promise<void>; onTurnOffered?(): void
    }) {
      assert.ok(input.onSessionReady)
      await input.onSessionReady()
      input.onTurnOffered?.()
      yield* nativeEventBatches(startTurn(session, input))
    },
  }
  f.internals.resolveManager = () => ({ manager: physical as never, processState: 'needs_start',
    beginStart: () => { f.calls.push('begin-start') }, markResident: () => { f.calls.push('resident') } })
  f.credentials.prepare = async (input) => {
    assert.equal(input.executionId, f.get().id)
    assert.equal(input.workingDirectory, f.get().workingDirectory)
    return { credential: { principalId: 'principal-native2-captured',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      environment: { agentId: f.get().agentId, variables: {} } },
    detection: ScopedMcpDetectionSchema.parse({ detection: { harness: 'codex', serverName: 'graphql',
      state: 'connected', endpointMatches: true, credentialEnvironmentVariable: 'GRAPHQL_MCP_TOKEN', checkedAt: f.at },
      runnerId: 'runner-native2', workingDirectory: input.workingDirectory,
      providerVersion: f.session.providerVersion, nativeFilters: {} }) }
  }
  const observed = await f.coordinator.observeExact({ execution: f.get(), request: liveRequest(f), approval: f.run.approval, store: f.store,
    owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id, signal: new AbortController().signal })
  assert.equal(observed.state, 'completed')
  assert.equal((await f.observe()).state, 'completed')
  assert.equal(creates, 1); assert.equal(turns, 1); assert.equal(permits, 1)
  assert.equal(f.persisted.length, 1)
  assert.ok(f.persisted[0]?.evidence)
  assert.equal(f.get().nativeSessionId, f.session.nativeSessionId)
  assert.equal(f.calls.filter((call) => call === 'closure:41').length, 1)
})

for (const replacement of ['owner', 'generation', 'session', 'copy'] as const) {
  test(`NATIVE-2 original boundary capture rejects ${replacement} replacement`, async () => {
    const f = native2Fixture(false); f.installResident()
    const evidence = await f.coordinator.nativeBoundaryEvidence(f.get().id, f.owner as never)
    const original = f.captureChannel.verify.read(evidence)
    assert.equal(original.owner, f.owner)
    assert.equal(original.lifetimeGeneration, 7)
    assert.deepEqual(original.session, f.session)
    assert.deepEqual(original.source, { type: 'boundary' })
    if (replacement === 'owner') f.loseOwner()
    if (replacement === 'generation') f.resident.generation++
    if (replacement === 'session') f.resident.session = { ...f.session, nativeSessionId: 'replacement-session' }
    assert.throws(() => f.captureChannel.verify.read(replacement === 'copy' ? structuredClone(evidence) : evidence),
      { code: replacement === 'owner' ? 'RUN_OWNERSHIP_LOST'
        : replacement === 'copy' ? 'NATIVE_SOURCE_NOT_CAPTURED' : 'NATIVE_LIFETIME_CHANGED' })
    assert.ok(!f.calls.some((call) => /terminal:|close:|revoke:/.test(call)))
  })
}
