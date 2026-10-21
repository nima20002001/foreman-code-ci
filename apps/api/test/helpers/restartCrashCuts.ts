import { isWorkflowStart } from '../../src/modules/harnesses/sessionStart.js'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import { HarnessExecutionSchema, NativeHarnessEventSchema, type HarnessExecution, type NativeHarnessEvent, type NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, parseRepeatExitResultV1 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../../src/modules/errors.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../../src/modules/harnesses/port.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { REPEAT_NATIVE_PENDING_MESSAGE, isSettlementPendingCheckpointError } from '../../src/modules/interactions/repeatNativeEvidence.js'
import { RepeatRunRepository } from '../../src/modules/runs/repeatPostgres.js'
import { repeatDigest } from '../../src/modules/runs/repeatResolution.js'
import { canonicalRepeatEffect } from '../../src/modules/run-graph/repeatPublication.js'
import { readWorkflowCheckpoint } from '../../src/modules/runs/repeatGraph.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'
import { approvalResponse } from './approvalResponse.js'
import { agent3Database } from './wave25Agent3.js'
import { reserveFromExitedParent } from './eng06LaunchReservation.testSupport.js'
import { holdCrashCut, observeCrashTask } from './eng06CrashCut.testSupport.js'

type Runtime = Awaited<ReturnType<typeof checkpointRuntimeFixture>>
type Ports = {
  reserveNativeLaunch?: (id: string, manager: NativeHarnessSessionManager) => void
  recoverNativeProcesses?: (id: string, signal: AbortSignal) => Promise<boolean>
}
const pending = () => new DomainError('REPEAT_CLEANUP_PENDING', REPEAT_NATIVE_PENDING_MESSAGE, 409)

async function executions(t: Runtime): Promise<HarnessExecution[]> {
  return (await t.db.pool.query<{ record: unknown }>('select record from harness_executions where run_id=$1 order by created_at,id',
    [t.f.run.id])).rows.map((row) => HarnessExecutionSchema.parse(row.record))
}
interface EffectRow { entity_id: string; effect_digest: string; first_sequence: string }
async function effects(t: Runtime, kind: string) {
  return (await t.db.pool.query<EffectRow>(`select entity_id,effect_digest,first_sequence::text from run_graph_effects
    where run_id=$1 and effect_kind=$2 order by entity_id`, [t.f.run.id, kind])).rows
}
/** result.accept is a storage category for terminal.accept, INCLUDING failed
 * node resolution. Its encoded entity key is not the execution id. Check both
 * private and canonical receipts, without confusing either with success. */
async function terminalReceipts(t: Runtime) {
  const privateRows = (await t.db.pool.query<{ execution_id: string; payload_digest: string }>(
    `select entity_id as execution_id,payload_digest from run_repeat_effects
      where run_id=$1 and effect_kind='terminal.accept' order by entity_id`, [t.f.run.id])).rows
  const canonical = await effects(t, 'result.accept')
  expect(canonical).toHaveLength(privateRows.length)
  return privateRows.map((row) => {
    const effect = canonicalRepeatEffect(t.f.scope, { kind: 'terminal.accept', entityId: row.execution_id, digest: row.payload_digest })
    const exact = canonical.filter((receipt) => receipt.entity_id === effect.identity.entityId)
    expect(exact).toHaveLength(1)
    expect(exact[0]!.effect_digest).toBe(effect.digest)
    return { executionId: row.execution_id, receipt: exact[0]! }
  })
}
async function successfulResults(t: Runtime) {
  return (await t.db.pool.query<{ execution_id: string; result_json: string; result_digest: string }>(
    'select execution_id,result_json,result_digest from run_repeat_results where run_id=$1 order by execution_id', [t.f.run.id])).rows
}
async function assertSuccessfulResults(t: Runtime, expected: readonly HarnessExecution[]) {
  const ids = expected.map((execution) => execution.id).sort()
  const stored = await successfulResults(t)
  expect(stored.map((row) => row.execution_id)).toEqual(ids)
  const flags = (await t.db.pool.query<{ id: string }>(
    'select id from harness_executions where run_id=$1 and accepted order by id', [t.f.run.id])).rows
  expect(flags.map((row) => row.id)).toEqual(ids)
  for (const row of stored) {
    const result = expected.find((execution) => execution.id === row.execution_id)!.result!
    expect(result.outcome).toBe('succeeded')
    expect(JSON.parse(row.result_json)).toEqual(result)
    expect(row.result_digest).toBe(repeatDigest(result, 64 * 1024))
  }
}
async function originalProofs(t: Runtime, id: string) {
  return (await t.db.pool.query('select proof_id,source_digest,record from workflow_native_proofs where execution_id=$1 order by proof_id', [id])).rows
}
async function occurrenceCount(t: Runtime) {
  return Number((await t.db.pool.query<{ count: string }>('select count(*)::text as count from run_repeat_occurrences where run_id=$1',
    [t.f.run.id])).rows[0]!.count)
}

/** The real drive has finished at a persisted task error before this is called.
 * Model an abruptly dead API: its shutdown must NOT manufacture the missing
 * receipt. Only its old shutdown-close callback is suppressed. New composition
 * uses fresh managers/coordinator/capture channels and the same real DB/saver. */
async function coldRuntime(t: Runtime) {
  vi.spyOn(t.native, 'closeForRestart').mockResolvedValue(undefined)
  await t.engine.shutdown()
  return t.compose()
}

function terminalFrame(event: NativeHarnessEvent): NativeHarnessEvent {
  if (event.type !== 'turn.completed') return event
  const payload = event.payload as Record<string, unknown>
  return NativeHarnessEventSchema.parse({ ...event, payload: { ...payload, turn: { ...(payload.turn as Record<string, unknown>), status: 'failed' } } })
}

/** Change only the fixture's external provider transport. Both the ORIGINAL
 * terminal frame and terminal result agree; SQL/source/normalization/receipt
 * checks are unmocked. First-attempt failure does not seed a fake SQL result. */
function failEntryAtProvider(t: Runtime, allAttempts = false) {
  let first: string | undefined
  const failed = new Set<string>()
  const create = t.provider.createSession.bind(t.provider)
  vi.spyOn(t.provider, 'createSession').mockImplementation(async (input) => {
    const session = await create(input)
    if (isWorkflowStart(input) && input.request.workflowNodeId === t.f.version.entryNodeId
      && (allAttempts || !first)) {
      first ??= input.request.executionId
      failed.add(session.nativeSessionId)
    } else {
      failed.delete(session.nativeSessionId)
    }
    return session
  })
  const start = t.provider.startTurn.bind(t.provider)
  vi.spyOn(t.provider, 'startTurn').mockImplementation(async function* (session, input) {
    for await (const event of start(session, input)) yield failed.has(session.nativeSessionId) ? terminalFrame(event) : event
  })
  const history = t.provider.history.bind(t.provider)
  vi.spyOn(t.provider, 'history').mockImplementation(async (session): Promise<NativeHistory> => {
    const source = await history(session)
    if (!failed.has(session.nativeSessionId) || !source.terminalResult) return source
    return { ...source, events: source.events.map(terminalFrame), terminalResult: {
      outcome: 'failed', error: { code: 'TRANSIENT_PROVIDER_FAILURE', message: 'Injected original provider failure', retryable: true },
    } }
  })
}

type CrashCutDatabase = Awaited<ReturnType<typeof agent3Database>>
type WorkflowForm = 'sequential' | 'repeat'
type TerminalRecoveryKind = 'success' | 'approval' | 'retry' | 'retry-exhausted' | 'stop'

// Each case keeps its own Run, provider and engines; only migrations are shared.
export function useCrashCutDatabase() {
  let database: CrashCutDatabase | undefined
  beforeAll(async () => {
    database = await agent3Database()
  }, 60_000)
  afterEach(() => vi.restoreAllMocks())
  afterAll(async () => {
    await database?.close()
  }, 60_000)
  return () => {
    if (!database) throw new Error('Crash-cut database has not been initialized')
    return database
  }
}

export async function recoverEnteredLaunch(
  database: CrashCutDatabase, form: WorkflowForm, finish: 'stop' | 'reconcile',
) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
  // The retried node continues the workflow, so the repeat exit needs a valid result.
  const exitOutput = { routing: { outcome: 'pass' }, data: {
    latestDeliverable: { node: fixture.version.definition.nodes[1]!.id }, remainingFindings: [],
  } }
  const t = await checkpointRuntimeFixture(1, 1, { database, fixture, approvalNodeIds: [],
    outputFor: (nodeId) => nodeId === fixture.version.definition.nodes[1]!.id && form === 'repeat'
      ? exitOutput : { node: nodeId },
  })
  const interrupted = new DomainError('ENGINE_RESTART', 'Injected abrupt API restart at entered COMMIT.', 409)
  const barrier = holdCrashCut<string>(interrupted)
  let launchSignal: AbortSignal | undefined
  const observeExact = t.native.observeExact.bind(t.native)
  vi.spyOn(t.native, 'observeExact').mockImplementation((input) => {
    launchSignal = input.signal
    return observeExact(input)
  })
  // Shutdown commits cleanup before closing native sessions and aborting the drive.
  // Keep the launch parked until that abort, without manufacturing a closure.
  const restartClose = vi.spyOn(t.native, 'closeForRestart').mockImplementation(async () => {
    barrier.release()
  })
  const stopOld = async () => {
    try {
      await t.engine.shutdown()
    } finally {
      barrier.release()
    }
  }
  let restore: () => void = () => undefined
  try {
    const root = join(t.db.directory, 'launch-registry'), registry = new NativeProcessRegistry(root)
    const reservations: string[] = []
    const ports = t.native as unknown as Ports
    ports.reserveNativeLaunch = (id) => {
      reserveFromExitedParent(root, `execution:${id}`)
      reservations.push(id)
    }
    const authorize = RepeatRunRepository.prototype.authorizeNativeSubmission
    const fault = vi.spyOn(RepeatRunRepository.prototype, 'authorizeNativeSubmission')
      .mockImplementation(async function (this: RepeatRunRepository, id, prepared) {
        expect(reservations).toContain(id) // Reservation must PRECEDE entered.
        await authorize.call(this, id, prepared)
        // Do not throw REPEAT_CLEANUP_PENDING: the LIVE graph would retry
        // the starting/no-session attempt and leave this exact crash cut.
        if (!launchSignal) throw new Error('The held launch has no engine signal.')
        return barrier.hold(id, launchSignal) // Known COMMIT; no preflight or dispatch.
      })
    restore = () => fault.mockRestore()
    const started = observeCrashTask(t.engine.start(t.f.run.id))
    const cut = await barrier.wait(started, 30_000)
    expect(barrier.visits).toBe(1)
    expect(fault).toHaveBeenCalledTimes(1)
    const original = (await executions(t)).find((item) => item.id === cut)!
    expect(original.state).toBe('starting')
    expect(original.nativeSessionId).toBeUndefined()
    expect((await t.db.pool.query('select phase from workflow_native_entries where execution_id=$1', [cut])).rows)
      .toEqual([{ phase: 'entered' }])
    expect(t.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
    const launchReceipts = await effects(t, 'execution.launch'), occurrences = await occurrenceCount(t)
    expect(occurrences).toBe(form === 'repeat' ? 1 : 0)
    expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    expect(await effects(t, 'result.accept')).toEqual([])
    expect(await originalProofs(t, cut)).toEqual([])
    await stopOld()
    expect(restartClose).toHaveBeenCalledTimes(1)
    const outcome = await started
    expect(outcome).toMatchObject({ status: 'rejected', reason: { code: 'ENGINE_RESTART' } })
    if (outcome.status === 'rejected') expect(outcome.reason).toBe(launchSignal?.reason)
    expect(barrier.visits).toBe(1)
    // Graceful shutdown leaves the in-flight startup to recovery and fences nothing:
    // the Run keeps running so its node retries after restart.
    expect(await t.runs.getExecution(cut)).toEqual(original)
    expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    expect(t.provider.counts).toEqual({ sessions: 0, starts: 0, responses: 0, attaches: 0 })
    restore()
    const next = t.compose()
    const recover = vi.fn((id: string, signal: AbortSignal) => registry.closeOwner(`execution:${id}`, signal))
    ;(next.native as unknown as Ports).recoverNativeProcesses = recover
    if (finish === 'stop') {
      await t.stop()
      expect(await next.engine.cancel(t.f.run.id)).toBe(true)
    } else await next.engine.start(t.f.run.id)
    const run = await next.runs.get(t.f.run.id)
    expect(run).toMatchObject({ executionState: 'completed', outcome: finish === 'stop' ? 'canceled' : 'succeeded' })
    expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    // Stop cancels the undispatched attempt; otherwise recovery abandons it with its cause
    // after closing its original registry reservation. Nothing was replayed.
    expect(await next.runs.getExecution(original.id)).toMatchObject({ id: original.id, attempt: 1,
      input: original.input, state: 'completed', result: finish === 'stop' ? { outcome: 'canceled' }
        : { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true } } })
    expect(recover).toHaveBeenCalledTimes(1)
    const retries = (await executions(t)).filter((item) => item.workflowNodeId === original.workflowNodeId && item.id !== cut)
    if (finish === 'stop') {
      expect(retries.every((item) => item.result?.outcome !== 'succeeded')).toBe(true)
      expect(t.provider.counts.starts).toBe(0)
    } else {
      expect(retries).toEqual([expect.objectContaining({ attempt: 2, input: original.input,
        state: 'completed', result: expect.objectContaining({ outcome: 'succeeded' }) })])
      expect((await effects(t, 'execution.launch')).length).toBeGreaterThan(launchReceipts.length)
    }
    expect(await occurrenceCount(t)).toBeGreaterThanOrEqual(occurrences)
    await next.engine.start(t.f.run.id)
    expect(recover).toHaveBeenCalledTimes(1)
    expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    expect(await next.runs.get(t.f.run.id)).toEqual(run)
  } finally {
    try { await stopOld() } finally { restore(); await t.close() }
  }
}

export async function recoverTerminalBeforeClosure(
  database: CrashCutDatabase, form: WorkflowForm, kind: TerminalRecoveryKind,
) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
  // One finite technical replacement in the same slot; business bounds
  // are unchanged and ordinary Runs never manufacture an occurrence.
  fixture.version.definition.executionPolicy!.maxNodeExecutions += 1
  const exitOutput = { routing: { outcome: 'pass' }, data: {
    latestDeliverable: { node: fixture.version.definition.nodes[1]!.id }, remainingFindings: [],
  } }
  if (form === 'repeat') {
    // Validate the synthetic provider at the actual pinned contract before
    // starting. A malformed result must not masquerade as recovery failure.
    expect(parseRepeatExitResultV1({ outcome: 'succeeded', output: exitOutput },
      fixture.version.definition.nodes[1]!.choice!).data).toEqual(exitOutput.data)
  }
  const t = await checkpointRuntimeFixture(1, 1, { database, fixture,
    approvalNodeIds: kind === 'approval' ? [fixture.version.entryNodeId] : [],
    outputFor: (nodeId) => nodeId === fixture.version.definition.nodes[1]!.id && form === 'repeat'
      ? exitOutput : { node: nodeId },
  })
  let restore: () => void = () => undefined
  try {
    if (kind === 'retry' || kind === 'retry-exhausted') failEntryAtProvider(t, kind === 'retry-exhausted')
    // The external fixture manager really reports a close. Recovery is
    // allowed to attest ONLY that exact captured session, not any id.
    const closed = new Map<string, NativeSessionReference>()
    const close = t.provider.close.bind(t.provider)
    vi.spyOn(t.provider as NativeHarnessSessionManager, 'close').mockImplementation(async (...args) => {
      await close(args[0])
      closed.set(args[0].nativeSessionId, structuredClone(args[0]))
    })
    const record = PostgresWorkflowClosureStore.prototype.record
    let cut: HarnessExecution | undefined
    const fault = vi.spyOn(PostgresWorkflowClosureStore.prototype, 'record')
      .mockImplementation(async function (this: PostgresWorkflowClosureStore, execution, ...args) {
        if (execution.workflowNodeId === fixture.version.entryNodeId && execution.attempt === 1) {
          expect(execution.state).toBe('completed')
          expect(closed.get(execution.nativeSessionId!)).toEqual(args[0])
          cut = structuredClone(execution)
          throw pending() // AFTER original terminal and close, BEFORE receipt.
        }
        return record.call(this, execution, ...args)
      })
    restore = () => fault.mockRestore()
    await t.engine.start(t.f.run.id)
    if (kind === 'approval') {
      const interaction = (await t.pending())[0]!
      expect(interaction).toBeDefined()
      await t.service.respond({ kind: 'user', principal: t.principal }, approvalResponse(interaction))
    }
    expect(cut).toBeDefined()
    const original = cut!
    expect(await t.runs.getExecution(original.id)).toEqual(original)
    expect((await t.db.pool.query('select closed_at from execution_native_closures where execution_id=$1', [original.id])).rows)
      .toEqual([{ closed_at: null }])
    expect(await new PostgresWorkflowClosureStore(t.db.pool).read(original)).toBeUndefined()
    expect((await originalProofs(t, original.id)).length).toBeGreaterThan(0)
    const proofs = await originalProofs(t, original.id), resumes = await t.receipts()
    const ackRows = (await t.db.pool.query('select interaction_id,state,approval_native_ack_id from interaction_graph_resumes where run_id=$1 order by interaction_id', [t.f.run.id])).rows
    if (kind === 'approval') {
      expect(resumes).toHaveLength(1)
      expect(ackRows).toHaveLength(1)
      expect(ackRows[0]).toMatchObject({ state: 'resumed', approval_native_ack_id: expect.any(String) })
    }
    expect(await t.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    const checkpoint = await readWorkflowCheckpoint(t.f.run.id, t.f.version, t.saver)
    expect(checkpoint.tasks.some((task) => isSettlementPendingCheckpointError(task.error))).toBe(true)
    restore()
    const next = await coldRuntime(t)
    // Success itself requests post-terminal cleanup. Observe DURABLE
    // state at the call, not call count or the final state after the fact.
    const cleanupStates: Array<{ executionState: string; outcome: string }> = []
    const requestCleanup = next.runs.requestCleanup.bind(next.runs)
    vi.spyOn(next.runs, 'requestCleanup').mockImplementation(async (...args) => {
      const run = await next.runs.get(args[0], args[1])
      if (!run) throw new Error('Cleanup lost the exact Run')
      cleanupStates.push({ executionState: run.executionState, outcome: run.outcome })
      if (kind !== 'stop' && kind !== 'retry-exhausted') {
        expect(run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      }
      return requestCleanup(...args)
    })
    const cancel = vi.spyOn(next.native, 'cancelRun')
    let evidenceAvailable = kind === 'stop'
    const physical = vi.fn(async (id: string, signal: AbortSignal) => {
      signal.throwIfAborted()
      const saved = await next.runs.getExecution(id)
      return evidenceAvailable && id === original.id && saved?.nativeSessionId === original.nativeSessionId
        && closed.has(original.nativeSessionId!)
    })
    ;(next.native as unknown as Ports).recoverNativeProcesses = physical
    if (kind !== 'stop') {
      // SQL completed state plus an empty/unknown physical read is NOT a
      // close receipt, acceptance, negative Run intent or retry permission.
      const before = { ...t.provider.counts }, unchangedRun = await next.runs.get(t.f.run.id)
      expect(unchangedRun?.outcome).toBe('pending')
      await expect(next.engine.start(t.f.run.id)).rejects.toThrow('Terminal native closure remains unconfirmed.')
      expect(physical).toHaveBeenCalledTimes(1)
      expect(await next.runs.get(t.f.run.id)).toEqual(unchangedRun)
      expect(await next.runs.getExecution(original.id)).toEqual(original)
      expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
      expect((await t.db.pool.query('select 1 from execution_native_recoveries where execution_id=$1', [original.id])).rowCount).toBe(0)
      expect(await terminalReceipts(t)).toEqual([])
      await assertSuccessfulResults(t, [])
      expect(await originalProofs(t, original.id)).toEqual(proofs)
      expect(t.provider.counts).toEqual(before)
      expect(cleanupStates).toEqual([])
      expect(cancel).not.toHaveBeenCalled()
      evidenceAvailable = true
    }
    if (kind === 'stop') {
      await t.stop()
      expect(await next.engine.cancel(t.f.run.id)).toBe(true)
    } else if (kind === 'retry-exhausted') {
      // A selected node that exhausts its attempts settles the Run as failed.
      // That failed outcome is the Run's data, not an engine start error.
      await next.engine.start(t.f.run.id)
    } else await next.engine.start(t.f.run.id)
    expect(await next.runs.get(t.f.run.id)).toMatchObject({ executionState: 'completed',
      outcome: kind === 'stop' ? 'canceled' : kind === 'retry-exhausted' ? 'failed' : 'succeeded' })
    expect(await next.runs.getExecution(original.id)).toEqual(original)
    expect(await originalProofs(t, original.id)).toEqual(proofs)
    expect(await t.receipts()).toEqual(resumes)
    expect((await t.db.pool.query('select interaction_id,state,approval_native_ack_id from interaction_graph_resumes where run_id=$1 order by interaction_id', [t.f.run.id])).rows).toEqual(ackRows)
    expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
    expect(physical).toHaveBeenCalledTimes(kind === 'stop' ? 1 : 2)
    // retry: two entry attempts plus the next node; retry-exhausted: every allowed entry attempt.
    const expectedStarts = kind === 'stop' ? 1 : kind === 'retry' || kind === 'retry-exhausted' ? 3 : 2
    expect(t.provider.counts).toEqual({ sessions: expectedStarts, starts: expectedStarts,
      responses: kind === 'approval' ? 1 : 0, attaches: 0 })
    expect(t.provider.startedExecutions.filter((id) => id === original.id)).toHaveLength(1)
    expect(new Set(t.provider.startedExecutions).size).toBe(expectedStarts)
    if (kind !== 'stop' && kind !== 'retry-exhausted') {
      expect(cleanupStates.length).toBeGreaterThan(0)
      expect(cleanupStates.every((run) => run.executionState === 'completed' && run.outcome === 'succeeded')).toBe(true)
      expect(cancel).not.toHaveBeenCalled()
    }
    const all = await executions(t), attempts = all.filter((item) => item.workflowNodeId === original.workflowNodeId)
    expect(attempts.map((item) => item.attempt).sort())
      .toEqual(kind === 'retry-exhausted' ? [1, 2, 3] : kind === 'retry' ? [1, 2] : [1])
    if (kind.startsWith('retry')) {
      const retry = attempts.find((item) => item.attempt === 2)!
      expect(retry.nativeSessionId).toBeDefined()
      expect(retry.nativeSessionId).not.toBe(original.nativeSessionId)
      expect(retry.sessionContinuation).toBeUndefined()
      expect(new Set(all.map(item => item.nativeSessionId)).size).toBe(all.length)
    }
    expect(await occurrenceCount(t)).toBe(form === 'repeat' ? 1 : 0)
    const decisions = (await t.db.pool.query<{ record: { reason: string } }>(
      'select record from run_repeat_decisions where run_id=$1', [t.f.run.id])).rows
    expect(decisions.map((row) => row.record.reason)).toEqual(
      form === 'repeat' && kind !== 'stop' && kind !== 'retry-exhausted' ? ['early_exit'] : [])
    if (kind === 'retry-exhausted') {
      expect(all).toHaveLength(3)
      expect(all.every((item) => item.result?.outcome === 'failed'
        && item.result.error?.code === 'TRANSIENT_PROVIDER_FAILURE')).toBe(true)
      // Attempts one and two requested a retry; only exhausted attempt three resolves
      // the node. A negative terminal receipt must exist, but no successful
      // accepted-result row or flag may be created for either failure.
      expect((await terminalReceipts(t)).map((item) => item.executionId))
        .toEqual([attempts.find((item) => item.attempt === 3)!.id])
    }
    await assertSuccessfulResults(t, kind === 'stop' ? [] : all.filter((item) => item.result?.outcome === 'succeeded'))
    if (kind.startsWith('retry')) {
      const second = attempts.find((item) => item.attempt === 2)!
      expect(second.id).not.toBe(original.id)
      expect(second.input).toEqual(original.input)
      expect(second.agentConfigurationVersionId).toBe(original.agentConfigurationVersionId)
      const owner = await next.runs.acquireOwnership(t.f.run.id, () => undefined)
      if (!owner) throw new Error('Test failed to acquire the settled Run owner')
      try {
        const store = await next.runs.repeat(owner)
        const firstSlot = await store.readExecution(original.id), nextSlot = await store.readExecution(second.id)
        expect(nextSlot.slotId).toBe(firstSlot.slotId)
        expect(nextSlot.ref).toEqual(firstSlot.ref)
        expect(nextSlot.inputDigest).toBe(firstSlot.inputDigest)
      } finally { await owner.release() }
    }
    if (kind !== 'stop' && kind !== 'retry-exhausted') {
      const receipts = await terminalReceipts(t)
      expect(receipts.map((item) => item.executionId).sort())
        .toEqual(all.filter((item) => item.result?.outcome === 'succeeded').map((item) => item.id).sort())
      expect(receipts.filter((item) => item.executionId === original.id)).toHaveLength(kind === 'retry' ? 0 : 1)
    }
    const counts = { ...t.provider.counts }, accepted = await effects(t, 'result.accept')
    const resultRows = await successfulResults(t)
    await next.engine.start(t.f.run.id)
    expect(t.provider.counts).toEqual(counts)
    expect(await effects(t, 'result.accept')).toEqual(accepted)
    expect(await successfulResults(t)).toEqual(resultRows)
    expect(await next.runs.hasPendingCleanup(t.f.run.id)).toBe(false)
  } finally { restore(); await t.close() }
}
