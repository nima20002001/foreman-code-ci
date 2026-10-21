import type pg from 'pg'
import { z } from 'zod'
import { BuildComputerPrepareInputSchema, BuildComputerPrepareStatusSchema, PreparedCiRuntimeSchema }
  from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { JobVerificationProfileSchema, JobVerificationProfileSaveSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { SourceRootBindInputSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceManifestSchema } from '@foreman-code/contracts/source-materialization'
import { DomainError } from '../errors.js'
import type { JobSql } from './repository.js'

export const CiPreparationRecordSchema = z.object({
  id: z.uuid(), input: BuildComputerPrepareInputSchema, principal: ManagementPrincipalSchema,
  source: z.enum(['http', 'mcp']), profile: JobVerificationProfileSchema,
  status: BuildComputerPrepareStatusSchema,
  manifest: SourceManifestSchema.optional(), prepared: PreparedCiRuntimeSchema.optional(),
  rootInput: SourceRootBindInputSchema.optional(), root: SourceRootRecordSchema.optional(),
  refreshStartedAt: z.string().datetime().optional(), refreshed: z.boolean().optional(),
  saves: z.array(z.object({ input: JobVerificationProfileSaveSchema,
    profile: JobVerificationProfileSchema.optional(), approvalId: z.string().optional(),
    qualified: JobVerificationProfileSchema.optional() }).strict()).optional(),
}).strict()
export type CiPreparationRecord = z.infer<typeof CiPreparationRecordSchema>
export interface CiPreparationRepository {
  create(sql: JobSql, record: CiPreparationRecord): Promise<void>
  get(id: string): Promise<CiPreparationRecord>
  latest(workspaceId: string, deviceId: string): Promise<CiPreparationRecord | undefined>
  latestForDevice(deviceId: string): Promise<CiPreparationRecord | undefined>
  pending(): Promise<CiPreparationRecord[]>
  save(sql: JobSql, record: CiPreparationRecord): Promise<void>
}

export class PostgresCiPreparationRepository implements CiPreparationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(sql: JobSql, record: CiPreparationRecord): Promise<void> {
    const deviceId = record.status.deviceId!
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`ci-runtime:${deviceId}`])
    const active = await sql.query('select 1 from ci_runtime_preparations where device_id=$1 and active', [deviceId])
    if (active.rows.length) {
      throw new DomainError('CI_RUNTIME_BUSY', 'This computer already has a runtime preparation. Retry this command after it finishes.', 409)
    }
    await sql.query(`insert into ci_runtime_preparations
      (id,workspace_id,device_id,principal_id,command_id,record,active) values($1,$2,$3,$4,$5,$6::jsonb,true)`,
    [record.id, record.input.workspaceId, deviceId, record.principal.id, record.input.commandId, JSON.stringify(record)])
  }

  async get(id: string): Promise<CiPreparationRecord> {
    const row = (await this.pool.query<{ record: unknown }>(
      'select record from ci_runtime_preparations where id=$1', [id])).rows[0]
    if (!row) throw new DomainError('CI_RUNTIME_PREPARATION_NOT_FOUND', 'The runtime preparation was not found.', 404)
    return CiPreparationRecordSchema.parse(row.record)
  }

  async latest(workspaceId: string, deviceId: string): Promise<CiPreparationRecord | undefined> {
    const row = (await this.pool.query<{ record: unknown }>(`select record from ci_runtime_preparations
      where workspace_id=$1 and device_id=$2 order by created_at desc,id desc limit 1`, [workspaceId, deviceId])).rows[0]
    return row ? CiPreparationRecordSchema.parse(row.record) : undefined
  }

  async pending(): Promise<CiPreparationRecord[]> {
    return (await this.pool.query<{ record: unknown }>(
      'select record from ci_runtime_preparations where active order by created_at,id')).rows
      .map(row => CiPreparationRecordSchema.parse(row.record))
  }

  async latestForDevice(deviceId: string): Promise<CiPreparationRecord | undefined> {
    const row = (await this.pool.query<{ record: unknown }>(`select record from ci_runtime_preparations
      where device_id=$1 order by created_at desc,id desc limit 1`, [deviceId])).rows[0]
    return row ? CiPreparationRecordSchema.parse(row.record) : undefined
  }

  async save(sql: JobSql, record: CiPreparationRecord): Promise<void> {
    CiPreparationRecordSchema.parse(record)
    await sql.query('update ci_runtime_preparations set record=$2::jsonb,active=$3 where id=$1',
      [record.id, JSON.stringify(record), !['qualified', 'failed'].includes(record.status.state)])
  }
}
