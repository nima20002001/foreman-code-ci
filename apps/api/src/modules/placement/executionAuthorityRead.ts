import { DispatchIntentSchema, type DispatchIntent } from '@foreman-code/contracts/node-placement'
import { RemoteOwnerReconciliationSchema } from '@foreman-code/contracts/remote-execution'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { readPlacement } from './binding.js'

interface AuthorityRow {
  dispatch: unknown
  transition: unknown | null
  placement: unknown | null
  operation_id: string
  execution_id: string
  run_id: string
  node_id: string
  binding_hash: string
  attempt_id: string
  authorization_principal_id: string
  workspace_id: string
  workflow_id: string
  execution_state: string
  stopped: boolean
  cleanup: boolean
  failed: boolean
  granted: boolean
  connection: unknown | null
  receipt: unknown | null
  receipt_present: boolean
  entered: boolean
}

/** One committed snapshot per admission check; mutating callers retain their ordered row locks. */
export async function readExecutionAuthoritySnapshot(sql: GraphSqlClient,
  intent: DispatchIntent) {
  const rows = await sql.query<AuthorityRow>(`select i.record as dispatch,i.operation_id,i.execution_id,i.run_id,
      i.node_id,i.binding_hash,i.attempt_id,t.transition,p.record as placement,
      r.record->>'authorizationPrincipalId' as authorization_principal_id,
      r.workspace_id,r.workflow_id,r.execution_state,r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup,
      exists(select 1 from approval_execution_state b where b.execution_id=e.id
        and b.failure_result is not null) as failed,
      (select count(*)=1 from execution_dispatch_owner_grants g where g.execution_id=i.execution_id
        and g.operation_id=i.operation_id and g.grant_id=$3 and g.epoch=$4 and not g.revoked) as granted,
      o.connection,a.receipt,a.operation_id is not null as receipt_present,
      (select count(*)=1 from workflow_native_entries n where n.execution_id=i.execution_id
        and n.run_id=i.run_id and n.phase='entered') as entered
    from execution_dispatch_intents i join runs r on r.id=i.run_id
    join harness_executions e on e.id=i.execution_id and e.run_id=r.id
    left join run_node_placements p on p.run_id=i.run_id and p.node_id=i.node_id
    left join lateral (select transition from remote_execution_owner_reconciliations
      where operation_id=i.operation_id order by ordinal desc limit 1) t on true
    left join remote_dispatch_origins o on o.operation_id=i.operation_id
    left join remote_execution_receipts a on a.operation_id=i.operation_id
    where i.operation_id=$1 and i.execution_id=$2`,
  [intent.operationId, intent.executionId, intent.owner.grantId, intent.owner.epoch])
  const row = rows.rows[0]
  if (!row || row.placement === null) return undefined
  const original = DispatchIntentSchema.parse(row.dispatch)
  const placement = readPlacement(row.placement)
  if (rows.rows.length !== 1 || original.operationId !== row.operation_id || original.executionId !== row.execution_id
    || original.runId !== row.run_id || original.nodeId !== row.node_id || original.bindingHash !== row.binding_hash
    || original.attemptId !== row.attempt_id || placement.runId !== original.runId || placement.nodeId !== original.nodeId
    || placement.bindingHash !== original.bindingHash || placement.mainId !== original.mainId) {
    throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'Immutable placement or dispatch evidence conflicts.', 409)
  }
  const transition = row.transition === null ? undefined : RemoteOwnerReconciliationSchema.parse(row.transition)
  const current = transition ? DispatchIntentSchema.parse({ ...original, owner: transition.nextOwner }) : original
  return { current, placement, row,
    origin: row.connection === null ? undefined : { connection: row.connection },
    stored: row.receipt_present ? { receipt: row.receipt } : undefined,
  }
}
