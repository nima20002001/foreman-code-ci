import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { HostHarnessProfileCheckRequestSchema, type HostHarnessOverride,
  type HostHarnessProfileEvidence } from '@foreman-code/contracts/harness-registry'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { readInstalledWorkerAccountBinding } from './installedWorkerAccountBinding.js'
import { requireClaudeProductionCredentialDelivery } from './claudeSdk/productionCredentials.js'
import { DomainError } from '../errors.js'
import { createClaudeCurrentPinResolver } from './claudeSdk/currentPin.js'
import { qualifyClaudeNativeProfile } from './claudeSdk/nativeProfileQualification.js'
import { HarnessInstallationRegistry } from './installationRegistry.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from './instanceRegistry.js'
import { inspectInstalledClaude, type InstalledClaudeTarget } from './installedClaudeInspection.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import type { HostHarnessProfileQualifier } from './instanceSettings/profileChecks.js'
import { runCommand } from './process.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { runOwnedClaudeOperation } from './claudeSdk/ownedOperation.js'

export function createInstalledClaudeQualifier(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
  accounts?: () => ProviderAccountResolver | undefined
}): HostHarnessProfileQualifier & { close(): Promise<void> } {
  const stopping = new AbortController()
  const flights = new Set<Promise<HostHarnessProfileEvidence>>()
  const perform = async (value: HostHarnessOverride, request: { checkId: string; signal: AbortSignal }) => {
    HostHarnessProfileCheckRequestSchema.parse({ checkId: request.checkId, override: value })
    const signal = AbortSignal.any([request.signal, stopping.signal])
    const connection = structuredClone(input.current())
    const inspect = async (original?: InstalledClaudeTarget) => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(connection, input.current())) throw new DomainError(
        'HARNESS_INVENTORY_STALE', 'The Claude profile check connection changed.', 409)
      const selected = await inspectInstalledClaude({ binding: connection, configuration: input.configuration,
        environment: process.env, cwd: input.stateDirectory, signal })
      const target = selected.currentTarget
      if (!target || !isDeepStrictEqual(target.target, value.target)
        || original && (!isDeepStrictEqual(target.target, original.target)
          || !isDeepStrictEqual(target.installation.claudeSdk, original.installation.claudeSdk)
          || !isDeepStrictEqual(target.installation.launcher.payloadFingerprints,
            original.installation.launcher.payloadFingerprints)
          || target.installation.environmentGeneration !== original.installation.environmentGeneration)
        || !isDeepStrictEqual(connection, input.current())) throw new DomainError(
        'HARNESS_INSTALLATION_CHANGED', 'The installed Claude SDK or profile check host changed.', 409)
      return target
    }
    if (value.configuration.harness !== 'claude' || value.driverId !== 'claude' || !value.enabled
      || value.configurationFingerprint !== commandInputHash(withAdvancedDefaults(value.configuration))) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The saved Claude profile is invalid.', 409)
    }
    const configuration = value.configuration
    const accountBinding = configuration.accountId ? readInstalledWorkerAccountBinding({
      ...input, provider: 'claude', accountId: configuration.accountId,
    }) : undefined
    const accounts = accountBinding ? { resolve: (provider: 'codex' | 'claude', accountId?: string) => {
      const resolver = input.accounts?.()
      if (!resolver) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
        'The selected Worker account resolver is unavailable.', 409)
      return resolver.resolve(provider, accountId, { acceptedBinding: accountBinding, allowDefault: false, signal })
    } } : undefined
    const apiKey = await requireClaudeProductionCredentialDelivery(configuration, accounts)
    const original = await inspect()
    const assertCurrent = async () => {
      await inspect(original)
      await requireClaudeProductionCredentialDelivery(configuration, accounts)
    }
    const resolver = createClaudeCurrentPinResolver({ sdk: original.sdk, ownedVersionProbe: async observation => {
      await assertCurrent()
      const recovery = await input.registry.reserveLaunch(`claude-profile-version:${request.checkId}`)
      return runOwnedClaudeOperation(async () => {
        const environment: NodeJS.ProcessEnv = { PATH: original.installation.launcher.environment.path }
        const result = await runCommand(observation.launcher, ['--version'], input.stateDirectory,
          signal, environment, { recovery, maxOutputBytes: 16_384 })
        await assertCurrent()
        const version = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?\s*$/u.exec(result.stdout)?.[1]
        if (result.exitCode !== 0 || !version) throw new DomainError(
          'CLAUDE_VERSION_UNAVAILABLE', 'The owned CLI inspection returned no Claude version.', 409)
        return { ...observation, version, positiveProcessClosure: true }
      }, async () => {
        await input.registry.abandonReservedLaunch(recovery)
        if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError(
          'CLAUDE_PROCESS_CLOSURE_PENDING', 'Claude version inspection has not stopped.', 409)
      })
    } })
    const current = await resolver({ hostGeneration: original.installation.connectionGeneration,
      harnessInstallationId: original.installation.harnessInstallationId,
      environment: original.installation.launcher.environment,
      instanceRevision: value.instanceRevision, profilePath: configuration.configDirectory }, signal)
    if (current.status !== 'available') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', current.reason, 409)
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId: value.instanceId, instanceRevision: value.instanceRevision,
      driverId: 'claude', enabled: value.enabled, configuration }])
    const installations = new HarnessInstallationRegistry(instances)
    installations.refresh([original.installation])
    const binding = installations.pin({ instanceId: value.instanceId, hostRef: value.target.hostRef,
      harnessInstallationId: value.target.harnessInstallationId,
      connectionGeneration: original.installation.connectionGeneration,
      environmentGeneration: original.installation.environmentGeneration })
    const recovery = await input.registry.reserveLaunch(`claude-profile-check:${request.checkId}`)
    return runOwnedClaudeOperation(async () => {
      return await qualifyClaudeNativeProfile({ value, checkId: request.checkId, binding, pin: current.pin,
        directory: join(input.stateDirectory, 'claude-native-qualification'), recovery, signal, assertCurrent,
        sdkEntrypoint: original.sdk.entrypoint, ...(apiKey ? { apiKey } : {}) })
    }, async () => {
      await input.registry.abandonReservedLaunch(recovery)
      if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError(
        'CLAUDE_PROCESS_CLOSURE_PENDING', 'Claude profile qualification has not stopped.', 409)
    })
  }
  return {
    qualify(value, request) {
      const flight = perform(value, request)
      flights.add(flight)
      void flight.then(() => flights.delete(flight), () => flights.delete(flight))
      return flight
    },
    async close() {
      stopping.abort(new Error('Claude profile checks are stopping.'))
      await Promise.allSettled([...flights])
    },
  }
}
