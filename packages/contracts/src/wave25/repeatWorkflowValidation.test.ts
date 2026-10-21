import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { ExecutableRepeatWorkflowV1Schema, parseRepeatExitResultV1 } from './repeat.js'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema } from './currentAuthoring.js'

function fixture() {
  const f = makeCurrentWorkflowFixture('eng04-backend-contract', 'repeat')
  return { ...f, choice: f.version.definition.nodes[1]!.choice! }
}

describe('ENG04 backend shared validation', () => {
  it('validates a saved repeat candidate without retagging the returned immutable version', () => {
    const f = fixture()
    const result = ExecutableRepeatWorkflowV1Schema.parse({ version: f.version, configurations: f.configurations })
    expect(result.version).toEqual(f.version)
    expect(result.version.executionSemanticsVersion).toBe(3)
    expect(result.version.definition).toHaveProperty('repeat')
  })
  it('requires every exact pinned configuration, no substitutions or duplicate Agent configs', () => {
    const f = fixture()
    for (const configurations of [[], [f.configurations[0]!], [...f.configurations, f.configurations[0]!],
      f.configurations.map((configuration, index) => index ? configuration : { ...configuration, id: 'other-config' }),
      f.configurations.map((configuration, index) => index ? configuration : { ...configuration, workspaceId: 'other-workspace' })]) {
      expect(ExecutableRepeatWorkflowV1Schema.safeParse({ version: f.version, configurations }).success).toBe(false)
    }
  })
  it('accepts only complete object/JSON/exact-text exit envelopes and never mutates native provenance', () => {
    const f = fixture(), envelope = { routing: { outcome: 'issues' }, data: { latestDeliverable: { text: 'revision' }, remainingFindings: ['still open'] } }
    for (const output of [envelope, JSON.stringify(envelope), { text: JSON.stringify(envelope) }]) {
      const result = { outcome: 'succeeded', output }, before = structuredClone(result)
      expect(parseRepeatExitResultV1(result, f.choice)).toEqual(envelope)
      expect(result).toEqual(before)
    }
  })
  it('fails closed on mixed carriers, Markdown, prose, truncated JSON, undeclared outcomes and empty deliverables', () => {
    const f = fixture(), envelope = { routing: { outcome: 'issues' }, data: { latestDeliverable: 'revision', remainingFindings: ['open'] } }
    for (const output of [
      { text: JSON.stringify(envelope), metadata: 'not an exact text carrier' },
      { text: '```json\n' + JSON.stringify(envelope) + '\n```' },
      { text: 'Here is the result: ' + JSON.stringify(envelope) },
      { text: JSON.stringify(envelope).slice(0, -1) },
      { ...envelope, routing: { outcome: 'undeclared' } },
      { ...envelope, data: { latestDeliverable: null, remainingFindings: [] } },
      { ...envelope, data: { latestDeliverable: 'revision', remainingFindings: null } },
      { text: 'x'.repeat(65536) },
    ]) expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output }, f.choice)).toThrow()
  })
  it('keeps the complete current graph, pins and nested value/replayed transport shape', () => {
    const f = fixture(), input = { workspaceId: f.version.workspaceId, workflowId: f.version.workflowId,
      commandId: 'repeat-save', expectedRevision: 1, expectedWorkflowVersionId: f.version.id,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds,
      executionSemanticsVersion: 3, graph: f.version.definition }
    expect(CurrentWorkflowSaveInputSchema.safeParse(input).success).toBe(true)
    expect(CurrentWorkflowSaveInputSchema.safeParse({ ...input, graph: { ...input.graph, repeat: null } }).success).toBe(false)
    expect(CurrentWorkflowSaveInputSchema.safeParse({ ...input, mode: 'repeat' }).success).toBe(false)
    const value = { workspaceId: f.version.workspaceId, workflowId: f.version.workflowId, revision: 2,
      currentVersionId: f.version.id, version: f.version }
    expect(CurrentWorkflowSaveResultSchema.safeParse({ value, replayed: false }).success).toBe(true)
    expect(CurrentWorkflowSaveResultSchema.safeParse({ ...value, replayed: false }).success).toBe(false)
  })
})
