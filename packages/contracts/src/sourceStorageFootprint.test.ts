import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { SourceOperationResponseSchema, SourceReservationReclamationResponseSchema } from './sourceOperations.js'

it('accepts measured output larger than the admission budget in a closed source response', () => {
  const response = { version: 1, operation: 'sources.release', materializationId: randomUUID(),
    operationId: randomUUID(), released: true, retainedBytes: 2 * 1024 * 1024 * 1024 }
  expect(SourceOperationResponseSchema.parse(response)).toEqual(response)
  for (const retainedBytes of [-1, Number.MAX_SAFE_INTEGER + 1]) {
    expect(SourceOperationResponseSchema.safeParse({ ...response, retainedBytes }).success).toBe(false)
  }
  expect(SourceOperationResponseSchema.safeParse({ ...response,
    sharedTree: { id: randomUUID(), bytes: response.retainedBytes + 1 } }).success).toBe(false)
})

it('reports preserved working trees as retained storage rather than full reclamation', () => {
  const response = { version: 1, operation: 'sources.reclaim-reservation', reservationId: randomUUID(),
    reclamationId: randomUUID(), operationId: randomUUID(), reclaimed: false, closures: [],
    retained: { retainedBytes: 8192, sharedTree: { id: randomUUID(), bytes: 4096 } } }
  expect(SourceReservationReclamationResponseSchema.parse(response)).toEqual(response)
  expect(SourceReservationReclamationResponseSchema.safeParse({ ...response, reclaimed: true }).success).toBe(false)
  expect(SourceReservationReclamationResponseSchema.safeParse({ ...response,
    retained: { retainedBytes: 0, sharedTree: response.retained.sharedTree } }).success).toBe(false)
})
