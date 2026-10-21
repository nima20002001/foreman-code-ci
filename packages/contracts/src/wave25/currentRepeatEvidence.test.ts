import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from './currentFixture.js'
import {
  RepeatOccurrenceV1Schema, RepeatDecisionV1Schema, RepeatWorkflowVersionV1Schema,
  validateRepeatDecisionV1, validateRepeatSuccessorV1,
  type RepeatDecisionV1, type RepeatOccurrenceV1,
} from './repeat.js'

const digest = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`
function evidence(index = 1, outcome = 'issues', cap = 3) {
  const f = makeCurrentWorkflowFixture('current-evidence', 'repeat')
  const block = f.version.definition.repeat!.blocks[0]!
  block.maxOccurrences = cap
  f.version.definition.executionPolicy!.maxNodeExecutions = cap * 2
  const version = RepeatWorkflowVersionV1Schema.parse(f.version)
  const occurrence: RepeatOccurrenceV1 = {
    contractVersion: 1, identity: { scope: f.scope, blockId: block.id, occurrenceIndex: index, occurrenceId: `occ-${index}` },
    input: { bindingId: `input-${index}`, inputDigest: digest(index + 10), previous: index === 1 ? null : {
      occurrenceId: `occ-${index - 1}`, occurrenceIndex: index - 1, decisionId: `decision-${index - 1}`, acceptedResultDigest: digest(index - 1),
    } },
  }
  const resultData = { latestDeliverable: { revision: index }, remainingFindings: outcome === 'pass' ? [] : [{ id: 'finding' }] }
  const reason = outcome === 'pass' ? 'early_exit' : index === cap ? 'limit_exit' : 'repeat'
  const decision: RepeatDecisionV1 = {
    contractVersion: 1, decisionId: `decision-${index}`, occurrence,
    exitExecution: { ...f.identities[1]!, executionId: `execution-${index}`, occurrence: occurrence.identity },
    acceptedResultDigest: digest(index), outcome, reason,
    target: reason === 'repeat' ? { kind: 'next_occurrence', entryNodeId: block.entryNodeId, occurrenceIndex: index + 1 }
      : { kind: 'branch_end' }, resultData, decidedAt: f.createdAt,
  }
  return { version, decision, result: { outcome: 'succeeded', output: { routing: { outcome }, data: resultData } } }
}
/** Pure provenance rules, not PostgreSQL/native source, receipt or Stop proof. */
describe('current V3 optional-repeat decision and successor provenance', () => {
  it.each([[1, 'issues', 'repeat'], [2, 'pass', 'early_exit'], [3, 'issues', 'limit_exit'], [3, 'pass', 'early_exit']] as const)(
    '%i/%s preserves exact reason %s', (index, outcome, reason) => {
      const f = evidence(index, outcome)
      expect(validateRepeatDecisionV1(f.version, f.decision, f.result)).toEqual(f.decision)
      expect(f.decision.reason).toBe(reason)
    })
  it('an explicitly authored cap one is a limit exit, not normalization of ordinary V3', () => {
    const f = evidence(1, 'issues', 1)
    expect(validateRepeatDecisionV1(f.version, f.decision, f.result).reason).toBe('limit_exit')
    expect(f.decision.resultData.remainingFindings).toHaveLength(1)
    const ordinary = makeCurrentWorkflowFixture('ordinary-evidence').version
    expect(Object.hasOwn(ordinary.definition, 'repeat')).toBe(false)
    expect(() => validateRepeatDecisionV1(ordinary, f.decision, f.result)).toThrow()
  })
  it('the successor names the exact preceding decision, result and occurrence in the same Run', () => {
    const before = evidence(), after = evidence(2)
    expect(validateRepeatSuccessorV1(before.version, before.decision, after.decision.occurrence, before.result)).toEqual(after.decision.occurrence)
    const mutations: Array<(value: RepeatOccurrenceV1) => void> = [
      (v) => { v.identity.scope.runId = 'another-run' },
      (v) => { v.identity.scope.workflowVersionId = 'another-version' },
      (v) => { v.identity.blockId = 'another-block' },
      (v) => { v.input.previous!.decisionId = 'another-decision' },
      (v) => { v.input.previous!.acceptedResultDigest = digest(90) },
      (v) => { v.input.bindingId = before.decision.occurrence.input.bindingId },
    ]
    for (const mutate of mutations) {
      const next = structuredClone(after.decision.occurrence); mutate(next)
      expect(() => validateRepeatSuccessorV1(before.version, before.decision, next, before.result)).toThrow()
    }
  })
  it('early/limit exit never authorizes an extra occurrence', () => {
    for (const f of [evidence(1, 'pass'), evidence(3, 'issues')]) {
      const next = evidence(f.decision.occurrence.identity.occurrenceIndex + 1).decision.occurrence
      expect(() => validateRepeatSuccessorV1(f.version, f.decision, next, f.result)).toThrow()
    }
  })
  it('rejects mismatched accepted output, configuration or scope rather than guessing', () => {
    const f = evidence()
    const wrongData = structuredClone(f.result); wrongData.output.data.latestDeliverable.revision = 99
    expect(() => validateRepeatDecisionV1(f.version, f.decision, wrongData)).toThrow()
    for (const changes of [{ agentConfigurationVersionId: 'another-configuration' }, { workflowNodeId: 'another-node' }, { agentId: 'another-agent' }]) {
      expect(() => validateRepeatDecisionV1(f.version, { ...f.decision, exitExecution: { ...f.decision.exitExecution, ...changes } }, f.result)).toThrow()
    }
    expect(() => RepeatDecisionV1Schema.parse({ ...f.decision, target: { kind: 'next_occurrence', entryNodeId: f.version.entryNodeId, occurrenceIndex: 3 } })).toThrow()
    expect(() => RepeatOccurrenceV1Schema.parse({ ...f.decision.occurrence, input: { ...f.decision.occurrence.input, previous: {} } })).toThrow()
  })
})
