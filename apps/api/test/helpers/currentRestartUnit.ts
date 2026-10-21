import assert from 'node:assert/strict'
import type pg from 'pg'
import { DurableInteractionSchema, HarnessExecutionSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { RepeatRunRepository, type RepeatRepositoryHost } from '../../src/modules/runs/repeatPostgres.js'
import { bindRepeatNodeInput, repeatDigest, repeatExecutionIdentity, repeatSlotId, tickSlotId }
  from '../../src/modules/runs/repeatResolution.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import type { RepeatNativeObservationStore } from '../../src/modules/interactions/repeatObservation.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import type { ChildProcessEnvironment, NativeHarnessSessionManager } from '../../src/modules/harnesses/port.js'
import type { NativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { nativeLanes } from './nativeLanes.js'
import { currentUnitSnapshot } from './currentUnitSnapshot.js'

export interface RestartClosureRow {
  generation: string; execution_identity: unknown; expected_reference: unknown | null;
  closed_reference: unknown | null; closed: boolean; detached: boolean;
  detached_reference: unknown | null; closed_without_session: boolean
}
/** Strict single-execution SQL model, NOT PostgreSQL or native qualification.
 * Actual coordinator, closure store, branded transaction and V3 per-execution
 * settlement run unchanged. The repository host is a narrow recording port;
 * it checks the independently seeded input receipt rather than minting one.
 * Synthetic managers never contact a provider. */
export function currentRestartUnit(reviewer = false, acceptedPlacement?: AcceptedNodePlacement,
  options: { tick?: { index: number; everySeconds: number } } = {}) {
  const f = currentUnitSnapshot('be001-restart', 'single'), configuration = f.configurations[0]!
  const node = f.version.definition.nodes[0]!
  if (options.tick) {
    assert.ok(node.kind !== 'job')
    node.interval = { everySeconds: options.tick.everySeconds }
    f.version.definition.handoffs = { contractVersion: 1 }
  }
  if (reviewer) {
    configuration.productRole = 'orchestrator'
    const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: configuration.agentId }
    f.version.approval = approval; f.version.definition.approval = approval; f.run.approval = approval
  }
  f.version.contentHash = graphSourceDigest({ definition: f.version.definition,
    configurations: f.version.agentConfigurationVersionIds, entryNodeId: f.version.entryNodeId })
  f.run.executionState = 'waiting'
  const candidate = HarnessExecutionSchema.parse({ id: 'be001-restart-execution', runId: f.run.id, workflowNodeId: node.id,
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'queued', createdAt: f.createdAt })
  const ref = { nodeId: node.id, occurrence: null }
  const slot = options.tick ? tickSlotId(f.run.id, node.id, options.tick.index) : repeatSlotId(f.run.id, ref)
  const frozen = bindRepeatNodeInput({ version: f.version, runInput: f.run.input, recipient: candidate,
    ref, occurrence: null, entry: null, predecessors: [] })
  const input = options.tick ? { ...frozen.input, tick: options.tick } : frozen.input
  const bound = { ...frozen, input, digest: repeatDigest(input) }
  let execution: HarnessExecution = HarnessExecutionSchema.parse({ ...candidate, input: bound.input,
    state: reviewer ? 'completed' : 'waiting', nativeSessionId: 'be001-restart-native',
    workingDirectory: '/synthetic', runtimeDirectory: '/synthetic/runtime',
    ...(reviewer ? { result: { outcome: 'succeeded' }, finishedAt: f.createdAt } : {}) })
  const session = { harness: 'codex', providerVersion: 'synthetic-no-native-call', nativeSessionId: execution.nativeSessionId! } satisfies NativeSessionReference
  const state = { stopped: false, cleanup: false, finalized: reviewer, outstanding: false, owned: true,
    restartDetached: false,
    failBegin: false, failCloseWrite: false, loseCommitReply: false, failNativeClose: false, loseAtFinalFence: false,
    finalizationWrites: 0, revocations: 0, retirementCalls: 0, closeWrites: 0, beginCalls: 0,
    preflightCalls: 0, restores: 0, closes: 0, restartCloses: 0, attaches: 0, cancels: 0, creates: 0, turns: 0, reads: 0,
    resolutions: 0, budgetStops: 0, budgetWaits: 0, interactionCancels: 0 }
  // The reviewer fixture starts after a positively closed workflow lifetime.
  // Keep that real predecessor in the SQL model so all generation checks see it.
  const priorWorkflow: RestartClosureRow = {
    generation: '1', execution_identity: { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
      agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId, attempt: execution.attempt,
      workingDirectory: execution.workingDirectory, runtimeDirectory: execution.runtimeDirectory },
    expected_reference: session, closed_reference: session, closed: true, detached: false,
    detached_reference: null, closed_without_session: false,
  }
  let rows: RestartClosureRow[] = reviewer ? [structuredClone(priorWorkflow)] : []
  let originalSetupClaimed = false
  let before: { rows: RestartClosureRow[]; finalized: boolean; writes: number; closeWrites: number } | undefined
  let closureWritten = false
  let beforePreflight: () => void | Promise<void> = () => undefined
  let beforeClose = async () => undefined as void
  const statements: string[] = []
  const inputReceipt = graphSourceDigest({ executionId: execution.id, inputDigest: bound.digest })
  const priorUnclosed = (generation: string) => rows.some((row) => BigInt(row.generation) < BigInt(generation) && !row.closed && !row.detached)
  async function query(text: string, values: unknown[] = []) {
    const q = text.replace(/\s+/g, ' ').trim(); statements.push(q)
    const result = (data: unknown[] = []) => ({ rows: structuredClone(data), rowCount: data.length, command: '', oid: 0, fields: [] })
    if (q.startsWith('begin')) {
      assert.equal(before, undefined, 'the SQL model must not nest transactions')
      before = { rows: structuredClone(rows), finalized: state.finalized, writes: state.finalizationWrites, closeWrites: state.closeWrites }
      closureWritten = false; return result()
    }
    if (q === 'commit') {
      before = undefined
      if (closureWritten && state.loseCommitReply) {
        state.loseCommitReply = false; closureWritten = false
        throw new Error('Synthetic lost COMMIT reply AFTER durable close write')
      }
      closureWritten = false; return result()
    }
    if (q === 'rollback') {
      if (before) { rows = before.rows; state.finalized = before.finalized; state.finalizationWrites = before.writes; state.closeWrites = before.closeWrites }
      before = undefined; closureWritten = false; return result()
    }
    if (q.startsWith("select r.record->>'executionSemanticsVersion' as semantics,")) {
      assert.deepEqual(values, [f.run.id]); assert.ok(q.endsWith('from runs r where r.id=$1 for update'))
      return result([{ semantics: '3', fenced: state.stopped || state.cleanup || f.run.executionState === 'completed' }])
    }
    if (q.startsWith('select p.generation::text,p.execution_identity,p.reference')) {
      assert.deepEqual(values, [execution.id])
      assert.ok(q.includes('from execution_native_recoveries p join execution_native_closures c'))
      // This model has original close/detach receipts, never a kernel-recovery receipt.
      return result()
    }
    if (q === 'select id from runs where id=$1 for update') {
      assert.deepEqual(values, [f.run.id]); return result([{ id: f.run.id }])
    }
    if (q.startsWith('select 1 from run_worktrees target')) return result()
    if (q.startsWith('select record from harness_executions')) {
      assert.deepEqual(values, [execution.id, f.run.id]); return result([{ record: execution }])
    }
    if (q.startsWith('select 1 from runs r where r.id=$1')) {
      assert.deepEqual(values, [f.run.id]); return result(f.run.executionState !== 'completed' && !state.stopped && !state.cleanup ? [{}] : [])
    }
    if (q.startsWith('select reference from execution_native_sessions')) {
      assert.deepEqual(values, [execution.id]); return result([{ reference: session }])
    }
    if (q.startsWith('insert into execution_native_closures')) {
      state.beginCalls++
      if (state.failBegin) throw new Error('Synthetic lifetime registration failure')
      assert.equal(values[0], execution.id)
      const row: RestartClosureRow = { generation: String(rows.length + 1), execution_identity: JSON.parse(String(values[1])),
        expected_reference: values[2] === null ? null : JSON.parse(String(values[2])), closed_reference: null, closed: false,
        detached: false, detached_reference: null, closed_without_session: false }
      rows.push(row); return result([{ generation: row.generation }])
    }
    if (q.startsWith('select generation::text,execution_identity')) {
      assert.equal(values[0], execution.id)
      const row = values.length === 2 ? rows.find((row) => row.generation === values[1]) : rows.at(-1)
      return result(row ? [{ ...row, prior_unclosed: priorUnclosed(row.generation) }] : [])
    }
    if (q.startsWith('update execution_native_closures')) {
      if (state.failCloseWrite) throw new Error('Synthetic close receipt write failure')
      const row = rows.find((item) => item.generation === values[1])
      if (!row || row.closed || row.detached || values[0] !== execution.id) return result()
      if (q.includes('set detached_reference=')) { row.detached = true; row.detached_reference = JSON.parse(String(values[2])) }
      else if (q.includes('set closed_reference=')) { row.closed = true; row.closed_reference = JSON.parse(String(values[2])) }
      else throw new Error(`Unsupported closure mutation: ${q}`)
      closureWritten = true; state.closeWrites++; return result([{ generation: row.generation }])
    }
    if (q.startsWith('select c.generation::text,c.execution_identity')) {
      assert.deepEqual(values, [execution.id, execution.runId]); state.reads++
      if (q.includes('from runs r join harness_executions e')
        && (state.stopped || state.cleanup || state.finalized || f.run.executionState === 'completed')) return result()
      const row = rows.at(-1)
      return result(row ? [{ ...row, record: execution, reference: session, prior_unclosed: priorUnclosed(row.generation) }] : [])
    }
    if (q.startsWith('select r.record as run,v.record as version,')) {
      assert.deepEqual(values, [f.run.id]); return result([{ run: f.run, version: f.version,
        stopped: state.stopped, cleanup: state.cleanup, state: f.run.executionState, now: f.createdAt }])
    }
    if (q.startsWith('select e.record,e.accepted,x.identity,s.slot_id,')) {
      assert.deepEqual(values, [execution.id, f.run.id])
      return result([{ record: execution, accepted: reviewer, identity: repeatExecutionIdentity(candidate), slot_id: slot,
        occurrence_id: null, workflow_node_id: node.id, input_json: JSON.stringify(bound.input), input_digest: bound.digest,
        execution_run_id: f.run.id, execution_node_id: node.id, execution_agent_id: configuration.agentId, execution_attempt: 1,
        execution_occurrence_id: null, identity_occurrence_id: null, technical_attempt: 1,
        execution_tick_index: options.tick?.index ?? null, tick_index: options.tick?.index ?? null }])
    }
    if (q.startsWith('select payload_digest from run_repeat_effects')) {
      assert.deepEqual(values, [f.run.id, 'input.bind', execution.id]); return result([{ payload_digest: inputReceipt }])
    }
    if (q.startsWith("select id,record->>'executionSemanticsVersion'")) {
      assert.deepEqual(values, [f.run.id]); return result([{ id: f.run.id, semantics: '3', workspace_id: f.run.workspaceId,
        workflow_id: f.run.workflowId, pins_match: true, negative_cleanup: f.run.executionState === 'completed' && f.run.outcome === 'canceled' }])
    }
    if (q.startsWith('select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions')) {
      assert.deepEqual(values, [execution.id, f.run.id]); return result([{ id: execution.id, run_id: f.run.id,
        workflow_node_id: node.id, agent_id: configuration.agentId, attempt: 1, record: execution }])
    }
    if (q.startsWith('select j.id,j.execution_id,j.state,j.record') || q.startsWith('select i.id,i.execution_id,i.status,i.record')) return result()
    if (q.startsWith('select ( exists(select 1 from worker_credential_bindings')) return result([{ outstanding: state.outstanding }])
    if (q.startsWith('select reference,workflow_finalized_at')) return result([{ reference: session, finalized: state.finalized }])
    if (q.startsWith('select c.record#>>')) return result([{ harness: configuration.harness.harness, agent_id: configuration.agentId,
      workspace_id: configuration.workspaceId, pinned: true }])
    if (q.startsWith('update execution_native_sessions')) {
      assert.deepEqual(values, [execution.id, JSON.stringify(session)])
      state.finalized = true; state.finalizationWrites++; return result([{ execution_id: execution.id }])
    }
    // Main-local executions have no device dispatch intent or native placement.
    if (/from execution_dispatch_intents where execution_id=\$1/.test(q) || q.startsWith('select record from execution_native_placements where execution_id=$1')) return result([])
    throw new Error(`Unexpected current restart SQL: ${q}`)
  }
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const assertOwned = () => { if (!state.owned) throw new Error('RUN_OWNERSHIP_LOST') }
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, assertOwned)
  const owner = { runId: f.run.id, assertOwned, oneShotConnection: () => connection,
    retain: () => async () => { assertOwned() }, release: async () => {},
    readOneShotFence: async () => {
      if (state.loseAtFinalFence && state.finalizationWrites > 0) state.owned = false
      assertOwned(); return { ownerId: 'unit-owner', fence: '1' }
    } } as unknown as RunOwnership
  const forbidden = async () => { throw new Error('No admission/publication writer in this read-only restart test') }
  const host: RepeatRepositoryHost = { openLocked: async (_sql, scope, run, version) => {
    assert.deepEqual(scope, f.scope); assert.deepEqual(run, f.run); assert.deepEqual(version, f.version)
    return { run: f.run, assertAuthorityLocked: forbidden, assertAdmissionLocked: forbidden,
      assertSettlementLocked: async () => { assertOwned() }, allowTechnicalRetryLocked: async () => false,
      publishLocked: forbidden, completeRunLocked: forbidden,
      assertPublicationReceiptLocked: async (_sql, effect) => {
        assert.equal(effect.kind, 'input.bind'); assert.equal(effect.entityId, execution.id); assert.equal(effect.digest, inputReceipt)
      } }
  } }
  const repository = new RepeatRunRepository(owner, host, f.version)
  const captures = createWorkflowNativeCaptureChannel()
  const runs = { requestCleanup: async () => { assertOwned(); state.cleanup = true }, get: async () => f.run, getExecution: async () => execution,
    getRepeatSnapshot: async () => ({ run: f.run, version: f.version, configurations: f.configurations, stopRequested: state.stopped, cleanupPending: state.cleanup }),
    getRepeatVersion: async (runId: string, versionId: string) => {
      assert.equal(runId, f.run.id)
      assert.equal(versionId, f.run.workflowVersionId)
      return f.version
    },
    repeat: async () => repository, async *executionPages() { yield [execution] },
    getExecutionConfiguration: async () => configuration, updateExecution: async (next: HarnessExecution, actualOwner: RunOwnership,
      evidence: Parameters<typeof captures.verify.read>[0]) => {
      assert.equal(actualOwner, owner); assertOwned()
      const original = captures.verify.read(evidence)
      assert.equal(original.execution.id, execution.id)
      assert.equal(next.nativeSessionId, session.nativeSessionId)
      execution = next
    } }
  const coordination = Object.assign(nativeLanes(), {
    workflowSession: async () => ({ session, finalized: state.finalized, reviewerActive: false }),
    hasUnsettledReview: async () => false,
    finishStoppedReviews: async () => { state.retirementCalls++ },
  })
  const pendingApproval = DurableInteractionSchema.parse({
    id: 'be001-original-pending', revision: 0, workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
    runId: f.run.id, executionId: execution.id, requestingAgentId: configuration.agentId, ...session,
    nativeRequestId: 'be001-request', nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: f.run.id,
    request: { command: 'unit-only' }, approval: { handler: 'user' }, status: 'pending', deliveryState: 'not_started',
    responseOptions: [{ optionId: 'approve', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
      affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    createdAt: f.createdAt, updatedAt: f.createdAt,
  })
  const interactions = { coordination, getForExecution: async () => undefined,
    getNativeRequest: async (id: string, harness: string, nativeId: string, requestId: string) => {
      assert.deepEqual([id, harness, nativeId, requestId], [execution.id, session.harness, session.nativeSessionId, pendingApproval.nativeRequestId])
      return pendingApproval
    },
    cancelPendingForRun: async () => { state.interactionCancels++; return 0 } }
  const budgets = { ensure: async () => undefined, resume: async () => undefined, remaining: async () => 60_000,
    assertActive: async () => undefined, beginWait: async () => { state.budgetWaits++ }, stop: async () => { state.budgetStops++ } }
  const credentials = { prepare: async () => {
    state.preflightCalls++
    await beforePreflight()
    return { credential: { principalId: 'synthetic-credential', expiresAt: new Date(Date.now() + 300_000).toISOString(),
      environment: { agentId: execution.agentId, variables: {} } } }
  }, restore: async (executionId: string, environment: ChildProcessEnvironment) => {
    assert.equal(executionId, execution.id)
    assert.equal(environment.agentId, execution.agentId)
    state.restores++
    return { principalId: 'synthetic-credential', expiresAt: new Date(Date.now() + 300_000).toISOString(), environment }
  }, revokeForExecution: async () => { state.revocations++ } }
  const cold = () => {
    let resident = false, restartClosed = false
    const close = async (reference: NativeSessionReference) => {
      assert.deepEqual(reference, session); state.closes++; await beforeClose()
      if (state.failNativeClose) throw new Error('Synthetic uncertain native close')
    }
    const manager = { harness: 'codex', attachSession: async (reference: NativeSessionReference) => {
      assert.deepEqual(reference, session); state.attaches++; return reference
    }, close, closeForRestart: async (reference: NativeSessionReference) => {
      state.restartCloses++; if (restartClosed) return; await close(reference); restartClosed = true
      state.restartDetached = true
    }, cancel: async () => { state.cancels++; return true },
    createSession: async () => { state.creates++; throw new Error('Replacement creation forbidden') },
    startTurn: () => { state.turns++; throw new Error('Turn replay forbidden') },
    history: async () => ({ events: [], pendingInteractions: [] }), reconcile: async () => ({ events: [], pendingInteractions: [] }),
    respond: async () => { throw new Error('Approval delivery forbidden') } } as unknown as NativeHarnessSessionManager
    const resolver: NativeSessionManagerResolver = { resolve() {
      state.resolutions++
      return { manager, get processState() { return resident ? 'resident' as const : 'needs_start' as const },
        beginStart() {}, markResident() { resident = true } }
    }, release() { resident = false } }
    const store = new PostgresWorkflowClosureStore(pool,
      executionId => executionId === execution.id && state.restartDetached)
    type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
    const coordinator = new ApprovalExecutionCoordinator(runs as unknown as Args[0], interactions as unknown as Args[1],
      budgets as unknown as Args[2], resolver, 60_000, credentials as unknown as Args[5], undefined, store,
      undefined, captures.capture, undefined, undefined, undefined,
      acceptedPlacement ? async context => ({ ...context, acceptedPlacement }) : undefined)
    const observation: RepeatNativeObservationStore = {
      async readExecution(id) {
        assert.equal(id, execution.id)
        return { execution, ref, slotId: slot, input: bound.input, inputDigest: bound.digest, accepted: reviewer }
      },
      async assertExecutionAdmission(id) { assertOwned(); assert.equal(id, execution.id) },
      async assertNativeBoundary(id) { assertOwned(); assert.equal(id, execution.id) },
      async exactSession(id) { assert.equal(id, execution.id); return session },
      authorizeNativeSubmission: forbidden, consumeLaunch() { return false }, settleNativeExecution: forbidden,
    }
    const attachOriginal = async (signal?: AbortSignal) => {
      // First-lifetime setup only. Fresh coordinators in recovery tests must use
      // the public cold path; they cannot claim this original observation again.
      assert.equal(originalSetupClaimed, false, 'only the original fixture lifetime may be observed')
      originalSetupClaimed = true
      if (reviewer) return coordinator.attachOwnedSession(context(), session, signal)
      await coordination.ensureLane({
        id: `lane-${execution.id}`, harness: session.harness, nativeSessionId: session.nativeSessionId,
        ownerAgentId: execution.agentId, observedStatus: 'busy', connectionGeneration: 0,
        correlationId: `execution:${execution.id}`, currentTurnOrMessageId: 'be001-turn',
        observedAt: f.createdAt, revision: 1,
      })
      manager.reconcile = async (_session, correlationId) => ({ events: [], correlationId, nativeTurnId: 'be001-turn',
        pendingInteractions: [{ session, turn: { nativeTurnId: 'be001-turn', nativeRequestId: pendingApproval.nativeRequestId },
          nativeRequestType: pendingApproval.nativeRequestType, request: pendingApproval.request, responseOptions: pendingApproval.responseOptions }] })
      const result = await coordinator.observeExact({ execution, store: observation, owner,
        workflowId: f.run.workflowId, graphThreadId: f.run.id, approval: { handler: 'user' },
        signal: signal ?? new AbortController().signal,
        request: { executionId: execution.id, runId: f.run.id, workspaceId: f.run.workspaceId, workflowNodeId: execution.workflowNodeId,
          workingDirectory: execution.workingDirectory!, runtimeDirectory: execution.runtimeDirectory!, configuration, input: execution.input } })
      assert.equal(result.state, 'waiting'); assert.equal(resident, true)
      assert.equal(state.creates, 0); assert.equal(state.turns, 0)
      return result
    }
    return { coordinator, store, resolver, manager, attachOriginal }
  }
  const context = () => ({ executionId: execution.id, agentId: execution.agentId, workingDirectory: execution.workingDirectory!, harness: 'codex' as const,
    ...(reviewer ? { purpose: 'reviewer' as const } : {}) })
  const stop = async (instance: ReturnType<typeof cold>) => {
    state.stopped = true; state.cleanup = true // Explicit already-committed Stop fixture; not a service authorization substitute.
    await instance.coordinator.cancelRun(f.run.id)
  }
  const terminal = () => {
    state.stopped = true; state.cleanup = true
    f.run = { ...f.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: f.createdAt }
    execution = { ...execution, state: 'completed', result: { outcome: 'canceled' }, finishedAt: f.createdAt }
  }
  const finalize = async (instance: ReturnType<typeof cold>) => {
    await instance.coordinator.cancelRun(f.run.id, owner)
    // Current cancelRun performs physical/negative cleanup; positive verification
    // belongs to the repository. A returned cancel promise alone proves nothing.
    await repository.settleNativeExecution(execution.id)
  }
  return { f, cold, state, session, owner, connection, coordination, context, stop, terminal, finalize, repository, statements,
    execution: () => execution, rows: () => rows,
    beforePreflight: (fn: typeof beforePreflight) => { beforePreflight = fn }, beforeClose: (fn: typeof beforeClose) => { beforeClose = fn } }
}
