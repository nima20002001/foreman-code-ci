import { DurableInteractionSchema, HarnessExecutionSchema, ReviewJobSchema, RunStopCauseSchema } from '@foreman-code/contracts'
import type { GraphEffect } from '@foreman-code/contracts/wave25'
import type { RunGraphPublication } from '../../run-graph/publication.js'
import { graphSourceDigest } from '../../run-graph/publication.js'
import { assertOrchestratorGraphAuthority } from '../graphAuthority.js'
import { publicReviewStopError } from '../reviewPolicy.js'
import { DomainError } from '../../errors.js'
import { fail, readContext, type ApprovalContext } from './context.js'
import { approvalAttentionFacts } from './attention.js'
import { stopForReviewFailure } from './stop.js'

type FailureReference = { reviewJobId: string } | { interactionId: string; errorCode: 'APPROVAL_DIRECT_CONNECTION_REQUIRED' }

/** Re-enter the existing failure sweep through G1; no legacy raw Run mutation. */
export async function recoverApprovalFailure(publication: RunGraphPublication, reference: FailureReference): Promise<string | undefined> {
  const sql = publication.sql, runId = publication.scope.runId
  const row = (await sql.query<{ interaction: unknown; job: unknown; execution: unknown }>('reviewJobId' in reference
    ? `select i.record as interaction,j.record as job,e.record as execution from review_jobs j
       join durable_interactions i on i.id=j.interaction_id join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
       where j.id=$1 and i.run_id=$2`
    : `select i.record as interaction,null as job,e.record as execution from durable_interactions i
       join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id where i.id=$1 and i.run_id=$2`,
  ['reviewJobId' in reference ? reference.reviewJobId : reference.interactionId, runId])).rows[0]
  if (!row) return undefined
  const i = DurableInteractionSchema.parse(row.interaction)
  if ('reviewJobId' in reference) {
    const job = ReviewJobSchema.parse(row.job)
    if (job.state !== 'failed') return undefined
    const context = await readContext(sql, i)
    await stopForReviewFailure(publication, job, context)
    return runId
  }
  if (i.status !== 'pending' || i.approval.handler !== 'orchestrator') return undefined
  const stopped = await sql.query("select 1 from runs where id=$1 and (stop_requested_at is not null or execution_state='completed')", [runId])
  if (stopped.rowCount) return runId
  try {
    // A stale failure report cannot Stop a currently authorized immutable route.
    // This helper only reads; it never grants access or initializes a reviewer.
    await assertOrchestratorGraphAuthority(sql, i)
    return undefined
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'INTERACTION_ACCESS_DENIED') throw error
  }
  const requester = HarnessExecutionSchema.parse(row.execution)
  if (requester.id !== i.executionId || requester.runId !== runId || requester.agentId !== i.requestingAgentId
    || i.workspaceId !== publication.scope.workspaceId || i.workflowId !== publication.scope.workflowId) return fail('APPROVAL_IDENTITY_MISMATCH')
  const context: ApprovalContext = { scope: publication.scope, requester, stopped: false }
  const cause = RunStopCauseSchema.parse({ kind: 'review_failure', interactionId: i.id,
    error: publicReviewStopError(reference.errorCode), recordedAt: new Date().toISOString() })
  const effect: GraphEffect = { identity: { kind: 'run.stop', entityId: runId }, digest: graphSourceDigest({ runId, cause }) }
  const facts = (await approvalAttentionFacts(sql, context, { interaction: i })).flatMap((fact) =>
    fact.type === 'run.state' ? [{ ...fact, state: { ...fact.state, stopRequested: true, cleanupPending: true } }] : [])
  await publication.effect({ effect, evidence: { sourceKind: 'cleanup', sourceId: `stop:${graphSourceDigest({ interactionId: i.id }).slice(7)}`, sourceRevision: '0' },
    sourceDigest: graphSourceDigest({ i, cause }), facts }, { expected: { scope: publication.scope, effect: effect.identity,
      effectDigest: effect.digest, ownerId: i.id, fence: String(i.revision), connectionGeneration: null },
    readCurrentLocked: async (transaction) => {
      const actual = (await transaction.query<{ id: string; revision: string; status: string }>(
        'select id,revision::text,status from durable_interactions where id=$1 and run_id=$2 for update', [i.id, runId])).rows[0]
      if (!actual) return fail('APPROVAL_IDENTITY_MISMATCH')
      return { scope: publication.scope, effect: { kind: 'run.stop', entityId: runId }, effectDigest: graphSourceDigest({ runId, cause }),
        ownerId: actual.id, fence: actual.revision, connectionGeneration: null, ownership: actual.status === 'pending' ? 'held' : 'lost',
        access: 'effect', security: 'valid', effectClosed: false, submission: 'not_submitted' }
    } }, async (transaction) => {
    await transaction.query('update runs set stop_cause=coalesce(stop_cause,$2::jsonb),record=record where id=$1', [runId, JSON.stringify(cause)])
    await transaction.query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=clock_timestamp()`, [runId])
  })
  return runId
}
