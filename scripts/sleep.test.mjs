import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sleep } from './sleep.mjs'

test('plain delays resolve without a value and retain timer argument coercion', async () => {
  assert.equal(await sleep(1), undefined)
  assert.equal(await sleep('1'), undefined)
})
