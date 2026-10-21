import { isWorkflowStart } from '../../src/modules/harnesses/sessionStart.js'
import { randomUUID } from 'node:crypto'
import { expect, vi } from 'vitest'
import type { DurableInteraction, NativeSessionReference } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { HarnessExecutionError } from '../../src/modules/harnesses/errors.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../../src/modules/harnesses/port.js'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'
import { readCurrentExecutions } from './wave25Agent3.js'
import { graphParity } from './wave25R1GraphParity.js'
import { FixtureProcessClosures } from './eng06ProcessClosures.js'
import { rejectableDeferred } from './deferred.js'

export type FaultForm = 'ordinary' | 'repeat'
export type FaultRuntime = ReturnType<Awaited<ReturnType<typeof checkpointRuntimeFixture>>['compose']>

/** Provider-port faults only. No SQL mutation, injected receipt, synthetic Run
 * result, owner replacement, or disabled production fence lives in this helper.
 *
 * The usual checkpoint provider retains external history when an API connection
 * closes. killOnRestart models a task-owned subprocess that instead exits during
 * that close. A cold attach cannot resurrect it. Disposing a NEW empty facade
 * proves only that facade's disposal, never closure of the old session.
 */
export class ApprovalTransportFaults {
  readonly processes = new FixtureProcessClosures()
  recoveryAvailable = true
  hideResponseEvidence = false
  killOnRestart = false
  readonly deadSessions = new Set<string>()
  readonly restartCloses: NativeSessionReference[] = []
  readonly responseWrites: Array<{ sessionId: string; requestId: string; optionId: string }> = []
  readonly rejectedColdAttaches: string[] = []
  async recoverNativeProcesses(executionId: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    return this.recoveryAvailable && this.processes.recover(executionId, signal)
  }
  private hold: ReturnType<typeof rejectableDeferred<void>> | undefined
  private entered: ReturnType<typeof rejectableDeferred<string>> | undefined
  private holdNext = false
  private workerGate: { entered: ReturnType<typeof rejectableDeferred<void>>; release: ReturnType<typeof rejectableDeferred<void>>; deliveryObserved: Set<string> } | undefined

  holdNextTurn() {
    if (this.hold) throw new Error('A native turn gate is already installed')
    const release = rejectableDeferred(), entered = rejectableDeferred<string>()
    this.hold = release; this.entered = entered; this.holdNext = true
    return { entered: entered.promise, release: () => release.resolve() }
  }
  holdWorkerAcknowledgement() {
    if (this.workerGate) throw new Error('A Worker acknowledgement gate is already installed')
    const entered = rejectableDeferred(), release = rejectableDeferred()
    this.workerGate = { entered, release, deliveryObserved: new Set() }
    return { entered: entered.promise, release: () => release.resolve() }
  }
  private async beforeWorkerObservation(session: NativeSessionReference, signal?: AbortSignal) {
    const gate = this.workerGate
    if (!gate?.deliveryObserved.has(session.nativeSessionId)) return
    gate.entered.resolve()
    let onAbort: (() => void) | undefined
    try {
      await Promise.race([gate.release.promise, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal?.reason ?? new Error('Worker observation was aborted'))
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      })])
      signal?.throwIfAborted()
    } finally { if (onAbort) signal?.removeEventListener('abort', onAbort) }
  }
  release() { this.hold?.resolve(); this.workerGate?.release.resolve() }

  private visible(session: NativeSessionReference, history: NativeHistory): NativeHistory {
    if (this.deadSessions.has(session.nativeSessionId)) return { events: [], pendingInteractions: [] }
    if (!this.hideResponseEvidence) return history
    // Loss of the response ACK AND the terminal observation, not a manufactured
    // negative result. Preserve any actual pending request as contradictory data.
    return { events: [], pendingInteractions: history.pendingInteractions,
      ...(history.pendingInteraction ? { pendingInteraction: history.pendingInteraction } : {}) }
  }

  wrap(raw: NativeHarnessSessionManager): NativeHarnessSessionManager {
    // The returned manager methods need this fixture instance after wrap returns.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const faults = this
    let disposed = false
    let disposal: Promise<void> | undefined
    const attached = new Map<string, NativeSessionReference>()
    function open() {
      if (disposed) throw new Error('The original test-provider facade was disposed')
    }
    function alive(session: NativeSessionReference) {
      open()
      if (faults.deadSessions.has(session.nativeSessionId)) throw new HarnessExecutionError(
        'ENG06_NATIVE_PROCESS_GONE', 'The task-owned provider exited without a retained terminal result.', false)
    }
    async function close(session: NativeSessionReference, restart: boolean) {
      open()
      // The actual captured provider operation completes first. No test writes
      // execution_native_closures or upgrades a detach to a closure receipt.
      if (restart && raw.closeForRestart) await raw.closeForRestart(session)
      else await raw.close(session)
      if (!restart || faults.killOnRestart) await faults.processes.closeSession(session.nativeSessionId)
      attached.delete(session.nativeSessionId)
      if (restart) {
        faults.restartCloses.push({ ...session })
        if (faults.killOnRestart) faults.deadSessions.add(session.nativeSessionId)
      }
    }
    return {
      ...raw,
      async createSession(input, signal) {
        open()
        if (!isWorkflowStart(input)) throw new Error('This fixture owns workflow sessions only')
        const session = await raw.createSession(input, signal)
        await faults.processes.start(input.request.executionId, session.nativeSessionId)
        faults.deadSessions.delete(session.nativeSessionId)
        attached.set(session.nativeSessionId, session)
        return session
      },
      async attachSession(session, input, signal) {
        if (faults.deadSessions.has(session.nativeSessionId)) faults.rejectedColdAttaches.push(session.nativeSessionId)
        alive(session)
        const exact = await raw.attachSession(session, input, signal)
        attached.set(exact.nativeSessionId, exact)
        return exact
      },
      async *startTurn(session, input, signal) {
        alive(session)
        for await (const event of raw.startTurn(session, input, signal)) {
          yield event
          // The coordinator has persisted turn.started before requesting this
          // next event. The native generator has not produced a terminal result.
          if (faults.holdNext && event.type === 'turn.started') {
            faults.holdNext = false
            faults.entered!.resolve(session.nativeSessionId)
            let onAbort: (() => void) | undefined
            try {
              await Promise.race([faults.hold!.promise, new Promise<void>((resolve) => {
                onAbort = resolve
                signal?.addEventListener('abort', onAbort, { once: true })
                if (signal?.aborted) resolve()
              })])
            } finally { if (onAbort) signal?.removeEventListener('abort', onAbort) }
            // Process exit has no terminal event, output or native ACK.
            return
          }
        }
      },
      async respond(session, requestId, option, signal) {
        alive(session)
        faults.responseWrites.push({ sessionId: session.nativeSessionId, requestId, optionId: option.optionId })
        await raw.respond(session, requestId, option, signal)
      },
      async pending(session, signal) {
        return faults.deadSessions.has(session.nativeSessionId) ? undefined : raw.pending(session, signal)
      },
      async history(session, signal) {
        await faults.beforeWorkerObservation(session, signal)
        return faults.visible(session, await raw.history(session, signal))
      },
      async reconcile(session, correlation, signal) {
        await faults.beforeWorkerObservation(session, signal)
        return faults.visible(session, await raw.reconcile(session, correlation, signal))
      },
      async reconcileResponse(session, response, signal) {
        // The writer's response control operation does its own reconcile before
        // delivery is persisted. Do not block that pre-delivery observation:
        // arm the Worker-only gate when the delivery service reads its ACK.
        const history = faults.visible(session, raw.reconcileResponse
          ? await raw.reconcileResponse(session, response, signal) : await raw.history(session, signal))
        if (history.responseDeliveries?.some((proof) => proof.nativeSessionId === session.nativeSessionId
          && proof.nativeRequestId === response.nativeRequestId && proof.optionId === response.option.optionId)) {
          faults.workerGate?.deliveryObserved.add(session.nativeSessionId)
        }
        return history
      },
      async cancel(session, signal, turnId) {
        alive(session)
        return raw.cancel(session, signal, turnId)
      },
      canDetachForRestart(session) {
        const original = attached.get(session.nativeSessionId)
        return !disposed && !faults.deadSessions.has(session.nativeSessionId)
          && original?.harness === session.harness && original.providerVersion === session.providerVersion
      },
      close: (session) => close(session, false),
      closeForRestart: (session) => close(session, true),
      dispose() {
        if (disposal) return disposal
        disposed = true
        // This deterministic facade owns no transports outside this exact set.
        // It rejects all later setup; a failed cold attach adds nothing to it.
        // Retain any rejected disposal promise; a retry is not a fake success.
        disposal = (async () => {
          for (const session of attached.values()) {
            await raw.close(session)
            await faults.processes.closeSession(session.nativeSessionId)
          }
          attached.clear()
        })()
        return disposal
      },
    }
  }
}

export function approvalResponse(interaction: DurableInteraction) {
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  if (!option) throw new Error('The provider did not expose the expected request-scoped approval option')
  return { interactionId: interaction.id, expectedRevision: interaction.revision,
    optionId: option.optionId, commandId: randomUUID() }
}

export async function approvalFaultFixture(form: FaultForm, options: { approvals?: boolean } = {}) {
  const definition = makeCurrentWorkflowFixture(randomUUID(), form === 'ordinary' ? 'sequential' : 'repeat')
  const exit = definition.version.definition.nodes[1]!.id
  let exits = 0
  const faults = new ApprovalTransportFaults()
  const f = await checkpointRuntimeFixture(1, 1, { fixture: definition,
    recoverNativeProcesses: (id, signal) => faults.recoverNativeProcesses(id, signal),
    approvalNodeIds: options.approvals === false ? [] : [exit],
    outputFor: (nodeId) => form !== 'repeat' || nodeId !== exit ? { nodeId }
      : { text: JSON.stringify({ routing: { outcome: ++exits === 1 ? 'issues' : 'pass' },
        data: { latestDeliverable: { occurrence: exits }, remainingFindings: exits === 1 ? [{ id: 'eng06-finding' }] : [] } }) },
  })
  const connection = f.provider.connection.bind(f.provider)
  vi.spyOn(f.provider, 'connection').mockImplementation(() => faults.wrap(connection()))
  let runtime: FaultRuntime = f
  const initialPins = { workflowVersionId: f.f.run.workflowVersionId,
    executionSemanticsVersion: f.f.run.executionSemanticsVersion,
    agentConfigurationVersionIds: structuredClone(f.f.run.agentConfigurationVersionIds),
    executionLocation: structuredClone(f.f.run.executionLocation) }
  const parity = await graphParity(f.db.pool, f.f.scope)
  const responder = { kind: 'user' as const, principal: f.principal }
  const runId = f.f.run.id

  async function currentPending() {
    return (await runtime.repository.list({ runId, limit: 100 })).filter((item) => item.status === 'pending')
  }
  async function onePending() {
    const pending = await currentPending()
    expect(pending).toHaveLength(1)
    return pending[0]!
  }
  async function assertPins() {
    expect(await runtime.runs.get(runId)).toMatchObject(initialPins)
    const executions = await readCurrentExecutions(runtime.runs, runId)
    for (const execution of executions) {
      expect(execution.runId).toBe(runId)
      expect(execution.agentConfigurationVersionId).toBe(initialPins.agentConfigurationVersionIds[execution.agentId])
    }
  }
  async function assertShape(expectedOccurrences: number) {
    const occurrences = (await f.db.pool.query<{ occurrence_id: string }>(
      'select occurrence_id from run_repeat_occurrences where run_id=$1 order by occurrence_id', [runId])).rows
    expect(occurrences).toHaveLength(form === 'ordinary' ? 0 : expectedOccurrences)
    expect(new Set(occurrences.map((item) => item.occurrence_id)).size).toBe(occurrences.length)
    if (form === 'ordinary') {
      expect(f.f.version.definition).not.toHaveProperty('repeat')
      expect((await f.db.pool.query('select 1 from run_repeat_decisions where run_id=$1', [runId])).rows).toHaveLength(0)
    } else expect(f.f.version.definition.repeat?.blocks).toHaveLength(1)
    await assertPins()
  }
  async function settled(outcome: 'succeeded' | 'canceled' | 'failed') {
    expect(await runtime.runs.get(runId)).toMatchObject({ executionState: 'completed', outcome })
    expect(await runtime.runs.hasPendingCleanup(runId)).toBe(false)
    const executions = await readCurrentExecutions(runtime.runs, runId)
    expect(executions.length).toBeGreaterThan(0)
    expect(executions.every((item) => item.state === 'completed')).toBe(true)
    expect(await currentPending()).toHaveLength(0)
    const snapshot = await parity.compare()
    expect(snapshot.state.run).toMatchObject({ executionState: 'completed', outcome, cleanupPending: false, pendingInteractionCount: 0 })
    await assertPins()
    return snapshot
  }
  async function finishApprovals() {
    // At most two occurrences in this fixture; the third iteration also detects
    // a bogus new request/repeated occurrence instead of silently draining it.
    for (let count = 0; count < 3; count++) {
      await vi.waitFor(async () => {
        const run = await runtime.runs.get(runId)
        if (run?.executionState === 'completed') return
        expect(run?.executionState).toBe('waiting')
        expect(await currentPending()).toHaveLength(1)
      }, { timeout: 30000, interval: 10 })
      if ((await runtime.runs.get(runId))?.executionState === 'completed') {
        await settled('succeeded'); await assertShape(form === 'repeat' ? 2 : 0)
        return
      }
      await runtime.service.respond(responder, approvalResponse(await onePending()))
      await parity.compare()
    }
    throw new Error('Approval recovery did not finish the finite workflow')
  }
  async function resumeRows(interactionId: string) {
    return (await f.db.pool.query<{ state: string; approval_native_ack_id: string | null; approval_native_ack_record: unknown }>(
      'select state,approval_native_ack_id,approval_native_ack_record from interaction_graph_resumes where interaction_id=$1',
      [interactionId])).rows
  }
  async function assertNoNativeAcknowledgement(interactionId: string) {
    const rows = await resumeRows(interactionId)
    expect(rows.length).toBeLessThanOrEqual(1)
    // A graph-resume row need not exist before a decision. Absence cannot prove
    // closure, but it can prove that this table contains no native ACK.
    expect(rows.every((row) => row.approval_native_ack_id === null && row.approval_native_ack_record === null)).toBe(true)
    expect((await parity.compare()).state.interactions.filter((item) => item.interactionId === interactionId)
      .every((item) => item.resumeState !== 'acknowledged' && item.resumeAcknowledgementId === undefined)).toBe(true)
  }
  async function closureRows() {
    return (await f.db.pool.query(`select c.* from execution_native_closures c
      join harness_executions e on e.id=c.execution_id where e.run_id=$1 order by c.generation`, [runId])).rows
  }
  async function recoveryRows() {
    return (await f.db.pool.query<{ execution_id: string; generation: string; reference: { nativeSessionId: string } | null;
      execution_identity: { id: string; runId: string }; owner_id: string; owner_fence: string }>(
      `select p.execution_id,p.generation::text,p.reference,p.execution_identity,p.owner_id,p.owner_fence
       from execution_native_recoveries p join harness_executions e on e.id=p.execution_id
       where e.run_id=$1 order by p.generation`, [runId])).rows
  }
  async function recoverUntilSettled() {
    const errors: unknown[] = []
    // Cold recovery fences the Run instead of replaying native work. No DB
    // clock travel, lease expiry edits or infinite polling proves process loss.
    for (let pass = 0; pass < 8; pass++) {
      await runtime.engine.reconcile((error) => errors.push(error))
      // reconcile schedules a task; start joins that exact task rather than
      // racing a detached assertion with its asynchronous writer.
      await runtime.engine.start(runId).catch((error: unknown) => { errors.push(error) })
      if ((await runtime.runs.get(runId))?.executionState === 'completed'
        && !await runtime.runs.hasPendingCleanup(runId)) return
    }
    const current = await runtime.runs.get(runId)
    throw new Error(`ENG06 recovery never settled: ${JSON.stringify({ runId, state: current?.executionState,
      outcome: current?.outcome, cleanupPending: await runtime.runs.hasPendingCleanup(runId),
      errors: errors.map(errorChain) })}`)
  }
  return { f, form, faults, runId, responder, get runtime() { return runtime },
    compare: parity.compare, resumeRows, assertNoNativeAcknowledgement, closureRows, recoveryRows, onePending, currentPending, assertPins, assertShape, settled, finishApprovals, recoverUntilSettled,
    async restart() {
      await runtime.engine.shutdown()
      runtime = f.compose()
      return runtime
    },
    async stop() { await f.stop(); return runtime.engine.cancel(runId) },
    async close() { faults.release(); try { await f.close() } finally { await faults.processes.close() } },
  }
}
export type ApprovalFaultFixture = Awaited<ReturnType<typeof approvalFaultFixture>>

/** Keep the actual nested DomainError visible in a failed bounded recovery run. */
function errorChain(error: unknown): unknown {
  if (!(error instanceof Error)) return String(error)
  return { name: error.name, message: error.message,
    ...('code' in error ? { code: error.code } : {}),
    ...(error.cause === undefined ? {} : { cause: errorChain(error.cause) }),
    ...(error instanceof AggregateError ? { errors: error.errors.map(errorChain) } : {}) }
}
