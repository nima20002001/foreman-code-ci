import type pg from 'pg'
import {
  ManagementPrincipalSchema,
  type ManagementAction,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'

import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'

export interface AuthorizedResource {
  workspaceId?: string
  workflowId?: string
  runId?: string
  mainId?: string
  deviceId?: string
  applicationInstallationId?: string
  providerAccountId?: string
}

// Scope arrays belong to immutable authorization snapshots.
const scopeIds = new WeakMap<string[], ReadonlySet<string>>()

function includesOrUnscoped(values: string[] | undefined, value: string | undefined): boolean {
  if (!values) return true
  if (value === undefined) return false
  let ids = scopeIds.get(values)
  if (!ids) {
    ids = new Set(values)
    scopeIds.set(values, ids)
  }
  return ids.has(value)
}

const validatedPrincipals = new WeakSet<ManagementPrincipal>()

/** Reuse validation only for an immutable snapshot; mutable callers are parsed afresh. */
export function authorizationPrincipal(input: ManagementPrincipal): ManagementPrincipal {
  if (validatedPrincipals.has(input)) return input
  const principal = ManagementPrincipalSchema.parse(input)
  for (const grant of principal.grants) {
    Object.freeze(grant.actions)
    for (const ids of Object.values(grant.scope)) Object.freeze(ids)
    Object.freeze(grant.scope)
    Object.freeze(grant)
  }
  Object.freeze(principal.grants)
  Object.freeze(principal)
  validatedPrincipals.add(principal)
  return principal
}

export function isAuthorized(
  input: ManagementPrincipal,
  action: ManagementAction,
  resource: AuthorizedResource = {},
  now = new Date(),
): boolean {
  // Worker/App principals are intentionally outside the Operator management policy.
  if (input.audience !== 'operator') return false
  const principal = authorizationPrincipal(input)
  if (principal.audience !== 'operator' || principal.revokedAt || Date.parse(principal.expiresAt) <= now.getTime()) return false
  return principal.grants.some((grant) => grant.actions.includes(action)
    && includesOrUnscoped(grant.scope.workspaceIds, resource.workspaceId)
    && includesOrUnscoped(grant.scope.workflowIds, resource.workflowId)
    && includesOrUnscoped(grant.scope.runIds, resource.runId)
    && includesOrUnscoped(grant.scope.mainIds, resource.mainId)
    && includesOrUnscoped(grant.scope.deviceIds, resource.deviceId)
    && includesOrUnscoped(grant.scope.applicationInstallationIds, resource.applicationInstallationId)
    && includesOrUnscoped(grant.scope.providerAccountIds, resource.providerAccountId))
}

export function hasAction(principal: ManagementPrincipal, action: ManagementAction): boolean {
  if (principal.audience !== 'operator') return false
  const parsed = authorizationPrincipal(principal)
  return parsed.audience === 'operator' && !parsed.revokedAt && Date.parse(parsed.expiresAt) > Date.now()
    && parsed.grants.some((grant) => grant.actions.includes(action))
}

export function requireAuthorization(
  principal: ManagementPrincipal,
  action: ManagementAction,
  resource: AuthorizedResource = {},
): void {
  if (!isAuthorized(principal, action, resource)) {
    throw new DomainError('ACCESS_DENIED', 'The caller is not authorized for this operation and resource.', 403)
  }
}

interface AccountAccessRow {
  id: string
  name: string
  audience: string
  grants: unknown
  expires_at: Date
  revoked_at: Date | null
  delegated_from: string | null
}

/** Account target restrictions apply to every live delegation link. */
export async function requireLiveAccountAuthorization(sql: GraphSqlClient, principalId: string,
  action: 'provider_accounts:read' | 'provider_accounts:manage', resource: AuthorizedResource): Promise<void> {
  const seen = new Set<string>()
  let id: string | null = principalId
  while (id) {
    if (seen.has(id) || seen.size >= 16) throw new DomainError('AUTH_INVALID', 'The delegation chain is invalid.', 403)
    seen.add(id)
    const result: pg.QueryResult<AccountAccessRow> = await sql.query<AccountAccessRow>(
      'select id,name,audience,grants,expires_at,revoked_at,delegated_from from management_principals where id=$1 for share',
      [id])
    const row: AccountAccessRow | undefined = result.rows[0]
    if (!row) throw new DomainError('AUTH_REVOKED', 'The account authority is unavailable.', 403)
    const principal = ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: row.audience,
      grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null })
    requireAuthorization(principal, 'provider_accounts:read', resource)
    requireAuthorization(principal, action, resource)
    id = row.delegated_from
  }
}
