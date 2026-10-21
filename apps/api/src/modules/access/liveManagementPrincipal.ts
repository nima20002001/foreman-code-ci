import { isReadOnlyGraphTransaction, type GraphSqlClient } from '../run-graph/connection.js'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { intersectGrants } from './operatorDelegation.js'
import { authorizationReadSnapshot, snapshotPrincipal } from './authorizationReadSnapshot.js'

interface LivePrincipalRow {
  id: string
  name: string
  audience: string
  grants: unknown
  expires_at: Date
  revoked_at: Date | null
  delegated_from: string | null
}

/** Reuse the caller's connection and revalidate delegation rather than persisting authority. */
export async function readLiveManagementPrincipal(client: GraphSqlClient, principalId: string): Promise<ManagementPrincipal> {
  const seen = new Set<string>()
  let id: string | null = principalId
  let subject: ManagementPrincipal | undefined
  const lock = isReadOnlyGraphTransaction(client) ? '' : ' for share'
  const snapshot = await authorizationReadSnapshot(client)
  while (id) {
    if (seen.has(id) || seen.size >= 16) throw new DomainError('AUTH_INVALID', 'The delegated authority chain is invalid.', 403)
    seen.add(id)
    const row: LivePrincipalRow | undefined = snapshot ? snapshotPrincipal(snapshot, id) : (await client.query<LivePrincipalRow>(
      `select id,name,audience,grants,expires_at,revoked_at,delegated_from from management_principals where id=$1${lock}`, [id],
    )).rows[0]
    if (!row || row.audience !== 'operator' || row.revoked_at || row.expires_at.getTime() <= Date.now()) {
      throw new DomainError('AUTH_REVOKED', 'The management authority or its owner is no longer active.', 403)
    }
    const principal = ManagementPrincipalSchema.parse({id:row.id,name:row.name,audience:row.audience,grants:row.grants,
      expiresAt:row.expires_at.toISOString(),revokedAt:null})
    if (!subject) subject = principal
    else subject = {...subject, grants:intersectGrants(subject.grants,principal.grants),
      expiresAt:new Date(Math.min(Date.parse(subject.expiresAt),Date.parse(principal.expiresAt))).toISOString()}
    id = row.delegated_from
  }
  if (!subject) throw new DomainError('AUTH_INVALID', 'The management authority was not found.', 403)
  return subject
}
