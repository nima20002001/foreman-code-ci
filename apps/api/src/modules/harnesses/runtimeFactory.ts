import type { AcceptedProviderAccountBinding, ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { isDeepStrictEqual } from 'node:util'
import { HarnessConfigurationSchema, RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { captureOriginalCodexSession, type OriginalCodexSession } from './originalCodexSession.js'
import { createAdmittedNativeManager } from './admittedManager.js'
import type { ClaudeOwnedVersionObservation } from './claudeSdk/currentPin.js'
import { createAdmittedClaudeManager } from './claudeSdk/admittedManager.js'
import { allocateClaudeNativeHarness, type ClaudeNativeAllocation, type ClaudeNativeAllocationResult } from './claudeSdk/composition.js'
import type { HarnessConfiguration, NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { HarnessInstanceRegistry, localHarnessDrivers, type ConfiguredHarnessInstance } from './instanceRegistry.js'
import type { HarnessInstallationRegistry, RegistryHarnessSelection } from './installationRegistry.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { discoverLauncher } from './hostDiscovery.js'
import { CodexAppServerSessionManager, safeEnvironment, type CodexSessionDependencies } from './codexAppServer.js'
import { qualifyCodex, assertCodexUnchanged } from './codexProtocol.js'
import { CodexDiagnostics } from './codexDiagnostics.js'
import { runCommand } from './process.js'
import { binaryCacheIdentity } from './binaryIdentity.js'
import type { CodexNativeOutputs } from './codexNativeOutput.js'
import type { CodexChatFiles } from './codexFiles/runtime.js'
import { codexMcpInspectorAdapter } from './codexMcpInspectorAdapter.js'
import type { NativeMcpInspector } from './mcpDetection.js'
import type { NativeHarnessSessionManager, NativeSessionStart } from './port.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { NativeResponseJournal } from './recovery/responseJournal.js'
import type { ProviderAccountResolver, ResolvedProviderAccount } from '../provider-accounts/service.js'
import { pinnedCodexAccountEnvironment, resolveRuntimeProviderAccount } from './providerAccountRuntime.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

export type HarnessRuntimeRole = 'workflow' | 'operator' | 'agent-chat' | 'diagnostics' | 'qualification'
interface AllocationContext {
  role: HarnessRuntimeRole
  configured?: ConfiguredHarnessInstance
  selection?: RegistryHarnessSelection
  workingDirectory: string
  ownerAgentId: string
  processRecovery?: NativeProcessRecovery
  accountRecovery?: NativeProcessRecovery
  accountSourceRecovery?: NativeProcessRecovery
  accountBinding?: AcceptedProviderAccountBinding
  appMcpAccess: 'scoped' | 'none'
  revalidateSelection?: (signal?: AbortSignal) => Promise<void>
}
export type NativeHarnessAllocation = AllocationContext & {
  harness: 'codex'
  chatFiles?: CodexChatFiles
  nativeOutputs?: CodexNativeOutputs
}
export interface NativeHarnessAllocationResult {
  harness: 'codex'
  manager: CodexAppServerSessionManager
  inspector: NativeMcpInspector
}

interface CodexDiagnosticLifetime {
  readonly recovery: NativeProcessRecovery
  readonly writerOwner: string | undefined
  readonly controller: AbortController
  readonly operations: Set<Promise<unknown>>
  active: boolean
  admitted: boolean
  task?: Promise<unknown>
  cleanup?: Promise<void>
}
export type NativeFactoryInfrastructure =
  | { mode: 'native'; codex?: CodexSessionDependencies }
  | { mode: 'replay'; codex: CodexSessionDependencies & { mode: 'replay' } }

/** Shares construction code only. Every allocation constructs a new real adapter
 * and retains the caller's initially unreserved recovery scope. */
export class NativeHarnessFactories {
  readonly instances: HarnessInstanceRegistry
  private readonly configurations = new Map<string, ConfiguredHarnessInstance>()
  private auxiliaryClosing = false
  private readonly auxiliaries = new Map<NativeHarnessSessionManager, { recovery: NativeProcessRecovery | undefined; admitted: boolean; admissionError?: unknown; admission?: Promise<void>; disposal?: Promise<void> }>()
  private readonly closedAuxiliaries = new WeakSet<NativeHarnessSessionManager>()
  private readonly codexDiagnostics: CodexDiagnostics
  private readonly versionDiagnostics = new Set<CodexDiagnosticLifetime>()
  private readonly originalCodexManagers = new WeakMap<NativeHarnessSessionManager, () => CodexAppServerSessionManager | undefined>()
  private readonly inspectors = new WeakMap<NativeHarnessSessionManager, NativeMcpInspector>()
  constructor(private readonly config: {
    codexBinary: string
    accounts?: ProviderAccountResolver
    refreshInstallations?: (signal?: AbortSignal) => Promise<void>
    responseJournal?: NativeResponseJournal
    instances?: HarnessInstanceRegistry
    installations?: HarnessInstallationRegistry
    installationDiscovery?: typeof discoverLauncher
    selectDefault?: (harness: 'codex') => RegistryHarnessSelection
    selectConfiguration?: (configuration: HarnessConfiguration) => RegistryHarnessSelection
    selectAccount?: (binding: ProviderAccountBinding) => RegistryHarnessSelection
    auxiliaryRecovery?: (role: 'diagnostics' | 'qualification') => NativeProcessRecovery
    admitRecovery?: (recovery: NativeProcessRecovery) => void | Promise<void>
    abandonRecovery?: (recovery: NativeProcessRecovery) => Promise<void>
    closeRecovery?: (recovery: NativeProcessRecovery) => Promise<void>
    claudeVersionCommand?: typeof runCommand
  }, private readonly infrastructure: NativeFactoryInfrastructure = { mode: 'native' }) {
    this.codexDiagnostics = new CodexDiagnostics({
      native: infrastructure.codex,
      createRecovery: config.auxiliaryRecovery ? () => config.auxiliaryRecovery!('diagnostics') : undefined,
      admitRecovery: config.admitRecovery,
      abandonRecovery: config.abandonRecovery,
      closeRecovery: config.closeRecovery,
    })
    this.instances = config.instances ?? new HarnessInstanceRegistry(localHarnessDrivers)
    if (infrastructure.mode === 'native' && infrastructure.codex?.mode === 'replay') {
      throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay dependencies require the complete replay environment.', 500)
    }
    if (infrastructure.mode === 'replay' && (!infrastructure.codex || infrastructure.codex.mode !== 'replay')) {
      throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay requires every provider infrastructure port.', 500)
    }
  }

  async cacheIdentity(harness: 'codex', directory: string, configuration?: HarnessConfiguration,
    accountBinding?: ProviderAccountBinding) {
    await this.config.refreshInstallations?.()
    if (accountBinding && !this.config.selectAccount) throw new DomainError(
      'HARNESS_ACCOUNT_SELECTION_UNAVAILABLE', 'Select the qualified installed profile for this account before discovery.', 409)
    let selection: RegistryHarnessSelection | undefined
    if (accountBinding) selection = this.config.selectAccount!(accountBinding)
    else if (configuration) selection = this.config.selectConfiguration?.(configuration)
    else selection = this.config.selectDefault?.(harness)
    const binary = selection?.installation.launcher.resolvedLauncher
      ?? this.config.codexBinary
    let account: ResolvedProviderAccount | null = null
    if (accountBinding) {
      account = await resolveRuntimeProviderAccount(this.config.accounts, harness, accountBinding.accountId,
        undefined, undefined, accountBinding)
    } else if (configuration?.harness === 'codex' && configuration.accountId) {
      account = await resolveRuntimeProviderAccount(this.config.accounts, harness, configuration.accountId)
    }
    if (accountBinding && (!selection || !isDeepStrictEqual(selection.selection.hostRef, accountBinding.target.hostRef))) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'Model discovery requires the owning account installation.', 409)
    }
    return commandInputHash({ binary: await binaryCacheIdentity(harness, binary, directory), accountBinding: accountBinding ?? account?.binding,
      profile: account?.homePath, selection: selection?.selection, inventoryRevision: selection?.inventoryRevision,
      environmentGeneration: selection?.installation.environmentGeneration,
      connectionGeneration: selection?.installation.connectionGeneration })
  }

  allocateAdmitted(harness: 'codex',
    prepare: (signal: AbortSignal) => Promise<NativeHarnessAllocation>) {
    const result = createAdmittedNativeManager<NativeHarnessSessionManager>(harness, async (signal) => {
      const accepted = await prepare(signal)
      signal.throwIfAborted()
      return this.allocate(accepted)
    })
    this.inspectors.set(result.manager, result.inspector)
    if (harness === 'codex') this.originalCodexManagers.set(result.manager, () => {
      const current = result.peek()
      return current ? this.originalCodexManagers.get(current)?.() : undefined
    })
    return { manager: result.manager, inspector: result.inspector }
  }

  allocateAdmittedClaude(prepare: (signal: AbortSignal) => Promise<ClaudeNativeAllocation>,
    allocated?: (result: ClaudeNativeAllocationResult) => void): ClaudeNativeAllocationResult {
    const result = createAdmittedClaudeManager(async signal => {
      const admitted = await prepare(signal)
      signal.throwIfAborted()
      const result = this.allocate(admitted)
      allocated?.(result)
      return result
    })
    this.inspectors.set(result.manager, result.inspector)
    return result
  }

  allocate(input: ClaudeNativeAllocation): ClaudeNativeAllocationResult
  allocate(input: NativeHarnessAllocation): NativeHarnessAllocationResult
  allocate(input: NativeHarnessAllocation | ClaudeNativeAllocation): NativeHarnessAllocationResult | ClaudeNativeAllocationResult {
    if (input.harness === 'claude') {
      const auxiliary = input.role === 'diagnostics' || input.role === 'qualification'
      if (auxiliary && this.auxiliaryClosing) throw new DomainError(
        'NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
      const recovery = input.processRecovery ?? (auxiliary
        ? this.config.auxiliaryRecovery?.(input.role as 'diagnostics' | 'qualification') : undefined)
      // The domain owner supplies the exact admitted scope, qualified policy and
      // runner. There is no default profile or implicit native SDK fallback.
      const result = allocateClaudeNativeHarness({ ...input, ...(recovery ? { processRecovery: recovery } : {}) })
      if (auxiliary) {
        this.auxiliaries.set(result.manager, { recovery, admitted: false })
        const inspector = result.inspector
        if (inspector) result.inspector = { inspect: async (request) => {
          await this.admitAuxiliary(result.manager)
          return inspector.inspect(request)
        } }
      }
      if (result.inspector) this.inspectors.set(result.manager, result.inspector)
      return result
    }
    if (!input.selection && input.harness === 'codex' && input.role === 'diagnostics'
      && input.accountBinding?.kind === 'slot') {
      if (!this.config.selectAccount) throw new DomainError('HARNESS_ACCOUNT_SELECTION_UNAVAILABLE',
        'Account discovery requires its qualified installed native profile.', 409)
      input = { ...input, selection: this.config.selectAccount(input.accountBinding) }
    }
    if (!input.selection && (input.role === 'diagnostics' || input.role === 'qualification') && this.config.selectDefault) {
      input = { ...input, selection: this.config.selectDefault(input.harness) }
    }
    if (input.selection) {
      if (!this.config.installations) throw new DomainError('HARNESS_SELECTION_UNAVAILABLE', 'Canonical installation selection is not composed.', 503)
      this.config.installations.assertCurrent(input.selection)
      const selected = input.selection.instance
      if (selected.driverId !== input.harness || (input.configured
        && (input.configured.instanceId !== selected.instanceId || input.configured.instanceRevision !== selected.instanceRevision
          || commandInputHash(input.configured.configuration) !== commandInputHash(selected.configuration)))) {
        throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The accepted configuration differs from its canonical installation selection.', 409)
      }
      if (!input.selection.installation.launcher.resolvedLauncher || !input.selection.installation.installationFingerprint) {
        throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'Exact launcher and payload evidence is required before allocation.', 409)
      }
    } else if (input.configured) {
      if (input.configured.driverId !== input.harness) throw new DomainError(
        'HARNESS_CONFIGURATION_MISMATCH', 'The configured driver differs from the selected harness.', 409)
      const prior = this.configurations.get(input.configured.instanceId)
      if (!prior || prior.instanceRevision !== input.configured.instanceRevision) {
        const next = new Map(this.configurations)
        next.set(input.configured.instanceId, input.configured)
        this.instances.reload([...next.values()])
        this.configurations.set(input.configured.instanceId, structuredClone(input.configured))
      } else if (JSON.stringify(prior) !== JSON.stringify(input.configured)) {
        throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The accepted configured revision is immutable.', 409)
      }
      this.instances.select(input.configured.instanceId)
    }
    if ((input.role === 'diagnostics' || input.role === 'qualification')
      && input.appMcpAccess !== 'none') {
      throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'This runtime role has no application MCP credentials.', 403)
    }
    if (input.chatFiles && input.appMcpAccess === 'scoped' && input.role !== 'operator' && input.role !== 'agent-chat') {
      throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID',
        'Only conversation owners can combine file tools with scoped application credentials.', 403)
    }
    const auxiliary = input.role === 'diagnostics' || input.role === 'qualification'
    if (auxiliary && this.auxiliaryClosing) throw new DomainError(
      'NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
    const recovery = input.processRecovery ?? (auxiliary ? this.config.auxiliaryRecovery?.(input.role as 'diagnostics' | 'qualification') : undefined)
    let result: NativeHarnessAllocationResult
    if (input.harness === 'codex') {
      const rawConfiguration = input.configured?.configuration ?? input.selection?.instance.configuration
      const configuration = rawConfiguration ? HarnessConfigurationSchema.parse(rawConfiguration) : undefined
      const account = pinnedCodexAccountEnvironment(this.config.accounts,
        configuration?.harness === 'codex' ? configuration.accountId : undefined,
        input.accountRecovery ?? (auxiliary ? undefined : recovery), input.accountSourceRecovery, input.accountBinding)
      const environment = (variables?: NativeSessionStart['environment'], scopedNames: readonly string[] = []) => {
        const source = this.infrastructure.codex?.environment?.(variables, scopedNames)
          ?? safeEnvironment(variables, scopedNames)
        return account.environment(source)
      }
      let dependencies: CodexSessionDependencies | undefined = this.infrastructure.mode === 'native'
        ? { ...this.infrastructure.codex, mode: 'native',
          qualify: async (binary, cwd, environment, authenticated, signal) => {
            await input.revalidateSelection?.(signal)
            if (input.selection) await this.assertInstallationUnchanged(input.selection, signal)
            const qualified = await (this.infrastructure.codex?.qualify
              ?? ((selectedBinary, selectedCwd, selectedEnvironment, requireAuthentication, selectedSignal) =>
                qualifyCodex(selectedBinary, selectedCwd, selectedEnvironment, requireAuthentication, selectedSignal, recovery)))(
              binary, cwd, environment, authenticated, signal)
            await input.revalidateSelection?.(signal)
            if (input.selection) await this.assertInstallationUnchanged(input.selection, signal)
            return qualified
          },
          assertUnchanged: async (qualified) => {
            await input.revalidateSelection?.()
            await (this.infrastructure.codex?.assertUnchanged ?? assertCodexUnchanged)(qualified)
            if (input.selection) await this.assertInstallationUnchanged(input.selection)
          },
          withDiagnostics: (pin, run) => this.codexDiagnostics.run(pin, async (io) => {
            if (input.selection) await this.assertInstallationUnchanged(input.selection, pin.signal)
            const result = await run(io)
            if (input.selection) await this.assertInstallationUnchanged(input.selection, pin.signal)
            return result
          }, recovery) }
        : this.infrastructure.codex
      if (this.infrastructure.mode === 'replay' && input.revalidateSelection) {
        const replay = this.infrastructure.codex
        dependencies = { ...replay,
          qualify: async (...args) => {
            await input.revalidateSelection?.(args[4])
            if (input.selection) await this.assertInstallationUnchanged(input.selection, args[4])
            const result = await replay.qualify(...args)
            await input.revalidateSelection?.(args[4])
            if (input.selection) await this.assertInstallationUnchanged(input.selection, args[4])
            return result
          },
          assertUnchanged: async qualified => {
            await input.revalidateSelection?.()
            await replay.assertUnchanged(qualified)
            if (input.selection) await this.assertInstallationUnchanged(input.selection)
          },
        }
      }
      if (input.nativeOutputs && (input.role !== 'workflow' || input.appMcpAccess !== 'scoped')) {
        throw new DomainError('WORKER_NATIVE_OUTPUT_UNAVAILABLE', 'Native output requires the original scoped workflow allocation.', 403)
      }
      const diagnostic = dependencies!.withDiagnostics!
      dependencies = { ...dependencies!, prepareEnvironment: async () => { await account.prepare(); await account.revalidate() }, environment,
        withDiagnostics: (pin, run) => diagnostic(pin, async io => {
          return run({ ...io, environment: (variables, scopedNames) =>
            account.environment(io.environment(variables, scopedNames)) })
        }) }
      const manager = new CodexAppServerSessionManager(input.selection?.installation.launcher.resolvedLauncher ?? this.config.codexBinary, undefined, undefined,
        recovery, input.appMcpAccess, input.chatFiles, dependencies, undefined, input.nativeOutputs,
        this.config.responseJournal)
      this.originalCodexManagers.set(manager, () => manager)
      result = { harness: 'codex', manager, inspector: codexMcpInspectorAdapter(manager) }
    } else {
      throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'The selected harness driver is unavailable.', 503)
    }
    if (auxiliary) {
      this.auxiliaries.set(result.manager, { recovery, admitted: false })
      const inspector = result.inspector
      result.inspector = { inspect: async (request) => { await this.admitAuxiliary(result.manager); return inspector.inspect(request) } }
    } else if (this.infrastructure.mode === 'native') {
      const inspector = result.inspector
      result.inspector = { inspect: async request => {
        if (request.phase !== 'configuration') return inspector.inspect(request)
        await input.revalidateSelection?.(request.signal)
        const diagnosticRecovery = this.config.auxiliaryRecovery?.('diagnostics')
        if (recovery && (!diagnosticRecovery || diagnosticRecovery.owner === recovery.owner
          || !this.config.admitRecovery || !this.config.abandonRecovery || !this.config.closeRecovery)) {
          throw new DomainError('HARNESS_DIAGNOSTIC_OWNER_REQUIRED',
            'Configuration inspection requires a separate owned process lifetime.', 503)
        }
        const diagnostic = this.allocate({
          harness: input.harness,
          role: 'diagnostics',
          workingDirectory: input.workingDirectory,
          ownerAgentId: input.ownerAgentId,
          appMcpAccess: 'none',
          ...(diagnosticRecovery ? { processRecovery: diagnosticRecovery } : {}),
          ...(recovery ? { accountRecovery: input.accountRecovery ?? recovery } : {}),
          ...(input.accountSourceRecovery ? { accountSourceRecovery: input.accountSourceRecovery } : {}),
          ...(input.accountBinding ? { accountBinding: input.accountBinding } : {}),
          ...(input.selection ? { selection: input.selection } : {}),
          ...(input.configured ? { configured: input.configured } : {}),
          ...(input.revalidateSelection ? { revalidateSelection: input.revalidateSelection } : {}),
        })
        try {
          return await diagnostic.inspector.inspect(request)
        } finally {
          await this.disposeAuxiliary(diagnostic.manager)
        }
      } }
    }
    this.inspectors.set(result.manager, result.inspector)
    return result
  }

  /** Passive capture on this factory's actual retained adapter. The caller supplies
   * its original role/lease/writer/process fence; no allocation or cold attach. */
  originalCodexSession(manager: NativeHarnessSessionManager, session: NativeSessionReference,
    source: NativeSessionStart, assertOwnerCurrent: () => void): OriginalCodexSession | undefined {
    assertOwnerCurrent()
    const current = this.originalCodexManagers.get(manager)?.()
    if (!current) return undefined
    return captureOriginalCodexSession(current, session, source, () => {
      assertOwnerCurrent()
      if (this.originalCodexManagers.get(manager)?.() !== current) throw new DomainError(
        'NATIVE_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The original admitted adapter is no longer current.', 409)
    })
  }

  async assertInstallationUnchanged(binding: RegistryHarnessSelection, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    this.config.installations?.assertCurrent(binding)
    const prior = binding.installation.launcher
    const launcher = prior.resolvedLauncher
    if (!launcher || !binding.installation.installationFingerprint) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The selected payload evidence is unavailable.', 409)
    if (this.infrastructure.mode === 'replay' && !this.config.installationDiscovery) throw new DomainError(
      'HARNESS_REPLAY_INCOMPLETE', 'Replay installation inspection requires its explicit filesystem port.', 500)
    const current = await (this.config.installationDiscovery ?? discoverLauncher)(launcher, prior.environment,
      (prior.payloadFingerprints ?? []).filter((item) => item.path !== launcher).map((item) => item.path), signal)
    signal?.throwIfAborted()
    if (current.fingerprint !== binding.installation.installationFingerprint || current.interpreter !== prior.interpreter) throw new DomainError(
      'HARNESS_INSTALLATION_CHANGED', 'The selected launcher, interpreter or native payload changed after admission.', 409)
  }

  async qualifyConfiguration(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal) {
    if (configuration.harness === 'opencode') throw new DomainError('HARNESS_RETIRED',
      RETIRED_OPENCODE_MESSAGE, 409)
    await this.config.refreshInstallations?.(signal)
    if (configuration.harness === 'claude') throw new DomainError('CLAUDE_NATIVE_QUALIFICATION_UNAVAILABLE',
      'The Claude preset is saved, but native profile qualification is not available in this runtime. Execution still requires verified authentication, sandbox isolation and lifecycle evidence for the exact host profile.', 409)
    const selection = this.config.selectConfiguration?.(configuration)
    const allocation = this.allocate({ harness: configuration.harness, role: 'qualification',
      ...(selection ? { selection, configured: selection.instance } : { configured: {
        instanceId: 'configuration-qualification', instanceRevision: commandInputHash(configuration),
        driverId: configuration.harness, enabled: true, configuration,
      } }), workingDirectory, ownerAgentId: 'configuration-qualification', appMcpAccess: 'none',
    })
    try {
      await this.admitAuxiliary(allocation.manager)
      if (allocation.harness === 'codex' && configuration.harness === 'codex') {
        return await allocation.manager.qualifyConfiguration(configuration, workingDirectory, signal)
      }
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The configuration differs from its allocated driver.', 409)
    } finally { await this.disposeAuxiliary(allocation.manager) }
  }

  observeClaudeVersion(binding: RegistryHarnessSelection, workingDirectory: string, signal?: AbortSignal): Promise<ClaudeOwnedVersionObservation> {
    if (binding.selection.driverId !== 'claude' || !binding.installation.launcher.resolvedLauncher) return Promise.reject(new DomainError(
      'HARNESS_CONFIGURATION_MISMATCH', 'A Claude version probe requires the exact installed Claude binding.', 409))
    if (this.auxiliaryClosing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503))
    if (!this.config.auxiliaryRecovery || !this.config.admitRecovery || !this.config.abandonRecovery || !this.config.closeRecovery
      || !this.config.claudeVersionCommand) return Promise.reject(new DomainError('HARNESS_DIAGNOSTIC_OWNER_REQUIRED',
      'Claude version inspection requires an injected command and positive owned process closure.', 503))
    if ([...this.versionDiagnostics].some(owned => !owned.active)) return Promise.reject(new DomainError('HARNESS_DIAGNOSTIC_CLEANUP_PENDING', 'Retry retained version diagnostic cleanup before another inspection.', 409))
    if (this.versionDiagnostics.size >= 32) return Promise.reject(new DomainError('HARNESS_DIAGNOSTIC_LIMIT', 'Too many version diagnostics are owned.', 503))
    const recovery = this.config.auxiliaryRecovery('diagnostics')
    const owned: CodexDiagnosticLifetime = { recovery, writerOwner: undefined, controller: new AbortController(), operations: new Set(), active: true, admitted: false }
    const combined = signal ? AbortSignal.any([signal, owned.controller.signal]) : owned.controller.signal
    this.versionDiagnostics.add(owned)
    const task = Promise.resolve().then(async () => {
      combined.throwIfAborted()
      await this.assertInstallationUnchanged(binding, combined)
      await this.config.admitRecovery!(recovery)
      combined.throwIfAborted()
      owned.admitted = true
      const environment: NodeJS.ProcessEnv = { PATH: binding.installation.launcher.environment.path }
      for (const name of ['LANG', 'LC_ALL', 'TMPDIR']) if (process.env[name] !== undefined) environment[name] = process.env[name]
      const observed = await this.config.claudeVersionCommand!(binding.installation.launcher.resolvedLauncher!, ['--version'], workingDirectory,
        combined, environment, { recovery, maxOutputBytes: 16_384 })
      combined.throwIfAborted()
      await this.assertInstallationUnchanged(binding, combined)
      const version = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?\s*$/u.exec(observed.stdout)?.[1]
      if (observed.exitCode !== 0 || !version) throw new DomainError('CLAUDE_VERSION_UNAVAILABLE', 'The owned Claude version probe returned no exact CLI version.', 409)
      return { launcher: binding.installation.launcher.resolvedLauncher!, installationFingerprint: binding.selection.installationFingerprint,
        environmentGeneration: binding.installation.environmentGeneration, version, positiveProcessClosure: true }
    }).finally(async () => {
      owned.active = false
      owned.controller.abort(new Error('Version diagnostic is closed.'))
      await this.closeVersionDiagnostic(owned)
    }).then(result => {
      signal?.throwIfAborted()
      if (this.auxiliaryClosing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics are shutting down.', 503)
      return result
    })
    owned.task = task
    return task
  }

  private closeVersionDiagnostic(owned: CodexDiagnosticLifetime): Promise<void> {
    if (owned.cleanup) return owned.cleanup
    const cleanup = Promise.resolve().then(async () => {
      if (owned.admitted || owned.recovery.launchId !== undefined) {
        if (owned.recovery.launchId !== undefined) await this.config.abandonRecovery!(owned.recovery)
        await this.config.closeRecovery!(owned.recovery)
      }
      this.versionDiagnostics.delete(owned)
    })
    owned.cleanup = cleanup
    void cleanup.catch(() => { if (owned.cleanup === cleanup) delete owned.cleanup })
    return cleanup
  }

  stopAuxiliaries(): void {
    this.auxiliaryClosing = true
    this.codexDiagnostics.stop()
    for (const owned of this.versionDiagnostics) owned.controller.abort(new Error('Native diagnostics are shutting down.'))
    // Disposal aborts each real adapter's in-flight diagnostic requests. The
    // drain/dispose phase joins these same retained attempts and reports failures.
    for (const manager of this.auxiliaries.keys()) void this.disposeAuxiliary(manager).catch(ignoreError('harness', 'dispose auxiliary manager', { harness: manager.harness }))
  }

  async admitAuxiliary(manager: NativeHarnessSessionManager): Promise<void> {
    if (this.auxiliaryClosing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
    const owned = this.auxiliaries.get(manager)
    if (!owned) throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'Only diagnostic and qualification owners use this admission boundary.', 403)
    if (owned.admissionError) throw owned.admissionError
    if (owned.disposal) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
    if (!owned.admitted) {
      owned.admission ??= Promise.resolve().then(async () => {
        try {
          if (owned.recovery && this.config.admitRecovery) await this.config.admitRecovery(owned.recovery)
          owned.admitted = true
        } catch (error) { owned.admissionError = error; throw error }
      })
      await owned.admission
    }
    if (this.auxiliaryClosing || owned.disposal) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'Native diagnostics and qualification are shutting down.', 503)
  }

  disposeAuxiliary(manager: NativeHarnessSessionManager): Promise<void> {
    if (this.closedAuxiliaries.has(manager)) return Promise.resolve()
    const owned = this.auxiliaries.get(manager)
    if (!owned) return Promise.reject(new DomainError(
      'HARNESS_ROLE_AUTHORITY_INVALID', 'Only diagnostic and qualification owners use this cleanup boundary.', 403))
    if (owned.disposal) return owned.disposal
    const attempt = Promise.resolve().then(async () => {
      if (owned.admission) {
        try { await owned.admission } catch (error) {
          if (error !== owned.admissionError) throw error
          // A failed admission is retained below; disposal still closes any published reservation.
        }
      }
      await manager.dispose!()
      const reservedDuringFailure = owned.admissionError !== undefined && owned.recovery?.launchId !== undefined
      if ((owned.admitted || reservedDuringFailure) && owned.recovery && this.config.closeRecovery) {
        if (owned.recovery.launchId !== undefined) await this.config.abandonRecovery?.(owned.recovery)
        await this.config.closeRecovery(owned.recovery)
      }
      this.auxiliaries.delete(manager)
      this.closedAuxiliaries.add(manager)
    })
    owned.disposal = attempt
    void attempt.catch(() => { if (owned.disposal === attempt) delete owned.disposal })
    return attempt
  }

  async disposeAuxiliaries(): Promise<void> {
    const diagnosticResults = await Promise.allSettled([
      this.codexDiagnostics.dispose(),
      Promise.allSettled([...this.versionDiagnostics].flatMap(owned => owned.task ? [owned.task] : [])),
    ])
    const results = [
      ...diagnosticResults,
      ...await Promise.allSettled([...this.auxiliaries.keys()].map(manager => this.disposeAuxiliary(manager))),
      ...await Promise.allSettled([...this.versionDiagnostics].map(owned => this.closeVersionDiagnostic(owned))),
    ]
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Native diagnostic/qualification cleanup was incomplete.')
  }
  inspector(manager: NativeHarnessSessionManager): NativeMcpInspector {
    const inspector = this.inspectors.get(manager)
    if (!inspector) throw new DomainError('HARNESS_INSPECTOR_UNAVAILABLE', 'The allocated driver has no MCP inspector.', 503)
    return inspector
  }
}
