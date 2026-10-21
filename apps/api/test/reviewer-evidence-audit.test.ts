import assert from 'node:assert/strict'

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import { it } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import { ReviewEvidenceTracker, reviewTurnEvidence } from '../src/modules/interactions/reviewerEvidence.js'
import { LeaseGuard, ownedEvents, SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'
import { correlationId, event, permission, providerId, reviewerFixture, session, terminal, sourceTerminal } from './helpers/reviewerAudit.js'

it('reads the current capacity attempt without treating retained earlier turn IDs as conflicts', () => {
  const history = terminal()
  history.events = [
    event('turn.started', { threadId: session.nativeSessionId, turnId: 'first-turn', clientCorrelationId: correlationId }),
    event('turn.completed', { threadId: session.nativeSessionId, turnId: 'first-turn', status: 'failed', willRetry: true }),
    event('turn.capacity_retry', { threadId: session.nativeSessionId, turnId: 'first-turn' }),
    event('turn.started', { threadId: session.nativeSessionId, turnId: providerId, clientCorrelationId: correlationId }),
    event('turn.completed', { threadId: session.nativeSessionId, turnId: providerId, status: 'completed' }),
  ]
  assert.equal(reviewTurnEvidence(session, history, correlationId, providerId).terminal, true)
  const foreign = structuredClone(history)
  foreign.events[2]!.payload.threadId = 'foreign-session'
  assert.equal(reviewTurnEvidence(session, foreign, correlationId, providerId).terminal, false)
})

it('F2: cold Codex terminal metadata completes the exact review with no retained live events', () => {
  assert.deepEqual(reviewTurnEvidence(session, terminal(), correlationId), {
    acknowledged: true, terminal: true, nativeIdle: true, nativeBusy: false, providerId,
  })
  for (const outcome of ['succeeded', 'failed', 'canceled'] as const) {
    const history = terminal()
    history.terminalTurn!.result = { outcome }
    assert.equal(reviewTurnEvidence(session, history, correlationId, providerId).terminal, true)
  }
})

it('F2: cold dispatcher recovery attaches the durable review correlation and never submits again', async () => {
  const fixture = await reviewerFixture({ recovering: true })
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'completed')
  assert.equal(result.providerTurnOrMessageId, providerId)
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.attaches[0]?.correlationId, correlationId)
  const attachment = fixture.attaches[0]
  assert.ok(attachment?.kind === 'workflow')
  assert.equal(attachment.request.workflowNodeId, fixture.execution.workflowNodeId)
  assert.deepEqual(attachment.request.configuration, fixture.configuration)
  assert.deepEqual(attachment.request.input, fixture.execution.input)
  assert.equal(fixture.responses, 0)
  assert.equal(fixture.saved.events.length, 1)
})

it('F2: a durable provider ID is supplied to cold attach and cannot be substituted', async () => {
  const fixture = await reviewerFixture({ recovering: true })
  fixture.setJob({ providerTurnOrMessageId: providerId })
  await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(fixture.attaches[0]?.nativeTurnId, providerId)
  assert.equal(fixture.starts.length, 0)
})

it('F2: mismatched correlation, provider identity, missing exact metadata and pending requests veto completion', () => {
  const wrongHistoryCorrelation = { ...terminal(), correlationId: 'other-review' }
  const wrongTerminalCorrelation = terminal(); wrongTerminalCorrelation.terminalTurn!.correlationId = 'other-review'
  const wrongTurn = { ...terminal(), nativeTurnId: 'other-turn' }
  const noHistoryCorrelation = terminal(); delete noHistoryCorrelation.correlationId
  const noProviderId = terminal(); delete noProviderId.nativeTurnId
  const pendingList = { ...terminal(), pendingInteractions: [permission()] }
  const pendingSingle = { ...terminal(), pendingInteraction: permission() }
  for (const history of [wrongHistoryCorrelation, wrongTerminalCorrelation, wrongTurn, noHistoryCorrelation, noProviderId, pendingList, pendingSingle]) {
    assert.equal(reviewTurnEvidence(session, history, correlationId, providerId).terminal, false)
  }
  assert.equal(reviewTurnEvidence(session, terminal(), correlationId, 'durable-other-turn').terminal, false)
})

it('F2/F11: generic idle/latest output and unrelated native-session events never prove review completion', () => {
  const evidence = reviewTurnEvidence(session, {
    events: [event('thread.reconciled', { thread: { id: session.nativeSessionId, status: 'idle', turns: [] } }), event('turn.started', { threadId: 'other-session', turnId: providerId, clientCorrelationId: correlationId }),
      event('turn.completed', { threadId: 'other-session', turnId: providerId })],
    pendingInteractions: [], terminalResult: { outcome: 'succeeded' },
  }, correlationId)
  assert.equal(evidence.acknowledged, false)
  assert.equal(evidence.terminal, false)
  assert.equal(evidence.nativeIdle, true)
})

it('F2/F11: contradictory turn bindings remain rejected after later valid terminal metadata', () => {
  const tracker = new ReviewEvidenceTracker(session, correlationId)
  tracker.observeEvent(event('turn.started', { threadId: session.nativeSessionId, clientCorrelationId: correlationId, turnId: providerId }))
  tracker.observeEvent(event('turn.started', { threadId: session.nativeSessionId, clientCorrelationId: correlationId, turnId: 'other-turn' }))
  tracker.observeHistory(terminal())
  assert.equal(tracker.snapshot().identityConflict, true)
  assert.equal(tracker.snapshot().terminal, false)
  const sameIdDifferentCorrelation = new ReviewEvidenceTracker(session, correlationId, providerId)
  sameIdDifferentCorrelation.observeEvent(event('turn.started', { turnId: providerId, clientCorrelationId: 'other-review' }))
  sameIdDifferentCorrelation.observeHistory(terminal())
  assert.equal(sameIdDifferentCorrelation.snapshot().terminal, false)
})

it('F2: exact terminal metadata overrides its stale start event, but not another busy turn', () => {
  const same = new ReviewEvidenceTracker(session, correlationId, providerId)
  same.observeEvent(event('turn.started', { turnId: providerId, clientCorrelationId: correlationId }))
  same.observeHistory(terminal())
  assert.equal(same.snapshot().terminal, true)
  const other = new ReviewEvidenceTracker(session, correlationId, providerId)
  other.observeEvent(event('turn.started', { turnId: 'new-active-turn', clientCorrelationId: 'new-review' }))
  other.observeHistory(terminal())
  assert.equal(other.snapshot().terminal, false)
})

it('F11: 100,000 deltas are read once with zero retained event objects and exact final evidence', () => {
  const tracker = new ReviewEvidenceTracker(session, correlationId, providerId)
  let reads = 0
  const delta = { ...event('item.delta'), get payload() { reads += 1; return { text: 'x'.repeat(1_024) } } }
  for (let index = 0; index < 100_000; index += 1) {
    tracker.observeEvent(delta)
    tracker.snapshot()
  }
  tracker.observeHistory(terminal())
  assert.equal(reads, 100_000)
  assert.equal(tracker.processedEvents, 100_000)
  assert.equal(tracker.retainedEventCount, 0)
  assert.equal(tracker.snapshot().terminal, true)
  assert.ok(Object.values(tracker).every((value) => !Array.isArray(value)), 'tracker must not retain a transcript')
})

it('F11: actual session-writer evidence work is linear for a 20,000-event stream', async () => {
  const fixture = await reviewerFixture({ events: 20_000 })
  const lanes = nativeLanes()
  await lanes.ensureLane({ id: 'stress-lane', harness: 'codex', nativeSessionId: session.nativeSessionId,
    ownerAgentId: fixture.execution.agentId, observedStatus: 'idle', connectionGeneration: 0, observedAt: new Date().toISOString(), revision: 0 })
  let released: string | undefined
  const release = lanes.releaseLane.bind(lanes)
  lanes.releaseLane = async (id, token, fields) => { released = fields.observedStatus; return release(id, token, fields) }
  const writer = new SingleWriterSessionManager(fixture.manager, lanes, fixture.execution.agentId)
  let count = 0
  for await (const native of writer.startTurn(session, { prompt: 'Review only', clientCorrelationId: correlationId })) {
    assert.ok(native.type)
    count += 1
  }
  assert.equal(count, 20_001)
  assert.equal(released, 'idle')
})

it('F11: synchronous event floods yield to Stop timers and recheck ownership', async () => {
  const controller = new AbortController()
  let checks = 0
  const guard = new LeaseGuard(30_000, async () => { checks += 1 }, async () => new Date(Date.now() + 30_000).toISOString(), controller.signal)
  let count = 0
  const flood = async function* () { for (let i = 0; i < 100_000; i += 1) yield event('item.delta', {}, i) }
  const stop = setImmediate(() => controller.abort(new DomainError('TEST_STOP', 'Stop requested.', 409)))
  try {
    await assert.rejects(async () => { for await (const native of ownedEvents(flood(), guard)) { assert.ok(native); count += 1 } })
    assert.ok(count <= 256)
    assert.ok(checks >= count * 2)
  } finally { clearImmediate(stop); await guard.stop(); await yieldToEventLoop() }
})

it('F11: actual reviewer streaming reads each payload only for evidence and redaction, never a retained-history rescan', async () => {
  const fixture = await reviewerFixture()
  fixture.hooks.countOnly = true
  let reads = 0
  const count = 20_000
  fixture.manager.startTurn = async function* (_session, input) {
    await input.onSubmitted?.(providerId)
    for (let index = 0; index < count; index += 1) {
      yield { ...event('item.delta', {}, index), get payload() { reads += 1; return { text: 'delta' } } }
    }
    fixture.setHistory(sourceTerminal())
  }
  fixture.hooks.history = async () => sourceTerminal()
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'completed')
  assert.equal(fixture.hooks.eventCount, count + 1)
  // Redaction reads the provider getter once; evidence consumes the bounded
  // normalized copy, so no second provider-body walk or history rescan occurs.
  assert.equal(reads, count)
  assert.equal(fixture.saved.events.length, 0)
  assert.ok(fixture.saved.jobs.length <= 4)
}, 15_000)

it('F2/F11: lease loss after provider reconciliation forbids persisting the returned terminal evidence', async () => {
  const fixture = await reviewerFixture({ recovering: true })
  fixture.hooks.history = async () => { fixture.hooks.lostJob = true; return sourceTerminal() }
  await assert.rejects(fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker'),
    (error: unknown) => error instanceof DomainError && error.code === 'REVIEW_JOB_LEASE_LOST')
  assert.equal(fixture.saved.events.length, 0)
  assert.equal(fixture.saved.jobs.length, 0)
  assert.equal(fixture.starts.length, 0)
  assert.equal(fixture.revoked.length, 0)
})

it('F11: an idle lane retaining the last provider ID can accept a new correlation without confusing review identities', async () => {
  const fixture = await reviewerFixture()
  const lanes = nativeLanes()
  await lanes.ensureLane({ id: 'successive-lane', harness: 'codex', nativeSessionId: session.nativeSessionId,
    ownerAgentId: fixture.execution.agentId, observedStatus: 'idle', connectionGeneration: 0, observedAt: new Date().toISOString(), revision: 0 })
  let history = terminal('no-turn-yet')
  let starts = 0
  fixture.manager.startTurn = async function* (_session, input) {
    starts += 1
    const id = `native-turn-${starts}`
    await input.onSubmitted?.(id)
    const started = event('turn.started', { threadId: session.nativeSessionId, turnId: id, clientCorrelationId: input.clientCorrelationId })
    yield started
    history = { ...terminal(input.clientCorrelationId), nativeTurnId: id,
      terminalTurn: { correlationId: input.clientCorrelationId, providerId: id, result: { outcome: 'succeeded' } },
      events: [started, event('turn.completed', { threadId: session.nativeSessionId, turnId: id, clientCorrelationId: input.clientCorrelationId })] }
  }
  fixture.manager.reconcile = async (_session, requested) => history.correlationId === requested ? history
    : { events: history.events, pendingInteractions: [] }
  const writer = new SingleWriterSessionManager(fixture.manager, lanes, fixture.execution.agentId)
  for (const correlation of ['first-review', 'second-review']) {
    for await (const native of writer.startTurn(session, { prompt: 'Review', clientCorrelationId: correlation })) assert.ok(native)
  }
  assert.equal(starts, 2)
  assert.equal(reviewTurnEvidence(session, { events: history.events, pendingInteractions: [] }, 'third-review').terminal, false)
})

it('Claude evidence requires an exact observed native message receipt and terminal identity', () => {
  const claude = { ...session, harness: 'claude' as const, providerVersion: '2.1.284' }
  const message = { kind: 'message' as const, nativeSessionId: claude.nativeSessionId,
    nativeMessageId: 'native-observed-message', clientCorrelationId: correlationId }
  const history = { events: [], pendingInteractions: [], correlationId, nativeSubmission: message,
    terminalTurn: { correlationId, providerId: message.nativeMessageId, result: { outcome: 'succeeded' as const } } }
  assert.equal(reviewTurnEvidence(claude, history, correlationId).terminal, true)
  for (const receipt of [{ ...message, nativeSessionId: 'other-session' },
    { ...message, clientCorrelationId: 'other-correlation' }, { ...message, nativeMessageId: 'other-message' }]) {
    assert.equal(reviewTurnEvidence(claude, { ...history, nativeSubmission: receipt }, correlationId).terminal, false)
  }
  const noReceipt = { events: [], pendingInteractions: [], correlationId, terminalTurn: history.terminalTurn }
  assert.equal(reviewTurnEvidence(claude, noReceipt, correlationId).terminal, false)
  assert.equal(reviewTurnEvidence(claude, { ...noReceipt, nativeTurnId: message.nativeMessageId }, correlationId).terminal, false)
  assert.equal(reviewTurnEvidence(claude, { ...history, pendingInteractions: [permission()] }, correlationId).terminal, false)
})

it('recovers a review with saved dynamic-version provenance without replaying the submission', async () => {
  const fixture = await reviewerFixture({ recovering: true, savedProviderVersion: 'codex-cli 0.158.0' })
  const result = await fixture.dispatcher.dispatchNext(fixture.job.reviewerAgentId, 'worker')
  assert.equal(result?.state, 'completed')
  assert.equal(result.providerTurnOrMessageId, providerId)
  assert.equal(fixture.attaches.length, 1)
  assert.equal(fixture.starts.length, 0)
})
