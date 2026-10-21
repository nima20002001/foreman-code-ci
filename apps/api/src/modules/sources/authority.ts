import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceAction } from '@foreman-code/contracts/source-admission'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { authorizationReadSnapshot } from '../access/authorizationReadSnapshot.js'

/** The authenticated caller's accepted grants are a ceiling, even if its owner
 * later gets broader grants. Existing live delegation validation holds the chain.
 */
export async function authorizeSource(sql: GraphSqlClient, principal: ManagementPrincipal,
  action: SourceAction, workspaceId: string): Promise<{ principal: ManagementPrincipal; ownerId: string }> {
  requireAuthorization(principal, action, { workspaceId })
  const live = await readLiveManagementPrincipal(sql, principal.id)
  requireAuthorization(live, action, { workspaceId })
  const snapshot = await authorizationReadSnapshot(sql)
  const owner = snapshot ? snapshot.principals.find(row => row.delegated_from === null)
    : (await sql.query<{ id: string }>(`with recursive owners as (
    select id,delegated_from,1 as depth from management_principals where id=$1
    union all select p.id,p.delegated_from,o.depth+1 from management_principals p join owners o on p.id=o.delegated_from where o.depth<16
  ) select id from owners where delegated_from is null`, [principal.id])).rows[0]
  if (!owner) throw new DomainError('AUTH_INVALID', 'The source authority has no current root owner.', 403)
  return { principal: live, ownerId: owner.id }
}
