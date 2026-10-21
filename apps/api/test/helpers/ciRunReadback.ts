import { CiGetOutputSchema, type CiGetInput, type CiRunRecord } from '@foreman-code/contracts'
import { expect } from 'vitest'

/** A terminal execution can still be collecting reports; wait for both before comparing persisted records. */
export async function ciRunReadback(read: (input: CiGetInput) => Promise<unknown>, ticketId: string,
  state: CiRunRecord['state']) {
  const result = CiGetOutputSchema.parse(await read({ ticketId, waitUntil: 'group-terminal', waitSeconds: 10 }))
  expect(result.wait?.status).toBe('settled')
  expect(result.run.state, result.logTail ?? result.run.message ?? undefined).toBe(state)
  return result
}
