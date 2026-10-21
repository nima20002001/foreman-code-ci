import pg from 'pg'
import { withTransaction } from '../../../infrastructure/transaction.js'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { HostHarnessOverrideSchema, type HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { DomainError } from '../../errors.js'

export const harnessHostKey = (host: CanonicalMachineReference): string => host.kind === 'main' ? `main:${host.mainId}` : `device:${host.mainId}:${host.deviceId}`
export class HarnessInstanceSettingsRepository {
  constructor(private readonly pool: pg.Pool) {}
  async withProfileConnection<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const pool = new pg.Pool({ ...this.pool.options, max: 1, application_name: 'graphql-profile-check' })
    try {
      const client = await pool.connect()
      try { return await operation(client) } finally { client.release() }
    } finally { await pool.end() }
  }
  async list(host: CanonicalMachineReference, applicationInstallationId: string, client?: pg.ClientBase): Promise<HostHarnessOverride[]> {
    const result = await (client ?? this.pool).query<{ record: unknown }>(`select distinct on(instance_id) record from harness_instance_settings
      where host_key=$1 and application_installation_id=$2 order by instance_id,revision desc`, [harnessHostKey(host), applicationInstallationId])
    return result.rows.map(row => HostHarnessOverrideSchema.parse(row.record))
  }
  async prioritizeForRuns(profiles: HostHarnessOverride[]): Promise<HostHarnessOverride[]> {
    const result = await this.pool.query<{ instance_id: string; instance_revision: string }>(`
      select distinct placement.record#>>'{payload,instanceId}' as instance_id,
        placement.record#>>'{payload,instanceRevision}' as instance_revision
      from run_node_placements placement join runs run on run.id=placement.run_id
      where placement.record#>>'{payload,instanceId}'=any($1::text[])
        and run.record->>'executionState' in ('queued','running','waiting')
        and run.record->>'outcome'='pending'`, [profiles.map(profile => profile.instanceId)])
    const used = new Set(result.rows.map(row => `${row.instance_id}:${row.instance_revision}`))
    const priority = (value: HostHarnessOverride) => Number(used.has(`${value.instanceId}:${value.instanceRevision}`))
    return [...profiles].sort((left, right) => priority(right) - priority(left))
  }
  async readAuthorized<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, operation)
  }
  async latest(client: pg.ClientBase, instanceId: string): Promise<HostHarnessOverride | null> {
    const result = await client.query<{ record: unknown }>('select record from harness_instance_settings where instance_id=$1 order by revision desc limit 1', [instanceId])
    return result.rows[0] ? HostHarnessOverrideSchema.parse(result.rows[0].record) : null
  }
  async savedRevision(client: pg.ClientBase, instanceId: string, instanceRevision: string,
    options?: { target: HostHarnessOverride['target'] }): Promise<HostHarnessOverride | null> {
    const result = await client.query<{ record: unknown }>(`select record from harness_instance_settings
      where instance_id=$1 and record->>'instanceRevision'=$2
        and ($3::jsonb is null or record->'target'=$3::jsonb) order by revision desc limit 1`,
    [instanceId, instanceRevision, options ? JSON.stringify(options.target) : null])
    return result.rows[0] ? HostHarnessOverrideSchema.parse(result.rows[0].record) : null
  }
  async lockRevision(client: pg.ClientBase, instanceId: string, options?: { mode: 'shared' }): Promise<void> {
    const statement = options?.mode === 'shared'
      ? 'select pg_advisory_xact_lock_shared(hashtext($1))'
      : 'select pg_advisory_xact_lock(hashtext($1))'
    await client.query(statement, [`harness-instance:${instanceId}`])
  }
  async append(client: pg.PoolClient, principalId: string, expectedRevision: number | undefined, value: HostHarnessOverride): Promise<HostHarnessOverride> {
    await this.lockRevision(client, value.instanceId)
    const previous = await this.latest(client, value.instanceId)
    if (expectedRevision !== undefined && (previous?.revision ?? 0) !== expectedRevision) throw new DomainError('REVISION_CONFLICT', 'Host harness settings changed since they were read.', 409, { currentRevision: previous?.revision ?? 0 })
    if (previous && (harnessHostKey(previous.target.hostRef) !== harnessHostKey(value.target.hostRef)
      || previous.target.applicationInstallationId !== value.target.applicationInstallationId
      || previous.driverId !== value.driverId)) throw new DomainError('HARNESS_INSTANCE_TARGET_CONFLICT', 'A configured instance cannot move to another host, installation or driver.', 409)
    await client.query(`insert into harness_instance_settings(instance_id,revision,host_key,application_installation_id,record,configuration_fingerprint,created_by)
      values($1,$2,$3,$4,$5::jsonb,$6,$7)`, [value.instanceId, value.revision, harnessHostKey(value.target.hostRef), value.target.applicationInstallationId, JSON.stringify(value), value.configurationFingerprint, principalId])
    return value
  }
  async replaceInstallation(client: pg.PoolClient, previous: HostHarnessOverride,
    target: HostHarnessOverride['target']): Promise<HostHarnessOverride> {
    await this.lockRevision(client, previous.instanceId)
    const current = await this.latest(client, previous.instanceId)
    if (!current || current.revision !== previous.revision) throw new DomainError(
      'REVISION_CONFLICT', 'The harness profile changed during automatic qualification.', 409)
    const value: HostHarnessOverride = { ...previous, revision: previous.revision + 1,
      target, qualification: 'unqualified' }
    // Keep the configuration revision and its author; the audit identifies the system installation update.
    await client.query(`insert into harness_instance_settings
      (instance_id,revision,host_key,application_installation_id,record,configuration_fingerprint,created_by)
      select instance_id,$3,host_key,application_installation_id,$4::jsonb,configuration_fingerprint,created_by
      from harness_instance_settings where instance_id=$1 and revision=$2`,
    [previous.instanceId, previous.revision, value.revision, JSON.stringify(value)])
    await client.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values(null,'system','harness.instance.installation.update',$1,'succeeded',$2::jsonb)`,
    [`harness-instance:${value.instanceId}`, JSON.stringify({ previousRevision: previous.revision,
      revision: value.revision, previousTarget: previous.target, target })])
    return value
  }
}
