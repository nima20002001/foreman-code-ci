import type pg from 'pg'
import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { withTransaction } from '../../infrastructure/transaction.js'
import { isAuthorized } from '../access/policy.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DeviceAccessError } from '../devices/accessError.js'
import { DomainError } from '../errors.js'
import type { HarnessInstanceSettingsRepository } from '../harnesses/instanceSettings/repository.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import { commandInputHash } from '../commands/postgres.js'
import { computerAvailabilityFailure } from './computerAvailability.js'

export interface PairedRootServices {
  profiles: HarnessInstanceSettingsRepository
  ensureProfileReady?: (profile: HostHarnessOverride) => Promise<void>
  registry: Pick<ProductionHarnessRegistry, 'installations' | 'profileEvidence'>
  provisionRoot?: (principal: ManagementPrincipal, workspaceId: string, template: SourceRootRecord,
    target: DeviceProvisioningTarget, source: 'http' | 'mcp') => Promise<SourceRootRecord>
}

/** Pairing supplies storage approval; the caller still needs the existing scoped write actions. Returns whether a
 * computer was skipped because its matching profile is still being checked, so discovery is not settled yet. */
export async function provisionPairedAgentRoots(pool: pg.Pool, services: PairedRootServices,
  principal: ManagementPrincipal, workspaceId: string, configuration: AgentConfigurationVersion,
  matches: (profile: HostHarnessOverride, configuration: AgentConfigurationVersion) => boolean,
  source: 'http' | 'mcp'): Promise<boolean> {
  if (!services.provisionRoot) return false
  const writeActions = ['source_roots:bind', 'workspace_locations:validate', 'workspace_locations:update'] as const
  if (!writeActions.every(action => isAuthorized(principal, action, { workspaceId }))) return false
  const template = await withTransaction(pool, async sql => {
    const row = (await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
      join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
      join workspaces w on w.id=c.workspace_id
      join source_snapshots s on s.snapshot_id=b.snapshot_id
      where c.workspace_id=$1 and b.record#>>'{selection,hostRef,kind}'='main' and s.availability='retained'
      order by (b.record#>>'{selection,locationRevision}'=w.location_revision::text) desc,
        b.record->>'boundAt' desc, c.root_id limit 1`, [workspaceId])).rows[0]
    return row ? SourceRootRecordSchema.parse(row.record) : null
  })
  if (!template) return false
  const visited = new Set<string>()
  let pending = false
  for (const installation of services.registry.installations.list()) {
    if (!installation.installed || installation.driverId !== 'codex' || installation.hostRef.kind !== 'device') continue
    const host = installation.hostRef
    if (visited.has(host.deviceId)) continue
    const candidate = await withTransaction(pool, async sql => {
      const device = (await sql.query<{ worker_installation_id: string }>(
        'select worker_installation_id from device_registrations where id=$1 and main_id=$2',
        [host.deviceId, host.mainId])).rows[0]
      if (!device) return null
      let registration
      try {
        registration = await assertDeviceHostInstallation(sql, host, device.worker_installation_id)
      } catch (error) {
        if (error instanceof DeviceAccessError) return null
        throw error
      }
      if (!registration) return null
      const profiles = await services.profiles.list(host, registration.workerInstallationId, sql)
      const profile = profiles.find(value => matches(value, configuration)
        && value.target.harnessInstallationId === installation.harnessInstallationId
        && value.target.installationFingerprint === installation.installationFingerprint)
      if (!profile) return null
      return { profile, target: { hostRef: host, applicationInstallationId: registration.workerInstallationId,
        keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision } }
    })
    if (!candidate) continue
    visited.add(host.deviceId)
    try {
      await services.ensureProfileReady?.(candidate.profile)
    } catch (error) {
      const availability = computerAvailabilityFailure(error)
      if (availability) pending ||= availability.pending
      else if (error instanceof DomainError && [409, 422, 503].includes(error.status)) {
        pending ||= error.code === 'HARNESS_PROFILE_CHECK_PENDING'
      } else throw error
      continue
    }
    const qualified = await withTransaction(pool, async sql => {
      const current = await services.profiles.latest(sql, candidate.profile.instanceId)
      if (!current || commandInputHash(current) !== commandInputHash(candidate.profile)) return false
      return !!await services.registry.profileEvidence(current, sql)
    })
    if (!qualified) continue
    try {
      await services.provisionRoot(principal, workspaceId, template, candidate.target, source)
    } catch (error) {
      const availability = computerAvailabilityFailure(error)
      if (!availability) throw error
      pending ||= availability.pending
    }
  }
  return pending
}
