import { randomBytes, randomUUID } from 'node:crypto'
import { ManagementPrincipalSchema, NON_EXPIRING_CREDENTIAL_TIMESTAMP, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { intersectGrants } from './operatorDelegation.js'
import { authorizationReadSnapshot, snapshotPrincipal } from './authorizationReadSnapshot.js'

type Database = GraphSqlClient
interface Row {
  id: string; name: string; audience: string; grants: unknown; expires_at: Date
  revoked_at: Date | null; delegated_from: string | null
}
interface Binding {
  owner_principal_id: string; grant_ceiling: unknown; accepted_expires_at: Date
  execution_state: string; cleanup_pending: boolean
}
function principal(row: Row | undefined, options: { checkExpiry: boolean } = { checkExpiry: true }): ManagementPrincipal {
  if (!row || row.audience !== 'operator') throw new DomainError('AUTH_INVALID', 'The owning Operator authority is unavailable.', 401)
  if (row.revoked_at) throw new DomainError('AUTH_REVOKED', 'The owning Operator authority was revoked.', 401)
  if (options.checkExpiry && (!Number.isFinite(row.expires_at.getTime()) || row.expires_at.getTime() <= Date.now())) {
    throw new DomainError('AUTH_EXPIRED', 'The owning Operator authority expired.', 401)
  }
  return ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: 'operator',
    grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: null })
}
async function row(database: Database, id: string): Promise<Row | undefined> {
  const snapshot = await authorizationReadSnapshot(database)
  if (snapshot) return snapshotPrincipal(snapshot, id)
  return (await database.query<Row>(`select id,name,audience,grants,expires_at,revoked_at,delegated_from
    from management_principals where id=$1`, [id])).rows[0]
}

/** Only root human authority or a tokenless, Run-bound snapshot is durable authority. */
/** `atCommit` rechecks a transaction that may itself be the Run's terminal
 * transition. It keeps revocation and grant checks but tolerates the Run
 * completion and cleanup intent written by that same COMMIT. */
export async function currentOperatorAuthority(database: Database, id: string, atCommit = false): Promise<{
  principal: ManagementPrincipal; owner: ManagementPrincipal
}> {
  const stored = await row(database, id)
  const accepted = principal(stored)
  if (!stored!.delegated_from) return { principal: accepted, owner: accepted }
  const snapshot = await authorizationReadSnapshot(database)
  const found = snapshot ? undefined : await database.query<Binding>(`select b.owner_principal_id,b.grant_ceiling,b.accepted_expires_at,r.execution_state,
    exists(select 1 from run_cleanup_intents cleanup where cleanup.run_id=r.id and cleanup.pending) as cleanup_pending
    from run_authority_principals b join runs r on r.id=b.run_id
    where b.principal_id=$1 and r.record->>'authorizationPrincipalId'=b.principal_id`, [id])
  const storedBinding = snapshot?.run_authority
  const binding = snapshot ? storedBinding && { ...storedBinding,
    accepted_expires_at: typeof storedBinding.accepted_expires_at === 'string'
      ? new Date(storedBinding.accepted_expires_at) : storedBinding.accepted_expires_at,
  } : found!.rows[0]
  if (!binding || binding.owner_principal_id !== stored!.delegated_from) {
    throw new DomainError('AUTH_INVALID', 'A temporary chat credential is not durable Run authority.', 401)
  }
  if (!atCommit && (binding.execution_state === 'completed' || binding.cleanup_pending)) {
    throw new DomainError('AUTH_RUN_ENDED', 'The accepted Run authority cannot act after Stop or terminal completion.', 401)
  }
  const ownerRow = await row(database, binding.owner_principal_id)
  const owner = principal(ownerRow, { checkExpiry: false })
  if (ownerRow!.delegated_from) throw new DomainError('AUTH_INVALID', 'Run authority must have a root human owner.', 401)
  const ceiling = ManagementPrincipalSchema.shape.grants.parse(binding.grant_ceiling)
  accepted.grants = intersectGrants(intersectGrants(accepted.grants, ceiling), owner.grants)
  accepted.expiresAt = new Date(Math.min(Date.parse(accepted.expiresAt),
    binding.accepted_expires_at.getTime())).toISOString()
  if (Date.parse(accepted.expiresAt) <= Date.now()) throw new DomainError('AUTH_EXPIRED', 'The accepted Run authority expired.', 401)
  return { principal: accepted, owner }
}

export interface AcceptedRunAuthority {
  principal: ManagementPrincipal
  ownerId: string
  callerId: string
}

/** Called inside run.start's command transaction. No bearer token is created or returned. */
export async function acceptRunAuthority(
  client: TransactionSql, caller: ManagementPrincipal,
): Promise<AcceptedRunAuthority> {
  const initial = await row(client, caller.id)
  principal(initial)
  const parentId = initial!.delegated_from ?? caller.id
  const initialParent = await currentOperatorAuthority(client, parentId)
  const ids = [...new Set([caller.id, parentId, initialParent.owner.id])].sort()
  await client.query('select id from management_principals where id=any($1::text[]) order by id for share', [ids])
  const liveRow = await row(client, caller.id)
  const live = principal(liveRow)
  if ((liveRow!.delegated_from ?? caller.id) !== parentId) throw new DomainError('AUTH_INVALID', 'The caller authority changed during Run admission.', 401)
  const parent = await currentOperatorAuthority(client, parentId)
  if (parent.owner.id !== initialParent.owner.id) throw new DomainError('AUTH_INVALID', 'The root Run owner changed.', 401)
  const grants = intersectGrants(intersectGrants(caller.grants, live.grants), parent.principal.grants)
  const expiresAt = NON_EXPIRING_CREDENTIAL_TIMESTAMP
  const accepted = ManagementPrincipalSchema.parse({ id: `run-authority-${randomUUID()}`,
    name: `Run authority accepted by ${caller.id}`, audience: 'operator', grants, expiresAt, revokedAt: null })
  await client.query(`insert into management_principals
    (id,name,audience,token_hash,grants,expires_at,delegated_from)
    values($1,$2,'operator',$3,$4::jsonb,$5,$6)`,
  [accepted.id, accepted.name, randomBytes(32).toString('hex'), JSON.stringify(accepted.grants), expiresAt, parent.owner.id])
  return { principal: accepted, ownerId: parent.owner.id, callerId: caller.id }
}

export async function bindRunAuthority(client: TransactionSql, runId: string, accepted: AcceptedRunAuthority): Promise<void> {
  await client.query(`insert into run_authority_principals
    (principal_id,run_id,owner_principal_id,caller_principal_id,grant_ceiling,accepted_expires_at)
    values($1,$2,$3,$4,$5::jsonb,$6)`, [accepted.principal.id, runId, accepted.ownerId, accepted.callerId,
    JSON.stringify(accepted.principal.grants), accepted.principal.expiresAt])
}
