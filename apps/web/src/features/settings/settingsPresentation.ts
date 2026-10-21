import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessSettingsSection, SettingsAgentRole } from '@foreman-code/contracts/management'

export const agentRoleOrder: readonly SettingsAgentRole[] = ['operator', 'master', 'orchestrator', 'coder']
export const rolePresentation: Record<SettingsAgentRole, { title: string }> = {
  operator: { title: 'Operator' },
  master: { title: 'Master' },
  orchestrator: { title: 'Orchestrator' },
  coder: { title: 'Worker' },
}
export const harnessSections: readonly { id: HarnessSettingsSection; label: string }[] = [
  { id: 'model', label: 'Model & speed' },
  { id: 'permissions', label: 'Access & approvals' },
  { id: 'session', label: 'Session' },
  { id: 'tools', label: 'Tool permissions' },
  { id: 'connections', label: 'MCP connections' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'workspace', label: 'App connection' },
]
export function sectionForHarnessIssue(path: readonly (string | number)[]): HarnessSettingsSection {
  const field = path.join('.')
  if (/mcp/i.test(field)) return 'tools'
  if (/sessionPersistence|requiresResume|webSearch|compaction|subagentDepth|plugins/.test(field)) return 'session'
  if (/sandbox|approval|autoApprove|permission|Writable|workspaceWrite|shellEnvironment/.test(field)) return 'permissions'
  return 'model'
}
export const retiredHarnessLabel = 'Retired harness (OpenCode): read-only'

export function harnessSummary(value: HarnessConfiguration): { label: string; value: string }[] {
  if (value.harness === 'opencode') return [{ label: 'Harness', value: retiredHarnessLabel }, { label: 'Model', value: value.model }]
  if (value.harness === 'claude') return [{ label: 'Harness', value: 'Claude' }, { label: 'Model', value: value.model },
    { label: 'Profile', value: value.configDirectory }, { label: 'Authentication', value: value.authMode },
    { label: 'Access', value: value.sandbox === 'read-only' ? 'Read only' : 'Workspace write' }]
  return [{ label: 'Harness', value: 'Codex' }, { label: 'Model', value: value.model },
      { label: 'Effort', value: value.reasoningEffort },
      { label: 'Access', value: value.sandbox === 'read-only' ? 'Read only' : value.sandbox === 'workspace-write' ? 'Workspace write' : 'Full access' },
      { label: 'Speed', value: value.serviceTier === 'priority' ? 'Fast' : 'Standard' }]

}

export const harnessNames: Record<HarnessConfiguration['harness'], string> = { codex: 'Codex', opencode: retiredHarnessLabel, claude: 'Claude' }
