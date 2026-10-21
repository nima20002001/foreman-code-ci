import { afterEach, expect, it, vi } from 'vitest'
import type { DurableInteraction } from '@foreman-code/contracts'
import { DomainError } from '../src/modules/errors.js'
import type { GraphResumeClaim } from '../src/modules/interactions/deliveryPostgres.js'
import { INTERACTION_DELIVERY_LEASE_MS } from '../src/modules/interactions/delivery.js'
import { resumeApproval, type ApprovalRuntimeDependencies } from '../src/modules/interactions/wave25/service.js'

afterEach(() => { vi.useRealTimers() })

/** The outbox lease as the database enforces it: a claim is live until its expiry and renews only while live. */
function resumeOutbox() {
  let expiresAt = 0
  const lost = () => new DomainError('GRAPH_RESUME_OWNER_LOST', 'The graph-resume intent is no longer owned.', 409)
  const delivery = {
    claimAtomicGraphResume: vi.fn(async (_id: string, ownerToken: string): Promise<GraphResumeClaim> => {
      expiresAt = Date.now() + INTERACTION_DELIVERY_LEASE_MS
      return { interaction: { id: 'interaction', runId: 'run' } as DurableInteraction, ownerToken }
    }),
    renewGraphResume: vi.fn(async () => {
      if (Date.now() >= expiresAt) throw lost()
      expiresAt = Date.now() + INTERACTION_DELIVERY_LEASE_MS
    }),
    finishGraphResume: vi.fn(async (...args: [GraphResumeClaim, string?]) => {
      void args
      if (Date.now() >= expiresAt) throw lost()
    }),
  }
  return { delivery, live: () => Date.now() < expiresAt }
}

it('keeps a delivered response claimed while it waits longer than its lease for the Run owner', async () => {
  vi.useFakeTimers()
  const outbox = resumeOutbox()
  const consumed: boolean[] = []
  // The Run owner is busy with earlier work for three minutes, then commits under the claim's lease fence.
  const atomicResume = vi.fn(async (claim: GraphResumeClaim) => {
    await new Promise(resolve => setTimeout(resolve, 3 * 60_000))
    await claim.release?.()
    consumed.push(outbox.live())
    if (!outbox.live()) throw new DomainError('GRAPH_RESUME_OWNER_LOST', 'The resume claim expired.', 409)
  })
  const deps = { repository: { delivery: outbox.delivery }, atomicResume } as unknown as ApprovalRuntimeDependencies
  const resumed = resumeApproval(deps, { id: 'interaction', deliveryState: 'delivered', status: 'delivered' } as DurableInteraction)
  await vi.advanceTimersByTimeAsync(3 * 60_000)
  await expect(resumed).resolves.toBeUndefined()
  expect(consumed).toEqual([true])
  expect(outbox.delivery.finishGraphResume).toHaveBeenCalledWith(expect.anything(), undefined)
  // The owner took the claim over: its claimant no longer renews it.
  const renewals = outbox.delivery.renewGraphResume.mock.calls.length
  expect(renewals).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(outbox.delivery.renewGraphResume).toHaveBeenCalledTimes(renewals)
})
