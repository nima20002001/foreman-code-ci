import { expect, it } from 'vitest'
import { errorMessage } from './errorMessage.js'

it('preserves Error messages even when empty and uses the caller fallback for other values', () => {
  expect(errorMessage(new Error('Request failed'), 'Fallback')).toBe('Request failed')
  expect(errorMessage(new Error(''), 'Fallback')).toBe('')
  for (const error of [undefined, null, 'message', { message: 'message' }]) {
    expect(errorMessage(error, 'Fallback')).toBe('Fallback')
  }
})
