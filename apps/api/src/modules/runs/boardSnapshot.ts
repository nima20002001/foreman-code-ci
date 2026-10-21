import { RunBoardSnapshotSchema, RunDropdownTriggerSchema, type RunDropdownTrigger } from '@foreman-code/contracts/run-snapshots'
import type { AcceptedRepeatStartV1 } from '@foreman-code/contracts/wave25'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { projectRunBoardSnapshot } from './boardSnapshotProjection.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'

/** Called after runs INSERT on the SAME common Start transaction, before any
 * canonical publication or dispatch. It has no upsert/rebuild/repair path.
 * A duplicate or invalid capture aborts admission rather than changing history.
 * Scheduled admission must supply 'schedule' here through insertRepeatRun. */
export async function insertRunBoardSnapshot(sql: GraphTransactionSql, accepted: AcceptedRepeatStartV1,
  trigger: RunDropdownTrigger, providerAccountBindings?: Record<string, AcceptedProviderAccountBinding>): Promise<void> {
  assertGraphTransaction(sql)
  const snapshot = RunBoardSnapshotSchema.parse({ ...projectRunBoardSnapshot(accepted),
    ...(providerAccountBindings ? { providerAccountBindings } : {}) })
  if (snapshot.kind !== 'available') throw new DomainError('RUN_SNAPSHOT_PIN_CONFLICT', 'Admission requires a board capture.', 409)
  await sql.query(`insert into run_board_snapshots
    (run_id, workspace_id, workflow_id, workflow_version_id, captured_at, admission_trigger, record)
    values ($1,$2,$3,$4,$5::timestamptz,$6,$7::jsonb)`,
  [snapshot.runId, snapshot.workspaceId, snapshot.workflowId, snapshot.workflowVersionId,
    snapshot.capturedAt, RunDropdownTriggerSchema.parse(trigger), canonicalGraphJson(snapshot)])
}
