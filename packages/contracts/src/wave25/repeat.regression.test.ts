import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { canonicalGraphJson } from './json.js'
import {
  REPEAT_CONTRACT_VERSION,
  REPEAT_EXECUTION_SEMANTICS_VERSION,
  RepeatDecisionV1Schema,
  RepeatOccurrenceV1Schema,
  RepeatWorkflowVersionV1Schema,
  parseRepeatExitResultV1,
  validateRepeatDecisionV1,
  validateRepeatSuccessorV1,
  type RepeatDecisionV1,
  type RepeatOccurrenceV1,
  type RepeatWorkflowVersionV1,
} from './repeat.js'
import { ExecutionSemanticsVersionSchema } from './workflow.js'

const at = '2026-09-25T02:21:00.000Z'
const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`
const edge = (source: string, target: string) => ({ id: `${source}-${target}`, kind: 'execution' as const, source, target })

function version(cap = 3): RepeatWorkflowVersionV1 {
  const base = makeCurrentWorkflowFixture('eng04-d-contract')
  const names = ['work', 'review', 'done', 'limit']
  return RepeatWorkflowVersionV1Schema.parse({
    ...base.version,
    executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
    entryNodeId: 'work',
    agentConfigurationVersionIds: Object.fromEntries(names.map((id) => [`agent-${id}`, `config-${id}`])),
    definition: {
      ...base.version.definition,
      executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
      entryNodeId: 'work',
      executionPolicy: { maxParallelism: 2, maxNodeExecutions: cap * 2 + 2 },
      nodes: names.map((id) => ({
        id,
        agentId: `agent-${id}`,
        name: id,
        ...(id === 'review' ? { choice: { outcomes: [
          { outcome: 'pass', target: { kind: 'edge' as const, relationshipId: 'review-done' } },
          { outcome: 'issues', target: { kind: 'edge' as const, relationshipId: 'review-limit' } },
        ] } } : {}),
      })),
      edges: [edge('work', 'review'), edge('review', 'done'), edge('review', 'limit')],
      repeat: {
        contractVersion: REPEAT_CONTRACT_VERSION,
        blocks: [{
          id: 'review-fix', nodeIds: ['work', 'review'], entryNodeId: 'work', exitNodeId: 'review', maxOccurrences: cap,
          repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'edge', relationshipId: 'review-limit' },
        }],
      },
    },
  })
}

function accepted(index: number, outcome: 'issues' | 'pass' = 'issues') {
  return {
    outcome: 'succeeded' as const,
    output: {
      routing: { outcome },
      data: { latestDeliverable: { revision: index, rawArtifactId: `artifact-${index}` }, remainingFindings: outcome === 'pass' ? [] : [{ id: `finding-${index}` }] },
    },
  }
}

function occurrence(v: RepeatWorkflowVersionV1, index = 1, previous: RepeatOccurrenceV1['input']['previous'] = null): RepeatOccurrenceV1 {
  const scope = {
    workspaceId: v.workspaceId,
    workflowId: v.workflowId,
    workflowVersionId: v.id,
    runId: 'run-eng04-d-contract',
    executionSemanticsVersion: REPEAT_EXECUTION_SEMANTICS_VERSION,
  } as const
  return RepeatOccurrenceV1Schema.parse({
    contractVersion: REPEAT_CONTRACT_VERSION,
    identity: { scope, blockId: 'review-fix', occurrenceId: `occurrence-${index}`, occurrenceIndex: index },
    input: { bindingId: `binding-${index}`, inputDigest: digest({ index }), previous },
  })
}

function decision(v: RepeatWorkflowVersionV1, occ: RepeatOccurrenceV1, result: ReturnType<typeof accepted>): RepeatDecisionV1 {
  const outcome = result.output.routing.outcome
  const cap = v.definition.repeat!.blocks[0]!.maxOccurrences
  const reason = outcome === 'pass' ? 'early_exit' : occ.identity.occurrenceIndex === cap ? 'limit_exit' : 'repeat'
  const target = reason === 'early_exit' ? { kind: 'edge' as const, relationshipId: 'review-done' }
    : reason === 'limit_exit' ? { kind: 'edge' as const, relationshipId: 'review-limit' }
      : { kind: 'next_occurrence' as const, entryNodeId: 'work', occurrenceIndex: occ.identity.occurrenceIndex + 1 }
  return RepeatDecisionV1Schema.parse({
    contractVersion: REPEAT_CONTRACT_VERSION,
    decisionId: `decision-${occ.identity.occurrenceIndex}`,
    occurrence: occ,
    exitExecution: {
      workflowNodeId: 'review', executionId: `review-execution-${occ.identity.occurrenceIndex}`,
      agentId: 'agent-review', agentConfigurationVersionId: 'config-review', attempt: 1,
      occurrence: occ.identity,
    },
    acceptedResultDigest: digest(result),
    outcome,
    reason,
    target,
    decidedAt: at,
    resultData: result.output.data,
  })
}

describe('NIM-2648 ENG04-D repeat shared-contract regressions', () => {
  it('rejects retired execution semantics while repeat remains an explicit semantics-3 contract', () => {
    expect(ExecutionSemanticsVersionSchema.safeParse(1).success).toBe(false)
    expect(ExecutionSemanticsVersionSchema.safeParse(2).success).toBe(false)
    const repeat = version(1)
    expect(repeat.executionSemanticsVersion).toBe(3)
    expect(repeat.definition.executionSemanticsVersion).toBe(3)
    expect(repeat.definition.repeat!.contractVersion).toBe(1)
  })

  it('accepts only the complete strict repeat-exit envelope and rejects prose, null deliverable and missing findings', () => {
    const v = version()
    const choice = v.definition.nodes.find((node) => node.id === 'review')!.choice!
    const good = accepted(1)
    expect(parseRepeatExitResultV1(good, choice).data).toEqual(good.output.data)
    expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output: `prefix ${JSON.stringify(good.output)}` }, choice)).toThrow()
    expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output: { routing: { outcome: 'issues' }, data: { latestDeliverable: null, remainingFindings: [] } } }, choice)).toThrow()
    expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output: { routing: { outcome: 'issues' }, data: { latestDeliverable: {} } } }, choice)).toThrow()
    expect(() => parseRepeatExitResultV1({ outcome: 'succeeded', output: { routing: { outcome: 'undeclared' }, data: good.output.data } }, choice)).toThrow()
  })

  it('validates exact route/result/pin provenance for repeat, early exit and cap limit exit', () => {
    const v = version(2)
    const first = occurrence(v)
    const firstResult = accepted(1, 'issues')
    const repeat = decision(v, first, firstResult)
    expect(validateRepeatDecisionV1(v, repeat, firstResult)).toEqual(repeat)
    expect(repeat.reason).toBe('repeat')

    const second = occurrence(v, 2, {
      occurrenceId: first.identity.occurrenceId,
      occurrenceIndex: 1,
      decisionId: repeat.decisionId,
      acceptedResultDigest: repeat.acceptedResultDigest,
    })
    expect(validateRepeatSuccessorV1(v, repeat, second, firstResult)).toEqual(second)
    const earlyResult = accepted(2, 'pass')
    expect(validateRepeatDecisionV1(v, decision(v, second, earlyResult), earlyResult).reason).toBe('early_exit')
    const limitResult = accepted(2, 'issues')
    expect(validateRepeatDecisionV1(v, decision(v, second, limitResult), limitResult).reason).toBe('limit_exit')
  })

  it('rejects replaced result data, changed exit pins, changed route and broken successor ancestry', () => {
    const v = version(3)
    const first = occurrence(v)
    const result = accepted(1)
    const recorded = decision(v, first, result)
    expect(() => validateRepeatDecisionV1(v, { ...recorded, resultData: { latestDeliverable: { revision: 999 }, remainingFindings: [] } }, result)).toThrow()
    expect(() => validateRepeatDecisionV1(v, { ...recorded, exitExecution: { ...recorded.exitExecution, agentConfigurationVersionId: 'config-other' } }, result)).toThrow()
    expect(() => validateRepeatDecisionV1(v, { ...recorded, target: { kind: 'edge', relationshipId: 'review-limit' } }, result)).toThrow()
    expect(() => validateRepeatDecisionV1(v, recorded, accepted(99))).toThrow()

    const second = occurrence(v, 2, {
      occurrenceId: first.identity.occurrenceId,
      occurrenceIndex: 1,
      decisionId: recorded.decisionId,
      acceptedResultDigest: recorded.acceptedResultDigest,
    })
    expect(() => validateRepeatSuccessorV1(v, recorded, {
      ...second,
      input: { ...second.input, previous: { ...second.input.previous!, decisionId: 'decision-wrong' } },
    }, result)).toThrow()
  })

  it('makes cap 1 an explicit limit exit with no valid successor ancestry', () => {
    const v = version(1)
    const first = occurrence(v)
    const result = accepted(1, 'issues')
    const capped = decision(v, first, result)
    expect(capped.reason).toBe('limit_exit')
    expect(capped.target).toEqual({ kind: 'edge', relationshipId: 'review-limit' })
    expect(validateRepeatDecisionV1(v, capped, result)).toEqual(capped)
    expect(() => validateRepeatSuccessorV1(v, capped, occurrence(v, 2, {
      occurrenceId: first.identity.occurrenceId, occurrenceIndex: 1,
      decisionId: capped.decisionId, acceptedResultDigest: capped.acceptedResultDigest,
    }), result)).toThrow()
  })
})
