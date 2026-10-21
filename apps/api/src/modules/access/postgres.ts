import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import {
  ManagementGrantSchema,
  NON_EXPIRING_CREDENTIAL_TIMESTAMP,
  ManagementPrincipalSchema,
  type ManagementAudience,
  type ManagementGrant,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import { requireActiveWorkerBinding } from './workerLifecycle.js'
import { intersectGrants } from './operatorDelegation.js'
import { operatorChatGrants } from './operatorChatDelegation.js'
import { currentOperatorAuthority } from './runAuthority.js'
import { requireAuthorization } from './policy.js'

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function sameDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex')
  const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

interface PrincipalRow {
  id: string
  name: string
  audience: ManagementAudience
  agent_id: string | null
  token_hash: string | null
  grants: unknown
  expires_at: Date
  revoked_at: Date | null
  delegated_from?: string | null
}

function fromRow(row: PrincipalRow): ManagementPrincipal {
  // Migration 100 intentionally cannot infer Agent subjects for old credentials.
  // Deny them explicitly; an operator must issue a replacement with a real subject.
  if (row.audience === 'worker' && !row.agent_id?.trim()) {
    throw new DomainError('AUTH_WORKER_SUBJECT_REQUIRED', 'This legacy worker credential has no Agent subject. Reissue it for the actual Agent.', 401)
  }
  return ManagementPrincipalSchema.parse({
    id: row.id,
    name: row.name,
    audience: row.audience,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    grants: row.grants,
    expiresAt: row.expires_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  })
}

export class PostgresAccessService {
  constructor(private readonly pool: pg.Pool) {}

  /** A list accepts any of those audiences; the unified MCP endpoint resolves the caller's role afterwards. */
  async authenticate(token: string | undefined, audience: ManagementAudience | readonly ManagementAudience[] = 'operator'): Promise<ManagementPrincipal> {
    const audiences: readonly ManagementAudience[] = typeof audience === 'string' ? [audience] : audience
    if (!token) throw new DomainError('AUTH_REQUIRED', 'A bearer credential is required.', 401)
    const tokenHash = digest(token)
    const result = await this.pool.query<PrincipalRow>(
      `select id, name, audience, agent_id, token_hash, grants, expires_at, revoked_at, delegated_from
       from management_principals where token_hash = $1`,
      [tokenHash],
    )
    const row = result.rows[0]
    if (!row?.token_hash || !sameDigest(row.token_hash, tokenHash)) {
      throw new DomainError('AUTH_INVALID', 'The supplied credential is invalid.', 401)
    }
    if (!audiences.includes(row.audience)) throw new DomainError('AUTH_WRONG_AUDIENCE', 'The credential cannot access this endpoint.', 403)
    if (row.revoked_at) throw new DomainError('AUTH_REVOKED', 'The credential has been revoked.', 401)
    if (row.expires_at.getTime() <= Date.now()) throw new DomainError('AUTH_EXPIRED', 'The credential has expired.', 401)
    const principal = fromRow(row)
    if (row.audience === 'worker') await requireActiveWorkerBinding(this.pool, row.id)
    if (row.delegated_from) {
      const parent = await this.currentOperator(row.delegated_from)
      // A name, requested action, or arbitrary delegated token is not evidence
      // of this translation. Require the issuance-time conversation binding.
      const chat = row.audience === 'operator' ? (await this.pool.query<{
        owner_principal_id: string | null; deleted_at: Date | null; status: string | null;
      }>(`select c.owner_principal_id,c.deleted_at,c.record->>'status' as status
        from operator_chat_credentials credential join operator_conversations c on c.id=credential.conversation_id
        where credential.principal_id=$1`, [row.id])).rows[0] : undefined
      if (chat && (chat.owner_principal_id !== row.delegated_from || chat.deleted_at || chat.status !== 'open')) {
        throw new DomainError('AUTH_REVOKED', 'The delegated chat is no longer owned and open.', 401)
      }
      principal.grants = intersectGrants(principal.grants, chat ? operatorChatGrants(parent.grants) : parent.grants)
      principal.expiresAt = new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(parent.expiresAt))).toISOString()
    }
    return principal
  }

  async currentOperator(id: string): Promise<ManagementPrincipal> {
    return (await currentOperatorAuthority(this.pool, id)).principal
  }

  /** Read-only harness inspection may come from an actual active chat delegate.
   * Keep the delegate's identity and grant ceiling; Run authority remains separate. */
  async currentHarnessInspectionPrincipal(id: string, client?: pg.ClientBase): Promise<ManagementPrincipal> {
    const database = client ?? this.pool
    const stored = (await database.query<PrincipalRow>(`select id,name,audience,agent_id,token_hash,grants,expires_at,revoked_at,delegated_from
      from management_principals where id=$1`, [id])).rows[0]
    if (!stored || stored.audience !== 'operator') throw new DomainError('AUTH_INVALID', 'The inspection principal is unavailable.', 401)
    if (stored.revoked_at) throw new DomainError('AUTH_REVOKED', 'The inspection credential was revoked.', 401)
    if (stored.expires_at.getTime() <= Date.now()) throw new DomainError('AUTH_EXPIRED', 'The inspection credential expired.', 401)
    const chat = stored.delegated_from ? (await database.query<{ owner_principal_id: string | null; active: boolean | null }>(`select c.owner_principal_id,
        (c.kind='operator' and c.deleted_at is null and c.record->>'status'='open'
          and c.active_phase='submitted' and c.turn_state in ('active','blocked') and not c.cancel_requested
          and c.native_session_id is not null and t.request_id is not null and t.result is null) as active
      from operator_chat_credentials credential join operator_conversations c on c.id=credential.conversation_id
      left join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
      where credential.principal_id=$1`, [id])).rows[0] : undefined
    if (!chat) {
      // A missing/dead chat binding cannot be reinterpreted as a root credential.
      const principal = (await currentOperatorAuthority(database, id)).principal
      requireAuthorization(principal, 'harnesses:read')
      return principal
    }
    if (!chat.active) throw new DomainError('AUTH_CHAT_ENDED', 'The inspection chat no longer has an active submitted turn.', 401)
    if (!chat.owner_principal_id || chat.owner_principal_id !== stored.delegated_from) throw new DomainError(
      'AUTH_INVALID', 'The inspection credential belongs to another chat owner.', 401)
    const parent = (await currentOperatorAuthority(database, chat.owner_principal_id)).principal
    requireAuthorization(parent, 'operator_chat:read')
    requireAuthorization(parent, 'operator_chat:write')
    const principal = fromRow(stored)
    principal.grants = intersectGrants(principal.grants, operatorChatGrants(parent.grants))
    principal.expiresAt = new Date(Math.min(stored.expires_at.getTime(), Date.parse(parent.expiresAt))).toISOString()
    requireAuthorization(principal, 'harnesses:read')
    return principal
  }

  async issue(input: {
    name: string
    audience: ManagementAudience
    /** Backend-derived for worker credentials; never accepted from an MCP request. */
    agentId?: string
    grants: ManagementGrant[]
    expiresAt?: Date
  }, client?: pg.ClientBase): Promise<{ principal: ManagementPrincipal; token: string }> {
    if (!input.expiresAt && input.audience !== 'operator') {
      throw new DomainError('INVALID_EXPIRY', 'Non-Operator credentials require an expiry.', 400)
    }
    const expiresAt = input.expiresAt ?? new Date(NON_EXPIRING_CREDENTIAL_TIMESTAMP)
    if (!Number.isFinite(expiresAt.getTime())) throw new DomainError('INVALID_EXPIRY', 'Credential expiry must be in the future.', 400)
    const name = input.name.trim()
    if (!name) throw new DomainError('INVALID_PRINCIPAL_NAME', 'Credential name is required.', 400)
    const grants = input.grants.map((grant) => ManagementGrantSchema.parse(grant))
    if (input.audience === 'worker' && !input.agentId?.trim()) {
      throw new DomainError('WORKER_AGENT_REQUIRED', 'Worker credentials require a backend-issued Agent subject.', 400)
    }
    if (input.audience !== 'worker' && input.agentId) {
      throw new DomainError('OPERATOR_AGENT_FORBIDDEN', 'Operator credentials cannot impersonate a board Agent.', 400)
    }
    const id = `principal-${randomUUID()}`
    const accepted = ManagementPrincipalSchema.parse({
      id, name, audience: input.audience, ...(input.agentId ? { agentId: input.agentId } : {}),
      grants, expiresAt: expiresAt.toISOString(), revokedAt: null,
    })
    const token = `opm_${randomBytes(32).toString('base64url')}`
    const result = await (client ?? this.pool).query<PrincipalRow>(
      `insert into management_principals (id, name, audience, agent_id, token_hash, grants, expires_at)
       select $1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz where $7::timestamptz>clock_timestamp()
       returning id, name, audience, agent_id, token_hash, grants, expires_at, revoked_at`,
      [id, accepted.name, accepted.audience, accepted.agentId ?? null, digest(token), JSON.stringify(accepted.grants), expiresAt],
    )
    if (!result.rows[0]) throw new DomainError('INVALID_EXPIRY', 'Credential expiry must be in the future.', 400)
    return { principal: fromRow(result.rows[0]), token }
  }

  async revoke(principalId: string, client?: pg.ClientBase): Promise<boolean> {
    const result = await (client ?? this.pool).query(
      'update management_principals set revoked_at = coalesce(revoked_at, now()) where id = $1',
      [principalId],
    )
    return result.rowCount === 1
  }
}

export function bearerToken(value: string | undefined): string | undefined {
  const match = /^Bearer ([^\s]+)$/i.exec(value ?? '')
  return match?.[1]
}
