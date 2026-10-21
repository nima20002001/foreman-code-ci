import type pg from 'pg'
import { CiEnrollmentComputerSchema, type CiEnrollmentComputer } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { z } from 'zod'
import { buildComputerKey } from '../settings/buildComputers.js'
import type { JobSql } from './repository.js'

const ProfileLinksSchema = z.record(z.string(), z.object({ profileId: z.string(), digest: z.string() }))
export type CiEnrollmentProfiles = z.infer<typeof ProfileLinksSchema>
export interface CiEnrollmentRecord {
  state: CiEnrollmentComputer
  profiles: CiEnrollmentProfiles
}

export class CiEnrollmentRepository {
  constructor(private readonly pool: pg.Pool) {}

  async workspace(sql: JobSql, workspaceId: string, principal: ManagementPrincipal): Promise<void> {
    await sql.query(`insert into ci_enrollment_workspaces(workspace_id,principal) values($1,$2::jsonb)
      on conflict(workspace_id) do update set principal=excluded.principal`, [workspaceId, JSON.stringify(principal)])
  }

  async unregisteredWorkspaces() {
    const result = await this.pool.query<{ workspace_id: string; principal_id: string }>(`
      select distinct p.workspace_id,c.principal_id from job_runtime_profiles p
      join workspaces w on w.id=p.workspace_id
      join management_command_receipts c on c.target_key=p.workspace_id
        and c.operation='job.runtime-profile.save' and c.result->>'id'=p.id
      left join ci_enrollment_workspaces e on e.workspace_id=p.workspace_id
      where e.workspace_id is null and w.archived_at is null and p.record->>'status'<>'revoked'`)
    return result.rows
  }

  async workspaces() {
    const result = await this.pool.query<{ workspace_id: string; principal: unknown }>(
      `select e.workspace_id,e.principal from ci_enrollment_workspaces e
        join workspaces w on w.id=e.workspace_id where w.archived_at is null order by e.workspace_id`)
    return result.rows.map(row => ({ workspaceId: row.workspace_id, principal: ManagementPrincipalSchema.parse(row.principal) }))
  }

  async computers(workspaceId: string): Promise<CiEnrollmentRecord[]> {
    const result = await this.pool.query<{ state: unknown; profiles: unknown; revision: string; enabled: boolean }>(
      'select state,profiles,revision,enabled from ci_enrollment_computers where workspace_id=$1 order by host_key', [workspaceId])
    return result.rows.map(row => ({ state: { ...CiEnrollmentComputerSchema.parse(row.state),
      revision: Number(row.revision), enabled: row.enabled }, profiles: ProfileLinksSchema.parse(row.profiles) }))
  }

  async save(sql: JobSql, workspaceId: string, record: CiEnrollmentRecord): Promise<void> {
    await sql.query(`insert into ci_enrollment_computers(workspace_id,host_key,revision,enabled,state,profiles)
      values($1,$2,$3,$4,$5::jsonb,$6::jsonb) on conflict(workspace_id,host_key) do update
      set state=case when ci_enrollment_computers.revision=excluded.revision
        then excluded.state else ci_enrollment_computers.state end,
        profiles=ci_enrollment_computers.profiles || excluded.profiles`,
    [workspaceId, buildComputerKey(record.state.target), record.state.revision, record.state.enabled,
      JSON.stringify(record.state), JSON.stringify(record.profiles)])
  }
}
