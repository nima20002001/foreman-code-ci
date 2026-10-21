import { HarnessQualificationSchema, type HarnessConfiguration, type HarnessQualification } from '@foreman-code/contracts'

/** A projection of the qualified native transport, not an alternate execution runtime. */
export function nativeQualification(configuration: HarnessConfiguration, version: string): HarnessQualification {
  const codex = configuration.harness === 'codex'
  return HarnessQualificationSchema.parse({
    harness: configuration.harness, version,
    authenticated: true, ready: true, structuredEvents: true,
    supportsResume: !codex || configuration.advanced?.sessionPersistence !== 'ephemeral',
    supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: codex
      ? ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'plan_update']
      : ['bash', 'read', 'edit', 'glob', 'grep', 'webfetch', 'task', 'todowrite', 'websearch', 'lsp', 'skill'],
    supportedSettings: codex ? [
      'model', 'reasoningEffort', 'sandbox', 'serviceTier',
      'advanced.approvalPolicy', 'advanced.approvalsReviewer', 'advanced.additionalWritableDirectories',
      'advanced.workspaceWrite', 'advanced.sessionPersistence', 'advanced.shellEnvironment',
      'advanced.webSearch', 'advanced.mcpServers',
    ] : [
      'model', 'variant', 'nativeAgent', 'thinking', 'autoApprove',
      'advanced.apiVersion', 'advanced.permissionHandling', 'advanced.permissionRules',
      'advanced.subagentDepth', 'advanced.plugins', 'advanced.compaction',
      'advanced.configLoading', 'advanced.mcp',
    ],
    unsupportedCapabilities: codex ? ['nativeAgentSelection'] : ['sandboxSelection', 'serviceTier', 'nativeQuestions'],
  })
}
