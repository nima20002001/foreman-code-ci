import { logIgnoredError } from '../../diagnostics/ignoredError.js'
import { inventoryPayloadFingerprints } from '../payloadFingerprintCache.js'
import { createRequire } from 'node:module'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { AcceptedProfileAuthority } from '../instanceSettings/acceptedProfile.js'
import type { TargetEnvironment } from '../hostDiscovery.js'
import type { NativeHarnessFactories } from '../runtimeFactory.js'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { ClaudeProfileOwner } from './production.js'
import { DomainError } from '../../errors.js'
import { createClaudeCurrentPinResolver, discoverInstalledClaudeSdk, type ClaudeSdkEntrypoint } from './currentPin.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './profileRevision.js'

let muslRuntime: boolean | undefined

function usesMusl() {
  if (process.platform !== 'linux') return false
  if (muslRuntime === undefined) {
    const report = process.report.getReport()
    muslRuntime = Boolean(report && typeof report === 'object' && 'header' in report
      && !(report.header as { glibcVersionRuntime?: string }).glibcVersionRuntime)
  }
  return muslRuntime
}

/** Pinned SDK 0.3.284's own native package algorithm, inspected in its installed
 * source. Selection resolves package files only; no module execution or PATH CLI. */
async function sdkNativeExecutable(entrypoint: string): Promise<string | undefined> {
  const requireSdk = createRequire(entrypoint)
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const musl = usesMusl()
  const packages = process.platform === 'linux'
    ? (musl ? [`linux-${process.arch}-musl`, `linux-${process.arch}`] : [`linux-${process.arch}`, `linux-${process.arch}-musl`])
    : [`${process.platform}-${process.arch}`]
  for (const target of packages) {
    try { return await realpath(requireSdk.resolve(`@anthropic-ai/claude-agent-sdk-${target}/claude${suffix}`)) }
    catch (error) {
      if (!['MODULE_NOT_FOUND', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      logIgnoredError('harness', 'select Claude native package', error)
    }
  }
  return undefined
}
function installedSdk(): ClaudeSdkEntrypoint {
  let entrypoint: string
  try { entrypoint = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk') }
  catch { throw new DomainError('CLAUDE_INSTALLED_METADATA_UNAVAILABLE', 'The installed Claude SDK entrypoint is unavailable.', 409) }
  const marker = '/node_modules/.pnpm/'
  const offset = entrypoint.indexOf(marker)
  if (offset < 0) throw new DomainError('CLAUDE_INSTALLED_METADATA_UNAVAILABLE', 'The installed SDK resolution lock is unavailable.', 409)
  return { entrypoint, installedLockPath: join(entrypoint.slice(0, offset), 'node_modules/.pnpm/lock.yaml'), nativeResolver: sdkNativeExecutable }
}

/** Startup uses only the passive half. CLI --version is a separately owned,
 * bounded diagnostic during the actual accepted profile operation. */
export function createClaudeProductionDiscovery(input: {
  registry(): ProductionHarnessRegistry
  factories(): NativeHarnessFactories
  workingDirectory: string
}) {
  const resolvers = new Map<string, ReturnType<typeof createClaudeCurrentPinResolver>>()
  const discover = async (host: Extract<CanonicalMachineReference, { kind: 'main' }>, environment: TargetEnvironment, signal?: AbortSignal) => {
    try {
      signal?.throwIfAborted()
      const sdk = installedSdk(), selectedExecutable = await sdkNativeExecutable(sdk.entrypoint)
      if (!selectedExecutable) return null
      const harnessInstallationId = commandInputHash({ hostRef: host, driverId: 'claude', launcher: selectedExecutable })
      return await discoverInstalledClaudeSdk({ ...sdk, selectedExecutable }, { harnessInstallationId, environment }, signal, inventoryPayloadFingerprints)
    } catch { signal?.throwIfAborted(); return null }
  }
  const currentForConfiguration = async (value: Parameters<AcceptedProfileAuthority<ClaudeProfileOwner>['current']>[1], signal?: AbortSignal) => {
    if (value.configuration.harness !== 'claude' || value.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
      'The current Claude pin must come from its actual authenticated execution host.', 409)
    const binding = input.registry().pinOverride(value)
    const selectedExecutable = binding.installation.launcher.resolvedLauncher
    if (!selectedExecutable) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The exact installed Claude launcher is unavailable.', 409)
    const sdk = { ...installedSdk(), selectedExecutable }
    const key = JSON.stringify([sdk.entrypoint, sdk.installedLockPath, selectedExecutable, binding.inventoryRevision, binding.selection,
      binding.installation.environmentGeneration, binding.installation.connectionGeneration, value.instanceRevision, value.configuration.configDirectory])
    let resolve = resolvers.get(key)
    if (!resolve) {
      if (resolvers.size >= 64) resolvers.delete(resolvers.keys().next().value!)
      resolve = createClaudeCurrentPinResolver({ sdk, ownedVersionProbe: async observed => {
        if (observed.launcher !== binding.installation.launcher.resolvedLauncher
          || observed.installationFingerprint !== binding.selection.installationFingerprint
          || observed.environmentGeneration !== binding.installation.environmentGeneration) throw new DomainError('HARNESS_INSTALLATION_CHANGED',
          'The current SDK declaration differs from the accepted installation.', 409)
        return input.factories().observeClaudeVersion(binding, input.workingDirectory, observed.signal)
      } })
      resolvers.set(key, resolve)
    }
    const observed = await resolve({ hostGeneration: binding.installation.connectionGeneration,
      harnessInstallationId: binding.selection.harnessInstallationId, environment: binding.installation.launcher.environment,
      instanceRevision: value.instanceRevision, profilePath: value.configuration.configDirectory }, signal)
    if (observed.status !== 'available') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', observed.reason, 409)
    if (observed.launcher.fingerprint !== binding.selection.installationFingerprint) throw new DomainError('HARNESS_INSTALLATION_CHANGED',
      'The installed SDK and native payload changed after profile selection.', 409)
    input.registry().installations.assertCurrent(binding)
    return { registry: binding, applicationInstallationId: value.target.hostRef.mainId, suiteRevision: CLAUDE_PROFILE_CHECK_REVISION, pin: observed.pin }
  }
  const current: AcceptedProfileAuthority<ClaudeProfileOwner>['current'] = (owner, value) => currentForConfiguration(value, owner.admissionSignal)
  return { discover, current, currentForConfiguration }
}
