import { describe, expect, it } from 'vitest'
import { validateInteractionResponse, withInteractionResponse, type NativeInteractionInput } from './interactionInput.js'

describe('native interaction input', () => {
  const questions: NativeInteractionInput = { kind: 'questions', questions: [
    { id: 'choice', header: 'Path', question: 'Which path?', isOther: false, isSecret: false,
      options: [{ label: 'Fast', description: '' }, { label: 'Careful', description: '' }] },
    { id: 'secret', header: 'Token', question: 'Enter token', isOther: true, isSecret: true, options: null },
  ] }
  it('requires every question and validates offered choices while accepting secret and other input', () => {
    const response = { choice: { answers: ['Careful'] }, secret: { answers: ['entered-token'] } }
    expect(() => validateInteractionResponse(questions, response)).not.toThrow()
    expect(() => validateInteractionResponse(questions, { choice: { answers: ['Careful'] } })).toThrow()
    expect(() => validateInteractionResponse(questions, { ...response, choice: { answers: ['invented'] } })).toThrow()
    expect(() => validateInteractionResponse(questions, { ...response, extra: { answers: ['extra'] } })).toThrow()
    expect(() => validateInteractionResponse(questions, { ...response, secret: { answers: [] } })).toThrow()
  })
  it('validates JSON schema constraints without coercion, defaults, or schema mutation', () => {
    const input: NativeInteractionInput = { kind: 'form', schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false,
      properties: {
        email: { type: 'string', format: 'email', default: 'generated@example.com' },
        count: { type: 'integer', minimum: 1, maximum: 3 },
        accepted: { type: 'boolean' },
        tags: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1, uniqueItems: true },
      }, required: ['email', 'count', 'accepted', 'tags'],
    } }
    const original = structuredClone(input)
    const valid = { email: 'user@example.com', count: 2, accepted: false, tags: ['a'] }
    expect(() => validateInteractionResponse(input, valid)).not.toThrow()
    for (const invalid of [
      { ...valid, email: 'invalid' }, { ...valid, count: '2' }, { ...valid, count: 4 },
      { ...valid, accepted: 'false' }, { ...valid, tags: ['a', 'a'] }, { ...valid, extra: true },
      { count: 2, accepted: false, tags: ['a'] },
    ]) expect(() => validateInteractionResponse(input, invalid)).toThrow()
    expect(input).toEqual(original)
    expect(withInteractionResponse({ input }, valid).response).toEqual(valid)
    expect(() => withInteractionResponse({ input }, undefined)).toThrow()
  })
  it('honors references, composition and dependent fields in requested forms', () => {
    const input: NativeInteractionInput = { kind: 'form', schema: {
      type: 'object', $defs: { code: { type: 'string', pattern: '^[A-Z]{2}$' } },
      properties: { code: { $ref: '#/$defs/code' }, details: { type: 'string' } },
      required: ['code'], dependentRequired: { code: ['details'] },
      allOf: [{ not: { properties: { code: { const: 'ZZ' } } } }], additionalProperties: false,
    } }
    expect(() => validateInteractionResponse(input, { code: 'AB', details: 'Entered' })).not.toThrow()
    for (const invalid of [{ code: 'ab', details: 'Entered' }, { code: 'AB' }, { code: 'ZZ', details: 'Entered' }]) {
      expect(() => validateInteractionResponse(input, invalid)).toThrow()
    }
  })
  it('rejects data on an option without input and preserves no-data confirmations', () => {
    expect(() => withInteractionResponse({}, { forged: true })).toThrow()
    expect(withInteractionResponse({}, undefined)).toEqual({})
    const input: NativeInteractionInput = { kind: 'form', schema: { type: 'object', properties: {} } }
    expect(withInteractionResponse({ input }, undefined).response).toEqual({})
    expect(() => validateInteractionResponse({ kind: 'form', schema: true }, {})).not.toThrow()
    expect(() => validateInteractionResponse({ kind: 'form', schema: false }, {})).toThrow()
  })
})
