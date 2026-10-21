import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/infrastructure/checkpoints.js'
import { buildProductionApp } from '../src/production.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { DEFAULT_HARNESS_DEFAULTS, HarnessConfigurationSchema } from '@foreman-code/contracts'
import { ProductionHarnessRegistry } from '../src/modules/harnesses/productionRegistry.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'

it('constructs the activity replay through production without installed inventory discovery', async () => {
  const replay = new ActivityProductionReplay()
  const infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected recorded replay infrastructure.')
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/replay',
    CODEX_BINARY: '/recorded-no-native-codex',  })
  const database = createDatabase(config.database)
  const checkpoints = createCheckpointStore(config.database.connectionString, 'replay', config.database)
  try {
    const production = buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, infrastructure)
    try {
      const environment = { generation: 'recorded-environment', provenance: 'terminal' as const, cwd: '/recorded', path: '' }
      expect(await infrastructure.inventoryDiscovery!.launcher(config.harnesses.codexBinary, environment)).toMatchObject({
        requested: config.harnesses.codexBinary, environment, status: 'installed', resolvedLauncher: config.harnesses.codexBinary,
        diagnostics: ['Synthetic activity protocol replay inventory; no installed provider was inspected or qualified.'],
      })
      for (const requested of ['/unrecorded-provider']) {
        expect(await infrastructure.inventoryDiscovery!.launcher(requested, environment)).toMatchObject({
          requested, environment, status: 'missing', resolvedLauncher: null, fingerprint: null,
        })
      }
      await expect(infrastructure.inventoryDiscovery!.payloads('codex', config.harnesses.codexBinary)).resolves.toEqual({ complete: true, paths: [] })
      await expect(infrastructure.inventoryDiscovery!.payloads('codex', '/unrecorded-provider')).rejects.toThrow('Unrecorded auxiliary replay operation.')
      await expect(infrastructure.codex.qualify('/unrecorded-provider', '/recorded', {}, true)).rejects.toThrow('Unrecorded replay qualification binary.')
      expect(replay.starts).toEqual([])
      expect(replay.calls).toEqual([])
    } finally { await production.app.close() }
    const incomplete = { ...infrastructure }
    delete incomplete.inventoryDiscovery
    expect(() => buildProductionApp(config, database, checkpoints, false, undefined, undefined, undefined, incomplete))
      .toThrow('Replay must inject settings and probes and cannot run installed CLI qualification.')
  } finally { await Promise.all([database.close(), checkpoints.close()]) }
})

for (const sandbox of ['read-only', 'workspace-write'] as const) it(`qualifies recorded ${sandbox} Operator defaults through registry selection without native IO`, async () => {
  const replay = new ActivityProductionReplay(), infrastructure = replay.infrastructure()
  if (infrastructure.mode !== 'replay') throw new Error('Expected recorded replay infrastructure.')
  const config = loadConfig({ DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/replay',
    CODEX_BINARY: '/recorded-no-native-codex',  })
  const database = createDatabase(config.database)
  const registry = new ProductionHarnessRegistry(database.pool, config.harnesses,
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }),
    new HostHarnessProfileEvidenceRepository(database.pool), () => null, {}, infrastructure.inventoryDiscovery!)
  const recovery = infrastructure.auxiliary.recovery
  const factories = new NativeHarnessFactories({ ...config.harnesses,
    instances: registry.instances, installations: registry.installations,
    selectConfiguration: harness => registry.pinAccepted({ id: `recorded-configuration:${harness.model}`, agentId: 'recorded-operator', harness }),
    auxiliaryRecovery: role => recovery.scope(`recorded-${role}`),
    admitRecovery: async scope => { Object.assign(scope, await recovery.reserveLaunch(scope.owner)) },
    abandonRecovery: async scope => { await recovery.abandonReservedLaunch(scope) },
    closeRecovery: async scope => { if (!await recovery.closeOwner(scope.owner)) throw new Error('Recorded closure failed.') },
    installationDiscovery: infrastructure.inventoryDiscovery!.launcher,
  }, infrastructure)
  try {
    await registry.initialize('00000000-0000-4000-8000-000000000001')
    const configuration = HarnessConfigurationSchema.parse({ harness: 'codex', model: 'test-model',
      reasoningEffort: 'low', sandbox, serviceTier: 'standard' })
    expect(await factories.qualifyConfiguration(configuration, '/recorded-workspace')).toMatchObject({ harness: 'codex', ready: true, authenticated: true })
    await expect(factories.qualifyConfiguration({ ...configuration, model: 'unrecorded-model' }, '/recorded-workspace'))
      .rejects.toThrow('Unrecorded replay model qualification.')
    expect(replay.starts).toEqual([])
    expect(replay.calls).toEqual([])
    expect(database.pool.totalCount).toBe(0)
  } finally { registry.stop(); await factories.disposeAuxiliaries(); await database.close() }
})
