import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '../index.js'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture, WorkflowDefinitionV3Schema } from './index.js'

describe('Agent interval checks in the saved workflow definition', () => {
  it('is off unless a node saves an interval within the supported range', () => {
    const f = makeCurrentWorkflowFixture('interval')
    expect(f.version.definition.nodes.every(node => !('interval' in node))).toBe(true)
    const definition = structuredClone(f.version.definition)
    for (const [everySeconds, valid] of [[9, false], [10, true], [86_400, true], [86_401, false], [1.5, false]] as const) {
      definition.nodes[0] = { ...f.version.definition.nodes[0]!, interval: { everySeconds } }
      expect(WorkflowDefinitionV3Schema.safeParse(definition).success).toBe(valid)
    }
  })

  it('saves an optional loop prompt, trimmed and bounded', () => {
    const f = makeCurrentWorkflowFixture('interval-prompt')
    const definition = structuredClone(f.version.definition)
    definition.nodes[0] = { ...f.version.definition.nodes[0]!, interval: { everySeconds: 60, prompt: '  Check the deploy log.  ' } }
    expect(WorkflowDefinitionV3Schema.parse(definition).nodes[0]).toMatchObject({ interval: { everySeconds: 60, prompt: 'Check the deploy log.' } })
    for (const prompt of ['   ', 'x'.repeat(4001)]) {
      definition.nodes[0] = { ...f.version.definition.nodes[0]!, interval: { everySeconds: 60, prompt } }
      expect(WorkflowDefinitionV3Schema.safeParse(definition).success).toBe(false)
    }
  })

  it('rejects interval checks inside a repeat block', () => {
    const f = makeCurrentWorkflowFixture('interval-repeat', 'repeat')
    const definition = structuredClone(f.version.definition)
    definition.nodes[0] = { ...definition.nodes[0]!, interval: { everySeconds: 60 } }
    const result = WorkflowDefinitionV3Schema.safeParse(definition)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('AGENT_INTERVAL_IN_REPEAT_BLOCK')
  })

  it('rejects interval checks on an Agent that declares artifact outputs', () => {
    const f = makeCurrentWorkflowFixture('interval-artifacts')
    const definition = structuredClone(f.version.definition)
    const node = { ...definition.nodes[0]!, interval: { everySeconds: 60 } }
    definition.nodes[0] = node
    expect(WorkflowDefinitionV3Schema.safeParse(definition).success).toBe(true)
    definition.nodes[0] = { ...node, artifactOutputs: { version: 1, outputKeys: ['report'] } }
    const result = WorkflowDefinitionV3Schema.safeParse(definition)
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.error?.issues)).toContain('AGENT_INTERVAL_WITH_ARTIFACT_OUTPUTS')
  })

  it('requires an Agent that never routes approvals to the workflow', () => {
    const f = makeCurrentWorkflowFixture('interval-approval')
    const version = structuredClone(f.version)
    version.definition.nodes[0] = { ...version.definition.nodes[0]!, interval: { everySeconds: 60 } }
    expect(ExecutableWorkflowV3Schema.safeParse({ version, configurations: f.configurations }).success).toBe(false)
    const never = f.configurations.map(config => ({ ...config, harness: { ...config.harness,
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' as const } } }))
    expect(ExecutableWorkflowV3Schema.safeParse({ version, configurations: never }).success).toBe(true)
  })
})
