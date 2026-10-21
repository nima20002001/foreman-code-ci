import { ClaudeHarnessConfigurationSchema } from '@foreman-code/contracts/claude'
import { requireClaudePolicyQualification, type ClaudePolicyQualification } from './configuration.js'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import type { HarnessQualification } from '@foreman-code/contracts'

/** Injected pinned-release discovery; it creates no conversation or model turn. */
export interface ClaudeNativeConfigurationPort {
  qualify(configuration: ClaudeHarnessConfiguration, workingDirectory: string, signal: AbortSignal): Promise<HarnessQualification>
  discover(workingDirectory: string, signal: AbortSignal): Promise<Omit<HarnessOptions, 'harness' | 'settings' | 'restrictions' | 'checkedAt'>>
  /** Drops reused discovery results so the next read observes the installation again. */
  invalidate?(): void
}
export function claudeSettingSupport(): HarnessOptions['settings'] {
  return [
    { field: 'model', support: 'conditional', detail: 'Only models observed from the selected local installation are selectable.' },
    { field: 'effort', support: 'conditional', detail: 'The accepted effort is delivered through the SDK and must be advertised by the selected model.' },
    { field: 'permissions', support: 'conditional', detail: 'Default permission mode and routed approvals require qualified always-applied policy checks.' },
    { field: 'sandbox', support: 'supported', detail: 'Claude requires Full access. Other modes are rejected at save and Start. Full access disables the native sandbox; application grants and tool approval still apply.' },
    { field: 'instructions', support: 'conditional', detail: 'Only accepted pinned instructions are delivered; ambient settings and plugins are excluded.' },
    { field: 'mcp', support: 'conditional', detail: 'Only the app HTTP MCP connection is supported. External MCP servers are rejected because their tool manifests are not supported; app and file authorization remain server-side.' },
  ]
}

/** Uses the same persisted HRT profile proof and current host binding as production admission. */
export class ClaudeCheckedNativeConfigurationPort implements ClaudeNativeConfigurationPort {
  constructor(private readonly source: {
    accepted(configuration: ClaudeHarnessConfiguration, workingDirectory: string, signal: AbortSignal): Promise<ClaudePolicyQualification>
    discover: ClaudeNativeConfigurationPort['discover']
    invalidate?(): void
  }) {}
  async qualify(raw: ClaudeHarnessConfiguration, workingDirectory: string, signal: AbortSignal): Promise<HarnessQualification> {
    signal.throwIfAborted()
    const configuration = ClaudeHarnessConfigurationSchema.parse(raw)
    const accepted = await this.source.accepted(configuration, workingDirectory, signal)
    signal.throwIfAborted()
    // Explicit API-key provisioning is checked by the actual native host; this read-only path never delivers a key.
    const capabilities = requireClaudePolicyQualification(configuration, accepted)
    const supportedSettings = ['model', 'effort', 'permissions', 'sandbox', 'instructions', 'mcp']
    return { harness: 'claude', version: accepted.currentBinding.pin.cliVersion, authenticated: accepted.persistedProof.authenticated === true, ready: capabilities.sdk && capabilities.basicTurns,
      structuredEvents: capabilities.basicTurns, supportsResume: capabilities.resume, supportsCancellation: capabilities.cancellation,
      supportsWorkingDirectory: capabilities.workingDirectory, supportsStartupPrompt: capabilities.startupPrompt,
      supportedNativeTools: accepted.persistedProof.claudeProof?.observedTools ?? [], supportedSettings,
      unsupportedCapabilities: ['Exact-turn steering', 'Restartable SDK callbacks', 'Child approvals', 'Background continuation',
        ...(!capabilities.history ? ['Native history'] : []), ...(!capabilities.fork ? ['Native fork'] : [])] }
  }
  discover(workingDirectory: string, signal: AbortSignal) { return this.source.discover(workingDirectory, signal) }
  invalidate(): void { this.source.invalidate?.() }
}
