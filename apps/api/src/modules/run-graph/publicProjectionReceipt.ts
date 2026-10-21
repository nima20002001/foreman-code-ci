import {
  PublicGraphProjectionSchema, PublicGraphDeltaSchema, canonicalGraphJson,
  GraphSequenceSchema, type PublicGraphProjection, type PublicGraphDelta, type RunGraphScope,
} from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, type GraphTransactionSql } from './connection.js'
import type { PublicProjectionReader } from './publicProjectionReader.js'
import { graphSourceDigest } from './graphDigest.js'
import { RunGraphError } from './errors.js'

/** A materialized, digest-checked public view, not a second domain store or journal.
 * Actual execution/native/approval records remain authoritative. Its only writer
 * is canonical G1 finalization, with its source receipt in run_graph_sources. */
export interface PublicProjectionReceipt {
  projection: PublicGraphProjection
  evidence: { sourceKind: 'run'; sourceId: string; sourceRevision: string }
  sourceDigest: string
  semanticDigest: string
  fact: { type: 'workflow.presentation'; delta: PublicGraphDelta }
}
const sourceId = (runId: string) => `public:${graphSourceDigest(runId).slice(7)}`
const same = (a: unknown, b: unknown) => canonicalGraphJson(a) === canonicalGraphJson(b)
const fail = (): never => { throw new RunGraphError('GRAPH_INVARIANT_VIOLATION') }

export function publicProjectionDelta(previous: PublicGraphProjection | undefined,
  current: PublicGraphProjection): PublicGraphDelta {
  const changed = <T>(before: readonly T[], after: readonly T[], key: (item: T) => string): T[] => {
    const prior = new Map(before.map((item) => [key(item), item]))
    return after.filter((item) => !prior.has(key(item)) || !same(prior.get(key(item)), item))
  }
  const retired = <T>(before: readonly T[], after: readonly T[], key: (item: T) => string): string[] => {
    const present = new Set(after.map(key))
    return before.map(key).filter((id) => !present.has(id)).sort()
  }
  if (previous && previous.nodes.some((item) => !current.nodes.some((row) => row.state.workflowNodeId === item.state.workflowNodeId))) return fail()
  return PublicGraphDeltaSchema.parse({
    ...(!previous || !same(previous.run, current.run) ? { run: current.run } : {}),
    nodes: changed(previous?.nodes ?? [], current.nodes, (item) => item.state.workflowNodeId),
    inputBindings: changed(previous?.inputBindings ?? [], current.inputBindings, (item) => item.bindingId),
    interactions: changed(previous?.interactions ?? [], current.interactions, (item) => item.interactionId),
    reviews: changed(previous?.reviews ?? [], current.reviews, (item) => item.reviewJobId),
    retiredInputBindingIds: retired(previous?.inputBindings ?? [], current.inputBindings, (item) => item.bindingId),
    retiredInteractionIds: retired(previous?.interactions ?? [], current.interactions, (item) => item.interactionId),
    retiredReviewIds: retired(previous?.reviews ?? [], current.reviews, (item) => item.reviewJobId),
  })
}
async function stored(sql: GraphTransactionSql, scope: RunGraphScope) {
  const row = (await sql.query<{ record: unknown; source_digest: string; semantic_digest: string; sequence: string;
    proof_sequence: string | null; proof_source_digest: string | null; proof_semantic_digest: string | null }>(`
    select p.record,p.source_digest,p.semantic_digest,p.sequence::text,
      s.first_sequence::text as proof_sequence,s.source_digest as proof_source_digest,
      s.semantic_digest as proof_semantic_digest
    from run_graph_public_projection p left join run_graph_sources s on s.run_id=p.run_id
      and s.source_kind='run' and s.source_id=$2 and s.source_revision=p.sequence
    where p.run_id=$1`, [scope.runId, sourceId(scope.runId)])).rows[0]
  if (!row) return undefined
  const projection = PublicGraphProjectionSchema.parse(row.record)
  if (graphSourceDigest({ scope, projection }) !== row.source_digest) return fail()
  if (row.proof_sequence !== row.sequence || row.proof_source_digest !== row.source_digest
    || row.proof_semantic_digest !== row.semantic_digest) return fail()
  return { ...row, projection }
}

/** Called BEFORE any producer mutation, under the same Run/head lock. A later
 * writer cannot "heal" an unjournaled/corrupt public domain cut by adopting it. */
export async function assertPublicProjectionCommittedLocked(sql: GraphTransactionSql, scope: RunGraphScope,
  head: string, readPublicProjection: PublicProjectionReader, actual?: PublicGraphProjection): Promise<void> {
  assertGraphTransaction(sql)
  const prior = await stored(sql, scope)
  if (!prior || BigInt(GraphSequenceSchema.parse(prior.sequence)) < 1n || BigInt(prior.sequence) > BigInt(GraphSequenceSchema.parse(head))
    || !same(prior.projection, actual ?? await readPublicProjection(sql, scope))) return fail()
}

/** Called once by G1, after all SQL producers and before the batch is finalized.
 * Compare canonical values, not elapsed time or presence/absence of a process. */
export async function capturePublicProjectionLocked(sql: GraphTransactionSql,
  scope: RunGraphScope, readPublicProjection: PublicProjectionReader): Promise<PublicProjectionReceipt | undefined> {
  assertGraphTransaction(sql)
  const head = (await sql.query<{ sequence: string }>(
    'select head_sequence::text as sequence from run_graph_heads where run_id=$1', [scope.runId])).rows[0]
  if (!head) return fail()
  const cursor = BigInt(GraphSequenceSchema.parse(head.sequence))
  const prior = await stored(sql, scope)
  if (!prior && cursor !== 0n) return fail()
  const projection = await readPublicProjection(sql, scope)
  if (prior && same(prior.projection, projection)) return undefined
  const delta = publicProjectionDelta(prior?.projection, projection)
  const evidence = { sourceKind: 'run' as const, sourceId: sourceId(scope.runId), sourceRevision: GraphSequenceSchema.parse(String(cursor + 1n)) }
  const fact = { type: 'workflow.presentation' as const, delta }
  const sourceDigest = graphSourceDigest({ scope, projection }), semanticDigest = graphSourceDigest([fact])
  await sql.query(`insert into run_graph_public_projection(run_id,sequence,record,source_digest,semantic_digest,source_id)
    values($1,$2::bigint,$3::jsonb,$4,$5,$6) on conflict(run_id) do update set
      sequence=excluded.sequence,record=excluded.record,source_digest=excluded.source_digest,semantic_digest=excluded.semantic_digest,source_id=excluded.source_id`,
    [scope.runId, evidence.sourceRevision, canonicalGraphJson(projection), sourceDigest, semanticDigest, evidence.sourceId])
  return { projection, evidence, sourceDigest, semanticDigest, fact }
}
export async function assertPublicProjectionUnchangedLocked(sql: GraphTransactionSql, scope: RunGraphScope,
  receipt: PublicProjectionReceipt, readPublicProjection: PublicProjectionReader): Promise<void> {
  const current = await readPublicProjection(sql, scope)
  if (!same(receipt.projection, current)) return fail()
  await assertPublicProjectionCommittedLocked(sql, scope, receipt.evidence.sourceRevision, readPublicProjection, current)
}
