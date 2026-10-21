import type { OperatorChatSetup } from '@foreman-code/contracts'
import { appMcpServerName } from '../appMcpLauncher.js'
import type { AcceptedClaudeProfile } from '../instanceSettings/acceptedProfile.js'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import { compileClaudeConfiguration } from './configuration.js'
import { loadOfficialClaudeSdk } from './official.js'
import { createClaudeSdkRunner } from './runner.js'
import { decodeClaudeMcpControl } from './mcpInspection.js'
import { DomainError } from '../../errors.js'

/** Actual read-authorized zero-input SDK inspection, separate from a turn's
 * callback/MCP authority. It never offers an input or issues a credential. */
export async function inspectClaudeOperatorConfiguration(input: {
  accepted: AcceptedClaudeProfile; binary: string; workingDirectory: string; endpoint: string
  recovery: NativeProcessRecovery; signal: AbortSignal; revalidate(): Promise<void>
  loadClient?: typeof loadOfficialClaudeSdk
  apiKey?: string
}): Promise<OperatorChatSetup> {
  if (input.accepted.override.configuration.harness !== 'claude') throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'Claude inspection requires the exact Claude profile.', 409)
  const compiled = compileClaudeConfiguration(input.accepted.override.configuration, input.workingDirectory,
    input.accepted, process.env, input.apiKey)
  const serverName = appMcpServerName(compiled.mcpServers)
  const server = compiled.mcpServers[serverName]
  const result = { harness: 'claude' as const, endpoint: input.endpoint, checkedAt: new Date().toISOString(), routing: 'fixed' as const }
  if (!server || server.type !== 'http' || server.url !== input.endpoint) return { ...result, status: 'setup_required',
    reason: 'The saved Claude profile does not configure this app’s Foreman Code HTTP MCP endpoint.' }
  const runner = createClaudeSdkRunner({ loadClient: async () => {
    await input.revalidate(); input.signal.throwIfAborted()
    return (input.loadClient ?? loadOfficialClaudeSdk)(compiled.configuration.configDirectory, input.recovery, input.binary)
  } })
  try {
    const session = await runner.open({ scope: { deviceId: input.accepted.override.target.applicationInstallationId,
      profilePath: compiled.configuration.configDirectory, configRevision: input.accepted.currentBinding.pin.configRevision,
      cwd: input.workingDirectory }, signal: input.signal, cancelPendingRequests: () => {},
      options: { model: compiled.model, ...(compiled.effort ? { effort: compiled.effort } : {}), tools: [],
        permissionMode: 'default', strictMcpConfig: true, settingSources: [], systemPrompt: '', env: compiled.env,
        mcpServers: { [serverName]: server }, sandbox: compiled.sandbox,
        canUseTool: async () => ({ behavior: 'deny', message: 'Read-only configuration inspection cannot execute tools.' }),
        hooks: { PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse',
          permissionDecision: 'deny', permissionDecisionReason: 'Configuration inspection has no tool authority.' } })] }] },
      } })
    await session.initializationResult?.()
    if (!session.mcpServerStatus) throw new DomainError('CLAUDE_MCP_INSPECTION_UNAVAILABLE', 'The installed SDK cannot inspect its actual MCP configuration.', 409)
    const observed = decodeClaudeMcpControl(await session.mcpServerStatus(), input.recovery.launchId ?? input.recovery.owner, new Date().toISOString())
    const entry = observed.servers.find(row => row.name === serverName)
    await input.revalidate()
    const configured = Boolean(entry && entry.configuration?.type === 'http' && entry.configuration.url === server.url
      && entry.status !== 'disabled')
    return { ...result, checkedAt: observed.checkedAt, status: configured ? 'configured' : 'setup_required',
      ...(!configured ? { reason: 'The actual Claude SDK did not report the saved Foreman Code HTTP MCP configuration.' } : {}) }
  } finally { await runner.dispose() }
}
