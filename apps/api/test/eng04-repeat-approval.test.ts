import { describe, expect, it } from 'vitest'

import {
  createRepeatHarness,
  makeSimpleRepeatFixture,
  repeatExitOutput,
} from './helpers/eng04RepeatFixtures.js'
import { repeatSettlementPending } from '../src/modules/runs/repeatRuntime.js'

describe('NIM-2648 ENG04-D approval wait, sibling progress and cleanup settlement', () => {
  it('holds only the exact waiting exit while an independently selected sibling can finish', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { sibling: true }))
    const root = await harness.admit(null, 'root', 'raw-root-before-repeat')
    harness.finish(root.id)
    await harness.accept(root.id)

    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-before-approval')
    harness.finish(work.id)
    await harness.accept(work.id)
    const review = await harness.admit(occurrence, 'review', 'raw-review-approval-wait')
    harness.finish(review.id, repeatExitOutput(1, 'issues'))
    harness.blockSettlement('APPROVAL_SETTLEMENT_PENDING', review.id)

    let pending: unknown
    try { await harness.accept(review.id) } catch (error) { pending = error }
    expect(repeatSettlementPending(pending)).toBe(true)
    expect(harness.state().results.has(review.id)).toBe(false)
    expect(harness.state().decisions.size).toBe(0)

    const sibling = await harness.admit(null, 'sibling', 'raw-sibling-during-approval')
    harness.finish(sibling.id, { rawProviderResultId: 'sibling-result-during-approval' })
    await harness.accept(sibling.id)
    expect(harness.state().executions.get(sibling.id)?.accepted).toBe(true)
    expect(harness.state().results.has(sibling.id)).toBe(true)
    expect(harness.state().decisions.size).toBe(0)

    harness.blockSettlement(null)
    await harness.accept(review.id)
    const decision = [...harness.state().decisions.values()][0]!
    expect(decision.exitExecution.executionId).toBe(review.id)
    expect(decision.reason).toBe('repeat')
  })

  it('treats unresolved cleanup as pending settlement, not a failed result or a new occurrence', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-cleanup-wait')
    harness.finish(work.id)
    harness.blockSettlement('REPEAT_CLEANUP_PENDING', work.id)

    let pending: unknown
    try { await harness.accept(work.id) } catch (error) { pending = error }
    expect(repeatSettlementPending(pending)).toBe(true)
    expect(harness.state().results.size).toBe(0)
    expect(harness.state().occurrences.size).toBe(1)
    expect(harness.state().executions.get(work.id)?.accepted).toBe(false)

    harness.blockSettlement(null)
    await harness.accept(work.id)
    expect(harness.state().executions.get(work.id)?.accepted).toBe(true)
    expect(harness.state().occurrences.size).toBe(1)
  })

  it('does not manufacture acknowledgement evidence while settlement is blocked', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-no-fake-ack')
    harness.finish(work.id)
    harness.blockSettlement('APPROVAL_SETTLEMENT_PENDING', work.id)
    await expect(harness.accept(work.id)).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })

    const serialized = JSON.stringify({
      results: [...harness.state().results.entries()],
      decisions: [...harness.state().decisions.entries()],
      publications: harness.state().publications,
    })
    expect(serialized).not.toContain('acknowledgementId')
    expect(serialized).not.toContain('worker.resumed')
  })
})

// Boundary settlement is distinct from provider/approval completion.  A durable
// terminal may exist, but it must not be accepted or advance the business repeat
// until the exact occurrence boundary is settled.
describe('NIM-2648 ENG04-D occurrence-boundary settlement', () => {
  it('keeps the same occurrence/execution identity while REPEAT_BOUNDARY_PENDING clears', async () => {
    const harness = createRepeatHarness(makeSimpleRepeatFixture(2, { suffix: 'eng04-d-boundary-pending' }))
    const occurrence = await harness.enter()
    const work = await harness.admit(occurrence, 'work', 'raw-work-boundary-pending-1')
    harness.finish(work.id, { rawProviderResultId: 'raw-result-boundary-pending-1' })
    harness.blockSettlement('REPEAT_BOUNDARY_PENDING', work.id)

    await expect(harness.accept(work.id)).rejects.toMatchObject({ code: 'REPEAT_BOUNDARY_PENDING' })
    expect(harness.state().executions.get(work.id)?.accepted).toBe(false)
    expect(harness.state().results.has(work.id)).toBe(false)
    expect(harness.state().occurrences.size).toBe(1)
    expect(harness.state().decisions.size).toBe(0)

    harness.blockSettlement(null)
    await harness.accept(work.id)
    expect(harness.state().executions.get(work.id)?.accepted).toBe(true)
    expect(harness.state().executions.get(work.id)?.record.id).toBe('raw-work-boundary-pending-1')
    expect(harness.state().occurrences.size).toBe(1)
  })
})
