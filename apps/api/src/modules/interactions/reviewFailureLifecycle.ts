import { DurableInteractionSchema, ReviewJobSchema, RunStopCauseSchema, WorkflowRunSchema } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { transact } from './wave25/transaction.js'
import { recoverApprovalFailure } from './wave25/failureRecovery.js'
import { DomainError } from '../errors.js'
import { publicReviewStopError, reviewNeedsStop } from './reviewPolicy.js'

type FailureReference = { reviewJobId: string } | { interactionId: string; errorCode: 'APPROVAL_DIRECT_CONNECTION_REQUIRED' }

/**
 * The failure row is the durable retry source. Resolve its actual Run, then
 * commit the cause and Stop intent before invoking any process lifecycle work.
 * Never accept the scheduler's unrelated Run/execution as the failure's owner.
 */
export async function requestReviewFailureStop(pool: pg.Pool, reference: FailureReference): Promise<string | undefined> {
  const target = (await pool.query<{ run_id: string; execution_semantics_version: number }>('reviewJobId' in reference
    ? `select i.run_id,v.execution_semantics_version from review_jobs j join durable_interactions i on i.id=j.interaction_id
       join runs r on r.id=i.run_id join workflow_versions v on v.id=r.workflow_version_id where j.id=$1`
    : `select i.run_id,v.execution_semantics_version from durable_interactions i join runs r on r.id=i.run_id
       join workflow_versions v on v.id=r.workflow_version_id where i.id=$1`,
  ['reviewJobId' in reference ? reference.reviewJobId : reference.interactionId])).rows[0]
  if (target?.execution_semantics_version === 3) return transact(pool, target.run_id, (publication) => recoverApprovalFailure(publication, reference))
  return requestLegacyReviewFailureStop(pool, reference)
}

async function requestLegacyReviewFailureStop(pool: pg.Pool, reference: FailureReference): Promise<string | undefined> {
  return withTransaction(pool, async (client) => {
    const target = await client.query<{ run_id: string }>('reviewJobId' in reference
      ? `select i.run_id from review_jobs j join durable_interactions i on i.id=j.interaction_id where j.id=$1`
      : 'select run_id from durable_interactions where id=$1',
    ['reviewJobId' in reference ? reference.reviewJobId : reference.interactionId])
    const runId = target.rows[0]?.run_id
    if (!runId) return undefined
    // Non-key lock is compatible with event inserts referencing this Run.
    // It also serializes competing first-cause/Stop requests without locking a
    // review job ahead of its Run or adopting the caller's stale Run snapshot.
    const owner = await client.query<{ record: unknown }>(
      'select record from runs where id=$1 for no key update', [runId],
    )
    const run = WorkflowRunSchema.parse(owner.rows[0]?.record)
    const rows = await client.query<{
      interaction: unknown; job: unknown; execution_id: string | null; requesting_node_id: string
    }>('reviewJobId' in reference
      ? `select i.record as interaction,j.record as job,j.execution_id,e.workflow_node_id as requesting_node_id
         from review_jobs j join durable_interactions i on i.id=j.interaction_id
         join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id and e.agent_id=i.requesting_agent_id
         join harness_executions reviewer on reviewer.id=j.execution_id and reviewer.run_id=i.run_id
           and reviewer.agent_id=j.reviewer_agent_id where j.id=$1 and i.run_id=$2`
      : `select i.record as interaction,null as job,null as execution_id,e.workflow_node_id as requesting_node_id
         from durable_interactions i join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
           and e.agent_id=i.requesting_agent_id where i.id=$1 and i.run_id=$2`,
    ['reviewJobId' in reference ? reference.reviewJobId : reference.interactionId, runId])
    const row = rows.rows[0]
    if (!row) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The failed review has inconsistent durable ownership.', 409)
    const interaction = DurableInteractionSchema.parse(row.interaction)
    const job = 'reviewJobId' in reference ? ReviewJobSchema.parse(row.job) : undefined
    if (run.id !== runId || interaction.runId !== run.id || interaction.workspaceId !== run.workspaceId
      || interaction.workflowId !== run.workflowId || (job && (job.id !== ('reviewJobId' in reference ? reference.reviewJobId : '')
        || job.interactionId !== interaction.id || job.reviewerAgentId !== interaction.approval.designatedOrchestratorAgentId))) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The failed review does not own this Run.', 409)
    }
    if (job ? !reviewNeedsStop(job, run) : run.executionState === 'completed' || interaction.status !== 'pending') {
      return undefined
    }
    const cause = RunStopCauseSchema.parse({
      kind: 'review_failure', interactionId: interaction.id,
      ...(job ? { reviewJobId: job.id } : {}),
      error: publicReviewStopError(job?.error?.code ?? ('errorCode' in reference ? reference.errorCode : undefined)),
      recordedAt: new Date().toISOString(),
    })
    // The DB trigger keeps the first cause in every later JSON state write,
    // including cancellation paths that started from an older Run snapshot.
    await client.query('update runs set stop_cause=coalesce(stop_cause,$2::jsonb),record=record where id=$1', [run.id, JSON.stringify(cause)])
    await client.query(`insert into run_cleanup_intents(run_id) values($1)
      on conflict(run_id) do update set pending=true,updated_at=now()`, [run.id])
    return run.id
  })
}
