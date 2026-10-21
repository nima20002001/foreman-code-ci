import { DurableInteractionSchema, ReviewJobSchema } from '@foreman-code/contracts'
import { RUN_GRAPH_LIMITS, type RunGraphScope } from '@foreman-code/contracts/wave25'

import type { GraphTransactionSql } from '../../run-graph/connection.js'
import type { CurrentExchanges } from '../../run-graph/compactSnapshot.js'
import { RunGraphError } from '../../run-graph/errors.js'
import { readContext, type ApprovalContext } from './context.js'
import { acknowledgementId, reviewEvidence } from './nativeEvidence.js'
import { CANCELED_INTERACTION_RETIRED_SQL, interactionFact, reviewFact } from './publication.js'

export interface InteractionRow {
  record: unknown
}

/** Current bounded approval exchanges for the compact graph snapshot.
 * Uses the caller's read transaction and the same immutable authority mapper as
 * the writers; completed/retired history remains on detail paths. */
export type CurrentInteractionRow = InteractionRow
export const CURRENT_INTERACTIONS_SQL = `select i.record
     from durable_interactions i
     left join interaction_graph_resumes g on g.interaction_id=i.id
     where i.run_id=$1 and (
       i.status not in ('delivered','canceled')
       or (i.status='delivered' and i.record->>'kind' is distinct from 'work_direction'
         and g.approval_native_ack_id is null)
       or (i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL}))
     ) order by i.id limit $2`

export type CurrentReviewRow = { record: unknown; revision: string; interaction_record: unknown }
export const CURRENT_REVIEWS_SQL = `select j.record,j.revision::text,i.record as interaction_record
     from review_jobs j join durable_interactions i on i.id=j.interaction_id
     where i.run_id=$1 and (
       j.state not in ('completed','failed')
       or (j.state='failed' and j.record->'cleanup' is not null
         and j.record->'cleanup'->>'completedAt' is null)
     ) order by j.id limit $2`

export async function readCurrentGraphExchanges(
  sql: GraphTransactionSql,
  scope: RunGraphScope,
  prefetched?: { interactions: CurrentInteractionRow[]; reviews: CurrentReviewRow[] },
): Promise<CurrentExchanges> {
  const interactionRows = prefetched ? { rows: prefetched.interactions } : await sql.query<CurrentInteractionRow>(
    CURRENT_INTERACTIONS_SQL,
    [scope.runId, RUN_GRAPH_LIMITS.exchanges + 1],
  )
  if (interactionRows.rows.length > RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')

  const contexts = new Map<string, ApprovalContext>()
  const contextFor = async (interaction: ReturnType<typeof DurableInteractionSchema.parse>) => {
    const saved = contexts.get(interaction.id)
    if (saved) return saved
    const context = await readContext(sql, interaction)
    if (context.scope.runId !== scope.runId || context.scope.workflowVersionId !== scope.workflowVersionId) {
      throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
    contexts.set(interaction.id, context)
    return context
  }

  const interactions: CurrentExchanges['interactions'] = []
  for (const row of interactionRows.rows) {
    const interaction = DurableInteractionSchema.parse(row.record)
    // Delivery establishes a pending continuation obligation, not evidence of
    // checkpoint consumption or native work. Lease/blocked states stay private.
    // Canceled uncertainty uses the same mapper as its delta producer. Only a
    // committed retirement receipt removes it, never a later cleanup flag alone.
    const fact = interactionFact(await contextFor(interaction), interaction)
    if (fact.type !== 'interaction.state') throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    interactions.push(fact.interaction)
  }

  const reviewRows = prefetched ? { rows: prefetched.reviews } : await sql.query<CurrentReviewRow>(
    CURRENT_REVIEWS_SQL,
    [scope.runId, RUN_GRAPH_LIMITS.exchanges + 1],
  )
  if (reviewRows.rows.length > RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const reviews: CurrentExchanges['reviews'] = []
  for (const row of reviewRows.rows) {
    const interaction = DurableInteractionSchema.parse(row.interaction_record)
    const job = ReviewJobSchema.parse(row.record)
    const fact = reviewFact(await contextFor(interaction), job, row.revision,
      acknowledgementId(await reviewEvidence(sql, job.id)))
    if (fact.type !== 'review.state') throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    reviews.push(fact.review)
  }
  if (interactions.length + reviews.length > RUN_GRAPH_LIMITS.exchanges) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  return { interactions, reviews }
}
