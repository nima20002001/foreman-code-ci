import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import {
  FileRetentionGetInputSchema, FileRetentionGetResultSchema,
  FileRetentionSaveInputSchema, FileRetentionSaveResultSchema,
  FileRetentionPreviewInputSchema, FileRetentionPreviewResultSchema,
  type FileRetentionGetResult, type FileRetentionSaveResult, type FileRetentionPreviewResult,
} from '@foreman-code/contracts/files'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'

import { isAuthorized, requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import {
  lockFileRetentionOwner, readFileRetentionPreference,
  LIVE_OWNER_TEMPORARY_FILES_SQL, PROPOSED_FILE_EXPIRY_SQL,
} from './retentionSnapshot.js'

type Source = 'http' | 'mcp'
interface OwnerRow {
  id: string; name: string; audience: string; grants: unknown; expires_at: Date
  revoked_at: Date | null; delegated_from: string | null
}

/** Grant-only discovery. Durable root-owner identity is checked again by the service on every call. */
export function fileRetentionGrantsAllow(principal: ManagementPrincipal, write = false): boolean {
  return isAuthorized(principal, 'settings:read') && (!write || isAuthorized(principal, 'settings:update'))
}

/** Per authenticated human owner; no transport or method accepts a target owner ID. */
export class FileRetentionService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  private async authorize(client: pg.PoolClient, principal: ManagementPrincipal, write: boolean): Promise<void> {
    requireAuthorization(principal, 'settings:read')
    if (write) requireAuthorization(principal, 'settings:update')
    // Follow the repo's root-human rule (runAuthority.ts), NOT a name/role supplied by a caller.
    // Never follow delegated_from: a native Operator/Run credential cannot become its human parent.
    const row = (await client.query<OwnerRow>(`select id,name,audience,grants,expires_at,revoked_at,delegated_from
      from management_principals where id=$1 for share`, [principal.id])).rows[0]
    if (!row || row.audience !== 'operator' || row.delegated_from !== null) {
      throw new DomainError('FILE_RETENTION_OWNER_REQUIRED', 'Only the human owner\'s own credential can manage file retention. Delegated Operator and Agent credentials cannot.', 403)
    }
    const live = ManagementPrincipalSchema.parse({ id: row.id, name: row.name, audience: row.audience,
      grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null })
    requireAuthorization(live, 'settings:read')
    if (write) requireAuthorization(live, 'settings:update')
  }

  private async audited<T>(principal: ManagementPrincipal, source: Source, action: string, work: () => Promise<T>): Promise<T> {
    try { return await work() } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, action, `file-retention:${principal.id}`)
      }
      throw error
    }
  }

  private async read<T>(principal: ManagementPrincipal, source: Source, action: string,
    work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.audited(principal, source, action, async () => {
      return withTransaction(this.pool, async (client) => {
        await this.authorize(client, principal, false)
        await lockFileRetentionOwner(client, principal.id)
        const result = await work(client)
        return result
      })
    })
  }

  async get(principal: ManagementPrincipal, source: Source, input: unknown = {}): Promise<FileRetentionGetResult> {
    FileRetentionGetInputSchema.parse(input)
    return this.read(principal, source, 'file_retention_get', async (client) =>
      FileRetentionGetResultSchema.parse({ preference: await readFileRetentionPreference(client, principal.id) }))
  }

  async preview(principal: ManagementPrincipal, source: Source, input: unknown): Promise<FileRetentionPreviewResult> {
    const request = FileRetentionPreviewInputSchema.parse(input)
    return this.read(principal, source, 'file_retention_preview', async (client) => {
      const preference = await readFileRetentionPreference(client, principal.id)
      const asOfUtc = await this.now(client)
      const counts = await client.query<{ n: string }>(`select count(*)::text as n from files
        where ${LIVE_OWNER_TEMPORARY_FILES_SQL} and ${PROPOSED_FILE_EXPIRY_SQL}<=$3::timestamptz`,
      [principal.id, request.durationSeconds, asOfUtc])
      return FileRetentionPreviewResultSchema.parse({ ownerPrincipalId: principal.id,
        preferenceRevision: preference.revision, durationSeconds: request.durationSeconds, asOfUtc,
        expireNowCount: Number(counts.rows[0]!.n) })
    })
  }

  async save(principal: ManagementPrincipal, source: Source, input: unknown): Promise<FileRetentionSaveResult> {
    const request = FileRetentionSaveInputSchema.parse(input)
    // Omission and explicit false mean exactly the same command. Source is not retry identity.
    const payload = { expectedRevision: request.expectedRevision, durationSeconds: request.durationSeconds,
      applyToExisting: request.applyToExisting === true }
    return this.audited(principal, source, 'file_retention_save', async () => {
      const result = await this.commands.execute({ principal, source, operation: 'file_retention_save',
        commandId: request.commandId, targetKey: `file-retention:${principal.id}`, payload,
        authorize: (client) => this.authorize(client, principal, true),
        replayResult: (value) => FileRetentionSaveResultSchema.shape.value.parse(value),
        perform: async (client) => {
          await lockFileRetentionOwner(client, principal.id)
          const current = await readFileRetentionPreference(client, principal.id)
          if (request.expectedRevision !== undefined && current.revision !== request.expectedRevision) {
            throw new DomainError('REVISION_CONFLICT', 'File retention changed. Read the current preference before saving.', 409,
              { expectedRevision: request.expectedRevision, actualRevision: current.revision })
          }
          let updatedFileCount = 0, expiredNowCount = 0
          if (payload.applyToExisting) {
            // Lock candidate rows before sampling eligibility; FOR SHARE admission can
            // otherwise hold an UPDATE past a file's original expiry deadline.
            const candidatesAt = await this.now(client)
            await client.query(`select file_id from files where owner_principal_id=$1 and scope_kind='temporary'
              and state in ('pending','ready') and expires_at>$2::timestamptz for update`,
            [principal.id, candidatesAt])
            const asOfUtc = await this.now(client)
            const changed = await client.query<{ updated: string; expired: string }>(`with changed as (
              update files set retention_duration_seconds=$2,
                expires_at=${PROPOSED_FILE_EXPIRY_SQL},
                state=case when ${PROPOSED_FILE_EXPIRY_SQL}<=$3::timestamptz then 'expired' else state end
              where ${LIVE_OWNER_TEMPORARY_FILES_SQL} returning state
            ) select count(*)::text as updated,
              count(*) filter (where state='expired')::text as expired from changed`,
            [principal.id, request.durationSeconds, asOfUtc])
            updatedFileCount = Number(changed.rows[0]!.updated)
            expiredNowCount = Number(changed.rows[0]!.expired)
          }
          await client.query(`insert into file_retention_preferences (owner_principal_id,duration_seconds,revision)
            values ($1,$2,$3) on conflict (owner_principal_id) do update
              set duration_seconds=excluded.duration_seconds,revision=excluded.revision`,
          [principal.id, request.durationSeconds, current.revision + 1])
          return FileRetentionSaveResultSchema.shape.value.parse({
            preference: await readFileRetentionPreference(client, principal.id), updatedFileCount, expiredNowCount,
          })
        },
      })
      return FileRetentionSaveResultSchema.parse(result)
    })
  }

  private async now(client: pg.PoolClient): Promise<string> {
    // transaction_timestamp/now() would predate time spent waiting for an owner lock.
    return (await client.query<{ at: Date }>('select clock_timestamp() as at')).rows[0]!.at.toISOString()
  }
}
