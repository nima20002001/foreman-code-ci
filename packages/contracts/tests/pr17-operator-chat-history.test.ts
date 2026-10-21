import { describe, expect, it } from 'vitest'
import { OperatorConversationHistoryQuerySchema, OperatorHistoryCursorSchema } from '../src/operatorChat.js'

describe('Operator history page input boundaries', () => {
  it('uses bounded pages and opaque exact bigint cursors', () => {
    expect(OperatorConversationHistoryQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(OperatorConversationHistoryQuerySchema.parse({ limit: '100', before: '9007199254740993' }))
      .toEqual({ limit: 100, before: '9007199254740993' })
    expect(OperatorHistoryCursorSchema.parse('9223372036854775807')).toBe('9223372036854775807')
  })
  for (const before of ['', '0', '-1', '01', '1e3', '1;drop table x', '9223372036854775808']) it(`rejects invalid cursor ${before}`, () => {
    expect(OperatorConversationHistoryQuerySchema.safeParse({ before }).success).toBe(false)
  })
  for (const limit of [0, -1, 101, 1.5, 'NaN', '']) it(`rejects unbounded or invalid limit ${limit}`, () => {
    expect(OperatorConversationHistoryQuerySchema.safeParse({ limit }).success).toBe(false)
  })
})
