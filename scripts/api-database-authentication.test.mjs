import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { apiServiceTemplate } from './local-production-runtime.mjs'

const run = promisify(execFile)
const require = createRequire(new URL('../apps/api/package.json', import.meta.url))
const probe = fileURLToPath(new URL('./test-support/database-authentication-probe.mjs', import.meta.url))

async function measure(environment, blockedReads) {
  const env = { ...process.env, ...environment, TMPDIR: join(homedir(), '.cache', 'foreman-tmp') }
  if (environment.UV_THREADPOOL_SIZE === undefined) delete env.UV_THREADPOOL_SIZE
  const { stdout } = await run(process.execPath, ['--import', require.resolve('tsx/esm'), probe, String(blockedReads)], {
    env, timeout: 10_000,
  })
  return JSON.parse(stdout.trim())
}

test('production connections finish SCRAM while sixteen filesystem reads occupy libuv workers', async t => {
  // Two eight-entry source capture/verification batches can overlap during a burst.
  const idle = await measure({ UV_THREADPOOL_SIZE: '4' }, 0)
  const starved = await measure({ UV_THREADPOOL_SIZE: '4' }, 16)
  const saturated = await measure({ UV_THREADPOOL_SIZE: '16' }, 16)
  const headroom = await measure({ UV_THREADPOOL_SIZE: '32' }, 16)
  const unitEnvironment = Object.fromEntries(apiServiceTemplate('database.service').split('\n')
    .filter(line => line.startsWith('Environment='))
    .map(line => line.slice('Environment='.length).split(/=(.*)/s).slice(0, 2)))
  const production = await measure({ UV_THREADPOOL_SIZE: unitEnvironment.UV_THREADPOOL_SIZE }, 16)
  t.diagnostic(JSON.stringify({ idle, starved, saturated, headroom, production }))
  assert.equal(idle.connected, 17)
  assert.equal(starved.connected, 0)
  assert.ok(starved.errors.every(error => error === 'Connection terminated due to connection timeout'))
  assert.equal(saturated.connected, 0)
  assert.equal(headroom.connected, 17)
  assert.ok(headroom.elapsedMs < 1000)
  assert.equal(production.connected, 17)
  assert.ok(production.elapsedMs < 1000)
})
