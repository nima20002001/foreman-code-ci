import { AsyncLocalStorage } from 'node:async_hooks'
import type { InteractionDeliveryClaim } from './delivery.js'

const original = new AsyncLocalStorage<Readonly<InteractionDeliveryClaim>>()
/** Preserve the submit callback's original attempt/token/fence across the writer
 * queue. This cannot acquire a claim or turn reconciliation into a send permit. */
export function withOriginalInteractionDeliveryClaim<T>(claim: InteractionDeliveryClaim, action: () => Promise<T>): Promise<T> {
  if (claim.mode !== 'submit') throw new Error('Only the original submit claim can carry a native delivery context')
  const captured = structuredClone(claim)
  Object.freeze(captured)
  return original.run(captured, action)
}
/** Recovery can read the admitted command, but cannot create a new admission. */
export function withInteractionDeliveryReconciliation<T>(claim: InteractionDeliveryClaim, action: () => Promise<T>): Promise<T> {
  if (claim.mode !== 'reconcile') throw new Error('A reconciliation delivery claim is required')
  const captured = Object.freeze(structuredClone(claim))
  return original.run(captured, action)
}
export function readOriginalInteractionDeliveryClaim(): Readonly<InteractionDeliveryClaim> | undefined {
  const claim = original.getStore()
  return claim ? structuredClone(claim) : undefined
}
