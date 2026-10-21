import { expect, it } from 'vitest'
import { asRecord, isRecord } from './records'

it('keeps structured objects and treats arrays and primitive native payloads as empty records', () => {
  const payload = { input: { answers: ['yes'] } }
  expect(isRecord(payload)).toBe(true)
  expect(asRecord(payload)).toBe(payload)
  for (const value of [null, undefined, [payload], 'payload', 1, true]) {
    expect(isRecord(value)).toBe(false)
    expect(asRecord(value)).toEqual({})
  }
})
