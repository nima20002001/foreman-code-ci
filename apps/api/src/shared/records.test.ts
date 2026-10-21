import { describe, expect, it } from 'vitest'
import { asRecord, isRecord } from './records.js'

describe('record helpers', () => {
  it.each([null, undefined, false, 0, '', 'text', [], () => undefined])(
    'rejects non-record input %s and returns a fresh empty fallback', value => {
      expect(isRecord(value)).toBe(false)
      expect(asRecord(value)).toEqual({})
      expect(asRecord(value)).not.toBe(asRecord(value))
    },
  )

  it('preserves object identity, including objects with a custom prototype', () => {
    const values = [{ nested: { value: 1 } }, Object.create(null) as Record<string, unknown>, new Date(0)]
    for (const value of values) {
      expect(isRecord(value)).toBe(true)
      expect(asRecord(value)).toBe(value)
    }
  })
})
