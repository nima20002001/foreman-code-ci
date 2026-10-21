import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { afterEach, test, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, HarnessExecutionSchema, NATIVE_INTERACTION_FIXTURES, type DurableInteraction, type NativeHarnessEvent, type NativeSessionLane, type NativeSessionReference, type ReviewJob } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { RemoteExecutionHost, type RemoteExecutionHostPorts } from '../src/modules/runs/remote/executionHost.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { RemoteNativeSessionManager } from '../src/modules/runs/remote/nativeManagerProxy.js'

import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../src/modules/harnesses/port.js'
import { PostgresInteractionCoordinationRepository, type WriterFence } from '../src/modules/interactions/coordination.js'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { ReviewerDispatcher } from '../src/modules/interactions/reviewer.js'
import type { ReviewerNativeRuntime } from '../src/modules/interactions/reviewerRuntime.js'
import type { ReviewNativeCapture, ReviewOriginalNativeSource } from '../src/modules/interactions/reviewNativeCapture.js'
import type { RepeatReviewerBindings } from '../src/modules/interactions/repeatReviewer.js'
import { normalizeNativeProducerEvent } from '../src/modules/run-graph/nativeProducerNormalization.js'
import { reviewTurnEvidence } from '../src/modules/interactions/reviewerEvidence.js'
import { LeaseGuard, ownedEvents, SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'

afterEach(() => vi.useRealTimers())

const session = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'reviewer-native' } satisfies NativeSessionReference
const interaction: DurableInteraction = {
  ...NATIVE_INTERACTION_FIXTURES.codex,
  approval: { ...NATIVE_INTERACTION_FIXTURES.codex.approval, handler: 'orchestrator', designatedOrchestratorAgentId: 'reviewer' },
}
const event = (type: string, payload: Record<string, unknown> = {}): NativeHarnessEvent =>
  ({ sequence: 0, type, payload, occurredAt: new Date().toISOString() })
const history = (events: NativeHarnessEvent[] = []): NativeHistory => ({ events, pendingInteractions: [] })
const startEvent = (correlation: string) => event('turn.started', { threadId: session.nativeSessionId, turnId: 'native-turn', clientCorrelationId: correlation })
const endEvent = () => event('turn/completed', { threadId: session.nativeSessionId, turn: { id: 'native-turn', status: 'completed' } })
const idleHistory = () => history([event('thread.reconciled', { thread: { id: session.nativeSessionId, status: 'idle', turns: [] } })])
const clone = <T>(value: T): T => structuredClone(value)

/** Deterministic fencing fake. PostgreSQL predicate coverage lives in reviewer-coordination.test.ts. */
class CoordinationFake {
  job: ReviewJob | undefined
  lane: NativeSessionLane = { id: 'lane', harness: session.harness, nativeSessionId: session.nativeSessionId, ownerAgentId: 'reviewer', observedStatus: 'idle', revision: 0,
    connectionGeneration: 0, observedAt: new Date().toISOString() }
  context = { executionId: 'reviewer-execution', workingDirectory: '/accepted', providerVersion: session.providerVersion }
  transitions: ReviewJob['state'][] = []
  renewJobs = 0
  renewLanes = 0
  failJobRenewal = false
  failLaneRenewal = false
  pending = true
  delivered = false
  runStopped = false
  async reviewRunStopped() { return this.runStopped }
  readonly nativeEvents: NativeHarnessEvent[] = []
  // Scheduler-only policy port. Real immutable-graph checks live in the authenticated DB integration tests.
  graphAllowed = true
  async assertOrchestratorConnection() {
    if (!this.graphAllowed) throw new DomainError('INTERACTION_ACCESS_DENIED', 'Not directly connected.', 403)
  }
  async assertReviewConnection() { await this.assertOrchestratorConnection() }

  // This is a scheduler/coordination double, NOT production native-proof
  // qualification. Still require the original capture to reach its consumer;
  // a fabricated token or a different writer/job must never satisfy this seam.
  private readonly captures = new WeakMap<ReviewNativeCapture, {
    jobId: string; jobToken: string; writer: WriterFence; generation: number
    reference: NativeSessionReference; source: ReviewOriginalNativeSource
  }>()
  readonly captureNative: ReviewerNativeRuntime['captureReviewNative'] = (executionId, reference, job, lane, source) => {
    lane.guard.signal.throwIfAborted()
    assert.equal(executionId, this.context.executionId)
    assert.equal(job.id, this.job?.id)
    assert.ok(job.leaseToken)
    assert.equal(job.leaseToken, this.job?.leaseToken)
    assert.equal(reference.harness, job.provider)
    assert.equal(reference.nativeSessionId, job.nativeSessionId)
    assert.equal(reference.providerVersion, this.context.providerVersion)
    assert.equal(lane.fence.id, this.lane.id)
    assert.equal(lane.fence.token, this.lane.leaseToken)
    assert.equal(lane.previous.connectionGeneration, this.lane.connectionGeneration)
    const token = Object.freeze({ executionId })
    this.captures.set(token, { jobId: job.id, jobToken: job.leaseToken,
      writer: clone(lane.fence), generation: lane.previous.connectionGeneration,
      reference: clone(reference), source: clone(source) })
    return token
  }
  private readCapture(token: ReviewNativeCapture | undefined, job: ReviewJob, writer: WriterFence | undefined) {
    const captured = token && this.captures.get(token)
    assert.ok(captured, 'Original scheduler capture is required')
    assert.equal(token!.executionId, this.context.executionId)
    assert.equal(captured.jobId, job.id)
    assert.equal(captured.jobToken, job.leaseToken)
    assert.equal(captured.jobToken, this.job?.leaseToken)
    assert.deepEqual(captured.writer, writer)
    assert.equal(captured.writer.token, this.lane.leaseToken)
    assert.equal(captured.generation, this.lane.connectionGeneration)
    assert.equal(captured.reference.harness, job.provider)
    assert.equal(captured.reference.nativeSessionId, job.nativeSessionId)
    return captured.source
  }
  async appendReviewNativeEvent(job: ReviewJob, event: NativeHarnessEvent,
    options: { writer?: WriterFence; nativeCapture?: ReviewNativeCapture }) {
    this.publishEvents(job, [event], options)
  }
  async appendReviewNativeHistory(job: ReviewJob, events: NativeHarnessEvent[],
    options: { writer?: WriterFence; nativeCapture?: ReviewNativeCapture }) {
    this.publishEvents(job, events, options)
  }
  private publishEvents(job: ReviewJob, events: NativeHarnessEvent[],
    options: { writer?: WriterFence; nativeCapture?: ReviewNativeCapture }) {
    const source = this.readCapture(options.nativeCapture, job, options.writer)
    const originals = source.type === 'event' ? [source.event] : source.type === 'history' ? source.history.events : []
    for (const event of events) {
      assert.ok(originals.some((original) => isDeepStrictEqual(event,
        normalizeNativeProducerEvent({ ...original, executionId: this.context.executionId }).event)),
      'Projected event must come from the exact captured original event/history')
      this.nativeEvents.push(clone(event))
    }
  }

  asRepository() { return this as unknown as PostgresInteractionCoordinationRepository }
  async ensureReviewJob(job: ReviewJob, context: typeof this.context) {
    if (this.job) return { job: clone(this.job), created: false }
    this.job = clone(job); this.context = context
    return { job: clone(job), created: true }
  }
  async findReviewJob() { return this.job && clone(this.job) }
  async getReviewJobContext() { return this.context }
  async nextReviewJob() {
    if (!this.job || this.job.state === 'completed'
      || (this.job.state === 'failed' && (!this.job.cleanup || this.job.cleanup.completedAt))
      || (this.job.leaseExpiresAt && Date.parse(this.job.leaseExpiresAt) > Date.now())
      || (this.job.retryAfter && Date.parse(this.job.retryAfter) > Date.now())) return undefined
    return clone(this.job)
  }
  async reviewJobAgents() { return await this.nextReviewJob() ? ['reviewer'] : [] }
  async isReviewPending() { return this.pending }
  async reviewDecisionDelivered() { return this.delivered }
  async claimReviewJob(_id: string, owner: string, token: string, expires: string) {
    const current = await this.nextReviewJob()
    // Recheck after the await, just as the SQL update holds the row lock.
    if (!current || (this.job?.leaseExpiresAt && Date.parse(this.job.leaseExpiresAt) > Date.now())) {
      throw new DomainError('REVIEW_JOB_NOT_CLAIMABLE', 'owned', 409)
    }
    this.job = { ...current, state: ['submitted', 'acknowledged', 'uncertain', 'failed'].includes(current.state) ? current.state : 'leased',
      attempt: current.attempt + 1, leaseOwner: owner, leaseToken: token, leaseExpiresAt: expires, retryAfter: undefined }
    return clone(this.job)
  }
  async assertReviewJobLease(_id: string, token: string) {
    if (this.job?.leaseToken !== token || Date.parse(this.job.leaseExpiresAt ?? '') <= Date.now()) {
      throw new DomainError('REVIEW_JOB_LEASE_LOST', 'lost', 409)
    }
  }
  async renewReviewJob(id: string, token: string, ms: number) {
    if (this.failJobRenewal) throw new DomainError('REVIEW_JOB_LEASE_LOST', 'lost', 409)
    await this.assertReviewJobLease(id, token)
    this.renewJobs++
    return this.job!.leaseExpiresAt = new Date(Date.now() + ms).toISOString()
  }
  async transitionReviewJob(id: string, token: string, state: ReviewJob['state'], fields: {
    providerTurnOrMessageId?: string; writerFence?: WriterFence; releaseLease?: boolean; error?: ReviewJob['error']; cleanup?: ReviewJob['cleanup']; retryAfter?: string
    nativeCapture?: ReviewNativeCapture
  } = {}) {
    await this.assertReviewJobLease(id, token)
    if (fields.writerFence) await this.assertLaneLease(fields.writerFence.id, fields.writerFence.token)
    if (state === 'submitted') assert.equal(this.readCapture(fields.nativeCapture, this.job!, fields.writerFence).type, 'entry')
    this.transitions.push(state)
    this.job = { ...this.job!, state, updatedAt: new Date().toISOString(),
      ...(fields.providerTurnOrMessageId ? { providerTurnOrMessageId: fields.providerTurnOrMessageId } : {}),
      ...(fields.error ? { error: fields.error } : {}),
      ...(fields.cleanup ? { cleanup: fields.cleanup } : {}),
      ...(fields.retryAfter ? { retryAfter: fields.retryAfter } : {}) }
    if (state === 'submitted') this.job.submittedAt = new Date().toISOString()
    if (state === 'acknowledged') this.job.acknowledgedAt = new Date().toISOString()
    if (state === 'completed') this.job.completedAt = new Date().toISOString()
    if (fields.releaseLease ?? ['completed', 'failed', 'uncertain', 'blocked_busy', 'blocked_disconnected'].includes(state)) {
      delete this.job.leaseOwner; delete this.job.leaseToken; delete this.job.leaseExpiresAt
    }
    return clone(this.job)
  }
  async ensureLane(lane: NativeSessionLane) {
    if (lane.ownerAgentId !== this.lane.ownerAgentId) throw new DomainError('SESSION_LANE_OWNER_CONFLICT', 'wrong owner', 409)
    return clone(this.lane)
  }
  async getLane() { return clone(this.lane) }
  async claimLane(_id: string, revision: number, owner: string, token: string, expires: string, correlationId: string) {
    if (revision !== this.lane.revision || (this.lane.leaseExpiresAt && Date.parse(this.lane.leaseExpiresAt) > Date.now())) {
      throw new DomainError('SESSION_LANE_BUSY', 'busy', 409)
    }
    this.lane = { ...this.lane, revision: revision + 1, leaseOwner: owner, leaseToken: token,
      leaseExpiresAt: expires, observedStatus: 'busy' }
    void correlationId
    return clone(this.lane)
  }
  async assertLaneLease(_id: string, token: string) {
    if (this.lane.leaseToken !== token || Date.parse(this.lane.leaseExpiresAt ?? '') <= Date.now()) {
      throw new DomainError('SESSION_LANE_LEASE_LOST', 'lost', 409)
    }
  }
  async bindLaneTurn(fence: WriterFence, correlation: string) {
    await this.assertLaneLease(fence.id, fence.token)
    this.lane.correlationId = correlation
    delete this.lane.currentTurnOrMessageId
  }
  async acknowledgeLaneTurn(fence: WriterFence, correlation: string, providerId: string) {
    await this.assertLaneLease(fence.id, fence.token)
    if (this.lane.correlationId !== correlation
      || this.lane.currentTurnOrMessageId && this.lane.currentTurnOrMessageId !== providerId) {
      throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT', 'Different native turn.', 409)
    }
    this.lane.currentTurnOrMessageId = providerId
  }
  async renewLane(id: string, token: string, ms: number) {
    if (this.failLaneRenewal) throw new DomainError('SESSION_LANE_LEASE_LOST', 'lost', 409)
    await this.assertLaneLease(id, token)
    this.renewLanes++
    return this.lane.leaseExpiresAt = new Date(Date.now() + ms).toISOString()
  }
  async releaseLane(id: string, token: string, observed: Pick<NativeSessionLane, 'observedStatus' | 'currentTurnOrMessageId'>) {
    await this.assertLaneLease(id, token)
    this.lane = { ...this.lane, ...observed, revision: this.lane.revision + 1 }
    delete this.lane.leaseOwner; delete this.lane.leaseToken; delete this.lane.leaseExpiresAt
    if (observed.observedStatus === 'idle' && !observed.currentTurnOrMessageId) delete this.lane.correlationId
    return clone(this.lane)
  }
}

function fixture(ms = 30_000) {
  const coordination = new CoordinationFake()
  let started = 0
  let attached = 0
  let reconciled = 0
  let canceled = 0
  let responded = 0
  const manager = {
    harness: 'codex',
    capabilities: async () => ({ providerVersion: session.providerVersion }),
    createSession: async () => session,
    attachSession: async () => { attached++; return session },
    startTurn: async function* (_session: NativeSessionReference, input: { clientCorrelationId: string }) {
      started++; yield startEvent(input.clientCorrelationId); coordination.pending = false; yield endEvent()
    },
    reconcile: async () => { reconciled++; return idleHistory() },
    pending: async () => undefined,
    history: async () => history(),
    respond: async () => { responded++ },
    cancel: async () => { canceled++; return true },
    close: async () => undefined,
  } as unknown as NativeHarnessSessionManager
  const runtime: ReviewerNativeRuntime = {
    withInteractionOwner: (_interaction, signal, work) => work(signal),
    attachInteraction: async () => ({ manager, session }), attachOwnedSession: async () => ({ manager, session }),
    captureReviewNative: coordination.captureNative,
  }
  const dispatcher = new ReviewerDispatcher(coordination.asRepository(), runtime, ms)
  return { coordination, manager, runtime, dispatcher, counts: () => ({ started, attached, reconciled, canceled, responded }) }
}
async function enqueue(f: ReturnType<typeof fixture>) {
  return f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
}

for (const source of ['callback', 'event'] as const) test(`persists the reviewer turn from its ${source} before native proof capture`, async () => {
  const f = fixture()
  const capturedTurns: Array<string | undefined> = []
  f.runtime.captureReviewNative = (executionId, reference, job, lane, original) => {
    if (original.type === 'event' && original.event.type === 'turn.started') {
      capturedTurns.push(f.coordination.lane.currentTurnOrMessageId)
    }
    return f.coordination.captureNative(executionId, reference, job, lane, original)
  }
  f.manager.startTurn = async function* (_reference, input) {
    if (source === 'callback') await input.onSubmitted?.('native-turn')
    yield startEvent(input.clientCorrelationId)
    f.coordination.pending = false
    yield endEvent()
  }
  await enqueue(f)
  await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.deepEqual(capturedTurns, ['native-turn'])
})

test('publishes the reviewer acknowledgement after native proof becomes available', async () => {
  const f = fixture()
  const transition = f.coordination.transitionReviewJob.bind(f.coordination)
  f.coordination.transitionReviewJob = async (id, token, state, fields) => {
    const result = await transition(id, token, state, fields)
    if (state === 'acknowledged' && f.coordination.nativeEvents.length === 0) {
      // Production defers public acknowledgement until the original native event is committed.
      f.coordination.job = { ...result, state: 'submitted' }
      delete f.coordination.job.acknowledgedAt
      return clone(f.coordination.job)
    }
    return result
  }
  f.manager.startTurn = async function* (_reference, input) {
    await input.onSubmitted?.('native-turn')
    yield startEvent(input.clientCorrelationId)
    f.coordination.pending = false
    yield endEvent()
  }
  await enqueue(f)
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.ok(result?.acknowledgedAt)
})

async function remoteReviewerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'remote-reviewer-'))
  const path = join(root, 'journal')
  let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
  const coordination = new CoordinationFake()
  const digest = 'a'.repeat(64)
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID()
  const configuration = { id: 'reviewer-config', agentId: 'reviewer', workspaceId: interaction.workspaceId, version: 1,
    productRole: 'orchestrator' as const, prompt: { system: 'Review assigned interactions' }, assignedSkills: [],
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'read-only' as const },
    contentHash: `sha256:${digest}`, createdAt: new Date().toISOString() }
  const placement = freezePlacement({ schemaVersion: 1, mainId, mainInstallationId: mainId,
    runId: interaction.runId, nodeId: 'orchestrator', hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'source-tree', materializationDigest: digest },
    destination: { canonicalProjectRoot: '/accepted', canonicalCwd: '/accepted', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'root', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    payload: { kind: 'agent', agentId: 'reviewer', agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'codex', installationFingerprint: digest, protocolRevision: '1',
      runtimeContractVersion: 1, credentialScopeRefs: [] } })
  const intent = deriveDispatch(placement, { executionId: coordination.context.executionId,
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation',
    inputDigest: `sha256:${createHash('sha256').update(canonicalGraphJson({})).digest('hex')}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const request = { executionId: intent.executionId, runId: intent.runId, workspaceId: interaction.workspaceId,
    workflowNodeId: intent.nodeId, workingDirectory: '/accepted', runtimeDirectory: `/runtime/${intent.executionId}`, configuration, input: {} }
  const state = { workflows: 0, reviews: 0, decisions: 0, creates: 0, closed: false, disconnect: false, parked: false }
  let release!: () => void
  const resumed = new Promise<void>(resolve => { release = resolve })
  const histories = new Map<string, NativeHistory>()
  const events: NativeHarnessEvent[] = []
  let activeCorrelation = `execution:${intent.executionId}`
  const native: NativeHarnessSessionManager = {
    harness: 'codex', capabilities: async () => { throw new Error('Unused discovery') },
    inspectMcp: async () => { throw new Error('Unused inspection') },
    createSession: async () => { state.creates++; return session }, attachSession: async () => session,
    startTurn: async function* (_session, input) {
      activeCorrelation = input.clientCorrelationId
      const workflow = input.clientCorrelationId === `execution:${intent.executionId}`
      if (workflow) state.workflows++; else state.reviews++
      const providerId = workflow ? 'workflow-turn' : 'native-turn'
      await input.onSubmitted?.(providerId)
      const started = { ...event('turn.started', { threadId: session.nativeSessionId, turnId: providerId,
        clientCorrelationId: input.clientCorrelationId }), sequence: events.length }
      events.push(started)
      histories.set(activeCorrelation, { events, pendingInteractions: [], correlationId: activeCorrelation, nativeTurnId: providerId })
      yield started
      if (!workflow) {
        if (state.parked) await resumed
        state.decisions++
        coordination.pending = false
        coordination.delivered = true
      }
      const ended = { ...event('turn/completed', { threadId: session.nativeSessionId,
        turn: { id: providerId, status: 'completed' } }), sequence: events.length }
      events.push(ended)
      histories.set(activeCorrelation, { events, pendingInteractions: [], correlationId: activeCorrelation,
        nativeTurnId: providerId, nextSequence: events.length,
        terminalTurn: { correlationId: activeCorrelation, providerId, result: { outcome: 'succeeded', output: { reviewed: !workflow } } } })
      yield ended
    },
    history: async () => histories.get(activeCorrelation) ?? history(),
    reconcile: async (_session, correlation) => clone(histories.get(correlation) ?? history()),
    pending: async () => undefined, respond: async () => { throw new Error('Reviewer cannot approve its own native request') },
    cancel: async () => { release(); return false }, close: async () => { state.closed = true }, dispose: async () => {},
  }
  const { ExecutionScopedNativeSessionManagerResolver } = await import('../src/modules/interactions/runtimePorts.js')
  const managers = new ExecutionScopedNativeSessionManagerResolver(() => native)
  const ports: RemoteExecutionHostPorts = { journal, managers, incarnationId: randomUUID(),
    connection: { mainId, deviceId, workerInstallationId, bootId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, connectionGeneration: 1 },
    authorize: async (pin, saved) => { assert.deepEqual(pin, intent); assert.deepEqual(saved, placement) },
    authorizeReview: async (_intent, _placement, review) => {
      await coordination.assertReviewConnection()
      await coordination.assertReviewJobLease(review.jobId, review.leaseToken)
      assert.equal(coordination.lane.correlationId, review.correlationId)
      assert.equal(review.correlationId, coordination.job!.correlationId)
      assert.equal(review.interactionId, coordination.job!.interactionId)
      assert.equal(review.reviewerAgentId, 'reviewer')
      assert.deepEqual(review.session, session)
    },
    attestRuntimeLeaf: async () => ({ executionId: intent.executionId, attemptId: intent.attemptId,
      operationId: intent.operationId, bindingHash: intent.bindingHash, canonicalRuntimeDirectory: request.runtimeDirectory,
      directoryIdentityHash: digest, materializationId: 'source-tree', materializationDigest: digest }),
    preflight: async () => {}, nativeEvidence: async () => ({ sessionId: session.nativeSessionId, processIdentityDigest: digest }),
    verifyRecovery: async (receipt, reference, proof) => {
      assert.equal(proof, digest)
      assert.equal(receipt.native?.sessionId, reference.nativeSessionId)
      assert.equal(state.closed, false)
    },
    settle: async (_intent, observed) => {
      const status = await journal.status(intent.operationId)
      if (status.status !== 'known') throw new Error('Original journal unavailable')
      if (status.receipt.stopFence) { await native.close(session); return { kind: 'cancelled', closureEvidenceDigest: digest } }
      await journal.retainReviewer(intent.operationId, { agentId: 'reviewer', expiresAt: new Date(Date.now() + 60_000).toISOString() }, observed)
      return null
    },
  }
  let host = new RemoteExecutionHost(ports)
  const proxy = () => new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration,
    transport: { request: (method, frame) => {
      if (state.disconnect && method === 'history' && state.reviews) throw new Error('Review channel disconnected')
      return host.handle(frame)
    } }, observeReceipt: async () => {},
    controlFor: async ({ native: target }) => ({ schemaVersion: 1, protocolVersion: 1, commandId: 'run-end',
      operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId,
      bindingHash: intent.bindingHash, owner: intent.owner, native: target, action: { kind: 'stop' } }) })
  let manager = proxy()
  await manager.createSession({ request, correlationId: activeCorrelation })
  for await (const _event of manager.startTurn(session, { prompt: 'Initialize the Orchestrator', clientCorrelationId: activeCorrelation })) { void _event }
  await host.drain()
  const runtime: ReviewerNativeRuntime = { captureReviewNative: coordination.captureNative,
    withInteractionOwner: (_interaction, signal, work) => work(signal),
    attachInteraction: async () => ({ manager, session }), attachOwnedSession: async () => ({ manager, session }),
    prepareReviewTurn: async (_executionId, reference, job) => manager.prepareReview(reference, job) }
  const dispatcher = new ReviewerDispatcher(coordination.asRepository(), runtime)
  const dispatchers = new Set([dispatcher])
  return { state, coordination, dispatcher, get manager() { return manager }, get journal() { return journal },
    request, intent, placement, release,
    async restartMain() {
      await dispatcher.shutdown()
      await manager.closeForRestart(session)
      await manager.dispose()
      manager = proxy()
      await manager.attachSession(session, { request, correlationId: `execution:${intent.executionId}` })
      const replacement = new ReviewerDispatcher(coordination.asRepository(), runtime)
      dispatchers.add(replacement)
      return replacement
    },
    async restart() {
      await host.drain()
      await journal.close()
      journal = await RemoteOperationJournal.open(path)
      ports.journal = journal
      host = new RemoteExecutionHost(ports)
      await host.recover({ intent, placement, request, session, evidenceDigest: digest })
      manager = proxy()
      await manager.attachSession(session, { request, correlationId: `execution:${intent.executionId}` })
    },
    async close() {
      release()
      await Promise.all([...dispatchers].map(current => current.shutdown()))
      await host.drain()
      await journal.close()
      await rm(root, { recursive: true, force: true })
    } }
}

test('remote workflow settlement retains its Orchestrator for an assigned review and delivered decision', async () => {
  const f = await remoteReviewerFixture()
  try {
    assert.equal(f.state.closed, false)
    assert.deepEqual([f.state.workflows, f.state.reviews, f.state.decisions], [1, 0, 0])
    await f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
    const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(result?.state, 'completed')
    assert.equal(f.coordination.delivered, true)
    assert.deepEqual([f.state.creates, f.state.workflows, f.state.reviews, f.state.decisions], [1, 1, 1, 1])
    assert.equal(f.state.closed, false)
    await f.manager.close(session)
    assert.equal(f.state.closed, true)
    const status = await f.journal.status(f.intent.operationId)
    assert.equal(status.status === 'known' && status.receipt.phase, 'confirmed_terminal')
  } finally { await f.close() }
})

test('Main restart detaches observation while the original Worker review continues without resubmission', async () => {
  const f = await remoteReviewerFixture()
  try {
    await f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
    f.state.parked = true
    const dispatch = f.dispatcher.dispatchNext('reviewer', 'original-observer')
    const detached = assert.rejects(dispatch, { code: 'ENGINE_RESTART' })
    await vi.waitFor(() => assert.equal(f.coordination.job?.state, 'acknowledged'))
    const original = clone(f.coordination.job!)
    const replacement = await f.restartMain()
    await detached
    assert.equal(f.coordination.job?.leaseToken, undefined)
    assert.equal(f.coordination.lane.leaseToken, undefined)
    assert.equal(f.coordination.job?.providerTurnOrMessageId, original.providerTurnOrMessageId)
    assert.equal(f.coordination.lane.currentTurnOrMessageId, original.providerTurnOrMessageId)
    assert.equal(f.state.closed, false)
    assert.deepEqual([f.state.creates, f.state.workflows, f.state.reviews, f.state.decisions], [1, 1, 1, 0])
    f.release()
    const completed = await replacement.dispatchNext('reviewer', 'replacement-observer')
    assert.equal(completed?.state, 'completed')
    assert.equal(completed?.id, original.id)
    assert.equal(completed?.nativeSessionId, original.nativeSessionId)
    assert.equal(completed?.providerTurnOrMessageId, original.providerTurnOrMessageId)
    assert.equal(f.coordination.delivered, true)
    assert.deepEqual([f.state.creates, f.state.workflows, f.state.reviews, f.state.decisions], [1, 1, 1, 1])
    assert.equal(f.state.closed, false)
  } finally { await f.close() }
})

test('review reconnect and host restart observe the original submitted turn without another native submission', async () => {
  const f = await remoteReviewerFixture()
  try {
    await f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
    f.state.parked = true
    f.state.disconnect = true
    const first = await f.dispatcher.dispatchNext('reviewer', 'before-reconnect')
    assert.equal(first?.state, 'uncertain')
    assert.equal(f.state.reviews, 1)
    f.state.disconnect = false
    f.release()
    await f.restart()
    delete f.coordination.job!.retryAfter
    const recovered = await f.dispatcher.dispatchNext('reviewer', 'after-restart')
    assert.equal(recovered?.state, 'completed')
    assert.equal(f.state.creates, 1)
    assert.equal(f.state.reviews, 1)
    assert.equal(f.state.decisions, 1)
    await assert.rejects(f.manager.reconcile(session, 'unassigned-correlation'))
  } finally { await f.close() }
})

test('denied remote review authority leaves the retained owner unchanged and starts no review', async () => {
  const f = await remoteReviewerFixture()
  try {
    await f.dispatcher.enqueue(interaction, 'reviewer', session, f.coordination.context)
    f.coordination.graphAllowed = false
    await assert.rejects(f.dispatcher.dispatchNext('reviewer', 'denied'), { code: 'INTERACTION_ACCESS_DENIED' })
    assert.equal(f.state.reviews, 0)
    assert.equal(f.state.decisions, 0)
    assert.equal(f.state.closed, false)
    assert.equal(f.request.configuration.harness.sandbox, 'read-only')
  } finally { await f.close() }
})

test('rejects an unconnected request before persisting or dispatching a review', async () => {
  const f = fixture(); f.coordination.graphAllowed = false
  await assert.rejects(enqueue(f), { code: 'INTERACTION_ACCESS_DENIED' })
  assert.equal(f.coordination.job, undefined)
  assert.equal(f.counts().started, 0)
})

test('rechecks topology on recovery before claiming an older queued review', async () => {
  const f = fixture(); await enqueue(f); f.coordination.graphAllowed = false
  await assert.rejects(f.dispatcher.dispatchNext('reviewer', 'worker'), { code: 'INTERACTION_ACCESS_DENIED' })
  assert.equal(f.coordination.job?.state, 'pending')
  assert.equal(f.counts().started, 0)
  assert.equal(f.counts().attached, 0)
})

test('settles terminal review history before repeated publication expires its physical observation', async () => {
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  try {
    const f = fixture(900_000)
    const events = Array.from({ length: 8 }, (_, sequence) => ({ ...event('item/started'), sequence }))
    events.push({ ...endEvent(), sequence: 8 })
    f.manager.reconcile = async () => history(events)
    const capturedAt = new Map<ReviewNativeCapture, number>()
    const capture = f.runtime.captureReviewNative
    f.runtime.captureReviewNative = (...args) => {
      const value = capture(...args)
      if (args[4].type === 'history') capturedAt.set(value, now)
      return value
    }
    const append = f.coordination.appendReviewNativeEvent.bind(f.coordination)
    f.coordination.appendReviewNativeEvent = async (job, event, options) => {
      const observedAt = options.nativeCapture && capturedAt.get(options.nativeCapture)
      if (observedAt !== undefined) {
        now += 10_000
        if (now - observedAt >= 60_000) throw new Error('Original physical observation expired')
      }
      await append(job, event, options)
    }
    await enqueue(f)
    const completed = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(completed?.state, 'completed')
    assert.equal(f.counts().started, 1)
    for (const event of events) {
      assert.ok(f.coordination.nativeEvents.some(projected => projected.sequence === event.sequence
        && projected.type === normalizeNativeProducerEvent({ ...event, executionId: f.coordination.context.executionId }).event.type))
    }
  } finally {
    clock.mockRestore()
  }
})

test.each([
  ['completion', 'busy'], ['restart', 'busy'],
  ['completion', 'acknowledgement only'], ['restart', 'acknowledgement only'],
] as const)(
  'recovery keeps a retained review authorized until %s with %s history', async (settlement, observation) => {
    const f = fixture()
    const job = await enqueue(f)
    const now = new Date().toISOString()
    f.coordination.job = { ...job, state: 'acknowledged', attempt: 1,
      submittedAt: now, acknowledgedAt: now, providerTurnOrMessageId: 'native-turn' }
    f.coordination.lane.correlationId = job.correlationId
    Object.defineProperty(f.manager, 'retainsReviewerSession', { value: true })
    let observing!: () => void
    const observed = new Promise<void>(resolve => { observing = resolve })
    let finish!: (value: NativeHistory) => void
    const terminal = new Promise<NativeHistory>(resolve => { finish = resolve })
    let reads = 0
    f.manager.reconcile = async () => {
      if (reads++ === 0) {
        if (observation === 'busy') return history([startEvent(job.correlationId)])
        return { ...history(), correlationId: job.correlationId, nativeTurnId: 'native-turn' }
      }
      observing()
      return terminal
    }
    const dispatch = f.dispatcher.dispatchNext('reviewer', 'replacement-main')
    try {
      await Promise.race([observed, dispatch.then(() => {
        throw new Error('The running review released its observation before terminal history.')
      })])
      assert.equal(f.coordination.job?.state, 'acknowledged')
      assert.equal(f.coordination.job?.attempt, 2)
      await f.coordination.assertReviewJobLease(job.id, f.coordination.job!.leaseToken!)
      await f.coordination.assertLaneLease('lane', f.coordination.lane.leaseToken!)
      assert.equal(await f.dispatcher.dispatchNext('reviewer', 'competing-main'), undefined)
      assert.equal(f.counts().started, 0)
      if (settlement === 'restart') {
        await f.dispatcher.shutdown()
        await assert.rejects(dispatch, { code: 'ENGINE_RESTART' })
        assert.equal(f.coordination.job?.state, 'acknowledged')
        assert.equal(f.coordination.pending, true)
        assert.equal(f.counts().canceled, 0)
      } else {
        f.coordination.pending = false
        finish(history([endEvent()]))
        const completed = await dispatch
        assert.equal(completed?.state, 'completed')
        assert.equal(completed?.providerTurnOrMessageId, 'native-turn')
      }
      assert.equal(f.coordination.job?.leaseToken, undefined)
      assert.equal(f.coordination.lane.leaseToken, undefined)
      assert.equal(f.counts().started, 0)
    } finally {
      finish(history([endEvent()]))
      await f.dispatcher.shutdown()
    }
  },
)

test('post-delivery disconnect remains recoverable and only matching terminal history completes it', async () => {
  const f = fixture(); await enqueue(f)
  let submissions = 0
  f.manager.startTurn = async function* (_session, input) {
    submissions++
    yield startEvent(input.clientCorrelationId)
    f.coordination.pending = false
    f.coordination.delivered = true
    throw new Error('stream disconnected after decision delivery')
  }
  const first = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(first?.state, 'uncertain')
  assert.equal(first?.completedAt, undefined)
  assert.equal(first?.providerTurnOrMessageId, 'native-turn')
  assert.equal(f.coordination.lane.observedStatus, 'uncertain')
  // A session-idle event alone is not completion of the exact review.
  delete f.coordination.job!.retryAfter
  f.manager.reconcile = async () => idleHistory()
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'recovery-1'))?.state, 'acknowledged')
  f.manager.reconcile = async () => history([endEvent()])
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'recovery-2'))?.state, 'completed')
  assert.equal(submissions, 1)
  assert.equal(f.counts().responded, 0)
  assert.equal(f.coordination.delivered, true)
})

for (const failure of ['credential', 'identity'] as const) {
  test(`post-delivery ${failure} failure stays failed with cleanup instead of successful completion`, async () => {
    const f = fixture(); await enqueue(f)
    const credential = new AbortController()
    let revoked = 0, submissions = 0
    f.runtime.maintainReviewCredential = async (_executionId, _session, signal) => ({
      principalId: 'captured-principal', signal: AbortSignal.any([signal, credential.signal]),
      stop: async () => undefined, invalidate: async () => { revoked++ },
    })
    f.manager.startTurn = async function* (_session, input) {
      submissions++
      yield startEvent(input.clientCorrelationId)
      f.coordination.pending = false; f.coordination.delivered = true
      if (failure === 'credential') {
        credential.abort(new DomainError('REVIEWER_CREDENTIAL_LOST', 'credential maintenance failed', 409))
        credential.signal.throwIfAborted()
      }
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'conflicting native identity', 409)
    }
    f.manager.reconcile = async () => history()
    const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(result?.state, 'failed')
    assert.equal(result?.error?.code, failure === 'credential' ? 'REVIEWER_CREDENTIAL_LOST' : 'REVIEW_JOB_IDENTITY_CONFLICT')
    assert.equal(result?.cleanup?.nativeState, 'pending')
    assert.equal(result?.cleanup?.completedAt, undefined)
    assert.equal(revoked, 1)
    assert.equal(submissions, 1)
    assert.equal(f.counts().responded, 0)
    if (failure === 'identity') assert.equal(f.counts().canceled, 0)
    assert.ok(await f.coordination.nextReviewJob())
  })
}

test('a terminal Run moves an unsettled post-delivery review into closure-only recovery after restart', async () => {
  const f = fixture(); const job = await enqueue(f)
  f.coordination.job = { ...job, state: 'uncertain', submittedAt: job.createdAt, providerTurnOrMessageId: 'native-turn' }
  f.coordination.runStopped = true
  f.coordination.delivered = true; f.coordination.pending = false
  let attaches = 0, cleanupReads = 0
  f.runtime.attachOwnedSession = async () => { attaches++; return { manager: f.manager, session } }
  f.runtime.recoverReviewCleanup = async () => { cleanupReads++; return { manager: f.manager, resident: false, closed: false } }
  const restarted = new ReviewerDispatcher(f.coordination.asRepository(), f.runtime)
  const result = await restarted.dispatchNext('reviewer', 'after-restart')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEW_RUN_STOPPED')
  assert.equal(result?.cleanup?.nativeState, 'pending')
  assert.equal(attaches, 0)
  await restarted.dispatchNext('reviewer', 'cleanup')
  assert.equal(cleanupReads, 1)
  assert.equal(f.coordination.job?.cleanup?.completedAt, undefined)
  assert.equal(f.counts().started, 0)
  await restarted.shutdown()
})

for (const harness of ['codex'] as const) {
  for (const attachMode of ['resident', 'reattach'] as const) {
    test(`${harness} ${attachMode} uses A's saved pair to settle preflight before starting B`, async () => {
      const f = fixture()
      const reference: NativeSessionReference = { harness, providerVersion: '0.154.0', nativeSessionId: 'sequential-review' }
      const oldCorrelation = 'review-A'
      const oldProvider = 'native-A'
      const oldEvents = [event('thread.reconciled', { thread: {
        id: reference.nativeSessionId, status: 'idle', turns: [
          { id: oldProvider, clientUserMessageId: oldCorrelation, status: 'completed' },
        ],
      } })]
      f.coordination.lane = { ...f.coordination.lane, harness, nativeSessionId: reference.nativeSessionId,
        observedStatus: 'uncertain', correlationId: oldCorrelation, currentTurnOrMessageId: oldProvider }
      const reconciled: string[] = []
      let submissions = 0, attached = 0
      const manager: NativeHarnessSessionManager = { ...f.manager, harness,
        attachSession: async (_session, input) => {
          attached++
          assert.equal(input.correlationId, oldCorrelation)
          assert.equal(input.nativeTurnId, oldProvider)
          return reference
        },
        reconcile: async (_session, correlation) => {
          reconciled.push(correlation)
          return correlation === oldCorrelation ? history(oldEvents) : history()
        },
        startTurn: async function* (_session, input) {
          submissions++
          assert.notEqual(input.clientCorrelationId, oldCorrelation)
          f.coordination.pending = false
          yield event('turn.started', { threadId: reference.nativeSessionId, turnId: 'native-B', clientCorrelationId: input.clientCorrelationId })
          yield event('turn/completed', { threadId: reference.nativeSessionId, turn: { id: 'native-B', status: 'completed' } })
        },
      }
      f.runtime.attachOwnedSession = async (context) => {
        assert.equal(context.correlationId, oldCorrelation)
        assert.equal(context.nativeTurnId, oldProvider)
        if (attachMode === 'reattach') {
          const owner = new SingleWriterSessionManager(manager, f.coordination.asRepository(), 'reviewer')
          await owner.attachSession(reference, { kind: 'workflow', correlationId: context.correlationId,
            nativeTurnId: context.nativeTurnId } as NativeSessionStart)
        }
        return { manager, session: reference }
      }
      await f.dispatcher.enqueue(interaction, 'reviewer', reference, f.coordination.context)
      assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'completed')
      assert.equal(reconciled[0], oldCorrelation)
      assert.equal(submissions, 1)
      assert.equal(attached, attachMode === 'reattach' ? 1 : 0)
    })
  }
}

test('a changed unresolved lane pair refuses stale reattachment before any native call', async () => {
  const f = fixture()
  f.coordination.lane = { ...f.coordination.lane, observedStatus: 'uncertain', correlationId: 'new-owner', currentTurnOrMessageId: 'new-turn' }
  const writer = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  await assert.rejects(writer.attachSession(session, { kind: 'workflow', correlationId: 'old-owner', nativeTurnId: 'old-turn' } as NativeSessionStart),
    { code: 'SESSION_LANE_BUSY' })
  assert.equal(f.counts().attached, 0)
})

for (const status of ['busy', 'disconnected', 'uncertain'] as const) {
  test(`refreshes stale ${status} native lane before dispatch`, async () => {
    const f = fixture(); await enqueue(f)
    f.coordination.lane.observedStatus = status
    const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
    assert.equal(result?.state, 'completed')
    assert.equal(f.counts().started, 1)
    assert.equal(f.coordination.lane.observedStatus, 'idle')
  })
}

test('enqueues idempotently and enforces designated reviewer ownership', async () => {
  const f = fixture()
  const first = await enqueue(f); const second = await enqueue(f)
  assert.equal(second.id, first.id)
  assert.equal(second.correlationId, first.correlationId)
  assert.equal(second.nativeSessionId, session.nativeSessionId)
  await assert.rejects(f.dispatcher.enqueue(interaction, 'other', session, f.coordination.context), { code: 'REVIEWER_ASSIGNMENT_MISMATCH' })
})

test('does not submit a review after the interaction is decided or canceled', async () => {
  const f = fixture(); await enqueue(f); f.coordination.pending = false
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'failed')
  assert.equal(f.counts().started, 0)
})

test('a missing saved cgroup boundary blocks review permanently without replaying native work', async () => {
  const f = fixture(); await enqueue(f)
  f.runtime.attachOwnedSession = async () => { throw Object.assign(new Error('missing native boundary'), {
    code: 'ENOENT', path: '/sys/fs/cgroup/test/graphql-native-12345678-1234-1234-1234-123456789abc',
  }) }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEW_NATIVE_CLOSURE_UNCONFIRMED')
  assert.equal(result?.cleanup?.nativeState, 'pending')
  assert.equal(result?.cleanup?.completedAt, undefined)
  f.runtime.recoverReviewCleanup = async () => ({ manager: f.manager, resident: false, closed: false })
  const restarted = new ReviewerDispatcher(f.coordination.asRepository(), f.runtime)
  assert.equal((await restarted.dispatchNext('reviewer', 'cleanup-worker'))?.state, 'failed')
  assert.equal(f.coordination.job?.cleanup?.completedAt, undefined)
  assert.equal(f.counts().started, 0)
  await restarted.shutdown()
})

test('a transient reviewer attachment failure delays its next attempt', async () => {
  const f = fixture(); await enqueue(f)
  f.runtime.attachOwnedSession = async () => { throw new Error('transport unavailable') }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'blocked_disconnected')
  assert.ok(Date.parse(result.retryAfter!) > Date.now())
  assert.equal(await f.dispatcher.dispatchNext('reviewer', 'worker'), undefined)
  assert.equal(f.counts().started, 0)
})

for (const cleanup of [false, true]) {
  test(`persists ${cleanup ? 'cleanup' : 'attachment'} failure before releasing the reviewer session`, async () => {
    const f = fixture()
    await enqueue(f)
    if (cleanup) {
      f.coordination.job = { ...f.coordination.job!, state: 'failed', cleanup: {
        nativeState: 'pending', credentialState: 'pending', interruptState: 'not_sent',
      } }
      f.runtime.recoverReviewCleanup = async () => { throw new Error('transport unavailable') }
    } else {
      f.runtime.attachOwnedSession = async () => { throw new Error('transport unavailable') }
    }
    let committed = false
    const releasedAfterCommit: boolean[] = []
    const transition = f.coordination.transitionReviewJob.bind(f.coordination)
    f.coordination.transitionReviewJob = async (...args) => {
      await new Promise<void>(resolve => setImmediate(resolve))
      const result = await transition(...args)
      committed = true
      return result
    }
    f.runtime.releaseReviewSession = async () => { releasedAfterCommit.push(committed) }

    const result = await f.dispatcher.dispatchNext('reviewer', 'worker')

    assert.equal(result?.state, cleanup ? 'failed' : 'blocked_disconnected')
    assert.deepEqual(releasedAfterCommit, [true])
    assert.equal(f.counts().started, 0)
  })
}

test('fresh review preserves the unresolved previous review pair at attachment and preflight', async () => {
  const f = fixture(); await enqueue(f)
  f.coordination.lane = { ...f.coordination.lane, observedStatus: 'uncertain',
    correlationId: 'review-A', currentTurnOrMessageId: 'native-A' }
  let attachedCorrelation: string | undefined
  let attachedTurn: string | undefined
  const inspected: string[] = []
  f.runtime.attachOwnedSession = async (context) => {
    attachedCorrelation = context.correlationId
    attachedTurn = context.nativeTurnId
    return { manager: f.manager, session }
  }
  f.manager.reconcile = async (_session, correlation) => {
    inspected.push(correlation)
    return correlation === 'review-A' ? history([event('thread.reconciled', { thread: {
      id: session.nativeSessionId, status: 'idle', turns: [{ id: 'native-A', clientUserMessageId: 'review-A', status: 'completed' }],
    } })]) : idleHistory()
  }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'completed')
  assert.equal(attachedCorrelation, 'review-A')
  assert.equal(attachedTurn, 'native-A')
  assert.equal(inspected[0], 'review-A')
  assert.equal(f.counts().started, 1)
})

test('a terminal reviewer turn without a decision fails visibly and is never replayed', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    yield endEvent()
  }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEW_NO_DECISION')
  assert.ok(result?.cleanup)
  assert.equal(f.counts().started, 0)
  f.runtime.recoverReviewCleanup = async () => ({ manager: f.manager, resident: false, closed: false })
  const recovered = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(recovered?.state, 'failed')
  assert.equal(recovered?.cleanup?.completedAt, undefined)
  assert.equal(f.counts().started, 0)
})

test('delivered decision does not hide authority loss or falsely settle the native review', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    f.coordination.pending = false
    f.coordination.delivered = true
    throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The Run completed.', 409)
  }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'failed')
  assert.equal(result?.error?.code, 'REVIEWER_CREDENTIAL_LOST')
  assert.equal(result?.cleanup?.nativeState, 'pending')
  assert.equal(result?.cleanup?.completedAt, undefined)
  assert.equal(f.coordination.delivered, true)
  assert.equal(f.counts().responded, 0)
})

test('iterator exhaustion and unrelated events are not acknowledgement or completion', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* () { yield event('thread.started', { threadId: session.nativeSessionId }) }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
  assert.deepEqual(f.coordination.transitions, ['submitted', 'uncertain'])
})

test('generic submission errors stay uncertain, explicit pre-acceptance rejection fails', async () => {
  for (const [error, expected] of [[new Error('socket lost'), 'uncertain'], [new NativeDeliveryError('turn_submission', 'not_sent', new Error('rejected')), 'failed']] as const) {
    const f = fixture(); await enqueue(f)
    f.manager.startTurn = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw error } }) })
    assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, expected)
  }
})

test('an acknowledged turn is never classified as definitely rejected by a later error', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    throw Object.assign(new Error('later read rejected'), { certainty: 'definite' })
  }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'uncertain')
  assert.equal(result?.providerTurnOrMessageId, 'native-turn')
})

for (const state of ['submitted', 'acknowledged', 'uncertain', 'blocked_disconnected', 'leased'] as const) {
  test(`recovers ${state} with prior submission using original correlation, never resubmits`, async () => {
    const f = fixture(); const job = await enqueue(f)
    f.coordination.job = { ...job, state, submittedAt: job.createdAt,
      leaseExpiresAt: new Date(Date.now() - 100).toISOString(), leaseToken: 'old' }
    f.coordination.pending = false
    f.coordination.lane.observedStatus = 'uncertain'
    f.coordination.lane.correlationId = job.correlationId
    f.manager.reconcile = async (_session, correlation) => {
      assert.equal(correlation, job.correlationId)
      return history([startEvent(job.correlationId), endEvent()])
    }
    const recovered = await f.dispatcher.dispatchNext('reviewer', 'successor')
    assert.equal(recovered?.state, 'completed')
    assert.equal(recovered?.correlationId, job.correlationId)
    assert.equal(recovered?.nativeSessionId, job.nativeSessionId)
    assert.equal(f.counts().started, 0)
  })
}

test('bare uncertain state without timestamps survives repeated recovery crashes without resend', async () => {
  const f = fixture(); const job = await enqueue(f)
  f.coordination.job = { ...job, state: 'uncertain' }
  const result = await f.dispatcher.dispatchNext('reviewer', 'worker')
  assert.equal(result?.state, 'uncertain')
  assert.equal(f.counts().started, 0)
})

test('acknowledged nonterminal EOF remains recoverable instead of completed', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* (_session, input) { yield startEvent(input.clientCorrelationId) }
  f.manager.reconcile = async () => history()
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'acknowledged')
  assert.equal(f.coordination.job?.leaseToken, undefined)
})

test('two dispatchers cannot double-claim one job', async () => {
  const f = fixture(); await enqueue(f)
  const results = await Promise.all([f.dispatcher.dispatchNext('reviewer', 'one'), f.dispatcher.dispatchNext('reviewer', 'two')])
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(f.counts().started, 1)
})

test('a proven idle lane starts its first turn without inventing a recovery correlation', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  for await (const _event of owner.startTurn(session, { clientCorrelationId: 'first-turn', prompt: 'hello' })) void _event
  assert.equal(f.counts().started, 1)
  assert.equal(f.counts().reconciled, 1)
  assert.equal(f.coordination.lane.observedStatus, 'idle')
})

test('shutdown releases reviewer observation without reporting a runtime failure or canceling its turn', async () => {
  const f = fixture()
  await enqueue(f)
  let began!: () => void
  const observing = new Promise<void>(resolve => { began = resolve })
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId)
    began()
    await new Promise<void>(() => undefined)
  }
  const errors: unknown[] = []
  await f.dispatcher.reconcile(error => { errors.push(error) })
  await observing
  await f.dispatcher.shutdown()
  assert.deepEqual(errors, [])
  assert.equal(f.coordination.job?.state, 'acknowledged')
  assert.equal(f.coordination.pending, true)
  assert.equal(f.coordination.lane.observedStatus, 'uncertain')
  assert.equal(f.coordination.lane.leaseToken, undefined)
  assert.equal(f.coordination.lane.currentTurnOrMessageId, 'native-turn')
  assert.equal(f.counts().canceled, 0)
  assert.equal(f.counts().responded, 0)
})

test('shutdown joins a direct dispatch read before releasing its database', async () => {
  const f = fixture()
  await enqueue(f)
  let began!: () => void
  let release!: () => void
  const reading = new Promise<void>(resolve => { began = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const next = f.coordination.nextReviewJob.bind(f.coordination)
  let databaseOpen = true
  f.coordination.nextReviewJob = async () => {
    began()
    await held
    assert.equal(databaseOpen, true)
    return next()
  }
  const dispatch = f.dispatcher.dispatchNext('reviewer', 'worker').catch(error => error)
  await reading
  const closing = f.dispatcher.shutdown().then(() => { databaseOpen = false })
  await new Promise<void>(resolve => setImmediate(resolve))
  release()

  const result = await dispatch
  await closing

  assert.equal(result, undefined)
  assert.equal(databaseOpen, false)
  assert.equal(f.coordination.job?.leaseToken, undefined)
  assert.equal(f.counts().started, 0)
})

test('a captured writer preserves the restart cancellation reason while refusing further evidence', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  const stopped = new AbortController()
  const reason = new DomainError('ENGINE_RESTART', 'Restart requested.', 409)
  await owner.withLane(session, 'review', stopped.signal, async (_manager, lane) => {
    owner.assertCapturedLease(session, lane)
    stopped.abort(reason)
    assert.throws(() => owner.assertCapturedLease(session, lane), error => error === reason)
  })
  assert.equal(f.coordination.lane.leaseToken, undefined)
  assert.equal(f.coordination.lane.observedStatus, 'uncertain')
})

test('shutdown still reports an unexpected native capture failure', async () => {
  const f = fixture()
  await enqueue(f)
  let captured!: () => void
  const failure = new Promise<void>(resolve => { captured = resolve })
  f.runtime.captureReviewNative = () => {
    captured()
    void f.dispatcher.shutdown()
    throw new Error('Unexpected native capture failure')
  }
  const errors: unknown[] = []
  await f.dispatcher.reconcile(error => { errors.push(error) })
  await failure
  await f.dispatcher.shutdown()
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof Error)
  assert.equal(errors[0].message, 'Unexpected native capture failure')
})

for (const failure of ['dispatch', 'finalizer', 'release', 'dispatch-and-cleanup'] as const) {
  test(`preserves ${failure} errors and attempts reviewer session release`, async () => {
    const f = fixture()
    await enqueue(f)
    const steps: string[] = []
    const dispatchError = new DomainError('REVIEW_JOB_LEASE_LOST', 'Dispatch lease lost.', 409)
    const finalizerError = new Error('Review finalizer failed.')
    const releaseError = new Error('Review session release failed.')
    const dispatchFails = failure === 'dispatch' || failure === 'dispatch-and-cleanup'
    const finalizerFails = failure === 'finalizer' || failure === 'dispatch-and-cleanup'
    const releaseFails = failure === 'release' || failure === 'dispatch-and-cleanup'
    if (dispatchFails) {
      f.runtime.attachOwnedSession = async () => { throw dispatchError }
    }
    f.runtime.finishReview = async () => {
      steps.push('finalize')
      if (finalizerFails) throw finalizerError
    }
    f.runtime.releaseReviewSession = async () => {
      steps.push('release')
      if (releaseFails) throw releaseError
    }
    await assert.rejects(f.dispatcher.dispatchNext('reviewer', 'worker'), (error: unknown) => {
      if (failure === 'dispatch-and-cleanup') {
        assert.ok(error instanceof AggregateError)
        assert.equal(error.errors.length, 3)
        assert.ok(error.errors[0] instanceof DomainError)
        assert.equal(error.errors[0].code, dispatchError.code)
        assert.equal(error.errors[0].message, dispatchError.message)
        assert.ok(error.errors[1] instanceof Error)
        assert.equal(error.errors[1].message, finalizerError.message)
        assert.equal(error.errors[2], releaseError)
      } else if (dispatchFails) {
        assert.ok(error instanceof DomainError)
        assert.equal(error.code, dispatchError.code)
        assert.equal(error.message, dispatchError.message)
      } else if (finalizerFails) {
        assert.ok(error instanceof Error)
        assert.equal(error.message, finalizerError.message)
      } else {
        assert.equal(error, releaseError)
      }
      return true
    })
    assert.deepEqual(steps, ['finalize', 'release'])
  })
}

test('reviewer and normal workflow turn share active lane; long turns renew both leases', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  let finish!: () => void
  const turnFinished = new Promise<void>(resolve => { finish = resolve })
  const f = fixture(150); await enqueue(f)
  let started!: () => void
  const began = new Promise<void>((resolve) => { started = resolve })
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId); started()
    await turnFinished; f.coordination.pending = false; yield endEvent()
  }
  const task = f.dispatcher.dispatchNext('reviewer', 'worker')
  await began
  try {
    const ordinary = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer', 150)
    await assert.rejects(async () => { for await (const _event of ordinary.startTurn(session, { clientCorrelationId: 'normal', prompt: 'normal' })) { void _event } }, { code: 'SESSION_LANE_BUSY' })
    assert.equal(f.coordination.lane.observedStatus, 'busy')
    await vi.waitFor(() => {
      assert.ok(f.coordination.renewJobs >= 2)
      assert.ok(f.coordination.renewLanes >= 2)
    }, { interval: 10, timeout: 400 })
    finish()
    assert.equal((await task)?.state, 'completed')
    assert.ok(f.coordination.renewJobs >= 2)
    assert.ok(f.coordination.renewLanes >= 2)
  } finally {
    finish()
    await f.dispatcher.shutdown()
  }
})

for (const lost of ['job', 'lane'] as const) {
  test(`${lost} lease loss fences subsequent reviewer transitions and ends uncooperative iterator`, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const f = fixture(120); await enqueue(f)
    let nextCalls = 0
    f.manager.startTurn = (_session, input) => ({
      [Symbol.asyncIterator]: () => ({ next: async () => {
        nextCalls++
        if (nextCalls === 1) {
          if (lost === 'job') f.coordination.failJobRenewal = true
          else f.coordination.failLaneRenewal = true
          return { done: false, value: startEvent(input.clientCorrelationId) }
        }
        return new Promise<IteratorResult<NativeHarnessEvent>>(() => undefined)
      } }),
    })
    const rejected = assert.rejects(f.dispatcher.dispatchNext('reviewer', 'worker'), {
      code: lost === 'job' ? 'REVIEW_JOB_LEASE_LOST' : 'SESSION_LANE_LEASE_LOST',
    })
    await vi.waitFor(() => assert.equal(nextCalls, 2), { interval: 1, timeout: 100 })
    await vi.advanceTimersByTimeAsync(120)
    await rejected
    assert.deepEqual(f.coordination.transitions, ['submitted', 'acknowledged'])
    assert.equal(nextCalls, 2)
    assert.ok(f.coordination.lane.leaseToken)
  })
}

test('hung renewal expires the local writer even when native iterator ignores abort', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  const guard = new LeaseGuard(90, async () => undefined, () => new Promise<string>(() => undefined))
  const stream = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<NativeHarnessEvent>>(() => undefined) }) }
  const rejected = assert.rejects(async () => {
    for await (const _event of ownedEvents(stream, guard)) { void _event }
  }, { code: 'SESSION_LANE_LEASE_LOST' })
  await vi.advanceTimersByTimeAsync(90)
  await rejected
  await guard.stop()
})

test('normal turn fences new turns and attach while allowing owned approval control', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  let finish!: () => void
  const gate = new Promise<void>((resolve) => { finish = resolve })
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  f.manager.startTurn = async function* (_session, input) {
    yield startEvent(input.clientCorrelationId); began(); await gate; yield endEvent()
  }
  const task = (async () => { for await (const _event of owner.startTurn(session, { clientCorrelationId: 'normal', prompt: '' })) { void _event } })()
  await started
  const other = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  await assert.rejects(other.attachSession(session, {} as NativeSessionStart), { code: 'SESSION_LANE_BUSY' })
  await owner.respond(session, 'exact-request', interaction.responseOptions[0]!)
  assert.equal(f.counts().responded, 1)
  assert.equal(f.counts().attached, 0)
  finish(); await task
})

test('Stop can acquire cancellation after the streaming owner aborts without faking idle', async () => {
  const f = fixture()
  const owner = new SingleWriterSessionManager(f.manager, f.coordination.asRepository(), 'reviewer')
  const stop = new AbortController()
  let began!: () => void
  const started = new Promise<void>((resolve) => { began = resolve })
  f.manager.startTurn = async function* (_session, input, signal) {
    yield startEvent(input.clientCorrelationId); began()
    await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }))
  }
  const task = (async () => { for await (const _event of owner.startTurn(session, { clientCorrelationId: 'normal', prompt: '' }, stop.signal)) { void _event } })()
  const result = task.catch(() => undefined)
  await started; stop.abort()
  assert.equal(await owner.cancel(session), true)
  await result
  assert.equal(f.counts().canceled, 1)
})

test('query echo, old result and unrelated terminal ID are not review completion', () => {
  const result = reviewTurnEvidence(session, {
    ...history([event('thread.reconciled', { correlationId: 'review', thread: { id: session.nativeSessionId, turns: [{ id: 'old', status: 'completed' }] } }),
      event('turn/completed', { turnId: 'old' })]), terminalResult: { outcome: 'succeeded' },
  }, 'review')
  assert.equal(result.acknowledged, false)
  assert.equal(result.terminal, false)
})

test('recovery correlates Codex persisted client message ID, not the query echo', () => {
  const result = reviewTurnEvidence(session, history([event('thread.reconciled', {
    correlationId: 'query-only', thread: { id: session.nativeSessionId, status: 'idle',
      turns: [{ id: 'exact', clientUserMessageId: 'review', status: 'completed' }] },
  })]), 'review')
  assert.equal(result.terminal, true)
  assert.equal(result.providerId, 'exact')
})

test('failed reattachment cannot turn timestamp-free uncertainty into fresh work', async () => {
  const f = fixture(); const job = await enqueue(f)
  f.coordination.job = { ...job, state: 'uncertain' }
  f.runtime.attachOwnedSession = async () => { throw new Error('offline') }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
  f.runtime.attachOwnedSession = async () => ({ manager: f.manager, session })
  await f.dispatcher.dispatchNext('reviewer', 'successor')
  assert.equal(f.counts().started, 0)
})

test('a definite reconciliation read failure is not a definitely rejected submission', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = async function* () { yield* [] }
  let reads = 0
  f.manager.reconcile = async () => {
    if (++reads === 1) return idleHistory()
    throw Object.assign(new Error('history unavailable'), { certainty: 'definite' })
  }
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
})

test('known native turn identity cannot be replaced by a second turn with the same correlation', () => {
  const result = reviewTurnEvidence(session, history([
    startEvent('review'), endEvent(),
    event('thread.reconciled', { thread: { id: session.nativeSessionId, turns: [
      { id: 'original-turn', clientUserMessageId: 'review', status: 'inProgress' },
      { id: 'native-turn', clientUserMessageId: 'review', status: 'completed' },
    ] } }),
  ]), 'review', 'original-turn')
  assert.equal(result.providerId, 'original-turn')
  assert.equal(result.terminal, false)
})

function queueFixture() {
  const f = fixture()
  let executions = [{ state: 'completed', id: 'reviewer-execution', agentId: 'reviewer', workflowNodeId: 'reviewer-node', nativeSessionId: session.nativeSessionId,
    agentConfigurationVersionId: 'pinned-reviewer-config', workingDirectory: '/accepted', runtimeDirectory: '/runtime' }]
  const configuration = { id: 'pinned-reviewer-config', agentId: 'reviewer', productRole: 'orchestrator', harness: { harness: 'codex' } }
  const resolvedContexts: unknown[] = []
  const runs = { get: async () => ({ id: interaction.runId, executionSemanticsVersion: 3 }),
    getExecutionConfiguration: async () => configuration }
  // Discovery now receives the exact immutable relationship/occurrence binding,
  // rather than scanning all executions for the latest matching Agent.
  const selections: unknown[] = []
  const bindings: RepeatReviewerBindings = { async select(request, nodeId) {
    assert.deepEqual(request, interaction)
    assert.equal(nodeId, 'reviewer-node')
    selections.push({ request: clone(request), nodeId })
    const selected = executions[0]
    if (executions.length !== 1 || !selected) throw new DomainError('REPEAT_REVIEW_IDENTITY_CONFLICT',
      'No accepted execution of the exact reviewer relationship is available.', 409)
    const at = '2026-09-26T00:00:00.000Z'
    return { execution: HarnessExecutionSchema.parse({ runId: interaction.runId, attempt: 1, input: {},
      createdAt: at, startedAt: at, finishedAt: at, result: { outcome: 'succeeded', output: {} }, ...selected }),
      relationshipId: 'approval-reviewer-requester', requesterOccurrenceId: null, reviewerOccurrenceId: null }
  } }
  const repository = { coordination: Object.assign(f.coordination.asRepository(), { workflowSession: async () => ({ session, finalized: true }) }),
    assertOrchestratorConnection: async () => ({ orchestratorNodeId: 'reviewer-node' }), list: async () => [interaction] }
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator(runs as unknown as Args[0], repository as unknown as Args[1],
    {} as Args[2], { resolve: (context) => { resolvedContexts.push(context); return { manager: f.manager, processState: 'resident' } } },
    30_000, undefined, undefined, undefined, bindings)
  return { ...f, coordinator, resolvedContexts, selections, setExecutions: (value: typeof executions) => { executions = value } }
}

test('creation recovery binds the designated Agent real durable execution and native context', async () => {
  const f = queueFixture()
  let scheduled = 0
  f.coordinator.reviewers.reconcile = async () => { scheduled++ }
  await f.coordinator.reconcileReviews((error) => { throw error })
  assert.equal(f.coordination.job?.reviewerAgentId, 'reviewer')
  assert.equal((await f.coordination.findReviewJob())?.nativeSessionId, session.nativeSessionId)
  assert.equal(f.coordination.context.executionId, 'reviewer-execution')
  assert.equal(f.coordination.context.workingDirectory, '/accepted')
  assert.equal(f.coordination.context.providerVersion, session.providerVersion)
  assert.equal(f.counts().started, 0)
  assert.equal(scheduled, 1)
  assert.deepEqual(f.selections, [{ request: interaction, nodeId: 'reviewer-node' }])
})

test('queue recovery reuses an existing durable job without rebinding to a later execution', async () => {
  const f = queueFixture()
  await f.coordinator.enqueueReview(interaction)
  const first = clone(f.coordination.job)
  f.setExecutions([{ state: 'completed', id: 'replacement', agentId: 'reviewer', workflowNodeId: 'review-node', nativeSessionId: 'replacement-session',
    agentConfigurationVersionId: 'replacement-config', workingDirectory: '/different', runtimeDirectory: '/runtime' }])
  await f.coordinator.enqueueReview(interaction)
  assert.deepEqual(f.coordination.job, first)
  assert.equal(f.resolvedContexts.length, 0)
  assert.equal(f.selections.length, 1)
})

test('a missing exact reviewer binding fails closed, never replaced with the requester session', async () => {
  const f = queueFixture()
  f.setExecutions([])
  await assert.rejects(f.coordinator.enqueueReview(interaction), { code: 'REPEAT_REVIEW_IDENTITY_CONFLICT' })
  assert.equal(f.coordination.job, undefined)
  assert.equal(f.resolvedContexts.length, 0)
  assert.equal(f.counts().started, 0)
})

test('durable session attach rejects an identity different from its saved execution', async () => {
  const f = fixture()
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator({ getExecution: async () => ({
    id: 'reviewer-execution', agentId: 'reviewer', nativeSessionId: 'saved-native', workingDirectory: '/accepted', runtimeDirectory: '/runtime',
  }) } as unknown as Args[0], { coordination: f.coordination.asRepository() } as Args[1], {} as Args[2], {} as Args[3], 30_000)
  await assert.rejects(coordinator.attachOwnedSession({ harness: 'codex', executionId: 'reviewer-execution', agentId: 'reviewer', workingDirectory: '/accepted' }, session),
    /ownership context does not match/)
  assert.equal(f.counts().attached, 0)
})

test('fresh native idle status refreshes a lane without falsely completing the review', () => {
  const result = reviewTurnEvidence(session, idleHistory(), 'review')
  assert.equal(result.nativeIdle, true)
  assert.equal(result.terminal, false)
  assert.equal(result.acknowledged, false)
  const busyHistory = history([event('thread.reconciled', { thread: {
    id: session.nativeSessionId, status: 'active', turns: [{ id: 'other-turn', status: 'inProgress' }],
  } })])
  const busy = reviewTurnEvidence(session, busyHistory, 'review')
  assert.equal(busy.nativeBusy, true)
  assert.equal(busy.nativeIdle, false)
})

test('a definite observation failure after an unknown send is not a rejected prompt', async () => {
  const f = fixture(); await enqueue(f)
  f.manager.startTurn = () => ({ [Symbol.asyncIterator]: () => ({ next: async () => {
    throw Object.assign(new Error('Native observation rejected'), { certainty: 'definite' })
  } }) })
  assert.equal((await f.dispatcher.dispatchNext('reviewer', 'worker'))?.state, 'uncertain')
})

test('does not admit a reviewer in the gap between native turn completion and durable workflow finalization', async () => {
  const f = queueFixture()
  f.coordination.asRepository().workflowSession = async () => ({ session, finalized: false, reviewerActive: false })
  await f.coordinator.enqueueReview(interaction)
  assert.equal(f.coordination.job, undefined)
  assert.equal(f.resolvedContexts.length, 0)
  f.coordination.asRepository().workflowSession = async () => ({ session, finalized: true, reviewerActive: false })
  await f.coordinator.enqueueReview(interaction)
  assert.equal((await f.coordination.findReviewJob())?.nativeSessionId, session.nativeSessionId)
})

test('failed reviewer discovery never allocates or qualifies a provider process', async () => {
  const f = queueFixture()
  f.coordination.ensureReviewJob = async () => { throw new Error('job insert failed') }
  await assert.rejects(f.coordinator.enqueueReview(interaction), /job insert failed/)
  assert.equal(f.resolvedContexts.length, 0)
  assert.deepEqual(f.coordinator.residentRunIds(), [])
  assert.equal(f.counts().started, 0)
})
