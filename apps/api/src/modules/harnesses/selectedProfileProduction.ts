import { assertRuntimeProviderAccountProfile } from './providerAccountRuntime.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { withAdvancedDefaults, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { NativeHarnessFactories, NativeHarnessAllocation, HarnessRuntimeRole } from './runtimeFactory.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import type { AcceptedHarnessProfileAdmission, AcceptedProfileSelector } from './instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from './claudeSdk/production.js'

/** Exact selected profiles never fall through to unselected local defaults.
 * The existing native adapter still performs its protocol/model/auth checks. */
export function productionSelectedProfileManager(input: {
  factories: NativeHarnessFactories
  registry: ProductionHarnessRegistry
  profiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  selector: AcceptedProfileSelector
  binding: ClaudeProfileOwner
  configuration: CodexHarnessConfiguration
  role: Extract<HarnessRuntimeRole, 'workflow' | 'operator' | 'agent-chat'>
  workingDirectory: string
  ownerAgentId: string
  recovery: NativeProcessRecovery
  nativeSessionId?: string
  accountSourceRecovery?: NativeProcessRecovery
  accountBinding?: AcceptedProviderAccountBinding
  appMcpAccess: 'scoped' | 'none'
  files?: Extract<NativeHarnessAllocation, { harness: 'codex' }>['chatFiles']
  nativeOutputs?: Extract<NativeHarnessAllocation, { harness: 'codex' }>['nativeOutputs']
}) {
  input = { ...input, configuration: structuredClone(input.configuration), selector: structuredClone(input.selector),
    ...(input.accountBinding ? { accountBinding: structuredClone(input.accountBinding) } : {}) }
  const result = input.factories.allocateAdmitted(input.configuration.harness, async (signal) => {
    const owner = { ...input.binding, admissionSignal: signal }
    const accepted = await withProfileReady(() => input.profiles.admit(owner, input.selector), signal)
    assertRuntimeProviderAccountProfile(input.accountBinding, accepted.override.target)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(withAdvancedDefaults(accepted.override.configuration), withAdvancedDefaults(input.configuration))) throw new DomainError('HARNESS_CONFIGURATION_MISMATCH',
      'The accepted configured profile differs from this immutable native configuration.', 409)
    if (accepted.override.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH',
      'A selected registered-device profile must execute through its authenticated host.', 409)
    const selection = input.registry.pinOverride(accepted.override)
    const common = { selection, configured: selection.instance, role: input.role, workingDirectory: input.workingDirectory,
      ownerAgentId: input.ownerAgentId, processRecovery: input.recovery, appMcpAccess: input.appMcpAccess,
      ...(input.accountSourceRecovery ? { accountSourceRecovery: input.accountSourceRecovery } : {}),
      ...(input.accountBinding ? { accountBinding: input.accountBinding } : {}),
      revalidateSelection: (effectSignal?: AbortSignal) => {
        const currentOwner = { ...owner, admissionSignal: effectSignal ?? signal }
        return withProfileReady(() => input.profiles.revalidate(currentOwner, accepted), effectSignal ?? signal)
      } }
    return { ...common, harness: 'codex',
      ...(input.files ? { chatFiles: input.files } : {}),
      ...(input.nativeOutputs ? { nativeOutputs: input.nativeOutputs } : {}) }
  })
  async function withProfileReady<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      signal.throwIfAborted()
      try {
        return await read()
      }
      catch (error) {
        if (!input.nativeSessionId || !(error instanceof DomainError)
          || error.code !== 'HARNESS_PROFILE_CHECK_PENDING') throw error
        await delay(100, undefined, { signal })
      }
    }
  }
  result.manager.setSessionControlPrincipal = principalId => {
    if (input.binding.kind === 'operator' || input.binding.kind === 'agent') input.binding.controlPrincipalId = principalId
  }
  return result
}
