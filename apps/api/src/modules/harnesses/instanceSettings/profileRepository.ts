import type pg from 'pg'
import { DomainError } from '../../errors.js'
import { HostHarnessProfileEvidenceSchema, type HostHarnessOverride, type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'

export class HostHarnessProfileEvidenceRepository {
  constructor(private readonly pool: pg.Pool) {}
  async findCheck(checkId: string, instanceId: string, revision: number, client?: pg.ClientBase): Promise<HostHarnessProfileEvidence | null> {
    const result = await (client ?? this.pool).query<{ record: unknown; instance_id: string; instance_revision: string }>('select record,instance_id,instance_revision from harness_instance_profile_evidence where check_id=$1', [checkId])
    const row = result.rows[0]
    if (row && (row.instance_id !== instanceId || Number(row.instance_revision) !== revision)) throw new DomainError('COMMAND_ID_CONFLICT', 'This native check identity belongs to another instance revision.', 409)
    return row ? HostHarnessProfileEvidenceSchema.parse(row.record) : null
  }
  async latest(instanceId: string, revision: number, client?: pg.ClientBase): Promise<HostHarnessProfileEvidence | null> {
    const result = await (client ?? this.pool).query<{ record: unknown }>('select record from harness_instance_profile_evidence where instance_id=$1 and instance_revision=$2 order by created_at desc,check_id desc limit 1', [instanceId, revision])
    return result.rows[0] ? HostHarnessProfileEvidenceSchema.parse(result.rows[0].record) : null
  }
  async append(client: pg.ClientBase, checkId: string, value: HostHarnessOverride, proof: HostHarnessProfileEvidence): Promise<void> {
    await client.query(`insert into harness_instance_profile_evidence(check_id,instance_id,instance_revision,record)
      values($1,$2,$3,$4::jsonb)`, [checkId, value.instanceId, value.revision, JSON.stringify(proof)])
  }
  async previouslyQualified(value: HostHarnessOverride): Promise<boolean> {
    const result = await this.pool.query(`select 1 from harness_instance_profile_evidence evidence
      join harness_instance_settings settings on settings.instance_id=evidence.instance_id
        and settings.revision=evidence.instance_revision
      where settings.instance_id=$1 and settings.record->>'instanceRevision'=$2
        and settings.configuration_fingerprint=$3 and evidence.record->>'qualified'='true'
        and evidence.record->>'authenticated'='true' and evidence.record->>'compatible'='true' limit 1`,
    [value.instanceId, value.instanceRevision, value.configurationFingerprint])
    return result.rows.length > 0
  }
}
