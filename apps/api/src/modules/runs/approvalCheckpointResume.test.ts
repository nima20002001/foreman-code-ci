import type pg from 'pg'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { ApprovalPostgresSaver } from '../../infrastructure/approvalCheckpointSaver.js'
import { DomainError } from '../errors.js'
import { Wave25InteractionRepository } from '../interactions/wave25/repository.js'
import { consumeDeliveredApprovals } from './approvalCheckpointResume.js'
import type { RunOwnership } from './ownership.js'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('stops every resume claim when the Run owner disconnects during the last acquisition', async () => {
  vi.useFakeTimers()
  const pool = { query: vi.fn(async () => { throw new Error('Unexpected database call') }) } as unknown as pg.Pool
  const repository = new Wave25InteractionRepository(pool)
  const saver = new ApprovalPostgresSaver(pool)
  const pending = NATIVE_INTERACTION_FIXTURES.codex
  const option = pending.responseOptions[0]!
  const delivered = ['approval-a', 'approval-b'].map(id => DurableInteractionSchema.parse({
    ...pending, id, graphThreadId: pending.runId, graphInterruptId: 'saved-interrupt',
    status: 'delivered', deliveryState: 'delivered', selectedOptionId: option.optionId,
    selectedSemantic: option.semantic, nativeResponse: { decision: 'accept' },
    decidedAt: pending.createdAt, deliveredAt: pending.createdAt,
  }))
  let owned = true
  const assertOwned = () => {
    if (!owned) throw new DomainError('RUN_OWNERSHIP_LOST', 'The Run owner disconnected.', 409)
  }
  const owner = { runId: pending.runId, assertOwned, oneShotConnection: () => {
    assertOwned()
    throw new Error('The disconnected owner cannot open a transaction')
  } } as unknown as RunOwnership
  const release = vi.fn(async () => {})
  const supplied = { interaction: delivered[0]!, ownerToken: 'supplied-claim', release }
  vi.spyOn(repository.delivery, 'claimAtomicGraphResume').mockImplementation(async () => {
    owned = false
    return { interaction: delivered[1]!, ownerToken: 'acquired-claim' }
  })
  const renew = vi.spyOn(repository.delivery, 'renewGraphResume').mockResolvedValue(undefined)

  await expect(consumeDeliveredApprovals(owner, saver, repository, delivered, supplied))
    .rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
  await vi.advanceTimersByTimeAsync(25_000)
  expect.soft(renew).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})
