import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { HostHarnessOverrideService, type HostHarnessOverrideAuthority } from '../../src/modules/harnesses/instanceSettings/service.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import { authorizeDeviceHost } from '../../src/modules/devices/hostAuthorization.js'
import { ProductionHarnessRegistry } from '../../src/modules/harnesses/productionRegistry.js'
import { PostgresSettingsRepository } from '../../src/modules/settings/postgres.js'
import { codexQualificationSuite } from '../../src/modules/harnesses/qualification/suites/codex.js'

import { qualificationRevisionWithIdentity } from '../../src/modules/harnesses/qualification/identity.js'
import { qualifyScheduleHarness } from './qualifyScheduleHarness.js'
import type { Sch11Fixture } from './sch11Fixture.js'

/** Production discovery and settings; qualification is an explicit native operation. */
export async function scheduleHarnessFixture(f: Sch11Fixture, mainId: string, principal: ManagementPrincipal) {
  const pool = f.database.pool
  const profiles = new HostHarnessProfileEvidenceRepository(pool)
  const defaults = new PostgresSettingsRepository(pool)
  const binary = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
  const binaries = { codexBinary: binary,  }
  const createRegistry = () => new ProductionHarnessRegistry(pool,
    binaries, client => defaults.getManagedHarnessDefaults(client),
    profiles, () => null)
  let registry = createRegistry()
  await registry.initialize(mainId)
  const installation = registry.installations.list().find(item => item.driverId === 'codex')!
  if (!installation.installed || !installation.installationFingerprint) throw new Error('Pinned Codex discovery is required.')
  const repository = new HarnessInstanceSettingsRepository(pool)
  const authority: HostHarnessOverrideAuthority = {
    authorize: async (actor, action, host, installationId, sql) => {
      if (!sql) throw new Error('Harness settings authorization requires its transaction.')
      await authorizeDeviceHost(sql, actor, action, host, installationId)
    },
  }
  const service = new HostHarnessOverrideService(repository, f.commands, authority, async (value, sql) => {
    const proof = await registry.profileEvidence(value, sql)
    return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
      qualified: proof.qualified } : null
  })
  const settings: HostHarnessOverride[] = []
  for (const configuration of f.fixture.configurations) {
    settings.push((await service.save(principal, 'http', { commandId: randomUUID(),
      instanceId: randomUUID(), expectedRevision: 0, enabled: true,
      presetId: 'local-default:codex', configuration: SupportedHarnessConfigurationSchema.parse(configuration.harness),
      target: { hostRef: installation.hostRef, applicationInstallationId: mainId,
        harnessInstallationId: installation.harnessInstallationId,
        installationFingerprint: installation.installationFingerprint } })).value)
  }
  const suites = { codex: qualificationRevisionWithIdentity(codexQualificationSuite.revision) }
  return {
    settings, service, suites,
    get registry() { return registry },
    changeInstance: async (patch: { enabled?: boolean } = {}) => {
      const value = settings[0]!
      return service.save(principal, 'http', { commandId: randomUUID(), instanceId: value.instanceId,
        expectedRevision: value.revision, target: value.target, presetId: value.presetId,
        configuration: SupportedHarnessConfigurationSchema.parse(value.configuration), enabled: patch.enabled ?? true })
    },
    restart: () => { registry.stop(); registry = createRegistry() },
    recover: () => registry.initialize(mainId),
    changeBinary: (codexBinary: string) => { binaries.codexBinary = codexBinary; return registry.refreshMain() },
    qualify: () => qualifyScheduleHarness(f, principal, registry, settings, authority),
  }
}
