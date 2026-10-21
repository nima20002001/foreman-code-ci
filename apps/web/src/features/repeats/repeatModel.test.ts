import { type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { currentWorkflowFixture as makeWave25Fixture } from '../../shared/mocks/currentWorkflow'
import { describe, expect, it } from 'vitest'
import { repeatPlanFromLocalDraft, validateRepeatDraft, type RepeatLocalDraft } from './repeatModel'

function graph(): WorkflowDefinitionV3 {
  const fixture = makeWave25Fixture('repeat-ui')
  const [entry, exit] = fixture.version.definition.nodes
  return {
    ...fixture.version.definition,
    executionPolicy: { ...fixture.version.definition.executionPolicy!, maxNodeExecutions: 4 },
    nodes: [entry!, { ...exit!, choice: { outcomes: [
      { outcome: 'issues', target: { kind: 'branch_end' as const } },
      { outcome: 'pass', target: { kind: 'branch_end' as const } },
    ] } }],
  }
}

function draft(): RepeatLocalDraft {
  const value = graph()
  return { contractVersion: 1, blocks: [{
    id: 'review-fix', nodeIds: value.nodes.map((node) => node.id), entryNodeId: value.nodes[0]!.id,
    exitNodeId: value.nodes[1]!.id, maxOccurrences: 2, repeatOutcome: 'issues', earlyExitOutcome: 'pass',
  }] }
}

describe('repeatModel', () => {
  it('builds the shared plan and derives the limit route from the repeat outcome', () => {
    const plan = repeatPlanFromLocalDraft(draft(), graph())
    expect(plan?.blocks[0]?.limitExit).toEqual({ kind: 'branch_end' })
    expect(validateRepeatDraft(draft(), graph())).toEqual([])
  })

  it('rejects overlapping or nested scopes explicitly', () => {
    const value = draft()
    value.blocks.push({ ...value.blocks[0]!, id: 'second' })
    expect(validateRepeatDraft(value, graph()).some((issue) => issue.code === 'REPEAT_OVERLAP_OR_NESTING_UNSUPPORTED')).toBe(true)
  })

  it('counts the first occurrence and rejects zero as a cap', () => {
    const value = draft(); value.blocks[0]!.maxOccurrences = 0
    expect(validateRepeatDraft(value, graph()).some((issue) => issue.code === 'REPEAT_CAP_INVALID')).toBe(true)
  })

  it('allows an empty local draft so an existing repeat can be removed', () => {
    const value: RepeatLocalDraft = { contractVersion: 1, blocks: [] }
    expect(validateRepeatDraft(value, graph())).toEqual([])
    expect(repeatPlanFromLocalDraft(value, graph())).toBeNull()
  })
})
