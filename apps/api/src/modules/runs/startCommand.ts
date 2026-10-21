import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RunStartV3Input } from '@foreman-code/contracts/wave25'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { waitForRunStartLock, type RunStartLockWait } from './startLocks.js'

export function authorizeRunStart(principal: ManagementPrincipal, input: RunStartV3Input): void {
  requireAuthorization(principal, 'runs:start', { workspaceId: input.workspaceId, workflowId: input.workflowId })
  requireAuthorization(principal, 'workspace_locations:read', { workspaceId: input.workspaceId })
}

export async function lockRunStartCommand(sql: GraphTransactionSql, principal: ManagementPrincipal,
  input: RunStartV3Input, wait?: RunStartLockWait): Promise<void> {
  await waitForRunStartLock(sql, `command:${principal.id}:run.start:${input.commandId}`, wait)
  const authorize = async () => {
    const live = await readLiveManagementPrincipal(sql, principal.id)
    authorizeRunStart(live, input)
    const expiresAt = new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(live.expiresAt))).toISOString()
    const valid = await sql.query('select 1 where clock_timestamp() < $1::timestamptz', [expiresAt])
    if (valid.rowCount !== 1) throw new DomainError('AUTH_REVOKED', 'Start authority expired before commit.', 403)
  }
  await authorize()
  beforeGraphCommit(sql, authorize)
}
