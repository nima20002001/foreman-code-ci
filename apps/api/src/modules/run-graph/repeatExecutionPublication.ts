import { repeatExecutionStateDigest } from './graphDigest.js'
import { GraphSequenceSchema, canonicalGraphJson, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import type { RunOwnership } from '../runs/ownership.js'
import { beforeGraphCommit, poisonGraphTransaction } from './connection.js'
import { RunGraphError } from './errors.js'
import { graphSourceDigest, type RunGraphPublication } from './publication.js'
import { readRepeatGraphExecutionsLocked } from './repeatProjectionRows.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from './repeatReceipts.js'

/** Supplemental latest-state source, not a replacement for the immutable N1
 * source/effect receipt. Both proofs are required by the canonical snapshot.
 * Revision is a position from the EXISTING head; no additional counter/store.
 */
export async function publishRepeatExecutionStateLocked(publication: RunGraphPublication<RepeatGraphScopeV3>,
  owner: RunOwnership, executionId: string): Promise<void> {
  const { sql, scope } = publication
  try {
    const [execution] = await readRepeatGraphExecutionsLocked(sql, scope, { executionIds: [executionId] })
    if (!execution) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const sourceDigest = repeatExecutionStateDigest(scope, execution)
    const fact = { type: 'repeat.execution' as const, execution }
    const semanticDigest = graphSourceDigest([fact])
    const head = (await sql.query<{ head_sequence: string }>(
      'select head_sequence::text from run_graph_heads where run_id=$1', [scope.runId])).rows[0]
    if (!head) throw new RunGraphError('GRAPH_NOT_INITIALIZED')
    GraphSequenceSchema.parse(head.head_sequence)
    const latest = (await sql.query<{ source_revision: string; source_digest: string; semantic_digest: string; first_sequence: string }>(
      `select s.source_revision::text,s.source_digest,s.semantic_digest,s.first_sequence::text from run_graph_sources s
       where s.run_id=$1 and s.source_kind='execution' and s.source_id=$2 order by s.source_revision desc limit 1`, [scope.runId, executionId])).rows[0]
    if (latest && (!GraphSequenceSchema.safeParse(latest.first_sequence).success
      || latest.source_revision !== latest.first_sequence || BigInt(latest.first_sequence) < 1n
      || BigInt(latest.first_sequence) > BigInt(head.head_sequence))) throw new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    const same = latest?.source_digest === sourceDigest && latest.semantic_digest === semanticDigest
    const revision = same && latest ? latest.source_revision : String(BigInt(head.head_sequence) + 1n)
    if (!GraphSequenceSchema.safeParse(revision).success) throw new RunGraphError('GRAPH_SEQUENCE_EXHAUSTED')
    const evidence = { sourceKind: 'execution' as const, sourceId: executionId, sourceRevision: revision }
    const result = await publication.repeatExecutionReadback({ evidence, sourceDigest }, owner, async () => [fact])
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, evidence, sourceDigest, effect: null, semanticDigest: result.semanticDigest })
    beforeGraphCommit(sql, async () => {
      const [current] = await readRepeatGraphExecutionsLocked(sql, scope, { executionIds: [executionId] })
      if (!current || canonicalGraphJson(current) !== canonicalGraphJson(execution)) throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
    })
  } catch (error) {
    poisonGraphTransaction(sql)
    throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  }
}
