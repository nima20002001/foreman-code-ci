import { asRecord } from '../../../shared/records.js'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { DomainError } from '../../errors.js'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import { claudeEnvironment } from './configuration.js'
import { loadOfficialClaudeSdk } from './official.js'
import { runCommand } from '../process.js'
import { HarnessExecutionError } from '../errors.js'
import { createClaudeSdkRunner } from './runner.js'


/** Owns a zero-input SDK control query. No prompt, native model request or
 * ambient MCP/settings is admitted by discovery. Account details stay private. */
export async function discoverClaudeMetadata(input: {
  binary: string; model: string; profilePath: string; workingDirectory: string; recovery: NativeProcessRecovery; signal: AbortSignal
  sdkEntrypoint?: string
  authMode?: 'subscription' | 'api-key'; apiKey?: string; accountId?: string
}): Promise<Pick<HarnessOptions, 'providerVersion' | 'authenticated' | 'models' | 'nativeAgents'>> {
  const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: input.model,
    authMode: input.authMode ?? 'subscription', ...(input.accountId ? { accountId: input.accountId } : {}),
    configDirectory: input.profilePath, permissionMode: 'default', sandbox: 'danger-full-access', tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  const runner = createClaudeSdkRunner({ loadClient: () => loadOfficialClaudeSdk(input.profilePath, input.recovery, input.binary, input.sdkEntrypoint) })
  try {
    const version = await runCommand(input.binary, ['--version'], input.workingDirectory, input.signal,
      claudeEnvironment(configuration, process.env, input.apiKey), { recovery: input.recovery })
    const providerVersion = /^(\d+\.\d+\.\d+)(?:\s+\(Claude Code\))?$/.exec((version.stdout || version.stderr).trim())?.[1]
    if (version.exitCode !== 0 || !providerVersion) throw new HarnessExecutionError('CLAUDE_CONTRACT_UNSUPPORTED',
      'Claude Code unknown version does not satisfy the --version response contract.')
    const session = await runner.open({ scope: { deviceId: 'owned-discovery', profilePath: input.profilePath,
      configRevision: 'metadata-only', cwd: input.workingDirectory }, signal: input.signal,
      options: { model: input.model, tools: [], settingSources: [], strictMcpConfig: true, mcpServers: {}, systemPrompt: '',
        permissionMode: 'default', env: claudeEnvironment(configuration, process.env, input.apiKey) } })
    const initialized = asRecord(await session.initializationResult?.())
    const nativeModels = initialized.models
    if (!Array.isArray(nativeModels) || nativeModels.length > 100) throw new DomainError('CLAUDE_CONTRACT_UNSUPPORTED',
      `Claude Code ${providerVersion} does not satisfy the initializationResult.models catalog contract.`, 409)
    const models: HarnessOptions['models'] = []
    for (const [index, raw] of nativeModels.entries()) {
      const model = asRecord(raw)
      const id = typeof model.resolvedModel === 'string' && model.resolvedModel ? model.resolvedModel : model.value
      if (typeof id !== 'string' || !id) continue
      const contextWindow = Number.isSafeInteger(model.contextWindow) && Number(model.contextWindow) > 0
        ? Number(model.contextWindow) : undefined
      const existing = models.find(row => row.id === id)
      if (existing) {
        // Keep native default preference, but show its actual versioned name.
        if (model.value !== 'default' && typeof model.displayName === 'string') existing.name = model.displayName
        if (existing.contextWindow === undefined && contextWindow !== undefined) existing.contextWindow = contextWindow
        continue
      }
      models.push({ id, ...(contextWindow === undefined ? {} : { contextWindow }), ...(typeof model.displayName === 'string' ? { name: model.displayName } : {}),
        reasoningEfforts: Array.isArray(model.supportedEffortLevels) ? model.supportedEffortLevels.filter((value): value is string => typeof value === 'string') : [],
        variants: [], serviceTiers: [], defaultPriority: model.value === 'default' ? -1 : index })
    }
    const account = asRecord(initialized.account)
    return { providerVersion, authenticated: account.apiProvider === 'firstParty'
      && (typeof account.subscriptionType === 'string' || typeof account.tokenSource === 'string' && account.tokenSource !== 'none'
        || configuration.authMode === 'api-key' && typeof account.apiKeySource === 'string' && account.apiKeySource !== 'none'),
    models, nativeAgents: [] }
  } finally { await runner.dispose() }
}
