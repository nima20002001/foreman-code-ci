import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'

interface CommandIdentity {
  key: string
  runId?: string
  workActivationId?: string | null
  slotId?: string | null
}

export async function commandIdentity(sql: GraphSqlClient, principal: ManagementPrincipal): Promise<CommandIdentity> {
  if (principal.audience !== 'worker') return { key: principal.id }
  const row = (await sql.query<{ run_id: string; work_activation_id: string | null; slot_id: string | null }>(`
    select e.run_id,e.work_activation_id,x.slot_id
    from worker_credential_bindings b join harness_executions e on e.id=b.execution_id
    left join run_repeat_executions x on x.execution_id=e.id
    where b.principal_id=$1`, [principal.id])).rows[0]
  if (!row || !row.work_activation_id && !row.slot_id) return { key: principal.id }
  const kind = row.work_activation_id ? 'activation' : 'slot'
  return { key: JSON.stringify([row.run_id, kind, row.work_activation_id ?? row.slot_id]),
    runId: row.run_id, workActivationId: row.work_activation_id, slotId: row.slot_id }
}

export async function commandReceiptPrincipals(
  sql: GraphSqlClient, identity: CommandIdentity, principalId: string,
): Promise<string[]> {
  if (!identity.runId) return [principalId]
  // Retain the issuing principal on receipts and audits, while replacement credentials share their effects.
  const peers = await sql.query<{ principal_id: string }>(`
    select b.principal_id from worker_credential_bindings b
    join harness_executions e on e.id=b.execution_id
    left join run_repeat_executions x on x.execution_id=e.id
    where e.run_id=$1 and (e.work_activation_id=$2
      or $2::text is null and e.work_activation_id is null and x.slot_id=$3)`,
  [identity.runId, identity.workActivationId ?? null, identity.slotId ?? null])
  return [principalId, ...peers.rows.map(row => row.principal_id)]
}
