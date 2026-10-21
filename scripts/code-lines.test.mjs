import assert from 'node:assert/strict'
import test from 'node:test'
import { classify, physicalLines } from './code-lines.mjs'

test('classifies named tests before test support and separates source from tooling', () => {
  assert.equal(classify('apps/api/test/workflow.integration.test.ts'), 'integration')
  assert.equal(classify('apps/api/test/real-harness.acceptance.test.ts'), 'acceptance')
  assert.equal(classify('apps/api/test/checkpoint.smoke.mjs'), 'smoke')
  assert.equal(classify('apps/web/src/features/graph/GraphEditor.test.tsx'), 'unit')
  assert.equal(classify('apps/api/test/helpers/workflow.ts'), 'support')
  assert.equal(classify('apps/api/src/testing/deterministicNativeSession.ts'), 'support')
  assert.equal(classify('apps/web/src/mocks/handlers.ts'), 'support')
  assert.equal(classify('apps/web/src/features/run-graph/testFixtures.ts'), 'support')
  assert.equal(classify('apps/api/src/modules/workflow.ts'), 'source')
  assert.equal(classify('packages/contracts/src/index.ts'), 'source')
  assert.equal(classify('apps/web/index.html'), 'source')
  assert.equal(classify('scripts/dev.mjs'), 'tooling')
})

test('counts physical lines including an unterminated last line', () => {
  assert.equal(physicalLines(''), 0)
  assert.equal(physicalLines('one\n'), 1)
  assert.equal(physicalLines('one\ntwo'), 2)
  assert.equal(physicalLines('one\n\n'), 2)
})
