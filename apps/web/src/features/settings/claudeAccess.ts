import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'

export function claudeAccessOptions(sandbox: ClaudeHarnessConfiguration['sandbox']) {
  const fullAccess = { value: 'danger-full-access', label: 'Full access' }
  if (sandbox === 'danger-full-access') return [fullAccess]
  const label = sandbox === 'read-only' ? 'Read only' : 'Workspace write'
  return [{ value: sandbox, label: `${label} · unsupported`, disabled: true }, fullAccess]
}
