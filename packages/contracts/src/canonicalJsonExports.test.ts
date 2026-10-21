import { expect, it } from 'vitest'
import * as contracts from './index.js'

it('serializes collaboration command identities through the public package export', () => {
  const serialize = Reflect.get(contracts, 'canonicalJson') as (value: unknown) => string
  expect(serialize({ target: { runId: 'run', executionId: 'execution' }, commandId: 'send' }))
    .toBe('{"commandId":"send","target":{"executionId":"execution","runId":"run"}}')
})
