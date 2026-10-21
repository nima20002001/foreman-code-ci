import { expect, it } from 'vitest'
import { errorMessage } from './errorMessage'

it('uses the supplied UI fallback for non-Errors without replacing an empty Error message', () => {
  expect(errorMessage(new Error('Conflict'), 'Save failed')).toBe('Conflict')
  expect(errorMessage(new Error(''), 'Save failed')).toBe('')
  expect(errorMessage({ message: 'Untrusted text' }, 'Save failed')).toBe('Save failed')
  expect(errorMessage(undefined, 'Load failed')).toBe('Load failed')
})
