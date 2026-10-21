import { errorMessage } from '../../../shared/errorMessage.js'
import type { PayloadFingerprintCache } from '../payloadFingerprintCache.js'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import type { ClaudeQualificationPin } from '@foreman-code/contracts/claude-qualification'
import { claudeDiscoveryDeclaration } from '../claudeDiscovery.js'
import { discoverLauncher, type LauncherEvidence, type TargetEnvironment } from '../hostDiscovery.js'

export interface ClaudeSdkEntrypoint {
  /** Resolve the installed package, without importing its executable module. */
  entrypoint: string
  installedLockPath: string
  selectedExecutable?: string
  /** The installed SDK's native resolver, supplied by the host when no explicit override is selected. */
  nativeResolver?: (sdkEntrypoint: string) => Promise<string | undefined>
}
export interface ClaudeCurrentPinContext {
  hostGeneration: string
  harnessInstallationId: string
  environment: TargetEnvironment
  instanceRevision: string
  profilePath: string
}
export interface ClaudeOwnedVersionObservation {
  launcher: string
  installationFingerprint: string
  environmentGeneration: string
  version: string
  positiveProcessClosure: boolean
}
export type ClaudeCurrentPinResult = { status: 'available'; pin: ClaudeQualificationPin; launcher: LauncherEvidence;
  declaration: ReturnType<typeof claudeDiscoveryDeclaration> } | { status: 'unavailable'; reason: string }

/** Passive declaration uses installed files; a selected override is never replaced by another launcher. */
export async function discoverInstalledClaudeSdk(input: ClaudeSdkEntrypoint, context: Pick<ClaudeCurrentPinContext, 'harnessInstallationId' | 'environment'>, signal?: AbortSignal, fingerprintCache?: PayloadFingerprintCache) {
  signal?.throwIfAborted()
  const entrypoint = await realpath(input.entrypoint)
  const directory = dirname(entrypoint)
  const manifestPath = join(directory, 'package.json')
  const manifestText = await boundedText(manifestPath)
  const manifest = JSON.parse(manifestText) as { name?: unknown; version?: unknown }
  if (manifest.name !== '@anthropic-ai/claude-agent-sdk' || typeof manifest.version !== 'string'
    || !/^\d+\.\d+\.\d+$/u.test(manifest.version)) throw new Error('Installed Claude SDK manifest is invalid.')
  const lock = await boundedText(input.installedLockPath)
  const escapedVersion = manifest.version.replaceAll('.', '\\.')
  const integrity = new RegExp(`^  ['"]?@anthropic-ai/claude-agent-sdk@${escapedVersion}['"]?:\\r?\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`, 'mu').exec(lock)?.[1]
  if (!integrity) throw new Error('Installed Claude SDK resolution integrity is unavailable.')
  const selected = input.selectedExecutable ?? await input.nativeResolver?.(entrypoint)
  if (!selected || !isAbsolute(selected)) throw new Error('The actual SDK native executable selection is unavailable.')
  // Include all installed executable modules, not only the SDK facade/launcher.
  const modules = (await readdir(directory)).filter(name => /\.(?:mjs|js)$/u.test(name)).sort()
  if (modules.length === 0 || modules.length > 128) throw new Error('Installed SDK module inventory is unavailable or exceeds bounds.')
  const payloadPaths = [manifestPath, ...modules.map(name => join(directory, name))]
  for (const path of [selected, ...payloadPaths]) {
    if ((await stat(path)).size > 512 * 1024 * 1024) throw new Error('Selected launcher or SDK payload exceeds bounded inventory size.')
  }
  let launcher = await discoverLauncher(selected, context.environment, payloadPaths, signal, fingerprintCache)
  if (launcher.status === 'installed' && launcher.interpreter)
    launcher = await discoverLauncher(selected, context.environment, [...payloadPaths, launcher.interpreter], signal, fingerprintCache)
  if (launcher.status !== 'installed' || !launcher.resolvedLauncher || !launcher.fingerprint) throw new Error('Selected Claude SDK launcher or payload is unavailable.')
  return { sdkVersion: manifest.version, sdkIntegrity: integrity, launcher,
    declaration: claudeDiscoveryDeclaration({ harnessInstallationId: context.harnessInstallationId,
      requestedLauncher: selected, payloadPaths: launcher.payloadFingerprints!.map(value => value.path),
      protocolRevision: `claude-sdk-${manifest.version}` }) }
}
async function boundedText(path: string) {
  if (!isAbsolute(path) || (await stat(path)).size > 8 * 1024 * 1024) throw new Error('Installed metadata path is invalid or exceeds bounds.')
  return readFile(path, 'utf8')
}
/** Default resolution is passive require.resolve; it does not load SDK code or select a CLI. */
export function installedClaudeSdkEntrypoint(installedLockPath: string, selectedExecutable?: string,
  selectedSdkEntrypoint?: string): ClaudeSdkEntrypoint {
  return { entrypoint: selectedSdkEntrypoint ?? createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk'), installedLockPath,
    ...(selectedExecutable === undefined ? {} : { selectedExecutable }) }
}

/** Only the caller-owned, allowlisted, bounded probe can establish a current CLI version. */
export function createClaudeCurrentPinResolver(options: {
  sdk: ClaudeSdkEntrypoint
  ownedVersionProbe?: (input: { launcher: string; installationFingerprint: string; environmentGeneration: string;
    signal?: AbortSignal }) => Promise<ClaudeOwnedVersionObservation>
}) {
  const cache = new Map<string, ClaudeOwnedVersionObservation>()
  return async (context: ClaudeCurrentPinContext, signal?: AbortSignal): Promise<ClaudeCurrentPinResult> => {
    try {
      signal?.throwIfAborted()
      if (!context.hostGeneration || !context.harnessInstallationId || !context.environment.generation
        || !context.instanceRevision || !isAbsolute(context.profilePath) || context.profilePath.includes('\0'))
        return { status: 'unavailable', reason: 'Exact host, installation, environment and accepted profile revision are required.' }
      const current = await discoverInstalledClaudeSdk(options.sdk, context, signal)
      const key = JSON.stringify([context.hostGeneration, context.harnessInstallationId, context.environment,
        context.instanceRevision, context.profilePath, current.launcher.fingerprint, current.sdkIntegrity])
      let observed = cache.get(key)
      if (!observed) {
        if (!options.ownedVersionProbe) return { status: 'unavailable', reason: 'An owned trusted CLI version probe is unavailable.' }
        observed = await options.ownedVersionProbe({ launcher: current.launcher.resolvedLauncher!,
          installationFingerprint: current.launcher.fingerprint!, environmentGeneration: context.environment.generation,
          ...(signal ? { signal } : {}) })
      }
      signal?.throwIfAborted()
      if (!observed.positiveProcessClosure || observed.launcher !== current.launcher.resolvedLauncher
        || observed.installationFingerprint !== current.launcher.fingerprint || observed.environmentGeneration !== context.environment.generation
        || !/^\d+\.\d+\.\d+$/u.test(observed.version))
        return { status: 'unavailable', reason: 'CLI probe identity, version or positive process closure is unqualified.' }
      const after = await discoverInstalledClaudeSdk(options.sdk, context, signal)
      if (after.launcher.fingerprint !== current.launcher.fingerprint || after.sdkIntegrity !== current.sdkIntegrity)
        return { status: 'unavailable', reason: 'Selected installation changed during the owned version probe.' }
      if (cache.size >= 64) cache.delete(cache.keys().next().value!)
      cache.set(key, { ...observed })
      return { status: 'available', pin: { sdkVersion: current.sdkVersion, sdkIntegrity: current.sdkIntegrity,
        cliVersion: observed.version, executableSha256: current.launcher.payloadFingerprints!.find(value => value.path === current.launcher.resolvedLauncher)!.fingerprint,
        profilePath: context.profilePath, configRevision: context.instanceRevision }, launcher: current.launcher, declaration: current.declaration }
    } catch (error) {
      signal?.throwIfAborted()
      return { status: 'unavailable', reason: errorMessage(error, 'Current Claude installation is unreadable.') }
    }
  }
}
