import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./test-db.mjs', import.meta.url))

function computer(t, unavailable = false) {
  const parent = process.env.TMPDIR ?? join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(join(parent, 'ci-postgres-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const state = join(directory, 'servers.json')
  writeFileSync(state, '{}')
  const limits = join(directory, 'limits.json')
  writeFileSync(limits, '{}')
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
const servers = JSON.parse(fs.readFileSync(process.env.SERVERS, 'utf8'))
const project = args[args.indexOf('--project-name') + 1]
const limits = JSON.parse(fs.readFileSync(process.env.LIMITS, 'utf8'))
if (args[0] === 'ps') {
  const label = args.find(value => value.startsWith('label=com.docker.compose.project='))
  const name = label?.slice('label=com.docker.compose.project='.length)
  if (name && limits[name]) console.log(name)
  process.exit(0)
}
if (args[0] === 'inspect') {
  const limit = limits[args[1]]
  console.log(JSON.stringify([{ Config: { Labels: { 'graphql.test-owner': 'disposable-tests',
    'com.docker.compose.service': 'postgres' } }, State: { Running: true },
    HostConfig: { NanoCpus: limit.nanoCpus, Memory: limit.memory, MemorySwap: limit.memory * 2 } }]))
  process.exit(0)
}
if (args[0] === 'update') {
  const limit = limits[args.at(-1)]
  for (const value of args) {
    if (value.startsWith('--cpus=')) limit.nanoCpus = Math.round(Number(value.slice(7)) * 1e9)
    if (value.startsWith('--memory=')) limit.memory = Number(value.slice(9))
  }
  fs.writeFileSync(process.env.LIMITS, JSON.stringify(limits))
  process.exit(0)
}
if (args[0] === 'volume') process.exit(0)
if (args.includes('up')) {
  if (process.env.UNAVAILABLE === '1' && !project.includes(process.env.FOREMAN_CODE_CI_HOST_RUN_ID)) {
    console.error('persistent server unavailable')
    process.exit(1)
  }
  servers[project] ??= 55000 + Object.keys(servers).length
  fs.writeFileSync(process.env.SERVERS, JSON.stringify(servers))
  // compose up --no-recreate keeps an existing container's limits.
  limits[project] ??= { nanoCpus: Math.round(Number(process.env.FOREMAN_CODE_CI_DATABASE_CPUS ?? 0) * 1e9),
    memory: Number(process.env.FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES ?? 0) }
  fs.writeFileSync(process.env.LIMITS, JSON.stringify(limits))
}
if (args.includes('port')) console.log('127.0.0.1:' + servers[project])
if (args.includes('down')) {
  delete servers[project]
  fs.writeFileSync(process.env.SERVERS, JSON.stringify(servers))
}
`, { mode: 0o755 })
  function job(database = {}) {
    const runId = randomUUID()
    const temporary = join(directory, runId)
    mkdirSync(temporary)
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, TMPDIR: temporary,
      FOREMAN_CODE_CI_DATABASE_STATE: temporary,
      CI_HOST_RUNNER: '1', FOREMAN_CODE_CI_HOST_RUN_ID: runId, FOREMAN_CODE_VERIFICATION_ENVIRONMENT: '',
      FOREMAN_CODE_CI_POSTGRES_CACHE: join(directory, 'cache'), SERVERS: state, LIMITS: limits,
      UNAVAILABLE: unavailable ? '1' : '0',
      ...(database.cpus ? { FOREMAN_CODE_CI_DATABASE_CPUS: String(database.cpus) } : {}),
      ...(database.memory ? { FOREMAN_CODE_CI_DATABASE_MEMORY_BYTES: String(database.memory) } : {}) }
    return {
      runId,
      templateCache: () => readFileSync(join(temporary, 'test-database-template-cache'), 'utf8'),
      up() {
        const result = spawnSync(process.execPath, [script, 'up'], { env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        return readFileSync(join(temporary, 'test-database-url'), 'utf8')
      },
      // The heavy-job wrapper hands the job a fresh TMPDIR; the template cache must stay reachable.
      wrappedTemplateCache() {
        const wrapped = join(directory, `${runId}-wrapped`)
        mkdirSync(wrapped)
        const cache = new URL('./ci-postgres-cache.mjs', import.meta.url).href
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
          `import { ciTemplateCacheDirectory } from ${JSON.stringify(cache)}\nconsole.log(ciTemplateCacheDirectory() ?? 'none')`],
        { env: { ...env, TMPDIR: wrapped }, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
        return result.stdout.trim()
      },
      down() {
        const result = spawnSync(process.execPath, [script, 'down'], { env, encoding: 'utf8' })
        assert.equal(result.status, 0, result.stderr)
      },
    }
  }
  return { job, servers: () => JSON.parse(readFileSync(state, 'utf8')),
    limits: () => Object.values(JSON.parse(readFileSync(limits, 'utf8'))) }
}

test('CI parts reuse one persistent server and job cleanup leaves it running', t => {
  const host = computer(t)
  const first = host.job()
  const second = host.job()
  const url = first.up()
  first.down()
  assert.equal(Object.keys(host.servers()).length, 1)
  assert.equal(second.up(), url)
  second.down()
  assert.equal(Object.keys(host.servers()).length, 1)
})

test('an unavailable persistent server falls back to separate job servers and cleans them up', t => {
  const host = computer(t, true)
  const first = host.job()
  const second = host.job()
  assert.notEqual(first.up(), second.up())
  assert.equal(Object.keys(host.servers()).length, 2)
  first.down()
  assert.equal(Object.keys(host.servers()).length, 1)
  second.down()
  assert.equal(Object.keys(host.servers()).length, 0)
})

test('a reused persistent server grows to the database size a larger job needs and never shrinks', t => {
  const host = computer(t)
  const gib = 2 ** 30
  host.job({ cpus: 1, memory: gib }).up()
  assert.deepEqual(host.limits(), [{ nanoCpus: 1e9, memory: gib }])
  // A 16-shard gate part reuses the server a small job created; it must not keep one CPU and 1 GiB.
  host.job({ cpus: 4, memory: 4 * gib }).up()
  assert.deepEqual(host.limits(), [{ nanoCpus: 4e9, memory: 4 * gib }])
  host.job({ cpus: 2, memory: 2 * gib }).up()
  assert.deepEqual(host.limits(), [{ nanoCpus: 4e9, memory: 4 * gib }])
})

test('a job whose TMPDIR is replaced still finds the persistent template cache', t => {
  const host = computer(t)
  const job = host.job()
  job.up()
  const expected = job.templateCache()
  assert.ok(expected.length > 0)
  assert.equal(job.wrappedTemplateCache(), expected)
  const nextJob = host.job()
  nextJob.up()
  assert.equal(nextJob.templateCache(), expected)
  assert.equal(nextJob.wrappedTemplateCache(), expected)
})
