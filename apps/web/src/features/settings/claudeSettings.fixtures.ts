import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'

export const savedClaudeConfiguration: ClaudeHarnessConfiguration = {
  harness: 'claude', model: 'claude-saved-model', authMode: 'subscription',
  configDirectory: '/actual/claude/profile', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: ['Read', 'Bash'], permissionRules: [{ tool: 'Read', effect: 'allow' }, { tool: 'Bash', effect: 'ask' }],
  instructions: 'Retain these saved instructions.',
  mcpServers: { graphql: { type: 'http', url: 'http://127.0.0.1:4100/mcp' } },
}
