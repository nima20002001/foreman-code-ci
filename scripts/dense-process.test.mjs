import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { executeCommand } from './dense-process.mjs'
import { groupUsed, stopGroup } from './integration-process.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dense-process-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function command(directory, script, fields = {}) {
  return { id: 'command', command: process.execPath, args: ['-e', script], cwd: directory,
    log: join(directory, 'command.log'), timeoutMs: 3000, idleTimeoutMs: 2000, ...fields }
}

const context = { workerIndex: 1, attempt: 1, isRetest: false, timeoutScale: 1 }
const options = { pollIntervalMs: 20, graceMs: 100, metricsIntervalMs: 10 }

test('records a complete command, measured process usage, and bounded logs', async t => {
  const directory = fixture(t)
  const item = command(directory, `
    console.log(process.env.DENSE_TEST_VALUE)
    process.stdout.write('x'.repeat(64 * 1024))
    const until = Date.now() + 180
    while (Date.now() < until) Math.sqrt(Math.random())
  `, { env: { DENSE_TEST_VALUE: 'expected-environment' } })
  const result = await executeCommand(item, context, { ...options, maxLogBytes: 1024 })
  assert.equal(result.code, 0)
  assert.equal(result.complete, true)
  assert.equal(result.output.bytes, 1024)
  assert.ok(result.output.discardedBytes > 0)
  assert.match(readFileSync(result.log, 'utf8'), /^expected-environment/)
  assert.ok(result.metrics.durationMs > 0)
  assert.ok(result.metrics.peakRssBytes > 0)
  assert.ok(result.metrics.cpuSeconds > 0)
})

test('a normal failing command is complete and retains its nonzero exit code', async t => {
  const directory = fixture(t)
  const result = await executeCommand(command(directory, "console.error('failed check'); process.exit(7)"),
    context, options)
  assert.equal(result.code, 7)
  assert.equal(result.complete, true)
  assert.match(result.reason, /code 7/)
  assert.match(readFileSync(result.log, 'utf8'), /failed check/)
})

test('silent commands time out with a clear stall reason', async t => {
  const directory = fixture(t)
  const item = command(directory, "console.log('ready'); setInterval(() => {}, 1000)", { idleTimeoutMs: 250 })
  const result = await executeCommand(item, context, options)
  assert.equal(result.code, 124)
  assert.equal(result.complete, false)
  assert.equal(result.timedOut, true)
  assert.match(result.reason, /no log output for 250 ms/)
  assert.match(readFileSync(result.log, 'utf8'), /ready/)
})

test('load scales the absolute deadline and output does not defeat it', async t => {
  const directory = fixture(t)
  const item = command(directory, "console.log('ready'); setInterval(() => console.log('working'), 20)",
    { timeoutMs: 200, idleTimeoutMs: 500 })
  const result = await executeCommand(item, { ...context, timeoutScale: 2 }, options)
  assert.equal(result.code, 124)
  assert.match(result.reason, /file exceeded 400 ms/)
  assert.ok(result.metrics.durationMs >= 380)
})

test('spawn failure and signal death are incomplete runner failures', async t => {
  const directory = fixture(t)
  const missing = await executeCommand({ id: 'missing', command: join(directory, 'not-an-executable'),
    log: join(directory, 'missing.log') }, context, options)
  assert.equal(missing.code, 1)
  assert.equal(missing.complete, false)
  assert.match(missing.reason, /ENOENT/)
  const killed = await executeCommand(command(directory, "process.kill(process.pid, 'SIGKILL')"), context, options)
  assert.notEqual(killed.code, 0)
  assert.equal(killed.complete, false)
  assert.match(killed.reason, /SIGKILL/)
})

test('cancellation cleans up sampled detached descendants and leaves unrelated groups alive', async t => {
  const directory = fixture(t)
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore' })
  t.after(() => stopGroup(unrelated.pid, { graceMs: 100 }))
  const deadline = Date.now() + 450
  const item = command(directory, `
    const { spawn } = require('node:child_process')
    const child = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log('descendant ready'); setInterval(() => {}, 1000)"
    ], { detached: true, stdio: 'inherit' })
    console.log('detached descendant ' + child.pid)
    setInterval(() => {}, 1000)
  `)
  const result = await executeCommand(item, context, { ...options, shouldStop: () => Date.now() >= deadline })
  assert.notEqual(result.code, 0)
  assert.equal(result.complete, false)
  assert.match(result.reason, /Stopped/)
  const saved = readFileSync(item.log, 'utf8')
  assert.match(saved, /descendant ready/)
  const pid = Number(saved.match(/detached descendant (\d+)/)[1])
  assert.equal(groupUsed(pid), false)
  assert.equal(groupUsed(unrelated.pid), true)
})
