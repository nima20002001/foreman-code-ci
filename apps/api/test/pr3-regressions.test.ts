import { describe, expect, it } from 'vitest'
import { ClaudeHarnessConfigurationSchema, type Agent } from '@foreman-code/contracts'

import { configurationInput } from '../src/modules/workspaces/agentConfiguration.js'

const workspaceId = 'workspace-pr3'
const claude = ClaudeHarnessConfigurationSchema.parse({ harness: 'claude', model: 'claude-haiku-4-5-20251001',
  authMode: 'subscription', configDirectory: '/fixture', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {} })
describe('PR #3 agent persistence regressions', () => {
  it('honors the nested-only Claude discriminator and rejects contradictory harnesses', () => {
    const nested: Agent = { id: 'new-agent', name: 'Claude', harnessConfiguration: claude }
    expect(configurationInput(workspaceId, nested).harness).toEqual(claude)
    expect(() => configurationInput(workspaceId, { ...nested, harness: 'codex' }))
      .toThrow(expect.objectContaining({ code: 'AGENT_HARNESS_MISMATCH', status: 400 }))
  })

})
