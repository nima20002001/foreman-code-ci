import type { GraphTransactionSql } from '../run-graph/connection.js'
import { graphSourceDigest } from '../run-graph/graphDigest.js'
import { assertRepeatCanonicalReceiptsLocked, requireRepeatCanonicalReceiptBeforeCommit } from '../run-graph/repeatReceipts.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'

/** Transcript sources attach to the committed head without changing the graph or its public projection. */
export async function retainNativeTranscriptSources(sql: GraphTransactionSql,
  records: readonly WorkflowNativeProofRecord[]) {
  const scope = records[0]!.scope
  const receipts = records.map(record => {
    const evidence = { sourceKind: 'native_event' as const, sourceId: record.proofId, sourceRevision: '1' }
    return { scope, evidence, sourceDigest: graphSourceDigest(record),
      semanticDigest: graphSourceDigest({ evidence, facts: [], effect: null }), effect: null }
  })
  await sql.query(`insert into run_graph_sources
    (run_id,source_kind,source_id,source_revision,source_digest,semantic_digest,first_sequence)
    select h.run_id,'native_event',p.source_id,1,p.source_digest,p.semantic_digest,h.head_sequence
    from run_graph_heads h cross join jsonb_to_recordset($2::jsonb)
      as p(source_id text,source_digest text,semantic_digest text)
    where h.run_id=$1 and h.protocol_version=1 and h.head_sequence>0
    on conflict(run_id,source_kind,source_id,source_revision) do nothing`,
  [scope.runId, JSON.stringify(receipts.map(receipt => ({ source_id: receipt.evidence.sourceId,
    source_digest: receipt.sourceDigest, semantic_digest: receipt.semanticDigest })))])
  await assertRepeatCanonicalReceiptsLocked(sql, receipts)
  for (const receipt of receipts) requireRepeatCanonicalReceiptBeforeCommit(sql, receipt)
}
