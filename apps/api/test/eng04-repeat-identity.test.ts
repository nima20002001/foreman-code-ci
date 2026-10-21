import { describe, expect, it } from 'vitest'
import {
  RepeatOccurrenceV1Schema,
  validateRepeatDecisionV1,
  validateRepeatSuccessorV1,
} from '@foreman-code/contracts/wave25'

import {
  exitDecision,
  firstOccurrence,
  makeSimpleRepeatFixture,
  repeatExitOutput,
  successfulExecution,
  executionFor,
} from './helpers/eng04RepeatFixtures.js'
import {
  makeRepeatOccurrence,
  repeatDigest,
  repeatSuccessorInput,
} from '../src/modules/runs/repeatResolution.js'

function successor(
  fixture: ReturnType<typeof makeSimpleRepeatFixture>,
  current: ReturnType<typeof firstOccurrence>,
  completed: ReturnType<typeof exitDecision>['completed'],
  decision: ReturnType<typeof exitDecision>['decision'],
) {
  const input = repeatSuccessorInput(current.input, decision, completed.result!)
  return makeRepeatOccurrence(fixture.scope, fixture.block, input, decision)
}

describe('NIM-2648 ENG04-D repeat identity and provenance', () => {
  it('cap 1 records limit_exit on occurrence 1 and cannot mint occurrence 2', () => {
    const fixture = makeSimpleRepeatFixture(1)
    const current = firstOccurrence(fixture)
    const { completed, decision } = exitDecision(fixture, current.occurrence, 'issues', 'raw-exit-cap-1')

    expect(current.occurrence.identity.occurrenceIndex).toBe(1)
    expect(current.occurrence.input.previous).toBeNull()
    expect(decision.reason).toBe('limit_exit')
    expect(decision.target).toEqual(fixture.block.limitExit)
    expect(decision.exitExecution.executionId).toBe('raw-exit-cap-1')
    expect(decision.acceptedResultDigest).toBe(repeatDigest(completed.result))
    expect(decision.resultData).toEqual(repeatExitOutput(1).data)
    expect(validateRepeatDecisionV1(fixture.version, decision, completed.result)).toEqual(decision)
    expect(() => successor(fixture, current, completed, decision)).toThrow()
  })

  it('binds every successor to the exact previous occurrence, decision, execution and accepted-result digest', () => {
    const fixture = makeSimpleRepeatFixture(3)
    const first = firstOccurrence(fixture)
    const one = exitDecision(fixture, first.occurrence, 'issues', 'raw-review-exec-1')
    const second = successor(fixture, first, one.completed, one.decision)
    const two = exitDecision(fixture, second.occurrence, 'issues', 'raw-review-exec-2')
    const third = successor(fixture, second, two.completed, two.decision)

    expect(second.occurrence.input.previous).toEqual({
      occurrenceId: first.occurrence.identity.occurrenceId,
      occurrenceIndex: 1,
      decisionId: one.decision.decisionId,
      acceptedResultDigest: repeatDigest(one.completed.result),
    })
    expect(second.input.carry).toMatchObject({
      decisionId: one.decision.decisionId,
      execution: { executionId: 'raw-review-exec-1', occurrence: first.occurrence.identity },
      acceptedResultDigest: repeatDigest(one.completed.result),
    })
    expect(third.occurrence.input.previous).toMatchObject({
      occurrenceId: second.occurrence.identity.occurrenceId,
      occurrenceIndex: 2,
      decisionId: two.decision.decisionId,
      acceptedResultDigest: repeatDigest(two.completed.result),
    })
    expect(new Set([
      first.occurrence.identity.occurrenceId,
      second.occurrence.identity.occurrenceId,
      third.occurrence.identity.occurrenceId,
    ]).size).toBe(3)
    expect(new Set([
      first.occurrence.input.bindingId,
      second.occurrence.input.bindingId,
      third.occurrence.input.bindingId,
    ]).size).toBe(3)
    expect(validateRepeatSuccessorV1(fixture.version, one.decision, second.occurrence, one.completed.result)).toEqual(second.occurrence)
    expect(validateRepeatSuccessorV1(fixture.version, two.decision, third.occurrence, two.completed.result)).toEqual(third.occurrence)
  })

  it('does not use digest equality as result identity when identical result bytes occur in different occurrences', () => {
    const fixture = makeSimpleRepeatFixture(3)
    const first = firstOccurrence(fixture)
    const common = repeatExitOutput(1)
    const firstExecution = successfulExecution(executionFor(fixture, 'review', 'same-bytes-exec-1'), common)
    const firstDecision = exitDecision(fixture, first.occurrence, 'issues', firstExecution.id)
    const second = successor(fixture, first, firstDecision.completed, firstDecision.decision)

    const secondExecution = successfulExecution(executionFor(fixture, 'review', 'same-bytes-exec-2'), common)
    expect(repeatDigest(firstExecution.result)).toBe(repeatDigest(secondExecution.result))
    expect(firstExecution.id).not.toBe(secondExecution.id)
    expect(first.occurrence.identity.occurrenceId).not.toBe(second.occurrence.identity.occurrenceId)
    expect(firstDecision.decision.exitExecution.executionId).toBe(firstExecution.id)
    expect(firstDecision.decision.exitExecution.occurrence.occurrenceId).toBe(first.occurrence.identity.occurrenceId)
  })

  it('full-Run retry starts fresh at occurrence 1 and never imports previous-Run ancestry', () => {
    const firstRun = makeSimpleRepeatFixture(3, { suffix: 'eng04-d-full-run', runId: 'run-eng04-d-original' })
    const current = firstOccurrence(firstRun)
    const { completed, decision } = exitDecision(firstRun, current.occurrence, 'issues', 'review-original-1')
    const next = successor(firstRun, current, completed, decision)

    const retriedRun = makeSimpleRepeatFixture(3, { suffix: 'eng04-d-full-run', runId: 'run-eng04-d-retry' })
    const retryFirst = firstOccurrence(retriedRun)
    expect(next.occurrence.identity.occurrenceIndex).toBe(2)
    expect(retryFirst.occurrence.identity.occurrenceIndex).toBe(1)
    expect(retryFirst.occurrence.input.previous).toBeNull()
    expect(retryFirst.occurrence.identity.scope.runId).toBe('run-eng04-d-retry')
    expect(retryFirst.occurrence.identity.occurrenceId).not.toBe(current.occurrence.identity.occurrenceId)
    expect(() => RepeatOccurrenceV1Schema.parse({
      ...retryFirst.occurrence,
      input: { ...retryFirst.occurrence.input, previous: next.occurrence.input.previous },
    })).toThrow()
  })

  it('early exit wins at the cap and preserves exact latest deliverable and findings', () => {
    const fixture = makeSimpleRepeatFixture(2)
    const first = firstOccurrence(fixture)
    const one = exitDecision(fixture, first.occurrence, 'issues', 'review-early-1')
    const second = successor(fixture, first, one.completed, one.decision)
    const two = exitDecision(fixture, second.occurrence, 'pass', 'review-early-2')

    expect(two.decision.reason).toBe('early_exit')
    expect(two.decision.outcome).toBe('pass')
    expect(two.decision.resultData).toEqual(repeatExitOutput(2, 'pass').data)
    expect(two.decision.resultData.remainingFindings).toEqual([])
    expect(two.decision.exitExecution.executionId).toBe('review-early-2')
  })
})
