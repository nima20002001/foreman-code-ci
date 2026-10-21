import { expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_WORKFLOW_APPROVAL_HANDLER, withAdvancedDefaults } from '../src/index.js'

it('defaults workflow approval handling to native without a reviewing orchestrator', () => {
  expect(DEFAULT_WORKFLOW_APPROVAL_HANDLER).toBe('native')
})

it('defaults workflow Agents to never approval while preserving read-only sandboxing', () => {
  for (const role of ['coder', 'orchestrator'] as const) {
    expect(DEFAULT_AGENT_DEFAULTS[role].harness).toMatchObject({
      sandbox: 'read-only', advanced: { approvalPolicy: 'never' },
    })
    const configuration = structuredClone(DEFAULT_AGENT_DEFAULTS[role].harness)
    if (configuration.harness !== 'codex') throw new Error('Expected Codex defaults')
    delete configuration.advanced
    expect(withAdvancedDefaults(configuration)).toMatchObject({
      sandbox: 'read-only', advanced: { approvalPolicy: 'never' },
    })
    expect(configuration.advanced).toBeUndefined()
  }
})
