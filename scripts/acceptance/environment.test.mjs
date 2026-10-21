import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { environment } from './safety.mjs'

const resources = new URL('../test-resources.mjs', import.meta.url)
const adminUrl = 'postgresql://graphql_test_admin:graphql_test_disposable_only@127.0.0.1:55440/postgres'
const databaseUrl = new URL('/graphql_test_acceptance', adminUrl).href

function databaseProbe(overrides = {}) {
  const source = {
    PATH: process.env.PATH,
    FOREMAN_CODE_CI_HOST_RUN_ID: randomUUID(),
    FOREMAN_CODE_CI_TEST_ADMIN_URL: adminUrl,
    TEST_DATABASE_URL: databaseUrl,
    ...overrides,
  }
  return spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import { requireTestServerUrl } from ${JSON.stringify(resources.href)}
    console.log(requireTestServerUrl(process.env.TEST_DATABASE_URL).port)
  `], { env: environment(source), encoding: 'utf8', timeout: 10_000 })
}

test('acceptance children validate the host CI disposable database on its assigned port', () => {
  const result = databaseProbe()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '55440')
})

test('acceptance children still reject a database outside their host CI server', () => {
  const result = databaseProbe({ TEST_DATABASE_URL: databaseUrl.replace(':55440/', ':55441/') })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /dedicated disposable PostgreSQL server/)
})

test('acceptance children still validate their host CI database owner', () => {
  const result = databaseProbe({ FOREMAN_CODE_CI_HOST_RUN_ID: 'invalid-owner' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid host CI disposable database URL/)
})
