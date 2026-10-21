import { describe, expect, it } from 'vitest'

import {
  canonicalDigest,
  createRepeatHarness,
  makeSimpleRepeatFixture,
  repeatExitOutput,
} from './helpers/eng04RepeatFixtures.js'

describe('NIM-2648 ENG04-D bounded-repeat raw identity/digest matrix', () => {
  it('persists distinct accepted predecessor inputs/results across multiple business occurrences', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(3, { suffix: 'eng04-d-raw-matrix' }))
    const first = await harness.enter()
    expect(first.identity.occurrenceIndex).toBe(1)
    expect(first.input.previous).toBeNull()

    const firstWork = await harness.admit(first, 'work', 'raw-work-occurrence-1')
    harness.finish(firstWork.id, { rawProviderResultId: 'raw-work-result-1', deliverable: 'one' })
    await harness.accept(firstWork.id)
    const firstWorkRow = harness.state().results.get(firstWork.id)!

    const firstReview = await harness.admit(first, 'review', 'raw-review-occurrence-1')
    const firstExit = repeatExitOutput(1, 'issues')
    harness.finish(firstReview.id, firstExit)
    await harness.accept(firstReview.id)
    const firstReviewRow = harness.state().results.get(firstReview.id)!
    const firstDecision = harness.state().decisions.get(first.identity.occurrenceId)!
    const second = (await harness.store.transition(first.identity.occurrenceId)).next!

    expect(firstWorkRow.result_digest).toBe(canonicalDigest(JSON.parse(firstWorkRow.result_json)))
    expect(firstReviewRow.result_digest).toBe(canonicalDigest(JSON.parse(firstReviewRow.result_json)))
    expect(firstDecision.acceptedResultDigest).toBe(firstReviewRow.result_digest)
    expect(firstDecision.exitExecution.executionId).toBe('raw-review-occurrence-1')
    expect(second.identity.occurrenceId).not.toBe(first.identity.occurrenceId)
    expect(second.input.bindingId).not.toBe(first.input.bindingId)
    expect(second.input.inputDigest).not.toBe(first.input.inputDigest)
    expect(second.input.previous).toEqual({
      occurrenceId: first.identity.occurrenceId,
      occurrenceIndex: 1,
      decisionId: firstDecision.decisionId,
      acceptedResultDigest: firstReviewRow.result_digest,
    })

    const secondWork = await harness.admit(second, 'work', 'raw-work-occurrence-2')
    harness.finish(secondWork.id, { rawProviderResultId: 'raw-work-result-2', deliverable: 'two' })
    await harness.accept(secondWork.id)
    const secondReview = await harness.admit(second, 'review', 'raw-review-occurrence-2')
    harness.finish(secondReview.id, repeatExitOutput(2, 'pass'))
    await harness.accept(secondReview.id)
    const secondDecision = harness.state().decisions.get(second.identity.occurrenceId)!

    expect(secondDecision.reason).toBe('early_exit')
    expect(secondDecision.exitExecution.executionId).toBe('raw-review-occurrence-2')
    expect(secondDecision.acceptedResultDigest).toBe(harness.state().results.get(secondReview.id)!.result_digest)
    expect(new Set([firstWork.id, firstReview.id, secondWork.id, secondReview.id]).size).toBe(4)
    expect(new Set([first.identity.occurrenceId, second.identity.occurrenceId]).size).toBe(2)
  })

  it('turns the repeat outcome at the exact finite cap into limit_exit with no successor', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-exact-cap' }))
    const first = await harness.enter()
    await harness.runBody(first, 'issues')
    const second = (await harness.store.transition(first.identity.occurrenceId)).next!
    await harness.runBody(second, 'issues')
    const terminal = await harness.store.transition(second.identity.occurrenceId)
    const decision = harness.state().decisions.get(second.identity.occurrenceId)!

    expect(second.identity.occurrenceIndex).toBe(2)
    expect(decision.reason).toBe('limit_exit')
    expect(decision.target).toEqual(harness.fixture.block.limitExit)
    expect(terminal.next).toBeNull()
    expect(harness.state().occurrences.size).toBe(2)
  })

  it('rejects an invalid repeat exit without accepting result bytes or creating a business decision', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-invalid-result' }))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-before-invalid-review')
    harness.finish(work.id)
    await harness.accept(work.id)

    const review = await harness.admit(occurrence, 'review', 'raw-review-invalid-envelope')
    harness.finish(review.id, {
      routing: { outcome: 'issues' },
      data: { latestDeliverable: null, remainingFindings: [] },
    })

    await expect(harness.accept(review.id)).rejects.toBeDefined()
    expect(harness.state().executions.get(review.id)?.accepted).toBe(false)
    expect(harness.state().results.has(review.id)).toBe(false)
    expect(harness.state().decisions.size).toBe(0)
    expect(harness.state().occurrences.size).toBe(1)
  })

  it('does not confuse identical provider bytes with raw execution or business-occurrence identity', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-identical-bytes' }))
    const first = await harness.enter()
    const firstWork = await harness.admit(first, 'work', 'raw-identical-work-1')
    harness.finish(firstWork.id, { rawProviderResultId: 'same-provider-result' })
    await harness.accept(firstWork.id)
    const firstReview = await harness.admit(first, 'review', 'raw-identical-review-1')
    harness.finish(firstReview.id, repeatExitOutput(1, 'issues'))
    await harness.accept(firstReview.id)
    const second = (await harness.store.transition(first.identity.occurrenceId)).next!

    const secondWork = await harness.admit(second, 'work', 'raw-identical-work-2')
    harness.finish(secondWork.id, { rawProviderResultId: 'same-provider-result' })
    await harness.accept(secondWork.id)

    expect(harness.state().results.get(firstWork.id)!.result_digest)
      .toBe(harness.state().results.get(secondWork.id)!.result_digest)
    expect(firstWork.id).not.toBe(secondWork.id)
    expect(first.identity.occurrenceId).not.toBe(second.identity.occurrenceId)
    expect(first.input.inputDigest).not.toBe(second.input.inputDigest)
  })

  it('mirrors the strict stored execution columns, bound input digest and raw provider session identity', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-stored-execution-contract' }))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-stored-contract-work-1')
    const stored = harness.state().executions.get(work.id)!
    const slot = harness.state().slots.get(stored.slot_id)!

    expect(stored.execution_id).toBe(work.id)
    expect(stored.execution_run_id).toBe(work.runId)
    expect(stored.execution_node_id).toBe(work.workflowNodeId)
    expect(stored.execution_agent_id).toBe(work.agentId)
    expect(stored.execution_attempt).toBe(work.attempt)
    expect(stored.execution_occurrence_id).toBe(occurrence.identity.occurrenceId)
    expect(stored.identity_occurrence_id).toBe(occurrence.identity.occurrenceId)
    expect(stored.technical_attempt).toBe(1)
    expect(JSON.parse(slot.input_json)).toEqual(work.input)
    expect(slot.input_digest).toBe(canonicalDigest(work.input))

    harness.finish(work.id, { rawProviderResultId: 'raw-stored-contract-result-1' })
    const session = harness.state().nativeSessions.get(work.id)!
    const closure = harness.state().nativeClosures.get(work.id)!
    expect(session.reference.nativeSessionId).toBe(`native-session-${work.id}`)
    expect(closure.closed).toBe(true)
    expect(closure.generation).toBe('1')
    expect(session.finalized).toBe(false)

    await harness.accept(work.id)
    expect(harness.state().nativeSessions.get(work.id)?.finalized).toBe(true)
    expect(harness.state().results.get(work.id)?.result_digest)
      .toBe(canonicalDigest(JSON.parse(harness.state().results.get(work.id)!.result_json)))
  })

  it('fails closed on duplicated stored execution drift before any host settlement fence can decide the result', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-stored-execution-drift' }))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-stored-drift-work-1')
    harness.finish(work.id, { rawProviderResultId: 'raw-stored-drift-result-1' })
    const stored = harness.state().executions.get(work.id)!
    stored.technical_attempt = 2
    harness.blockSettlement('APPROVAL_SETTLEMENT_PENDING', work.id)

    await expect(harness.accept(work.id)).rejects.toMatchObject({ code: 'REPEAT_EXECUTION_INPUT_CONFLICT' })
    expect(harness.events.includes('settlement')).toBe(false)
    expect(harness.state().results.has(work.id)).toBe(false)

    harness.state().executions.get(work.id)!.technical_attempt = 1
    harness.blockSettlement(null)
    await harness.accept(work.id)
    expect(harness.state().executions.get(work.id)?.accepted).toBe(true)
  })

  it('requires durable native session evidence for a successful terminal before the host settlement adapter runs', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-native-settlement-order' }))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-native-settlement-work-1')
    harness.finish(work.id, { rawProviderResultId: 'raw-native-settlement-result-1' })
    const native = harness.state().nativeSessions.get(work.id)!
    harness.state().nativeSessions.delete(work.id)
    harness.blockSettlement('APPROVAL_SETTLEMENT_PENDING', work.id)

    await expect(harness.accept(work.id)).rejects.toMatchObject({ code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    expect(harness.events.includes('settlement')).toBe(false)
    expect(harness.state().results.has(work.id)).toBe(false)

    harness.state().nativeSessions.set(work.id, native)
    harness.blockSettlement(null)
    await harness.accept(work.id)
    expect(harness.state().nativeSessions.get(work.id)?.finalized).toBe(true)
  })

})
