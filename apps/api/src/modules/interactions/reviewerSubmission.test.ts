import { expect, it } from 'vitest'
import { NativeDeliveryError } from '../harnesses/errors.js'
import { definitelyRejected } from './reviewerEvidence.js'

it('classifies a native refusal before submission without a provider-specific code', () => {
  expect(definitelyRejected(new NativeDeliveryError('turn_submission', 'not_sent', new Error('Refused')))).toBe(true)
})

it.each([
  new Error('Connection lost'),
  new NativeDeliveryError('turn_submission', 'unknown', new Error('Connection lost')),
  new NativeDeliveryError('session_creation', 'not_sent', new Error('Session refused')),
  Object.assign(new Error('Observation failed'), { certainty: 'definite' }),
])('keeps other failures outside definite turn rejection: %s', error => {
  expect(definitelyRejected(error)).toBe(false)
})
