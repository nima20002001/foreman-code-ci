import { readPublicRunStateLocked } from '../run-graph/publicRunState.js'
import { publicAttentionTotals, readPublicAttentionCounts } from '../run-graph/currentAttention.js'
import type pg from 'pg'
import { AcceptedWorkflowRunV3Schema, canonicalGraphJson, type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { DurableInteractionSchema, ExecutionResultSchema,
  type DurableInteraction, type ExecutionResult, type HarnessExecution } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { beforeGraphCommit, poisonGraphTransaction, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { graphSourceDigest } from '../run-graph/publication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { openWorkflowLifecycleLocked } from './repeatLifecycle.js'
import { sameRepeatValue, compileRepeatLayout, repeatTickIndex } from './repeatResolution.js'
import { assertWorkflowRunSettlementLocked, type WorkflowRestartApprovals } from './workflowRepositoryServices.js'
import type { RunOwnership } from './ownership.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { RepeatCheckpoint } from './repeatGraph.js'
import { readRepeatExecutionLocked } from './repeatPostgres.js'
import { isAtomicApprovalCheckpointSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import { lockInteraction, readContext } from '../interactions/wave25/context.js'
import { decisionDigest, nextInteraction, publishInteraction } from '../interactions/wave25/publication.js'
import { assertSavedPendingApprovalOriginalLocked } from '../interactions/nativeApprovalProof.js'
import { isSettlementPendingCheckpointError } from '../interactions/repeatNativeEvidence.js'
import { ensureWorkDirectionInteraction } from './workDirectionInteraction.js'

function fail(code: string): never {
  throw new DomainError(code, 'The workflow lifecycle requires its exact persisted owner, checkpoint and settlement evidence.', 409)
}
async function retainOwner(sql: GraphTransactionSql, owner: RunOwnership): Promise<void> {
  const fence = await owner.readOneShotFence(sql)
  beforeGraphCommit(sql, async () => {
    owner.assertOwned()
    if (!sameRepeatValue(fence, await owner.readOneShotFence(sql))) return fail('RUN_OWNERSHIP_LOST')
  })
}

/** Retain settled/unsubmitted work and checkpoint-bound approval waits across restart. */
export async function settleWorkForRestart(owner: RunOwnership, approvals?: WorkflowRestartApprovals): Promise<boolean> {
  return owner.oneShotConnection().transaction(async (sql) => {
    const { snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    if (snapshot.stopRequested || snapshot.cleanupPending
      || !['queued', 'running', 'waiting'].includes(snapshot.run.executionState)) return false
    const waiting = [...new Set(approvals?.interactions.map(item => item.executionId) ?? [])]
    const pending = (await sql.query<{ pending: boolean }>(`select exists(
      select 1 from harness_executions e where e.run_id=$1 and (
        e.record->>'state' is null or e.record->>'state' not in ('completed','queued')
          and not (e.record->>'state'='waiting' and e.id=any($2::text[]))
        or e.record->>'state'='queued' and (not exists(select 1 from workflow_native_entries n
          where n.execution_id=e.id and n.run_id=e.run_id and n.phase='reserved')
          or exists(select 1 from run_graph_effects f where f.run_id=e.run_id
            and f.effect_kind='execution.launch' and f.entity_id=e.id))
        or e.record#>>'{result,outcome}'='succeeded' and (e.accepted and case
          when e.work_activation_id is null then not exists(
            select 1 from run_repeat_results x where x.run_id=e.run_id and x.execution_id=e.id)
          else not exists(select 1 from run_work_results x where x.run_id=e.run_id and x.execution_id=e.id
            and x.activation_id=e.work_activation_id) end
          or not e.accepted and not exists(select 1 from workflow_native_proofs p
            where p.run_id=e.run_id and p.execution_id=e.id
              and p.record#>>'{original,type}'='history'
              and p.record#>'{original,history,terminalTurn,result}'=e.record->'result')))) as pending`,
    [owner.runId, waiting])).rows[0]
    if (pending?.pending !== false) return false
    await retainOwner(sql, owner)
    await assertWorkflowRunSettlementLocked(sql, snapshot.run, owner, 'restart', approvals)
    return true
  })
}

/** Re-enter an unresolved approval BEFORE native observation resumes its budget
 * or touches a resident process. A parallel graph invocation re-runs siblings
 * too; delivery alone does not consume their task-local checkpoint. This is a
 * read of existing original requests and canonical receipts, not a resume/ACK
 * writer or permission to launch. The native boundary still revalidates all
 * owner, credential, session, generation and original-continuation evidence. */
export async function readUnconsumedWorkflowApprovals(owner: RunOwnership,
  execution: HarnessExecution): Promise<DurableInteraction[]> {
  owner.assertOwned()
  if (execution.runId !== owner.runId || execution.state !== 'waiting') return fail('GRAPH_SCOPE_MISMATCH')
  return owner.oneShotConnection().transaction(async (sql) => {
    const { snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    await retainOwner(sql, owner)
    if (snapshot.stopRequested || snapshot.cleanupPending) return fail('GRAPH_STOP_CONFLICT')
    if (!['running', 'waiting'].includes(snapshot.run.executionState)) return fail('GRAPH_TERMINAL_CONFLICT')
    const stored = await readRepeatExecutionLocked(sql, snapshot, execution.id)
    if (!sameRepeatValue(stored.execution, execution)) return fail('REPEAT_EXECUTION_INPUT_CONFLICT')
    const rows = (await sql.query<{ id: string; status: string; record: unknown;
      resume_state: string | null; effect_digest: string | null }>(`
      select i.id,i.status,i.record,g.state as resume_state,f.effect_digest
      from durable_interactions i
      left join interaction_graph_resumes g on g.interaction_id=i.id
      left join run_graph_effects f on f.run_id=i.run_id and f.effect_kind='graph.resume' and f.entity_id=i.id
      where i.run_id=$1 and i.execution_id=$2 order by i.id limit 1001 for update of i`,
    [owner.runId, execution.id])).rows
    if (rows.length > 1000) return fail('GRAPH_RESUME_LIMIT')
    const waiting: DurableInteraction[] = []
    for (const row of rows) {
      const item = DurableInteractionSchema.parse(row.record)
      if (item.id !== row.id || item.status !== row.status || item.runId !== owner.runId
        || item.graphThreadId !== owner.runId || item.executionId !== execution.id
        || item.workspaceId !== snapshot.run.workspaceId || item.workflowId !== snapshot.run.workflowId
        || item.requestingAgentId !== execution.agentId || item.nativeSessionId !== execution.nativeSessionId) {
        return fail('INTERACTION_IDENTITY_CONFLICT')
      }
      if (item.status === 'canceled') continue // Stop/terminal writers still require canonical retirement.
      await assertSavedPendingApprovalOriginalLocked(sql, item)
      if (row.effect_digest !== null) {
        const expected = graphSourceDigest({ interactionId: item.id, runId: item.runId,
          executionId: item.executionId, graphThreadId: item.graphThreadId,
          graphInterruptId: item.graphInterruptId ?? null, decision: decisionDigest(item) })
        if (row.effect_digest !== expected || row.resume_state !== 'resumed'
          || item.status !== 'delivered' || item.deliveryState !== 'delivered' || !item.graphInterruptId) {
          return fail('GRAPH_RESUME_RECEIPT_MISSING')
        }
        // An ACK is deliberately NOT required here: only observing the original
        // native continuation after this checkpoint consume can produce it.
        continue
      }
      if (row.resume_state === 'resumed') return fail('GRAPH_RESUME_RECEIPT_MISSING')
      waiting.push(item) // Includes delivered but not yet consumed approvals.
    }
    return waiting
  })
}

/** An engine checkpoint must be read from the existing saver. The same SQL
 * transaction then verifies the saver's ORIGINAL interrupt rows, exact native
 * pending source, execution/occurrence and immutable version before binding.
 * A guessed graphInterruptId or caller JSON cannot create this binding. */
export async function persistWorkflowApprovalWait(owner: RunOwnership, saver: BaseCheckpointSaver,
  supplied: RepeatCheckpoint): Promise<DurableInteraction[]> {
  if (!isAtomicApprovalCheckpointSaver(saver)) return fail('GRAPH_RESUME_ATOMIC_CONSUMER_REQUIRED')
  const checkpoint = structuredClone(supplied)
  if (!checkpoint.tasks.some((task) => task.interrupts?.length)) return []
  if (checkpoint.values.runId !== owner.runId || checkpoint.tasks.length > 1000
    // A completed sibling can still await physical settlement after consuming
    // its interrupt. Retain its task/error for retry; it must not prevent binding
    // the OTHER branch's original interrupt. This classification grants no
    // receipt/terminal authority: the replay rechecks the actual live guards.
    || checkpoint.tasks.some((task) => task.error != null
      && !isSettlementPendingCheckpointError(task.error))) return fail('GRAPH_INTERRUPT_INVALID')
  return owner.oneShotConnection().transaction(async (sql) => {
    try {
      const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
      const { run, version } = snapshot
      await retainOwner(sql, owner)
      if (snapshot.stopRequested || snapshot.cleanupPending) return fail('GRAPH_STOP_CONFLICT')
      if (!['running', 'waiting'].includes(run.executionState)) return fail('GRAPH_TERMINAL_CONFLICT')
      const workHandoffs = version.definition.handoffs !== undefined
      const wrappers = workHandoffs ? null : new Map(compileRepeatLayout(version).nodes.map((node) => [node.name, node]))
      const seen = new Set<string>(), current: DurableInteraction[] = []
      const retained: Array<{ item: DurableInteraction; checkpointId: string }> = []
      for (const task of checkpoint.tasks) {
        if (!task.interrupts?.length) continue
        const wrapper = wrappers?.get(task.name)
        if (workHandoffs ? task.name !== 'activation' : !wrapper || !['once', 'body'].includes(wrapper.kind)) {
          return fail('GRAPH_INTERRUPT_INVALID')
        }
        for (const pending of task.interrupts) {
          if (!pending.id || !pending.value || typeof pending.value !== 'object') return fail('GRAPH_INTERRUPT_INVALID')
          const value = pending.value as { interactionId?: unknown; interactionIds?: unknown }
          const ids = value.interactionIds ?? [value.interactionId]
          if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || typeof value.interactionId !== 'string'
            || !ids.includes(value.interactionId) || ids.some((id) => typeof id !== 'string')
            || new Set(ids).size !== ids.length || seen.size + ids.length > 1000) return fail('GRAPH_INTERRUPT_INVALID')
          let executionId: string | undefined
          for (const id of ids as string[]) {
            if (seen.has(id)) return fail('GRAPH_INTERRUPT_INVALID')
            seen.add(id)
            const item = await lockInteraction(sql, id)
            if (item.runId !== run.id || item.graphThreadId !== run.id || item.workspaceId !== run.workspaceId
              || item.workflowId !== run.workflowId || item.graphInterruptId && item.graphInterruptId !== pending.id) return fail('INTERACTION_IDENTITY_CONFLICT')
            if (executionId && executionId !== item.executionId) return fail('INTERACTION_INTERRUPT_CONFLICT')
            executionId = item.executionId
            const stored = await readRepeatExecutionLocked(sql, snapshot, item.executionId)
            if (!workHandoffs && stored.ref.nodeId !== wrapper!.nodeId
              || stored.execution.nativeSessionId !== item.nativeSessionId
              || stored.execution.agentId !== item.requestingAgentId
              || (workHandoffs ? !stored.workActivationId || stored.ref.occurrence !== null
                : wrapper!.kind === 'body'
                  ? !stored.ref.occurrence || stored.ref.occurrence.occurrenceId !== checkpoint.values.occurrences?.[wrapper!.blockId!]
                  : stored.ref.occurrence !== null)) return fail('REPEAT_CHECKPOINT_OCCURRENCE_CONFLICT')
            await assertSavedPendingApprovalOriginalLocked(sql, item)
            const bound = item.graphInterruptId ? item : nextInteraction(item, { graphInterruptId: pending.id })
            const checkpointId = await saver.inspectApprovalInterrupt(sql, bound)
            if (!item.graphInterruptId) {
              const context = await readContext(sql, item)
              await publishInteraction(publication, context, item, bound, { mutate: async (transaction) => {
                await transaction.query(`update interaction_graph_resumes set graph_interrupt_id=$2,revision=revision+1,
                  updated_at=clock_timestamp() where interaction_id=$1 and graph_interrupt_id is null`, [item.id, pending.id])
              } })
            }
            current.push(bound); retained.push({ item: bound, checkpointId })
          }
        }
      }
      if (!current.length) return fail('GRAPH_INTERRUPT_INVALID')
      if (run.executionState !== 'waiting') {
        const next = AcceptedWorkflowRunV3Schema.parse({ ...run, executionState: 'waiting' })
        // A Run can re-enter the same wait after a sibling branch resumed; the
        // locked graph head distinguishes that new transition from a replay.
        const head = (await sql.query<{ sequence: string }>('select head_sequence::text as sequence from run_graph_heads where run_id=$1',
          [run.id])).rows[0]?.sequence
        if (head === undefined) return fail('GRAPH_NOT_INITIALIZED')
        await lifecycleSource(publication, { kind: 'approval_wait', next, afterSequence: head, bindings: retained.map(({ item, checkpointId }) => ({
          interactionId: item.id, graphInterruptId: item.graphInterruptId, checkpointId,
        })) }, async () => {
          await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [run.id, next.executionState, JSON.stringify(next)])
        })
      }
      beforeGraphCommit(sql, async () => {
        for (const { item, checkpointId } of retained) {
          if (await saver.inspectApprovalInterrupt(sql, item) !== checkpointId) return fail('GRAPH_INTERRUPT_NOT_CURRENT')
          const actual = await lockInteraction(sql, item.id)
          if (actual.graphInterruptId !== item.graphInterruptId || actual.executionId !== item.executionId) return fail('INTERACTION_INTERRUPT_CONFLICT')
        }
      })
      return current
    } catch (error) { poisonGraphTransaction(sql); throw error }
  })
}

async function lifecycleSource(publication: Awaited<ReturnType<typeof openWorkflowLifecycleLocked>>['publication'],
  source: unknown, mutate: () => Promise<void>): Promise<void> {
  const sourceDigest = graphSourceDigest(source)
  const evidence = { sourceKind: 'run' as const, sourceId: `lifecycle:${sourceDigest.slice(7)}`, sourceRevision: '1' }
  const state = await readPublicRunStateLocked(publication.sql, publication.scope)
  const change = source as { kind: string; failed?: boolean; next?: AcceptedWorkflowRunV3 }
  if (change.next) {
    state.executionState = change.next.executionState
    state.outcome = change.next.outcome
  }
  if (change.kind === 'cleanup_requested') state.cleanupPending = true
  if (change.kind === 'cleanup_checked') state.cleanupPending = change.failed === true
    || publicAttentionTotals(await readPublicAttentionCounts(publication.sql, publication.scope.runId)).cleanupPending
  await publication.source({ evidence, sourceDigest, facts: [{ type: 'run.state', state }] }, mutate)
  requireRepeatCanonicalReceiptBeforeCommit(publication.sql, { scope: publication.scope, evidence, sourceDigest, effect: null })
  // G1's single finalizer reads/publishes the actual Run and public projection
  // after this mutation. No parallel journal or callback-shaped receipt exists.
}

/** A completed graph with unresolved work waits for owner direction or Stop.
 * It remains pending, so sibling results are preserved without declaring a
 * global success or failure. No approval resume or native launch is inferred. */
export async function persistWorkDirectionWait(owner: RunOwnership,
  locations: Pick<WorkspaceLocationService, 'revalidateRunAuthorization'>): Promise<void> {
  owner.assertOwned()
  await owner.oneShotConnection().transaction(async (sql) => {
    const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    const { run, version } = snapshot
    await retainOwner(sql, owner)
    if (!version.definition.handoffs || snapshot.stopRequested || snapshot.cleanupPending
      || !['running', 'waiting'].includes(run.executionState)) return fail('WORK_DIRECTION_WAIT_CONFLICT')
    const rows = (await sql.query<{ unresolved_id: string }>(
      'select unresolved_id from run_work_unresolved where run_id=$1 order by unresolved_id limit 1001',
      [run.id])).rows
    if (!rows.length || rows.length>1000) return fail('WORK_DIRECTION_WAIT_CONFLICT')
    const unresolvedIds = rows.map((item) => item.unresolved_id)
    if (run.executionState === 'waiting') {
      const prior = (await sql.query<{ unresolved_ids: unknown }>(
        'select unresolved_ids from run_work_direction_waits where run_id=$1', [run.id])).rows[0]
      if (!sameRepeatValue(prior?.unresolved_ids, unresolvedIds)) return fail('WORK_DIRECTION_WAIT_CONFLICT')
      await ensureWorkDirectionInteraction(publication, run)
      return
    }
    const incomplete = await sql.query(`select 1 from run_work_activations
      where run_id=$1 and state<>'completed' limit 1`, [run.id])
    if (incomplete.rowCount) return fail('WORK_ACTIVATIONS_UNRESOLVED')
    const authorize = () => locations.revalidateRunAuthorization(run.authorizationPrincipalId,
      run.workspaceId, run.workflowId, sql)
    await authorize()
    beforeGraphCommit(sql, authorize)
    await assertWorkflowRunSettlementLocked(sql, run, owner)
    const next = AcceptedWorkflowRunV3Schema.parse({ ...run, executionState: 'waiting', outcome: 'pending' })
    await lifecycleSource(publication, { kind: 'work_direction_wait', next, unresolvedIds }, async () => {
      const changed = await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
        [run.id, next.executionState, canonicalGraphJson(next)])
      if (changed.rowCount !== 1) return fail('RUN_PIN_CONFLICT')
      await sql.query(`insert into run_work_direction_waits(run_id,workflow_version_id,unresolved_ids,created_at)
        values($1,$2,$3::jsonb,clock_timestamp())`, [run.id, version.id, canonicalGraphJson(unresolvedIds)])
      await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
        values($1,'backend','work_direction_wait',clock_timestamp(),$2::jsonb)`,
      [run.id, canonicalGraphJson({ unresolvedIds })])
    })
    await ensureWorkDirectionInteraction(publication, next)
  })
}

export async function hasWorkDirectionWait(owner: RunOwnership): Promise<boolean> {
  owner.assertOwned()
  const row = await owner.client.query(`select 1 from run_work_direction_waits d join runs r on r.id=d.run_id
    where d.run_id=$1 and r.execution_state='waiting'
      and r.record->>'executionState'='waiting' and r.record->>'outcome'='pending'
      and r.workflow_version_id=d.workflow_version_id and r.stop_requested_at is null`,
  [owner.runId])
  return row.rowCount === 1
}

/** Retain an execution failure without fencing sibling work or claiming closure. */
export async function recordWorkflowExecutionFailure(owner: RunOwnership, executionId: string,
  failure: ExecutionResult): Promise<void> {
  const result = ExecutionResultSchema.parse(failure)
  if (result.outcome !== 'failed' || !result.error) return fail('RUN_FAILURE_CAUSE_INVALID')
  // A retryable cause abandons one attempt so its node can start a fresh one.
  const abandoned = result.error.retryable === true
  await owner.oneShotConnection().transaction(async sql => {
    const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    await retainOwner(sql, owner)
    if (snapshot.stopRequested || snapshot.cleanupPending
      || !['running', 'waiting'].includes(snapshot.run.executionState)) {
      return fail('GRAPH_STOP_CONFLICT')
    }
    const stored = await readRepeatExecutionLocked(sql, snapshot, executionId)
    const intervalCheck = repeatTickIndex(stored.execution.input) !== undefined
    if (!intervalCheck && !abandoned && (!snapshot.version.definition.handoffs || !stored.workActivationId
      || stored.execution.nativeSessionId || !['queued', 'starting'].includes(stored.execution.state))) {
      return fail('RUN_FAILURE_CAUSE_INVALID')
    }
    if (stored.execution.state === 'completed') return
    const budget = (await sql.query<{ failure_result: unknown }>(
      'select failure_result from approval_execution_state where execution_id=$1 for update', [executionId])).rows[0]
    if (!budget) return fail('RUN_FAILURE_CAUSE_INVALID')
    if (budget.failure_result) {
      // The first recorded cause wins.
      if (!intervalCheck && !abandoned && !sameRepeatValue(budget.failure_result, result)) return fail('RUN_FAILURE_CAUSE_INVALID')
      return
    }
    await lifecycleSource(publication, { kind: 'execution_failure_recorded', executionId, result }, async () => {
      await sql.query('update approval_execution_state set failure_result=$2::jsonb where execution_id=$1',
        [executionId, canonicalGraphJson(result)])
    })
  })
}

/** A negative cleanup intent is not success/closure. It only fences new work.
 * Ownerless calls are restricted to an already authorized Stop or terminal Run;
 * active-run cancellation must use its actual existing owner. */
export async function requestWorkflowCleanup(pool: pg.Pool, runId: string, owner?: RunOwnership,
  failure?: ExecutionResult, options?: { executionId: string }): Promise<void> {
  if (owner && owner.runId !== runId) return fail('RUN_OWNERSHIP_LOST')
  const result = failure ? ExecutionResultSchema.parse(failure) : null
  if (result && (!owner || result.outcome !== 'failed')) return fail('RUN_FAILURE_CAUSE_INVALID')
  const work = async (sql: GraphTransactionSql) => {
    const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, runId)
    if (owner) await retainOwner(sql, owner)
    else if (!snapshot.stopRequested && snapshot.run.executionState !== 'completed') return fail('RUN_OWNERSHIP_REQUIRED')
    const failureResult = snapshot.stopRequested || snapshot.run.executionState === 'completed' ? null : result
    const prior = (await sql.query<{ failure_result: unknown }>(
      'select failure_result from run_cleanup_intents where run_id=$1', [runId])).rows[0]
    let executionFailureNeeded = false
    if (failureResult && options) {
      const budget = (await sql.query<{ failure_result: unknown }>(
        `select b.failure_result from approval_execution_state b join harness_executions e on e.id=b.execution_id
         where b.execution_id=$1 and e.run_id=$2`, [options.executionId, runId])).rows[0]
      if (!budget) return fail('RUN_FAILURE_CAUSE_INVALID')
      executionFailureNeeded = !budget.failure_result
    }
    if (snapshot.cleanupPending && (!failureResult || prior?.failure_result) && !executionFailureNeeded) return
    await lifecycleSource(publication, { kind: 'cleanup_requested', runId, failure: failureResult,
      ...(executionFailureNeeded ? { executionId: options!.executionId } : {}),
      at: new Date().toISOString() }, async () => {
      await sql.query(`insert into run_cleanup_intents(run_id,failure_result) values($1,$2::jsonb)
        on conflict(run_id) do update set pending=true,updated_at=clock_timestamp(),
          failure_result=coalesce(run_cleanup_intents.failure_result,excluded.failure_result)`,
      [runId, failureResult ? canonicalGraphJson(failureResult) : null])
      if (executionFailureNeeded) {
        const changed = await sql.query(`update approval_execution_state
          set failure_result=coalesce(failure_result,$2::jsonb) where execution_id=$1`,
        [options!.executionId, canonicalGraphJson(failureResult)])
        if (changed.rowCount !== 1) return fail('RUN_FAILURE_CAUSE_INVALID')
      }
    })
  }
  if (owner) await owner.oneShotConnection().transaction(work)
  else await withExclusiveGraphConnection(pool, (connection) => connection.transaction(work))
}

/** The caller first physically closes/cancels exact managers. This writer
 * rereads every positive settlement proof under the same parent/head lock.
 * Neither a returned cleanup boolean nor an empty process list can clear it. */
export async function finishWorkflowCleanup(owner: RunOwnership, failed: boolean): Promise<void> {
  await owner.oneShotConnection().transaction(async (sql) => {
    const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    await retainOwner(sql, owner)
    if (!failed) {
      if (snapshot.run.executionState !== 'completed') return fail('REPEAT_CLEANUP_PENDING')
      await assertWorkflowRunSettlementLocked(sql, snapshot.run, owner, 'cleanup')
    }
    if (!snapshot.cleanupPending && !failed) return
    const now = new Date().toISOString()
    const row = (await sql.query<{ attempts: number }>('select attempts from run_cleanup_intents where run_id=$1 for update', [owner.runId])).rows[0]
    if (!row) return fail('REPEAT_CLEANUP_PENDING')
    await lifecycleSource(publication, { kind: 'cleanup_checked', runId: owner.runId, failed, attempt: row.attempts + 1, at: now }, async () => {
      await sql.query(`update run_cleanup_intents set pending=$2,attempts=attempts+1,last_error=$3,updated_at=$4::timestamptz where run_id=$1`,
        [owner.runId, failed, failed ? 'Exact native, reviewer or credential settlement is still pending.' : null, now])
      await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
        values($1,'backend','run_cleanup_checked',$2,$3::jsonb)`,
      [owner.runId, now, canonicalGraphJson({ failed, attempt: row.attempts + 1 })])
    })
  })
}

/** Terminalizes only after every selected/unselected admitted attempt has its
 * positive closure or sealed-entry proof. An interrupted/failed parent is not
 * used as a substitute for those proofs. Any failed assertion rolls it all back. */
export async function settleWorkflowRun(owner: RunOwnership, interrupted = false): Promise<boolean> {
  return owner.oneShotConnection().transaction(async (sql) => {
    const { publication, snapshot } = await openWorkflowLifecycleLocked(sql, owner.runId)
    await retainOwner(sql, owner)
    const { run } = snapshot
    if (run.executionState === 'completed') return false
    if (!snapshot.cleanupPending && !snapshot.stopRequested) return fail('REPEAT_CLEANUP_PENDING')
    const cleanup = (await sql.query<{ failure_result: unknown }>(
      'select failure_result from run_cleanup_intents where run_id=$1', [run.id])).rows[0]
    const failure = cleanup?.failure_result ? ExecutionResultSchema.parse(cleanup.failure_result) : undefined
    if (failure && failure.outcome !== 'failed') return fail('RUN_FAILURE_CAUSE_INVALID')
    let executionFailure: ExecutionResult | undefined
    if (!snapshot.stopRequested && !failure) {
      // Only exhausted node attempts have a failed resolution. Cleanup siblings
      // and superseded retries must not replace that cause.
      const candidates = (await sql.query<{ result: unknown; failed_resolution: boolean }>(`
        select e.record->'result' as result, exists(
          select 1 from run_repeat_resolutions r where r.run_id=e.run_id and r.execution_id=e.id
            and r.record#>>'{value,resolution}'='failed') as failed_resolution
        from harness_executions e
        where e.run_id=$1 and e.tick_index is null and e.record->>'state'='completed'
          and e.record#>>'{result,outcome}'='failed'
          and ($2::boolean or e.record#>>'{result,error,code}'='EXECUTION_INTERRUPTED')
        order by ${interrupted ? 'e.created_at,e.id' : 'e.created_at desc,e.id desc'}`, [run.id, !interrupted])).rows
      const execution = candidates.find(candidate => interrupted || candidate.failed_resolution)
      if (execution) executionFailure = ExecutionResultSchema.parse(execution.result)
    }
    const result: ExecutionResult = snapshot.stopRequested ? { outcome: 'canceled' } : failure ?? executionFailure ?? { outcome: 'failed', error: {
      code: interrupted ? 'EXECUTION_INTERRUPTED' : 'WORKFLOW_SELECTED_EXECUTION_FAILED',
      message: interrupted ? 'The owned execution was interrupted and physically settled; native work was not replayed.'
        : 'A selected execution did not complete successfully.', retryable: false,
    } }
    const next = AcceptedWorkflowRunV3Schema.parse({ ...run, executionState: 'completed', outcome: result.outcome,
      result, finishedAt: new Date().toISOString() })
    await lifecycleSource(publication, { kind: 'negative_terminal', previous: run, next, stopped: snapshot.stopRequested }, async () => {
      await sql.query('update runs set execution_state=$2,record=$3::jsonb where id=$1', [run.id, next.executionState, canonicalGraphJson(next)])
      await assertWorkflowRunSettlementLocked(sql, next, owner, 'cleanup')
      if (snapshot.version.definition.handoffs) {
        await sql.query(`update run_work_activations set state='completed'
          where run_id=$1 and state<>'completed'`, [run.id])
      }
    })
    beforeGraphCommit(sql, async () => {
      const final = await readAcceptedRepeatRunLocked(sql, run.id)
      if (!sameRepeatValue(final.run, next) || !final.cleanupPending) return fail('RUN_PIN_CONFLICT')
    })
    return true
  })
}
