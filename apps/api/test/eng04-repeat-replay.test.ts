import { describe, expect, it } from 'vitest'

import {
  createRepeatHarness,
  firstOccurrence,
  makeSimpleRepeatFixture,
  repeatExitOutput,
} from './helpers/eng04RepeatFixtures.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'

describe('NIM-2648 ENG04-D replay and retry separation', () => {
  it('replays occurrence creation, node admission, result acceptance and successor transition without duplicate durable effects', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(3))
    const occurrence = await harness.enter()
    const again = await harness.enter()
    expect(again.identity).toEqual(occurrence.identity)

    const work = await harness.admit(occurrence, 'work', 'raw-work-replay-1')
    const effectsAfterAdmission = harness.state().effects.size
    const reservation = structuredClone(harness.state().nativeReservations.get(work.id))
    expect(reservation).toMatchObject({ runId: work.runId, reservation: {
      scope: harness.fixture.scope, execution: { executionId: work.id },
      ref: { nodeId: work.workflowNodeId, occurrence: occurrence.identity },
    } })
    const reused = await harness.store.admit(
      { nodeId: 'work', occurrence: occurrence.identity },
      () => { throw new Error('duplicate admission must not allocate') },
    )
    expect(reused).toMatchObject({ kind: 'admitted', reused: true, execution: { id: work.id } })
    expect(harness.state().effects.size).toBe(effectsAfterAdmission)
    expect(harness.state().nativeReservations.size).toBe(1)
    expect(harness.state().nativeReservations.get(work.id)).toEqual(reservation)

    harness.finish(work.id)
    const accepted = await harness.accept(work.id)
    expect(accepted).toMatchObject({ kind: 'accepted', resolution: { value: { resolution: 'succeeded' } } })
    if (accepted.kind !== 'accepted') throw new Error('Expected first terminal acceptance')
    const resultDigest = harness.state().results.get(work.id)!.result_digest
    const countsBeforeReplay = {
      occurrences: harness.state().occurrences.size,
      executions: harness.state().executions.size,
      results: harness.state().results.size,
      resolutions: harness.state().resolutions.size,
      effects: harness.state().effects.size,
      publications: harness.state().publications.length,
    }
    const replay = await harness.repository().acceptTerminal(work.id,
      () => { throw new Error('accepted replay must not allocate') })
    expect(replay).toEqual({ kind: 'resolved', resolution: accepted.resolution })
    expect(harness.state().results.get(work.id)!.result_digest).toBe(resultDigest)
    expect({
      occurrences: harness.state().occurrences.size,
      executions: harness.state().executions.size,
      results: harness.state().results.size,
      resolutions: harness.state().resolutions.size,
      effects: harness.state().effects.size,
      publications: harness.state().publications.length,
    }).toEqual(countsBeforeReplay)

    const review = await harness.admit(occurrence, 'review', 'raw-review-replay-1')
    const completedReview = harness.finish(review.id, repeatExitOutput(1, 'issues'))
    expect(await harness.accept(review.id)).toMatchObject({ kind: 'resolved', resolution: { value: {
      resolution: 'succeeded', acceptedResultDigest: repeatDigest(completedReview.result),
    } } })
    const firstTransition = await harness.store.transition(occurrence.identity.occurrenceId)
    const publications = harness.state().publications.length
    const secondTransition = await harness.store.transition(occurrence.identity.occurrenceId)
    expect(secondTransition).toEqual(firstTransition)
    expect(secondTransition.next?.identity.occurrenceIndex).toBe(2)
    expect(harness.state().occurrences.size).toBe(2)
    expect(harness.state().publications.length).toBe(publications)
  })

  it('keeps technical retry, business occurrence and full-Run retry as three distinct identities', async () => {
    const fixture = makeSimpleRepeatFixture(2, { suffix: 'eng04-d-retry-triplet', runId: 'run-retry-triplet-1' })
    const harness = createRepeatHarness(fixture)
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-attempt-1')
    const firstInput = structuredClone(work.input)
    harness.failExecution(work.id, 'RAW_PROVIDER_RETRYABLE')
    const technical = await harness.accept(work.id)
    expect(technical.kind).toBe('retry')
    if (technical.kind !== 'retry') throw new Error('technical retry expected')
    expect(technical.execution.attempt).toBe(2)
    expect(technical.execution.input).toEqual(firstInput)
    expect(harness.state().occurrences.size).toBe(1)
    expect(harness.state().executions.get(technical.execution.id)!.slot_id).toBe(harness.state().executions.get(work.id)!.slot_id)

    harness.finish(technical.execution.id)
    await harness.accept(technical.execution.id)
    const review = await harness.admit(occurrence, 'review', 'raw-review-business-1')
    harness.finish(review.id, repeatExitOutput(1, 'issues'))
    await harness.accept(review.id)
    const transition = await harness.store.transition(occurrence.identity.occurrenceId)
    expect(transition.next?.identity.occurrenceIndex).toBe(2)
    expect(transition.next?.identity.occurrenceId).not.toBe(occurrence.identity.occurrenceId)

    const newRun = makeSimpleRepeatFixture(2, { suffix: 'eng04-d-retry-triplet', runId: 'run-retry-triplet-2' })
    const newRunOccurrence = firstOccurrence(newRun).occurrence
    expect(newRunOccurrence.identity.occurrenceIndex).toBe(1)
    expect(newRunOccurrence.input.previous).toBeNull()
    expect(newRunOccurrence.identity.scope.runId).toBe('run-retry-triplet-2')
    expect(newRunOccurrence.identity.occurrenceId).not.toBe(occurrence.identity.occurrenceId)
  })

  it('publishes exact repeat metadata once and a complete delta replay equals the deterministic snapshot cut', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2))
    const occurrence = await harness.enter()
    await harness.runBody(occurrence, 'issues')
    const next = (await harness.store.transition(occurrence.identity.occurrenceId)).next!
    await harness.runBody(next, 'pass')
    await harness.store.transition(next.identity.occurrenceId)

    const snapshot = harness.snapshotPublications()
    expect(snapshot.length).toBeGreaterThan(0)
    const firstSequence = snapshot[0]!.sequence
    const delta = harness.deltasAfter(firstSequence)
    expect([snapshot[0], ...delta]).toEqual(snapshot)

    const occurrenceFacts = snapshot.flatMap((publication) => publication.facts)
      .filter((fact) => fact.type === 'repeat.occurrence')
    const decisionFacts = snapshot.flatMap((publication) => publication.facts)
      .filter((fact) => fact.type === 'repeat.decision')
    expect(occurrenceFacts.map((fact) => fact.occurrence.identity.occurrenceIndex)).toEqual([1, 2])
    expect(decisionFacts.map((fact) => fact.decision.reason)).toEqual(['repeat', 'early_exit'])
    expect(decisionFacts[0]!.decision.acceptedResultDigest).toBe(repeatDigest(JSON.parse(harness.state().results.get('review-1')!.result_json)))
    expect(JSON.stringify(decisionFacts)).not.toContain('latestDeliverable')
    expect(JSON.stringify(decisionFacts)).not.toContain('remainingFindings')
  })
})

// NIM-2648 successor regression: a lost COMMIT reply must replay from durable
// state without minting a second accepted result, decision or publication.
describe('NIM-2648 ENG04-D durable replay after ambiguous commit', () => {
  it('reuses exact raw identities and digests after the first commit acknowledgement is lost', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-lost-commit' }))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-lost-commit-1')
    harness.finish(work.id, { rawProviderResultId: 'raw-result-lost-commit-1' })
    harness.loseCommit()

    await expect(harness.accept(work.id)).rejects.toThrow('COMMIT reply lost')

    const afterAmbiguousCommit = harness.state()
    expect(afterAmbiguousCommit.results.get(work.id)?.result_digest).toBeDefined()
    expect(afterAmbiguousCommit.executions.get(work.id)?.accepted).toBe(true)
    const digest = afterAmbiguousCommit.results.get(work.id)!.result_digest
    const publicationCount = afterAmbiguousCommit.publications.length
    const resultCount = afterAmbiguousCommit.results.size
    expect(harness.connection.unusable).toBe(true)
    harness.renewConnection()
    expect(harness.connection.unusable).toBe(false)

    await harness.repository().acceptTerminal(work.id, () => {
      throw new Error('durable accepted replay must not allocate another execution')
    })

    expect(harness.state().results.get(work.id)?.result_digest).toBe(digest)
    expect(harness.state().results.size).toBe(resultCount)
    expect(harness.state().publications.length).toBe(publicationCount)
    expect(harness.state().executions.get(work.id)?.record.id).toBe('raw-work-lost-commit-1')
  })
})
