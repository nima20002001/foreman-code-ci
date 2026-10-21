import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

test('local acceptance help starts without provisioning resources', () => {
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL('./local.mjs', import.meta.url)), '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /No database URL/)
  assert.equal(result.stderr, '')
})
