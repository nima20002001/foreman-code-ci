import { readPublicProjectionLocked } from './compactSnapshot.js'
import {
  AcceptedRepeatStartV1Schema, canonicalGraphJson, RepeatGraphScopeV3Schema,
  type RepeatGraphScopeV3, type AcceptedRepeatStartV1,
} from '@foreman-code/contracts/wave25'
import type { RepeatStartPublication } from '../runs/repeatStartAdmission.js'
import { assertGraphTransaction, poisonGraphTransaction, type GraphTransactionSql } from './connection.js'
import { openRunGraphPublication, type RunGraphPublication } from './publication.js'
import { readRepeatGraphPinsLocked } from './repeatProjectionRows.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from './repeatReceipts.js'
import { RunGraphError } from './errors.js'

/** Concrete NATIVE-3 producer. Admission inserts the Run before calling us and
 * owns live grants, immutable Start command/authority receipts and dispatch.
 * No bootstrap from an old Run, owner substitute, child activation or scheduler.
 */
export const repeatStartPublication: RepeatStartPublication = Object.freeze({
  async initializeLocked(sql: GraphTransactionSql, raw: AcceptedRepeatStartV1) {
    assertGraphTransaction(sql)
    try {
      const accepted = AcceptedRepeatStartV1Schema.parse(JSON.parse(canonicalGraphJson(raw)))
      const { run } = accepted
      const scope = RepeatGraphScopeV3Schema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
        workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 })
      // Run before head/children, same lock mode as canonical G1. A preexisting
      // head is never silently relabelled from_snapshot to from_admission.
      await sql.query('select id from runs where id=$1 for no key update', [run.id])
      if ((await sql.query('select run_id from run_graph_heads where run_id=$1', [run.id])).rowCount !== 0) {
        throw new RunGraphError('GRAPH_SOURCE_CONFLICT')
      }
      const pins = await readRepeatGraphPinsLocked(sql, scope)
      const byId = <T extends { id: string }>(items: T[]) => [...items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      if (canonicalGraphJson(pins.run) !== canonicalGraphJson(run)
        || canonicalGraphJson(pins.version) !== canonicalGraphJson(accepted.snapshot.executable.version)
        || canonicalGraphJson(byId(pins.configurations)) !== canonicalGraphJson(byId(accepted.snapshot.executable.configurations))) {
        throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      }
      const publication = await openRunGraphPublication(sql, scope, readPublicProjectionLocked, { historyCoverage: 'from_admission' })
      const receipt = await publication.repeatInsertedRunReadback(run)
      requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, evidence: receipt.evidence,
        sourceDigest: receipt.sourceDigest, semanticDigest: receipt.semanticDigest, effect: null })
      return { semanticDigest: receipt.semanticDigest }
    } catch (error) {
      poisonGraphTransaction(sql)
      throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
    }
  },
})

/** Enlist only the current SQL Stop after the existing authorized Stop writer.
 * Existing head required; no Run ownership is forged and no effect can progress.
 * Caller must obtain this publication FIRST, before its Run/child mutations.
 */
export async function publishRepeatStoppedRunLocked(publication: RunGraphPublication<RepeatGraphScopeV3>): Promise<void> {
  const { sql, scope } = publication
  try {
    assertGraphTransaction(sql)
    await readRepeatGraphPinsLocked(sql, scope)
    const receipt = await publication.repeatStoppedRunReadback()
    requireRepeatCanonicalReceiptBeforeCommit(sql, { scope, evidence: receipt.evidence,
      sourceDigest: receipt.sourceDigest, semanticDigest: receipt.semanticDigest, effect: null })
  } catch (error) {
    poisonGraphTransaction(sql)
    throw error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
  }
}
