import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hasTicketName, ticketNamedTests } from './check-test-names.mjs'

test('ticket, wave, lane and agent segments are rejected', () => {
  for (const file of ['apps/api/test/eng04-repeat.test.ts', 'apps/web/src/pr17Approvals.test.ts', 'a/w08-roots.integration.test.ts',
    'a/wave25-agent3-node.test.ts', 'a/native-lanes.test.ts', 'a/nim2642MeaningfulEdits.test.ts', 'a/SCH10.chat.test.ts']) {
    assert.equal(hasTicketName(file), true, file)
  }
  for (const file of ['apps/api/test/repeat-approval.test.ts', 'a/prompts.test.ts', 'a/http2.test.ts', 'a/agentChat.test.ts', 'a/planner.test.ts']) {
    assert.equal(hasTicketName(file), false, file)
  }
})

test('only test files outside the allowlist are reported', () => {
  const files = ['a/pr3-old.test.ts', 'a/pr4-new.test.ts', 'a/pr5-helper.ts']
  assert.deepEqual(ticketNamedTests(files, new Set(['a/pr3-old.test.ts'])), ['a/pr4-new.test.ts'])
})
