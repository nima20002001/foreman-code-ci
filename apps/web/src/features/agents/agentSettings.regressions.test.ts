import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessDefaults } from '@foreman-code/contracts'

import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { configuredHarness, defaultAgentForHarness, nextHarnessAgentName, initialModel, effortOptions } from './agentSettings'

const defaults: HarnessDefaults = {
  codex: {
    ...DEFAULT_HARNESS_DEFAULTS.codex,
    model: 'gpt-5.6-terra', reasoningEffort: 'high', sandbox: 'workspace-write', serviceTier: 'priority',
  },
  claude: savedClaudeConfiguration,

}

describe('PR #3 harness defaults and names', () => {
  it.each(['codex', 'claude'] as const)('uses the same saved %s template for direct creation and harness switching', (target) => {
    const source = target === 'codex' ? 'claude' : 'codex'
    const original = defaultAgentForHarness(source, 'agent-new', 'New agent', defaults[source])
    const direct = defaultAgentForHarness(target, 'agent-new', 'New agent', defaults[target])
    expect(direct.harnessConfiguration).toEqual(defaults[target])
    expect(configuredHarness(
      original,
      target,
      direct.model!,
      direct.effort!,
      direct.fastMode ?? false,
      direct.harnessConfiguration?.harness === 'codex' ? direct.harnessConfiguration.sandbox : 'danger-full-access',
      defaults,
    )).toEqual(direct.harnessConfiguration)
  })

  it('keeps existing agent settings when no creation defaults are supplied', () => {
    const existing = defaultAgentForHarness('codex', 'existing', 'Existing agent')
    expect(configuredHarness(existing, 'codex', existing.model!, existing.effort!, false, 'read-only'))
      .toEqual(DEFAULT_HARNESS_DEFAULTS.codex)
  })

  it.each(['codex', 'claude'] as const)('continues %s names through 998, 999, 1000, and 1001', (harness) => {
    const agents = [{ id: 'agent-998', name: `${harness}-998` }]
    for (const expected of [999, 1000, 1001]) {
      const name = nextHarnessAgentName(harness, agents)
      expect(name).toBe(`${harness}-${expected}`)
      expect(agents.some((agent) => agent.name === name)).toBe(false)
      agents.push({ id: `agent-${expected}`, name })
    }
  })
})

describe('Explicit Claude agent configuration', () => {
  it('requires an actual profile when creating or switching to Claude', () => {
    expect(() => defaultAgentForHarness('claude', 'new', 'New')).toThrow(/Claude.*profile/)
    const codex = defaultAgentForHarness('codex', 'existing', 'Existing')
    expect(() => configuredHarness(codex, 'claude', 'chosen-model', 'high', true, 'read-only')).toThrow(/Claude.*profile/)
    expect(initialModel(codex, 'claude')).toBe('')
  })
  it('does not replace a mismatched supplied configuration with a provider default', () => {
    expect(() => defaultAgentForHarness('claude', 'new', 'New', DEFAULT_HARNESS_DEFAULTS.codex)).toThrow(/match/)
  })
  it('preserves Claude settings while changing its model and requires Full access', () => {
    const agent = defaultAgentForHarness('claude', 'claude-1', 'Claude agent', savedClaudeConfiguration)
    expect(agent.harnessConfiguration).toEqual(savedClaudeConfiguration)
    expect(agent.effort).toBeUndefined()
    expect(agent.fastMode).toBeUndefined()
    expect(configuredHarness(agent, 'claude', 'chosen-model', 'high', true, 'danger-full-access')).toEqual({
      ...savedClaudeConfiguration, model: 'chosen-model', sandbox: 'danger-full-access',
    })
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      expect(() => configuredHarness(agent, 'claude', 'chosen-model', 'high', true, sandbox)).toThrow(/Full access/)
    }
    expect(effortOptions('claude', savedClaudeConfiguration.model)).toEqual([])
  })
  it('uses only an explicitly supplied Claude creation preset', () => {
    const agent = defaultAgentForHarness('codex', 'existing', 'Existing')
    expect(configuredHarness(agent, 'claude', savedClaudeConfiguration.model, 'high', true, 'danger-full-access', {
      ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration,
    })).toEqual(savedClaudeConfiguration)
    expect(nextHarnessAgentName('claude', [{ id: 'existing', name: 'claude-001' }])).toBe('claude-002')
  })
})
