import { expect, it } from 'vitest'
import { deviceApplicationFailure } from '../../devices/deviceApplicationError.js'
import { pageJsonContinuationBytes } from './jsonContinuation.js'

it.each(['size', 'digest', 'offset'] as const)('codes a permanent JSON continuation %s failure', reason => {
  const bytes = Buffer.from(JSON.stringify({ text: 'original reply' }))
  const first = pageJsonContinuationBytes(bytes)
  const request = { digest: first.digest, offset: 1 }
  if (reason === 'digest') request.digest = 'f'.repeat(64)
  if (reason === 'offset') request.offset = bytes.byteLength
  let failure: unknown
  try {
    pageJsonContinuationBytes(bytes, request, reason === 'size' ? { maxBytes: bytes.byteLength - 1 } : {})
  } catch (error) {
    failure = error
  }
  expect(deviceApplicationFailure(failure)).toEqual({
    code: reason === 'size' ? 'payload-too-large' : 'conflict', class: 'permanent', retryable: false,
  })
})
