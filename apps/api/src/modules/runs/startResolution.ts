import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunStartV3InputSchema, canonicalGraphJson, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '../commands/postgres.js'
import { withExclusiveGraphConnection } from '../run-graph/connection.js'
import { readStartReceipt } from './repeatStartAdmission.js'
import { authorizeRunStart, lockRunStartCommand } from './startCommand.js'

/** The command lock closes absence atomically with respect to every Start submission. */
export async function resolveRunStart(pool: pg.Pool, principal: ManagementPrincipal,
  source: 'http' | 'mcp', raw: RunStartV3Input) {
  const input = RunStartV3InputSchema.parse(raw)
  authorizeRunStart(principal, input)
  const hash = commandInputHash(input)
  const target = `workflow:${input.workflowId}:version:${input.workflowVersionId}`
  return withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
    await lockRunStartCommand(sql, principal, input)
    const receipt = await readStartReceipt(sql, principal.id, input, hash, target)
    if (receipt) return 'status' in receipt ? receipt : { status: 'accepted' as const, run: receipt }
    const canceled = { status: 'canceled' as const }
    await sql.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
      values($1,'run.start',$2,$3,$4,$5::jsonb)`,
    [principal.id, input.commandId, target, hash, canonicalGraphJson(canceled)])
    await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'run.start.resolve',$3,'succeeded',$4::jsonb)`,
    [principal.id, source, target, JSON.stringify({ commandId: input.commandId, status: canceled.status })])
    return canceled
  }))
}
