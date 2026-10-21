import { expect, it } from 'vitest'
import { DeviceHistoryPageSchema, DeviceHistoryRequestFields } from '../src/deviceApplication.js'
import { z } from 'zod'

it('preserves metadata continuation on native history requests and replies', () => {
  const metadata = { digest: 'a'.repeat(64), offset: 0 }
  expect(z.object(DeviceHistoryRequestFields).parse({ afterSequence: -1, metadata }))
    .toEqual({ afterSequence: -1, metadata })
  const reply = { nextAfterSequence: 4, hasMore: false,
    metadata: { ...metadata, byteSize: 3, data: 'YWJj' } }
  expect(DeviceHistoryPageSchema.parse(reply)).toEqual(reply)
})
