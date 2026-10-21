import { errorMessage } from '../../shared/errorMessage.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import {
  BuildComputerPreferenceSchema, BuildComputerStatusSchema, BuildComputerBatchResultSchema,
  BuildComputerReadSchema, BuildComputerUpdateSchema,
  BuildComputerBatchUpdateSchema, type BuildComputerBatchResult, type BuildComputerChange,
  type BuildComputerPreference, type BuildComputerStatus,
} from '@foreman-code/contracts/build-computers'
import { sameDeviceProvisioningTarget, DeviceProvisioningTargetSchema, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import type { JobSql } from '../jobs/repository.js'

export function buildComputerKey(target: Pick<DeviceProvisioningTarget, 'hostRef'>): string {
  const host = target.hostRef
  return `${host.mainId}:${host.kind === 'device' ? host.deviceId : 'main'}`
}
export async function initializePairedBuildComputer(sql: JobSql, registration: DeviceRegistration,
  principalId: string): Promise<'created' | 'rebound' | 'unchanged'> {
  const target = DeviceProvisioningTargetSchema.parse({
    hostRef: { kind: 'device', mainId: registration.mainId, deviceId: registration.deviceId },
    applicationInstallationId: registration.workerInstallationId,
    keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision,
  })
  await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`build-order:${registration.mainId}`])
  const key = buildComputerKey(target)
  const existing = (await sql.query<{ target: unknown; revision: string }>(
    'select target,revision from build_computer_preferences where host_key=$1 for update', [key])).rows[0]
  if (!existing) {
    await sql.query(`insert into build_computer_preferences
      (host_key,target,revision,build_enabled,build_priority,build_allowance_percent,updated_by)
      values($1,$2::jsonb,1,true,50,100,$3)`, [key, JSON.stringify(target), principalId])
    return 'created'
  }
  if (sameDeviceProvisioningTarget(DeviceProvisioningTargetSchema.parse(existing.target), target)) return 'unchanged'
  const updated = await sql.query(`update build_computer_preferences set target=$2::jsonb,revision=revision+1,updated_by=$3
    where host_key=$1 and revision=$4`, [key, JSON.stringify(target), principalId, existing.revision])
  if (updated.rowCount !== 1) {
    throw new DomainError('REVISION_CONFLICT', 'Build settings changed during pairing.', 409)
  }
  return 'rebound'
}
export function buildComputerTarget(target: Pick<import('@foreman-code/contracts/jobs').ResolvedJobDefinitionSpec['target'],
  'hostRef' | 'registration' | 'mainInstallationId'>): DeviceProvisioningTarget {
  return {
    hostRef: target.hostRef,
    applicationInstallationId: target.registration?.workerInstallationId ?? target.mainInstallationId,
    keyRevision: target.registration?.keyRevision ?? null,
    authorizationRevision: target.registration?.authorizationRevision ?? null,
  }
}
export async function assertBuildComputerTarget(sql: JobSql, target: DeviceProvisioningTarget): Promise<void> {
  const registration = await assertDeviceHostInstallation(sql, target.hostRef, target.applicationInstallationId)
  if ((registration?.keyRevision ?? null) !== target.keyRevision
    || (registration?.authorizationRevision ?? null) !== target.authorizationRevision) {
    throw new DomainError('BUILD_COMPUTER_IDENTITY_CHANGED', 'Refresh this computer’s registration before editing builds.', 409)
  }
}

type BuildComputerPreferenceRow = {
  host_key: string; target: DeviceProvisioningTarget; revision: string; build_enabled: boolean;
  build_priority: number; build_allowance_percent: number
}

function preferenceFromRow(target: DeviceProvisioningTarget, row?: BuildComputerPreferenceRow): BuildComputerPreference {
  const matches = row && sameDeviceProvisioningTarget(DeviceProvisioningTargetSchema.parse(row.target), target)
  return BuildComputerPreferenceSchema.parse({ target, revision: Number(row?.revision ?? 0),
    buildEnabled: matches ? row.build_enabled : false, buildPriority: matches ? row.build_priority : 50,
    buildAllowancePercent: matches ? row.build_allowance_percent : 100 })
}

export async function readBuildComputerPreference(sql: JobSql, target: DeviceProvisioningTarget): Promise<BuildComputerPreference> {
  const row = (await sql.query<BuildComputerPreferenceRow>(
    'select target,revision::text,build_enabled,build_priority,build_allowance_percent from build_computer_preferences where host_key=$1 for share',
    [buildComputerKey(target)])).rows[0]
  return preferenceFromRow(target, row)
}

export class BuildComputerSettings {
  enrollment?: { request(): void }
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly readiness: (sql: JobSql, target: DeviceProvisioningTarget, allowancePercent: number) => Promise<
      Pick<BuildComputerStatus, 'state' | 'reasons' | 'remoteExecutionEnabled'>>,
    private readonly changed?: () => void) {}

  async preference(sql: JobSql, target: DeviceProvisioningTarget): Promise<BuildComputerPreference> {
    // Retain one order through scheduling's transaction, even when a save commits between reads.
    await sql.query('select pg_advisory_xact_lock_shared(hashtext($1))', [`build-order:${target.hostRef.mainId}`])
    return readBuildComputerPreference(sql, target)
  }
  async preferences(sql: JobSql, targets: DeviceProvisioningTarget[]): Promise<BuildComputerPreference[]> {
    if (!targets.length) return []
    for (const mainId of [...new Set(targets.map(target => target.hostRef.mainId))].sort()) {
      await sql.query('select pg_advisory_xact_lock_shared(hashtext($1))', [`build-order:${mainId}`])
    }
    const keys = [...new Set(targets.map(buildComputerKey))].sort()
    const rows = (await sql.query<BuildComputerPreferenceRow>(`select host_key,target,revision::text,
      build_enabled,build_priority,build_allowance_percent from build_computer_preferences
      where host_key=any($1::text[]) order by host_key for share`, [keys])).rows
    const byHost = new Map(rows.map(row => [row.host_key, row]))
    return targets.map(target => preferenceFromRow(target, byHost.get(buildComputerKey(target))))
  }
  async requireEnabled(sql: JobSql, target: DeviceProvisioningTarget,
    options: { preference?: BuildComputerPreference } = {}): Promise<BuildComputerPreference> {
    await assertBuildComputerTarget(sql, target)
    const preference = options.preference ?? await this.preference(sql, target)
    if (!preference.buildEnabled) {
      throw new DomainError('BUILD_COMPUTER_DISABLED', 'Enable builds for this computer in Settings → Computers.', 409)
    }
    return preference
  }
  private async authorize(sql: JobSql, principal: ManagementPrincipal, action: ManagementAction) {
    requireAuthorization(principal, action)
    requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action)
  }
  private async status(preference: BuildComputerPreference): Promise<BuildComputerStatus> {
    const readiness = await this.readiness(this.pool, preference.target, preference.buildAllowancePercent).catch(error => {
      logIgnoredError('jobs', 'observe build computer readiness', error, { target: preference.target })
      return { state: 'offline' as const,
        reasons: [`Readiness unavailable: ${errorMessage(error, 'Readiness probe failed.')}`],
        remoteExecutionEnabled: false }
    })
    return { preference, ...readiness,
      state: preference.buildEnabled ? readiness.state : 'disabled',
      reasons: preference.buildEnabled ? readiness.reasons : ['Enable builds to participate.'] }
  }
  async read(principal: ManagementPrincipal, raw: unknown, source: 'http' | 'mcp' = 'http'): Promise<BuildComputerStatus> {
    const { target } = BuildComputerReadSchema.parse(raw)
    try { requireAuthorization(principal, 'settings:read') } catch (error) {
      await this.commands.recordDenied(principal.id, source, 'build.computer.read', buildComputerKey(target))
      throw error
    }
    const preference = await withTransaction(this.pool, async sql => {
      await this.authorize(sql, principal, 'settings:read')
      await assertBuildComputerTarget(sql, target)
      return this.preference(sql, target)
    })
    const result = await this.status(preference)
    await withTransaction(this.pool, async sql => {
      await this.authorize(sql, principal, 'settings:read')
      await assertBuildComputerTarget(sql, target)
    })
    return result
  }
  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<BuildComputerStatus> {
    const input = BuildComputerUpdateSchema.parse(raw)
    const { commandId, ...change } = input
    const result = await this.save(principal, source, { commandId, updates: [change] },
      'build.computer.update', buildComputerKey(input.target), input,
      async sql => (await this.savePreferences(sql, principal, [change]))[0]!,
      value => BuildComputerPreferenceSchema.or(BuildComputerStatusSchema.transform(status => status.preference)).parse(value))
    return this.status(result)
  }
  async updateBatch(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<BuildComputerBatchResult> {
    const input = BuildComputerBatchUpdateSchema.parse(raw)
    const preferences = await this.save(principal, source, input, 'build.computers.update',
      input.updates[0]!.target.hostRef.mainId, input,
      sql => this.savePreferences(sql, principal, input.updates),
      value => BuildComputerPreferenceSchema.array().or(BuildComputerBatchResultSchema.transform(
        result => result.computers.map(computer => computer.preference))).parse(value))
    return { computers: await Promise.all(preferences.map(preference => this.status(preference))) }
  }
  private async save<T>(principal: ManagementPrincipal, source: 'http' | 'mcp',
    input: { commandId?: string | undefined; updates: BuildComputerChange[] }, operation: string, targetKey: string,
    payload: unknown, perform: (sql: pg.PoolClient) => Promise<T>, replayResult: (value: unknown) => T): Promise<T> {
    try { requireAuthorization(principal, 'settings:update') } catch (error) {
      await this.commands.recordDenied(principal.id, source, operation, targetKey)
      throw error
    }
    const result = await this.commands.execute({ principal, source, commandId: input.commandId,
      operation, targetKey, payload,
      authorize: async sql => {
        await this.authorize(sql, principal, 'settings:update')
        for (const change of input.updates) await assertBuildComputerTarget(sql, change.target)
      },
      perform, replayResult })
    if (!result.replayed) {
      this.changed?.()
      this.enrollment?.request()
    }
    return result.value
  }
  private async savePreferences(sql: JobSql, principal: ManagementPrincipal, updates: BuildComputerChange[]) {
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`build-order:${updates[0]!.target.hostRef.mainId}`])
    const preferences: BuildComputerPreference[] = []
    for (const input of updates) {
      const old = await this.preference(sql, input.target)
      if (old.revision !== input.expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', 'Build settings changed. Refresh before saving again.', 409)
      }
      preferences.push(old)
    }
    for (const [index, input] of updates.entries()) {
      const old = preferences[index]!
      await sql.query(`insert into build_computer_preferences
          (host_key,target,revision,build_enabled,build_priority,build_allowance_percent,updated_by) values($1,$2::jsonb,$3,$4,$5,$6,$7)
          on conflict(host_key) do update set target=excluded.target,revision=excluded.revision,
          build_enabled=excluded.build_enabled,build_priority=excluded.build_priority,
          build_allowance_percent=excluded.build_allowance_percent,updated_by=excluded.updated_by`,
        [buildComputerKey(input.target), JSON.stringify(input.target), old.revision + 1,
          input.buildEnabled, input.buildPriority,
          input.buildAllowancePercent ?? old.buildAllowancePercent, principal.id])
    }
    return Promise.all(updates.map(input => readBuildComputerPreference(sql, input.target)))
  }
}
