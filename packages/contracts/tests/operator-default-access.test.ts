import { expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, operatorHarnessDefaults } from '../src/index.js'
import type { ClaudeHarnessConfiguration } from '../src/claude.js'

it('defaults only the Operator to full access and preserves sandbox restrictions for workflow Agents', () => {
  expect(DEFAULT_AGENT_DEFAULTS.operator.harness).toMatchObject({ sandbox: 'danger-full-access', advanced: { approvalPolicy: 'never' } })
  expect(DEFAULT_AGENT_DEFAULTS.coder.harness).toMatchObject({ sandbox: 'read-only' })
  expect(DEFAULT_AGENT_DEFAULTS.orchestrator.harness).toMatchObject({ sandbox: 'read-only' })
  expect(DEFAULT_HARNESS_DEFAULTS.codex.sandbox).toBe('read-only')
  expect(operatorHarnessDefaults(DEFAULT_HARNESS_DEFAULTS.codex)).toMatchObject({ sandbox: 'danger-full-access', advanced: { approvalPolicy: 'never' } })
  const claude: ClaudeHarnessConfiguration = {
    harness: 'claude', model: 'claude-fixture', authMode: 'subscription', configDirectory: '/profile',
    permissionMode: 'default', sandbox: 'read-only', tools: ['Read'],
    permissionRules: [{ tool: 'Read', effect: 'ask' }], instructions: 'Keep the saved policy.', mcpServers: {},
  }
  expect(operatorHarnessDefaults(claude)).toEqual({ ...claude, sandbox: 'danger-full-access' })
  expect(claude.sandbox).toBe('read-only')
})
