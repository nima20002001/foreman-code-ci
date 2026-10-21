import { describe, expect, it } from 'vitest'

import {
  createRepeatHarness,
  makeSimpleRepeatFixture,
  repeatExitOutput,
} from './helpers/eng04RepeatFixtures.js'

describe('NIM-2648 ENG04-D Stop fences', () => {
  it('Stop mid-occurrence preserves already observed terminal bytes but prevents acceptance, route and successor effects', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(3))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-stop-mid-work-1')
    const terminal = harness.finish(work.id, { rawProviderResultId: 'provider-result-stop-mid-1' })
    harness.setStopped(true)

    await expect(harness.accept(work.id)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    const row = harness.state().executions.get(work.id)!
    expect(row.record).toEqual(terminal)
    expect(row.accepted).toBe(false)
    expect(harness.state().results.has(work.id)).toBe(false)
    expect(harness.state().resolutions.has(`${occurrence.identity.occurrenceId}:work`)).toBe(false)
    expect(harness.state().decisions.size).toBe(0)
    expect(harness.state().occurrences.size).toBe(1)
  })

  it('Stop between occurrences makes a pre-Stop repeat decision and durable successor insufficient launch authority', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(3))
    const first = await harness.enter()
    await harness.runBody(first, 'issues')
    const exactDecision = [...harness.state().decisions.values()][0]!
    const successor = [...harness.state().occurrences.values()].find((row) => row.record.identity.occurrenceIndex === 2)!.record
    expect(exactDecision.reason).toBe('repeat')
    expect(successor.input.previous?.decisionId).toBe(exactDecision.decisionId)

    harness.setStopped(true)
    await expect(harness.store.transition(first.identity.occurrenceId)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    await expect(harness.admit(successor, 'work', 'must-never-launch-after-stop')).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    expect(harness.state().executions.has('must-never-launch-after-stop')).toBe(false)
    expect(harness.state().decisions.get(first.identity.occurrenceId)?.decisionId).toBe(exactDecision.decisionId)
  })

  it('Stop after an early/limit exit cannot be converted into another business occurrence by replay', async () => {
    for (const outcome of ['pass', 'issues'] as const) {
      const harness = createRepeatHarness(makeSimpleRepeatFixture(1, { suffix: `eng04-d-stop-final-${outcome}` }))
      const occurrence = await harness.enter()
      const work = await harness.admit(occurrence, 'work')
      harness.finish(work.id)
      await harness.accept(work.id)
      const review = await harness.admit(occurrence, 'review')
      harness.finish(review.id, repeatExitOutput(1, outcome))
      await harness.accept(review.id)
      const decision = [...harness.state().decisions.values()][0]!
      expect(decision.reason).toBe(outcome === 'pass' ? 'early_exit' : 'limit_exit')
      harness.setStopped(true)
      await expect(harness.store.transition(occurrence.identity.occurrenceId)).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
      expect(harness.state().occurrences.size).toBe(1)
    }
  })
})

// Stop is a launch/acceptance fence, not a reason to rewrite already durable
// predecessor provenance.
describe('NIM-2648 ENG04-D Stop provenance preservation', () => {
  it('preserves the exact predecessor decision/result digest while denying the next raw execution', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-stop-provenance' }))
    const first = await harness.enter()
    await harness.runBody(first, 'issues')
    const transition = await harness.store.transition(first.identity.occurrenceId)
    const next = transition.next!
    const decision = harness.state().decisions.get(first.identity.occurrenceId)!
    const result = harness.state().results.get(decision.exitExecution.executionId)!

    expect(next.input.previous).toEqual({
      occurrenceId: first.identity.occurrenceId,
      occurrenceIndex: first.identity.occurrenceIndex,
      decisionId: decision.decisionId,
      acceptedResultDigest: result.result_digest,
    })

    harness.setStopped(true)
    await expect(harness.admit(next, 'work', 'raw-work-after-stop-must-not-exist'))
      .rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })

    expect(harness.state().executions.has('raw-work-after-stop-must-not-exist')).toBe(false)
    expect(harness.state().decisions.get(first.identity.occurrenceId)?.decisionId).toBe(decision.decisionId)
    expect(harness.state().results.get(decision.exitExecution.executionId)?.result_digest).toBe(result.result_digest)
  })
})
