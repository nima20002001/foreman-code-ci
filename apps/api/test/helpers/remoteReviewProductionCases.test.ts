import { expect, it, vi } from 'vitest'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, ReviewJobSchema } from '@foreman-code/contracts'
import { deliveredReview } from './remoteReviewProductionCases.js'
import type { remoteReviewProduction } from './remoteReviewProduction.js'
import { projectInteractionActivity } from '../../src/modules/interactions/activityProjection.js'

it('observes remote delivery through the original decision retry without application maintenance', async () => {
  const now = new Date().toISOString()
  const interaction = DurableInteractionSchema.parse({
    ...NATIVE_INTERACTION_FIXTURES.codex,
    status: 'delivered',
    deliveryState: 'delivered',
    selectedOptionId: 'codex-approve-once',
    selectedSemantic: 'approve_once',
    nativeResponse: { decision: 'accept' },
    decidedAt: now,
    deliveredAt: now,
  })
  const job = ReviewJobSchema.parse({
    id: 'review-job',
    interactionId: interaction.id,
    reviewerAgentId: 'agent-orchestrator',
    attempt: 1,
    state: 'completed',
    provider: 'codex',
    nativeSessionId: 'review-session',
    providerTurnOrMessageId: 'review-turn',
    correlationId: 'review-correlation',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  })
  let retried = false
  const fixture = {
    provider: {
      calls: async () => [],
      retryReview: async () => { retried = true },
    },
    reconcile: async () => { throw new Error('Application maintenance is unavailable.') },
    reconcileReviews: async () => undefined,
    db: { pool: { query: async () => ({ rows: [{ record: job }] }) } },
    value: vi.fn(async () => {
      if (!retried) throw new Error('The original reviewer has not retried its decision.')
      return { interaction, activity: projectInteractionActivity(interaction, {
        response: { authorized: false, qualified: false, usable: false, path: null },
        workerAcknowledgmentId: 'worker-acknowledgment',
      }) }
    }),
  } as unknown as Awaited<ReturnType<typeof remoteReviewProduction>>

  await expect(deliveredReview(fixture, interaction.id)).resolves.toEqual({ interaction, job })
})

it.each([1, 3])('waits for worker acknowledgment across %i delivery snapshots before comparing MCP readback',
  async deliveryReads => {
    vi.useFakeTimers()
    try {
      const now = '2026-10-01T00:00:00.000Z'
      const delivered = DurableInteractionSchema.parse({
        ...NATIVE_INTERACTION_FIXTURES.codex, revision: 5,
        status: 'delivered', deliveryState: 'delivered',
        selectedOptionId: 'codex-approve-once', selectedSemantic: 'approve_once',
        nativeResponse: { decision: 'accept' }, decidedAt: now, deliveredAt: now, updatedAt: now,
      })
      const resumed = DurableInteractionSchema.parse({
        ...delivered, revision: 6, updatedAt: '2026-10-01T00:00:01.000Z',
      })
      const acknowledged = DurableInteractionSchema.parse({
        ...resumed, revision: 7, updatedAt: '2026-10-01T00:00:02.000Z',
      })
      const job = ReviewJobSchema.parse({
        id: 'review-job', interactionId: delivered.id, reviewerAgentId: 'agent-orchestrator',
        attempt: 1, state: 'completed', provider: 'codex', nativeSessionId: 'review-session',
        providerTurnOrMessageId: 'review-turn', correlationId: 'review-correlation',
        createdAt: now, updatedAt: now, completedAt: now,
      })
      const snapshots = [...Array.from({ length: deliveryReads }, () => delivered), resumed, acknowledged]
      const value = vi.fn(async () => {
        const interaction = snapshots.shift() ?? acknowledged
        return { interaction, activity: projectInteractionActivity(interaction, {
          response: { authorized: false, qualified: false, usable: false, path: null },
          ...(interaction === acknowledged ? { workerAcknowledgmentId: 'worker-acknowledgment' } : {}),
        }) }
      })
      const retryReview = vi.fn(async () => undefined)
      const fixture = {
        provider: { calls: async () => [], retryReview },
        reconcileReviews: async () => undefined,
        db: { pool: { query: async () => ({ rows: [{ record: job }] }) } },
        value,
      } as unknown as Awaited<ReturnType<typeof remoteReviewProduction>>

      const result = deliveredReview(fixture, delivered.id)
      await vi.advanceTimersByTimeAsync(5_000)
      const completed = await result
      const readback = await value()
      expect(readback.interaction).toEqual(completed.interaction)
      expect(completed.interaction).toEqual(acknowledged)
      expect(readback.activity.workerAcknowledgment).toBe('confirmed')
      expect(retryReview).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
