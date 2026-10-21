import type pg from 'pg'
import { SyncIdentitySchema, type SyncIdentity } from '@foreman-code/contracts/computer-accounts'
import { DeviceProvisioningTargetSchema, sameDeviceProvisioningTarget,
  type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { buildComputerKey } from '../settings/buildComputers.js'

export interface SyncWorkspace { id: string; name: string; active: boolean; targets: DeviceProvisioningTarget[] }
export interface SyncComputerIdentity { target: DeviceProvisioningTarget; identity: SyncIdentity }
export interface SyncPreference { revision: number; enabled: boolean }
export class SyncRepository {
  constructor(private readonly pool: pg.Pool, readonly mainId: string) {}
  get mainTarget(): DeviceProvisioningTarget {
    return { hostRef: { kind: 'main', mainId: this.mainId }, applicationInstallationId: this.mainId,
      keyRevision: null, authorizationRevision: null }
  }
  async identities(): Promise<SyncComputerIdentity[]> {
    const result = await this.pool.query<{ target: unknown; identity: unknown }>(
      `select target,identity from computer_sync_identities where target#>>'{hostRef,mainId}'=$1`, [this.mainId])
    return result.rows.map(row => ({ target: DeviceProvisioningTargetSchema.parse(row.target),
      identity: SyncIdentitySchema.parse(row.identity) }))
  }
  async saveIdentity(target: DeviceProvisioningTarget, identity: SyncIdentity): Promise<void> {
    await this.pool.query(`insert into computer_sync_identities(host_key,target,identity) values($1,$2::jsonb,$3::jsonb)
      on conflict(host_key,target) do update set identity=excluded.identity`,
    [buildComputerKey(target), JSON.stringify(target), JSON.stringify(identity)])
  }
  async workspaces(): Promise<SyncWorkspace[]> {
    const workspaces = (await this.pool.query<{ id: string; name: string; active: boolean }>(
      `select id,record->>'name' as name,archived_at is null as active from workspaces order by id`)).rows
    const hosts = (await this.pool.query<{ workspace_id: string; host: unknown; installation_id: string; key_revision: string | null;
      authorization_revision: string | null }>(`
      select a.workspace_id, c.record#>'{harnessProfileSelection,target,hostRef}' as host,
        c.record#>>'{harnessProfileSelection,target,applicationInstallationId}' as installation_id,
        null::text as key_revision,null::text as authorization_revision
      from agents a join agent_configuration_versions c on c.id=a.current_configuration_version_id
      where a.archived_at is null
      union
      select r.workspace_id,p.record->'hostRef' as host,
        p.record#>>'{registration,workerInstallationId}' as installation_id,
        p.record#>>'{registration,keyRevision}' as key_revision,
        p.record#>>'{registration,authorizationRevision}' as authorization_revision
      from run_node_placements p join runs r on r.id=p.run_id
      where p.record#>>'{payload,kind}'='agent' and r.execution_state in ('queued','running','waiting','interrupted')
    `)).rows
    const conversations = await this.pool.query<typeof hosts[number]>(`
      select c.workspace_id,
        coalesce(c.worker_conversation_binding#>'{profile,target,hostRef}',
          v.record#>'{harnessProfileSelection,target,hostRef}') as host,
        coalesce(c.worker_conversation_binding#>>'{profile,target,applicationInstallationId}',
          v.record#>>'{harnessProfileSelection,target,applicationInstallationId}') as installation_id,
        c.worker_conversation_binding#>>'{sourceExecution,placement,registration,keyRevision}' as key_revision,
        c.worker_conversation_binding#>>'{sourceExecution,placement,registration,authorizationRevision}' as authorization_revision
      from operator_conversations c
      join agent_configuration_versions v on v.id=c.agent_configuration_version_id
      where c.kind='agent' and (c.active_request_id is not null or exists(
        select 1 from operator_conversation_turns t where t.conversation_id=c.id
          and t.delivery in ('queued','submitting','accepted','unknown')))
    `)
    hosts.push(...conversations.rows)
    const computers = await this.computers()
    return workspaces.map(workspace => {
      const targets = new Map<string, DeviceProvisioningTarget>()
      if (workspace.active) targets.set('main', this.mainTarget)
      for (const row of hosts.filter(host => host.workspace_id === workspace.id)) {
        const host = row.host as DeviceProvisioningTarget['hostRef'] | null
        if (!workspace.active || !host || host.mainId !== this.mainId || host.kind !== 'device') continue
        const target = computers.find(value => value.hostRef.kind === 'device' && value.hostRef.deviceId === host.deviceId)
        if (!target || row.installation_id !== target.applicationInstallationId) continue
        if (row.key_revision !== null && Number(row.key_revision) !== target.keyRevision) continue
        if (row.authorization_revision !== null && Number(row.authorization_revision) !== target.authorizationRevision) continue
        targets.set(host.deviceId, target)
      }
      return { ...workspace, targets: [...targets.values()] }
    })
  }
  async computers(): Promise<DeviceProvisioningTarget[]> {
    const registrations = (await this.pool.query<{ record: unknown }>(
      `select record from device_registrations where main_id=$1 and record->>'status'='paired'`, [this.mainId]))
      .rows.map(row => DeviceRegistrationSchema.parse(row.record))
    return [this.mainTarget, ...registrations.map(registration => ({
      hostRef: { kind: 'device' as const, mainId: this.mainId, deviceId: registration.deviceId },
      applicationInstallationId: registration.workerInstallationId,
      keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision,
    }))]
  }
  async preference(sql: Pick<pg.Pool, 'query'>, workspaceId: string, target: DeviceProvisioningTarget): Promise<SyncPreference> {
    const row = (await sql.query<{ target: unknown; revision: string; enabled: boolean }>(
      `select target,revision::text,enabled from computer_sync_preferences where workspace_id=$1 and host_key=$2`,
      [workspaceId, buildComputerKey(target)])).rows[0]
    const matches = row && sameDeviceProvisioningTarget(DeviceProvisioningTargetSchema.parse(row.target), target)
    return { revision: Number(row?.revision ?? 0), enabled: matches ? row.enabled : true }
  }
  async save(sql: Pick<pg.Pool, 'query'>, workspaceId: string, target: DeviceProvisioningTarget,
    preference: SyncPreference, principalId: string) {
    await sql.query(`insert into computer_sync_preferences(workspace_id,host_key,target,revision,enabled,updated_by)
      values($1,$2,$3::jsonb,$4,$5,$6) on conflict(workspace_id,host_key) do update set
      target=excluded.target,revision=excluded.revision,enabled=excluded.enabled,updated_by=excluded.updated_by`,
    [workspaceId, buildComputerKey(target), JSON.stringify(target), preference.revision, preference.enabled, principalId])
  }
}
