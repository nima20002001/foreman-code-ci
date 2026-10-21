import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import { NativeHarnessFactories } from '../../src/modules/harnesses/runtimeFactory.js'
import { NativeProcessRegistry } from '../../src/modules/harnesses/recovery/processRegistry.js'
import { ProductionHostHarnessProfileQualifier } from '../../src/modules/harnesses/productionProfileQualifier.js'
import type { ProductionHarnessRegistry } from '../../src/modules/harnesses/productionRegistry.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../../src/modules/harnesses/instanceSettings/profileChecks.js'
import type { HostHarnessOverrideAuthority } from '../../src/modules/harnesses/instanceSettings/service.js'
import { HarnessQualificationRepository } from '../../src/modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from '../../src/modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from '../../src/modules/harnesses/qualification/service.js'
import { codexQualificationSuite } from '../../src/modules/harnesses/qualification/suites/codex.js'
import { withNativeQualificationOwnership } from '../../src/modules/harnesses/qualification/nativeOwnership.js'
import { withQualificationIdentity } from '../../src/modules/harnesses/qualification/identity.js'
import { runWithReadOnlyQualification } from '../../src/modules/harnesses/qualification/gate.js'
import { scopedCompatibilityProbe } from '../../src/modules/harnesses/compatibility/scopedProbe.js'
import { PostgresSettingsRepository } from '../../src/modules/settings/postgres.js'
import type { Sch11Fixture } from './sch11Fixture.js'
import { completeTestResourceCleanup, registerTestResourceCleanup } from '../../../../scripts/test-resources.mjs'
import { writeNativeAcceptanceEvidence } from './nativeAcceptanceEvidence.js'

/** Native acceptance only: the same qualifiers, owner guards and persistence as production. */
export async function qualifyScheduleHarness(f: Sch11Fixture, principal: ManagementPrincipal,
  registry: ProductionHarnessRegistry, settings: HostHarnessOverride[], authority: HostHarnessOverrideAuthority) {
  const configuration = settings[0]?.configuration
  if (!configuration || configuration.harness !== 'codex') {
    throw new Error('The native schedule fixture requires its configured Codex model.')
  }
  const defaults = new PostgresSettingsRepository(f.database.pool)
  const savedDefaults = await defaults.getHarnessDefaults()
  await defaults.saveHarnessDefaults({ ...savedDefaults,
    codex: { ...savedDefaults.codex, model: configuration.model, reasoningEffort: configuration.reasoningEffort } })
  const registryDirectory = join(f.runtimeRoot, `qualification-${randomUUID()}`)
  const processes = new NativeProcessRegistry(registryDirectory)
  const invocation = { directory: process.env.FOREMAN_CODE_TEST_ROOT!, token: process.env.FOREMAN_CODE_TEST_OWNER! }
  const cleanupId = registerTestResourceCleanup(invocation, {
    kind: 'native-qualification', root: f.database.directory, registryDirectory,
    schema: f.database.schema, databaseUrl: process.env.TEST_DATABASE_URL!,
  })
  const startedAt = new Date().toISOString()
  const phases: { operation: string; event: string; elapsedMs?: number; errorName?: string }[] = []
  const observe = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    const started = performance.now()
    phases.push({ operation, event: 'started' })
    try {
      const result = await action()
      phases.push({ operation, event: 'completed', elapsedMs: performance.now() - started })
      return result
    } catch (error) {
      phases.push({ operation, event: 'failed', elapsedMs: performance.now() - started,
        errorName: error instanceof Error ? error.name : 'unknown' })
      throw error
    }
  }
  const factories = new NativeHarnessFactories({
    codexBinary: registry.pinDefault('codex').installation.launcher.resolvedLauncher!,
    instances: registry.instances, installations: registry.installations,
    selectDefault: harness => registry.pinDefault(harness),
    auxiliaryRecovery: role => processes.scope(`${role}:${randomUUID()}`),
    admitRecovery: async recovery => { Object.assign(recovery, await processes.reserveLaunch(recovery.owner)) },
    abandonRecovery: async recovery => { await processes.abandonReservedLaunch(recovery) },
    closeRecovery: async recovery => {
      if (!await processes.closeOwner(recovery.owner)) throw new Error('Native qualification process closure is unconfirmed.')
    },
  })
  const validateInstallation = factories.assertInstallationUnchanged.bind(factories)
  const assertInstallation: typeof validateInstallation = (...args) =>
    observe('installed-payload-validation', () => validateInstallation(...args))
  const wrap = (suite: typeof codexQualificationSuite) => withQualificationIdentity(
    withNativeQualificationOwnership(suite, processes, () => {
      const binding = registry.pinDefault(suite.harness)
      return signal => assertInstallation(binding, signal)
    }), registry.installations, () => registry.pinDefault(suite.harness))
  const suites = { codex: wrap(codexQualificationSuite) }
  const repository = new HarnessQualificationRepository(f.database.pool)
  const qualifications = new HarnessQualificationRegistry(repository,
    { codex: suites.codex.revision })
  const service = new HarnessQualificationService(repository, qualifications, suites,
    { codex: registry.pinDefault('codex').installation.launcher.resolvedLauncher! },
    f.commands, defaults, undefined, undefined,
    (_harness, _binary, timeoutMs) => {
      const probe = scopedCompatibilityProbe({ registry: processes,
        pin: harness => registry.pinDefault(harness), assertInstallation,
        workingDirectory: f.runtimeRoot, timeoutMs })
      return {
        inspect: (...args: Parameters<typeof probe.inspect>) =>
          observe('version-inspection', () => probe.inspect(...args)),
        probe: (...args: Parameters<typeof probe.probe>) => observe('schema-export', () => probe.probe(...args)),
        assertUnchanged: (...args: Parameters<typeof probe.assertUnchanged>) =>
          observe('launcher-validation', () => probe.assertUnchanged(...args)),
        close: () => observe('diagnostic-cleanup', async () => { await probe.close?.() }),
      }
    },
    (_harness, signal) => registry.refreshMain(signal))
  const checks = new HostHarnessInstanceProfileChecks(new HarnessInstanceSettingsRepository(f.database.pool),
    new HostHarnessProfileEvidenceRepository(f.database.pool), f.commands, authority,
    new ProductionHostHarnessProfileQualifier(registry, factories, () => {
      throw new Error('Main-local qualification does not request a worker.')
    }, f.runtimeRoot))
  const failures: unknown[] = []
  const cleanupFailures: unknown[] = []
  try {
    const submitted = (await observe('qualification-preparation', () => service.run(principal, 'http', 'codex')))
      .qualification
    await observe('qualification-suite', () => service.join())
    const result = await repository.find('codex', submitted.version, submitted.binarySha256!, submitted.suiteRevision)
    if (result?.status !== 'qualified') {
      if (result) {
        await writeNativeAcceptanceEvidence(`schedule-qualification-${randomUUID()}.json`, result)
      }
      const failedChecks = result?.checks.filter(check => !check.passed).map(check => check.id).join(', ')
      throw new Error(`Native qualification did not pass (${failedChecks || 'no completed checks'}): ${result?.failureReason}`)
    }
    for (const value of settings) {
      const checked = await runWithReadOnlyQualification(qualifications, () => checks.check(principal, 'http', {
        commandId: randomUUID(), instanceId: value.instanceId, expectedRevision: value.revision, target: value.target,
      }))
      if (!checked.value.proof.qualified) throw new Error('The saved native profile did not qualify.')
    }
  } catch (error) {
    failures.push(error)
  }
  factories.stopAuxiliaries()
  const closed = await Promise.allSettled([checks.close(), service.shutdown(), factories.disposeAuxiliaries()])
  for (const result of closed) {
    if (result.status === 'rejected') cleanupFailures.push(result.reason)
  }
  for (const owner of new Set(processes.snapshot().launches.map(launch => launch.owner))) {
    try {
      if (!await processes.closeOwner(owner)) throw new Error('Native schedule qualification closure is unconfirmed.')
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  if (!cleanupFailures.length) {
    try { completeTestResourceCleanup(invocation, cleanupId) }
    catch (error) { cleanupFailures.push(error) }
  }
  failures.push(...cleanupFailures)
  try {
    await writeNativeAcceptanceEvidence(`schedule-qualification-diagnostics-${randomUUID()}.json`, {
      startedAt, schema: f.database.schema, registryDirectory, runtime: process.execPath, phases,
      failed: failures.length > 0, cleanupConfirmed: cleanupFailures.length === 0,
    })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Native schedule qualification or cleanup failed.')
}
