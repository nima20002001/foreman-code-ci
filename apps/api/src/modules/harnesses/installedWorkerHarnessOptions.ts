import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { HarnessOptionsDiscoveryRequest } from '@foreman-code/contracts/harness-registry'
import { HarnessOptionsResultSchema, type HarnessOptions } from '@foreman-code/contracts/management'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { codexAuthenticationIdentity } from './codexAuthenticationIdentity.js'
import { systemPorts } from '../computers/accountProbe.js'
import { DomainError } from '../errors.js'
import { installedHarnessSelection, readInstalledWorkflowConfiguration,
  type InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { CodexAppServerSessionManager, safeEnvironment } from './codexAppServer.js'
import { detectedClaudeProfilePath } from './claudeSdk/profilePath.js'
import { discoverClaudeMetadata } from './claudeSdk/metadata.js'
import { claudeSettingSupport } from './claudeSdk/nativeConfiguration.js'
import { runOwnedClaudeOperation } from './claudeSdk/ownedOperation.js'
import { managedProviderEnvironment } from './providerAccountRuntime.js'
import { harnessSettingSupport } from './operatorOptions.js'
import { inspectInstalledCodex } from './installedCodexInspection.js'
import { inspectInstalledClaude } from './installedClaudeInspection.js'
import { QualificationCache } from './qualificationCache.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'

/** Catalog reads own native processes but never qualify execution or create a model turn. */
export function createInstalledWorkerHarnessOptions(input: {
  stateDirectory: string
  configuration: InstalledWorkflowConfigurationLocation | null
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
  accounts?: () => ProviderAccountResolver | undefined
}) {
  const cache = new QualificationCache<HarnessOptions>(300_000, 128)
  const reads = new QualificationCache<HarnessOptions>(0, 128)
  async function readCatalog(request: HarnessOptionsDiscoveryRequest,
    context: { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal }) {
    const connection = structuredClone(context.binding)
    const assertConnection = (signal: AbortSignal) => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(input.current(), connection)) throw new DomainError(
        'HARNESS_INVENTORY_STALE', 'The model discovery connection changed.', 409)
    }
    assertConnection(context.signal)
    const inspect = async (signal: AbortSignal) => {
      assertConnection(signal)
      const ports = { binding: connection, configuration: input.configuration,
        environment: process.env, cwd: input.stateDirectory, signal }
      const selected = request.harness === 'claude'
        ? await inspectInstalledClaude(ports) : await inspectInstalledCodex(ports)
      assertConnection(signal)
      if (!selected.currentTarget) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE',
        'The selected harness is unavailable on this computer.', 409)
      return selected.currentTarget
    }
    const original = await inspect(context.signal)
    const resolveAccount = async (signal: AbortSignal) => {
      if (!request.accountBinding) return null
      const account = await input.accounts?.()?.resolve(request.harness, request.accountBinding.accountId,
        { acceptedBinding: request.accountBinding, allowDefault: false, signal })
      if (!account || !isDeepStrictEqual(account.binding, request.accountBinding)) throw new DomainError(
        'PROVIDER_ACCOUNT_UNAVAILABLE', 'The selected Worker account is unavailable.', 409)
      return account
    }
    const credentialIdentity = async (signal: AbortSignal) => {
      const account = await resolveAccount(signal)
      const environment = account ? managedProviderEnvironment(process.env, account, request.harness) : process.env
      const binary = original.installation.launcher.resolvedLauncher
      if (!binary) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The selected harness is unavailable.', 409)
      const identity = await systemPorts(environment).probeIdentity!(request.harness, binary)
      const authentication = request.harness === 'codex' ? await codexAuthenticationIdentity({
        binary, directory: input.stateDirectory, environment, registry: input.registry, signal,
      }) : null
      assertConnection(signal)
      return { key: commandInputHash({ identity, authentication }),
        cacheable: request.harness !== 'codex' || authentication !== null }
    }
    const credentials = await credentialIdentity(context.signal)
    const key = commandInputHash({ harness: request.harness, target: original.target,
      environment: original.installation.environmentGeneration, connection, credentials: credentials.key,
      accountBinding: request.accountBinding ?? null })
    const revalidate = async (signal: AbortSignal) => {
      const selected = await inspect(signal)
      if (!isDeepStrictEqual(selected.target, original.target)
        || selected.installation.environmentGeneration !== original.installation.environmentGeneration) {
        throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'The installed harness changed during model discovery.', 409)
      }
      if ((await credentialIdentity(signal)).key !== credentials.key) throw new DomainError(
        'PROVIDER_OBSERVATION_STALE', 'The selected login changed during model discovery.', 409)
    }
    const loadCatalog = async (signal: AbortSignal) => {
      await revalidate(signal)
      const account = await resolveAccount(signal)
      const configuration = await readInstalledWorkflowConfiguration(input.configuration)
      const recovery = await input.registry.reserveLaunch(`model-catalog:${randomUUID()}`)
      const close = async () => {
        await input.registry.abandonReservedLaunch(recovery)
        if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError(
          'HARNESS_PROCESS_CLOSURE_PENDING', 'Model discovery has not stopped.', 409)
      }
      return runOwnedClaudeOperation(async () => {
        let metadata: Pick<HarnessOptions, 'providerVersion' | 'authenticated' | 'models' | 'nativeAgents'>
        if (request.harness === 'claude') {
          if (!('sdk' in original) || !configuration?.claude) throw new DomainError(
            'HARNESS_DRIVER_UNAVAILABLE', 'Claude is unavailable on this computer.', 409)
          metadata = await discoverClaudeMetadata({ binary: configuration.claude.binary, model: 'default',
            profilePath: account?.homePath ?? detectedClaudeProfilePath(), workingDirectory: input.stateDirectory,
            recovery, signal, sdkEntrypoint: original.sdk.entrypoint,
            ...(account ? { accountId: account.accountId, authMode: account.authMode } : {}),
            ...(account?.apiKey ? { apiKey: account.apiKey } : {}) })
        } else {
          const selected = configuration && installedHarnessSelection(configuration)
          if (!selected) throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Codex is unavailable on this computer.', 409)
          const manager = new CodexAppServerSessionManager(selected.binary, selected.expectedVersion,
            undefined, recovery, 'none', undefined, { mode: 'native',
              environment: (variables, names) => account
                ? managedProviderEnvironment(safeEnvironment(variables, names), account, 'codex')
                : safeEnvironment(variables, names) })
          try {
            metadata = { ...await manager.discoverModels(input.stateDirectory, signal), authenticated: true, nativeAgents: [] }
          } finally { await manager.dispose() }
        }
        await revalidate(signal)
        await resolveAccount(signal)
        return HarnessOptionsResultSchema.parse({ harness: request.harness, ...metadata,
          settings: request.harness === 'claude' ? claudeSettingSupport() : harnessSettingSupport(),
          restrictions: ['Metadata comes from the selected computer and login. Execution requires a qualified profile.'],
          checkedAt: new Date().toISOString() })
      }, close)
    }
    // Without an effective workspace identity, only concurrent readers can safely share the result.
    const result = credentials.cacheable
      ? await cache.get(key, loadCatalog, { signal: context.signal, refresh: request.refresh })
      : await loadCatalog(context.signal)
    await revalidate(context.signal)
    await resolveAccount(context.signal)
    return result
  }
  return {
    discover(request: HarnessOptionsDiscoveryRequest,
      context: { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal }) {
      const key = commandInputHash({ harness: request.harness, target: request.target,
        accountBinding: request.accountBinding ?? null, refresh: request.refresh === true, connection: context.binding })
      return reads.get(key, signal => readCatalog(request, { binding: context.binding, signal }), { signal: context.signal })
    },
    async close() { await reads.close(); await cache.close() },
  }
}
