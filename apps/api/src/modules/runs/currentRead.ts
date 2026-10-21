import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { RetainedSourceFootprintSchema } from '@foreman-code/contracts/source-operations'
import { sourceWorkingTreePath } from '../sources/sourceTreePaths.js'
import { readRunActivitySnapshot } from './activitySnapshot.js'
import type pg from 'pg'
import { HarnessExecutionSchema, RunActivitySchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunWorktreeSchema, SavedRunDetailsSchema, REPEAT_GRAPH_LIMITS, graphJsonBytes, RUN_GRAPH_LIMITS } from '@foreman-code/contracts/wave25'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { readAcceptedRepeatRunLocked, readRecordedRepeatRunSnapshot, type AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { readRepeatExecutionsLocked } from './repeatExecutionRead.js'
import { readExecutionQueueReason } from './executionQueue.js'

const executionReadBatchSize = 16

/** Readback uses one unlocked snapshot; mutation callers retain admission locks. */
export async function withCurrentRunRead<T>(pool: pg.Pool, principal: ManagementPrincipal,
  workspaceId: string, runId: string, action: 'runs:read' | 'runs:stop',
  work: (sql: GraphTransactionSql, snapshot: AcceptedRepeatRunSnapshot, live: ManagementPrincipal) => Promise<T>,
  readAcceptedRun = action === 'runs:read' ? readRecordedRepeatRunSnapshot : readAcceptedRepeatRunLocked): Promise<T> {
  try {
    return await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      const row = (await sql.query<{ workspace_id: string; workflow_id: string }>(
        'select workspace_id,workflow_id from runs where id=$1 and workspace_id=$2', [runId, workspaceId])).rows[0]
      if (!row) throw new DomainError('RUN_NOT_FOUND', 'The Run was not found in this workspace.', 404)
      const live = await readLiveManagementPrincipal(sql, principal.id)
      requireAuthorization(live, action, { workspaceId: row.workspace_id, workflowId: row.workflow_id, runId })
      const snapshot = await readAcceptedRun(sql, runId)
      if (snapshot.run.workspaceId !== workspaceId || snapshot.run.workflowId !== row.workflow_id) {
        throw new DomainError('RUN_PIN_CONFLICT', 'The Run changed its exact scope.', 409)
      }
      return work(sql, snapshot, live)
    }, action === 'runs:read'))
  } catch (error) {
    throw action === 'runs:read' ? databaseReadFailure(error) : error
  }
}
export function readCurrentRunDetails(pool: pg.Pool, principal: ManagementPrincipal, workspaceId: string, runId: string) {
  return withCurrentRunRead(pool, principal, workspaceId, runId, 'runs:read', async (sql, snapshot, live) => {
    const { run } = snapshot
    const rows = (await sql.query<{ id: string }>(
      'select id from harness_executions where run_id=$1 order by created_at,id limit $2',
      [runId, REPEAT_GRAPH_LIMITS.executions + 1])).rows
    if (rows.length > REPEAT_GRAPH_LIMITS.executions) throw new DomainError('RUN_DETAIL_TOO_LARGE', 'Use the bounded canonical current graph for this Run.', 409)
    // Reject an oversized response before validating execution inputs and receipts.
    // Bound the temporary records retained while checking response size.
    let detailBytes = graphJsonBytes({ run, executions: [] })
    for (let offset = 0; offset < rows.length; offset += executionReadBatchSize) {
      const ids = rows.slice(offset, offset + executionReadBatchSize).map(row => row.id)
      const recorded = await sql.query<{ record: unknown }>(
        'select record from harness_executions where run_id=$1 and id=any($2::text[])', [runId, ids])
      for (const [index, row] of recorded.rows.entries()) {
        detailBytes += graphJsonBytes(HarnessExecutionSchema.parse(row.record)) + (offset + index > 0 ? 1 : 0)
        if (detailBytes > RUN_GRAPH_LIMITS.snapshotBytes) throw new DomainError(
          'RUN_DETAIL_TOO_LARGE', 'Use bounded graph metadata and activity pages for this Run.', 409)
      }
    }
    const executions = []
    const stored = await readRepeatExecutionsLocked(sql, snapshot, rows.map(row => row.id))
    for (const { execution } of stored) {
      const queueReason = readExecutionQueueReason(execution)
      executions.push(queueReason ? { ...execution, queueReason } : execution)
    }
    const activityRows = (await sql.query<{ sequence: string; source: string; kind: string; harness_execution_id: string | null;
      occurred_at: Date; payload: Record<string, unknown> }>(
      `select sequence::text,source,kind,harness_execution_id,occurred_at,payload from run_activity
       where run_id=$1 order by run_activity.sequence desc limit 101`, [runId])).rows
    const activity = activityRows.slice(0, 100).reverse().map((row) => RunActivitySchema.parse({
      id: `activity-${runId}-${row.sequence}`, runId, sequence: Number(row.sequence), source: row.source, kind: row.kind,
      ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}),
      occurredAt: row.occurred_at.toISOString(), payload: row.payload,
    }))
    const cleanup = (await sql.query<{ pending: boolean }>(
      'select exists(select 1 from run_cleanup_intents where run_id=$1 and pending) as pending', [runId])).rows[0]
    if (!cleanup || typeof cleanup.pending !== 'boolean') throw new DomainError('RUN_DETAIL_INVALID', 'Cleanup status is unavailable.', 409)
    const activitySnapshot = await readRunActivitySnapshot(sql,
      { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: run.workflowVersionId }, snapshot.version)
    const treeRows = await sql.query<{ record: unknown }>('select record from run_worktrees where run_id=$1', [run.id])
    const worktrees = treeRows.rows.map(row => RunWorktreeSchema.parse(row.record))
    const sourceTrees = await sql.query<{ execution_id: string; worktree_cleanup: unknown; record: unknown }>(
      `select m.execution_id,m.record,m.worktree_cleanup from source_execution_materializations m
        join harness_executions e on e.id=m.execution_id
        where e.run_id=$1 and m.record#>'{receipt,worktree}' is not null`, [run.id])
    for (const source of sourceTrees.rows) {
      const execution = executions.find(item => item.id === source.execution_id)
      const record = SourceMaterializationRecordSchema.parse(source.record)
      const tree = record.receipt.worktree
      const cleanup = RetainedSourceFootprintSchema.shape.worktree.parse(source.worktree_cleanup ?? undefined)
      if (tree) worktrees.push(RunWorktreeSchema.parse({
        executionId: source.execution_id,
        workingDirectory: execution?.workingDirectory ?? sourceWorkingTreePath(record.receipt),
        branch: tree.branch,
        baseCommit: tree.startCommit ?? tree.commit,
        state: cleanup?.state ?? 'active',
        ...(cleanup?.message ? { message: cleanup.message } : {}),
      }))
    }
    const detail = { run, ...(worktrees.length ? { worktrees } : {}), executions, activity, activitySnapshot, activityPageInfo: { hasEarlier: activityRows.length > 100 }, cleanupPending: cleanup.pending }
    if (graphJsonBytes(detail) > RUN_GRAPH_LIMITS.snapshotBytes) throw new DomainError('RUN_DETAIL_TOO_LARGE', 'Use bounded graph metadata and activity pages for this Run.', 409)
    const parsed = SavedRunDetailsSchema.parse(detail)
    // Redaction uses the live grants in this same snapshot, not the possibly
    // older principal snapshot captured by the transport before a grant change.
    delete parsed.run.authorizationPrincipalId
    if (!isAuthorized(live, 'workspace_locations:read', { workspaceId })) {
      delete parsed.run.executionLocation
      delete parsed.worktrees
      for (const execution of parsed.executions) {
        delete execution.workingDirectory
        delete execution.runtimeDirectory
      }
    }
    return parsed
  })
}
