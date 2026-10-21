import { describe, expect, it } from 'vitest'

import { toolFailure, toolResult } from '../src/mcp/shared/results.js'
import { DomainError } from '../src/modules/errors.js'

describe('MCP result envelopes', () => {
  it.each([
    { input: { items: ['one'] }, expected: { items: ['one'] } },
    { input: ['one'], expected: { value: ['one'] } },
    { input: 'one', expected: { value: 'one' } },
    { input: null, expected: { value: null } },
  ])('serializes successful structured and text results consistently: $input', ({ input, expected }) => {
    expect(toolResult(input)).toEqual({
      content: [{ type: 'text', text: JSON.stringify(expected) }], structuredContent: expected,
    })
  })

  it.each([undefined, { revision: 2 }])('preserves domain failures and optional details: %j', (details) => {
    const error = new DomainError('REVISION_CONFLICT', 'The resource changed.', 409, details)
    const body = { error: { code: 'REVISION_CONFLICT', message: 'The resource changed.', ...(details ? { details } : {}) } }
    expect(toolFailure(error)).toEqual({
      isError: true, content: [{ type: 'text', text: JSON.stringify(body) }],
    })
  })

  it.each([
    { message: undefined, expected: 'The Operator service could not complete the request.' },
    { message: 'The App service could not complete the request.', expected: 'The App service could not complete the request.' },
  ])('redacts unexpected failures while retaining the selected fallback: $expected', ({ message, expected }) => {
    const body = { error: { code: 'INTERNAL_ERROR', message: expected } }
    expect(toolFailure(new Error('sensitive provider diagnostic'), message)).toEqual({
      isError: true, content: [{ type: 'text', text: JSON.stringify(body) }],
    })
  })
})
