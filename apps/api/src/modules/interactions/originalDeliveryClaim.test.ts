import { expect, it } from 'vitest'
import type { InteractionDeliveryClaim } from './delivery.js'
import { readOriginalInteractionDeliveryClaim, withOriginalInteractionDeliveryClaim } from './originalDeliveryClaim.js'
it('retains the original submit tuple across awaits and isolates caller mutations and concurrent claims', async () => {
  const claim = { interaction: { id: 'original-interaction', revision: 7 }, attempt: 2, ownerToken: 'original-private-token', correlationId: 'original-correlation', mode: 'submit' } as InteractionDeliveryClaim
  const first = withOriginalInteractionDeliveryClaim(claim, async () => {
    await Promise.resolve()
    const readback = readOriginalInteractionDeliveryClaim()!
    expect(readback).toEqual(claim)
    readback.interaction.revision++
    expect(readOriginalInteractionDeliveryClaim()!.interaction.revision).toBe(7)
    await Promise.resolve()
    expect(readOriginalInteractionDeliveryClaim()!.ownerToken).toBe('original-private-token')
  })
  const second = withOriginalInteractionDeliveryClaim({ ...claim, ownerToken: 'other-private-token' }, async () => {
    await Promise.resolve()
    expect(readOriginalInteractionDeliveryClaim()!.ownerToken).toBe('other-private-token')
  })
  await Promise.all([first, second])
  expect(readOriginalInteractionDeliveryClaim()).toBeUndefined()
})
it('does not carry a reconciliation claim into native submit context', () => {
  expect(() => withOriginalInteractionDeliveryClaim({ mode: 'reconcile' } as InteractionDeliveryClaim, async () => {})).toThrow('original submit')
})
