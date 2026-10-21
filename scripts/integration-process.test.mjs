import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { adaptiveDeadlineMs, groupUsed, integrationProcessProgress, stopGroup, superviseIntegrationProcess,
  waitForIntegrationProcess } from './integration-process.mjs'
import { boundedLog } from './verification-reports.mjs'
import { fullRunExitCode, scheduleFiles } from './test-integration.mjs'
import { reusableIntegrationFile, startSlotServer, stopSlotServer, stopStrayProcesses,
  strayProcesses } from './integration-slot-process.mjs'
import { slotFileCode } from './integration-slot-server.mjs'

function loggedChild(log, script, { ipc = false } = {}) {
  const fd = openSync(log, 'w', 0o600)
  try {
    return spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', fd, fd, ...(ipc ? ['ipc'] : [])] })
  } finally {
    closeSync(fd)
  }
}

async function waitForLog(log, text) {
  let timer
  let watcher
  try {
    await new Promise((resolve, reject) => {
      const check = () => { if (readFileSync(log, 'utf8').includes(text)) resolve() }
      watcher = watch(log, check)
      watcher.on('error', reject)
      timer = setTimeout(() => reject(new Error(`Child did not write ${text}`)), 3000)
      check()
    })
  } finally {
    watcher?.close()
    clearTimeout(timer)
  }
}

test('an idle owned group fails, retains its log, and frees the slot for the next file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-'))
  const children = []
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
    { detached: true, stdio: 'ignore' })
  const started = []
  const timeouts = []
  const resets = []
  const hangingScript = `
    const { spawn } = require('node:child_process')
    process.on('SIGTERM', () => {})
    const worker = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); console.log('grandchild ready'); setInterval(() => {}, 1000)"
    ], { stdio: 'inherit' })
    console.log('owned grandchild ' + worker.pid)
    setInterval(() => {}, 1000)
  `
  try {
    const result = await scheduleFiles(['hang', 'next'], [{ index: 1 }], async (slot, file) => {
      started.push([slot.index, file])
      const log = join(directory, `${file}.log`)
      const script = file === 'hang' ? hangingScript : "console.log('next file completed')"
      const child = loggedChild(log, script)
      children.push(child)
      if (file === 'hang') await waitForLog(log, 'grandchild ready')
      if (file === 'next') assert.deepEqual(resets, [1], 'reset must finish before the next file starts')
      const outcome = await superviseIntegrationProcess(child, { log, idleTimeoutMs: 300,
        fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100,
        onTimeout: (error) => timeouts.push(error.message),
        resetAfterTimeout: async () => {
          assert.equal(groupUsed(child.pid), false, 'no database callers may survive before reset')
          await Promise.resolve()
          resets.push(slot.index)
        },
      })
      assert.equal(groupUsed(child.pid), false, 'a slot must be drained before reuse')
      return outcome
    })
    assert.deepEqual(started, [[1, 'hang'], [1, 'next']])
    assert.deepEqual(result.outcomes.map(({ code }) => code), [124, 0])
    assert.equal(result.skipped, 0)
    assert.equal(timeouts.length, 1)
    assert.match(timeouts[0], /no log output/)
    const saved = readFileSync(join(directory, 'hang.log'), 'utf8')
    assert.match(saved, /grandchild ready/)
    assert.match(saved, /TIMEOUT: no log output/)
    const descendant = Number(saved.match(/owned grandchild (\d+)/)[1])
    if (existsSync(`/proc/${descendant}/stat`)) {
      const status = readFileSync(`/proc/${descendant}/stat`, 'utf8').split(') ')[1].split(' ')[0]
      assert.equal(status, 'Z', 'the descendant cannot keep making database calls')
    }
    assert.equal(groupUsed(unrelated.pid), true, 'another process group must remain untouched')
  } finally {
    for (const child of [...children, unrelated]) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a failed timeout reset retires its slot while the healthy worker executes the remaining queue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-reset-'))
  const children = []
  const started = []
  const slots = [{ index: 1 }, { index: 2 }]
  const files = ['hang', 'healthy', 'remaining-one', 'remaining-two']
  const resetError = new Error('owned database reset rejected')
  let healthyChild
  try {
    const result = await scheduleFiles(files, slots, async (slot, file) => {
      if (slot.resetError) throw slot.resetError
      started.push([slot.index, file])
      const log = join(directory, `${file}.log`)
      let script = "console.log('completed')"
      if (file === 'hang') script = "console.log('ready'); setInterval(() => {}, 1000)"
      if (file === 'healthy') {
        script = "console.log('ready'); const timer = setInterval(() => console.log('working'), 50);"
          + "process.once('message', () => { clearInterval(timer); console.log('completed'); process.disconnect() })"
      }
      const child = loggedChild(log, script, { ipc: file === 'healthy' })
      if (file === 'healthy') healthyChild = child
      children.push(child)
      if (file === 'hang' || file === 'healthy') await waitForLog(log, 'ready')
      const outcome = await superviseIntegrationProcess(child, { log, idleTimeoutMs: 200,
        fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100,
        resetAfterTimeout: async () => {
          assert.equal(groupUsed(child.pid), false)
          slot.resetError = resetError
          healthyChild.send('finish')
          throw resetError
        },
      })
      slot.unavailable = outcome.slotUnavailable
      return outcome
    })
    assert.deepEqual(started, [[1, 'hang'], [2, 'healthy'],
      [2, 'remaining-one'], [2, 'remaining-two']])
    assert.equal(result.skipped, 0)
    assert.deepEqual(result.unexecuted, [])
    const timeout = result.outcomes.find(({ file }) => file === 'hang')
    assert.equal(timeout.code, 124)
    assert.equal(timeout.slotUnavailable, true)
    assert.equal(timeout.resetError, resetError)
    assert.equal(result.outcomes.filter(({ code }) => code === 0).length, 3)
    const saved = readFileSync(join(directory, 'hang.log'), 'utf8')
    assert.match(saved, /TIMEOUT: no log output/)
    assert.match(saved, /database reset rejected/)
    assert.ok(children.every((child) => !groupUsed(child.pid)))
  } finally {
    for (const child of children) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('when every slot is retired, remaining files are identified as unexecuted and the run fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-all-retired-'))
  const children = []
  const files = ['hang-one', 'hang-two', 'unexecuted-one', 'unexecuted-two']
  try {
    const result = await scheduleFiles(files, [{ index: 1 }, { index: 2 }], async (slot, file) => {
      const log = join(directory, `${file}.log`)
      const child = loggedChild(log, "console.log('ready'); setInterval(() => {}, 1000)")
      children.push(child)
      await waitForLog(log, 'ready')
      return superviseIntegrationProcess(child, { log, idleTimeoutMs: 200,
        fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100,
        resetAfterTimeout: async () => {
          assert.equal(groupUsed(child.pid), false)
          throw new Error(`slot ${slot.index} reset failed`)
        },
      })
    })
    assert.equal(result.outcomes.length, 2)
    assert.ok(result.outcomes.every(({ code, slotUnavailable }) => code === 124 && slotUnavailable))
    assert.deepEqual(result.unexecuted, ['unexecuted-one', 'unexecuted-two'])
    assert.equal(fullRunExitCode(result.outcomes.filter(({ code }) => code !== 0).length, null), 1)
    assert.ok(children.every((child) => !groupUsed(child.pid)))
    assert.ok(!existsSync(join(directory, 'unexecuted-one.log')))
    assert.ok(!existsSync(join(directory, 'unexecuted-two.log')))
  } finally {
    for (const child of children) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('cleanup finishes after the owned group exits and before its slot is reused', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-cleanup-'))
  const children = []
  const events = []
  try {
    const result = await scheduleFiles(['failed', 'next'], [{ index: 1 }], async (_slot, file) => {
      events.push(`start ${file}`)
      const log = join(directory, `${file}.log`)
      const child = loggedChild(log, file === 'failed'
        ? "console.log('failed'); process.exitCode = 1" : "console.log('completed')")
      children.push(child)
      return superviseIntegrationProcess(child, { log, cleanupAfterExit: async () => {
        assert.equal(groupUsed(child.pid), false)
        events.push(`cleanup ${file}`)
      } })
    })
    assert.deepEqual(events, ['start failed', 'cleanup failed', 'start next', 'cleanup next'])
    assert.deepEqual(result.outcomes.map(({ code }) => code), [1, 0])
  } finally {
    for (const child of children) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('unconfirmed cleanup fails its owning file and retires the slot before another file starts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-cleanup-retired-'))
  const children = []
  const cleanupError = new Error('Test cleanup remains unconfirmed')
  try {
    const result = await scheduleFiles(['owner', 'next'], [{ index: 1 }], async (_slot, file) => {
      const log = join(directory, `${file}.log`)
      const child = loggedChild(log, "console.log('completed')")
      children.push(child)
      return superviseIntegrationProcess(child, { log, cleanupAfterExit: async () => {
        assert.equal(groupUsed(child.pid), false)
        throw cleanupError
      } })
    })
    assert.equal(result.outcomes.length, 1)
    assert.equal(result.outcomes[0].file, 'owner')
    assert.equal(result.outcomes[0].code, 1)
    assert.equal(result.outcomes[0].error, cleanupError)
    assert.equal(result.outcomes[0].slotUnavailable, true)
    assert.deepEqual(result.unexecuted, ['next'])
    assert.equal(existsSync(join(directory, 'next.log')), false)
  } finally {
    for (const child of children) await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('continuous log noise cannot defeat the absolute file deadline', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-noise-'))
  const log = join(directory, 'noise.log')
  const child = loggedChild(log, "console.log('ready'); setInterval(() => console.log('still waiting'), 20)")
  try {
    await waitForLog(log, 'ready')
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 100,
      fileTimeoutMs: 300, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 124)
    assert.equal(outcome.timedOut, true)
    assert.match(outcome.error.message, /file exceeded 300 ms/)
    assert.match(readFileSync(log, 'utf8'), /still waiting/)
    assert.equal(groupUsed(child.pid), false)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a long progressing file survives the idle deadline and its monitor is cleared on exit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-progress-'))
  const log = join(directory, 'progress.log')
  const script = `
    console.log('ready')
    process.on('message', message => {
      if (message === 'finish') { console.log('finished'); process.disconnect() }
      else console.log('case completed ' + message)
    })
  `
  const child = loggedChild(log, script, { ipc: true })
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    await waitForLog(log, 'ready')
    const progress = integrationProcessProgress()
    const pending = waitForIntegrationProcess(child, { log, progress, idleTimeoutMs: 100,
      fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100 })
    for (const step of [1, 2, 3]) {
      child.send(step)
      await waitForLog(log, `case completed ${step}`)
      t.mock.timers.tick(60)
    }
    child.send('finish')
    const outcome = await pending
    assert.equal(outcome.code, 0)
    assert.equal(outcome.timedOut, false)
    assert.ok(progress.bytes > 0)
    const lastOutputAt = progress.lastOutputAt
    const bytes = progress.bytes
    appendFileSync(log, 'output after monitor finished\n')
    t.mock.timers.tick(150)
    assert.equal(progress.lastOutputAt, lastOutputAt)
    assert.equal(progress.bytes, bytes)
    assert.match(readFileSync(log, 'utf8'), /finished/)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('exit'), 0)
  } finally {
    t.mock.timers.reset()
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a spawn failure clears the deadline and reports a runner failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-spawn-'))
  const log = join(directory, 'spawn.log')
  const fd = openSync(log, 'w', 0o600)
  const child = spawn(join(directory, 'missing-executable'), [], { detached: true,
    stdio: ['ignore', fd, fd] })
  closeSync(fd)
  try {
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 100,
      fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 1)
    assert.equal(outcome.error.code, 'ENOENT')
    assert.equal(outcome.timedOut, false)
    assert.equal(statSync(log).size, 0)
    assert.equal(child.listenerCount('error'), 0)
    assert.equal(child.listenerCount('exit'), 0)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('external interruption clears the watchdog without being mislabeled as a timeout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-interrupt-'))
  const log = join(directory, 'interrupt.log')
  const child = loggedChild(log, "console.log('ready'); setInterval(() => {}, 1000)")
  try {
    await waitForLog(log, 'ready')
    const pending = waitForIntegrationProcess(child, { log, idleTimeoutMs: 1000,
      fileTimeoutMs: 3000, pollIntervalMs: 20, graceMs: 100 })
    process.kill(-child.pid, 'SIGINT')
    const outcome = await pending
    assert.equal(outcome.code, 130)
    assert.equal(outcome.timedOut, false)
    assert.doesNotMatch(readFileSync(log, 'utf8'), /TIMEOUT/)
    assert.equal(child.listenerCount('exit'), 0)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})


test('bounded log retention does not mistake continuing output for an idle process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-bounded-progress-'))
  const log = join(directory, 'bounded.log')
  const output = boundedLog(log, 10)
  const progress = integrationProcessProgress()
  // Eight 40ms heartbeats span the 200ms idle budget while the log stays capped.
  const child = spawn(process.execPath, ['-e',
    "let count = 0; const timer = setInterval(() => { console.log('still running'); if (++count === 8) { clearInterval(timer); } }, 40)"],
  { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const record = (chunk) => {
    output.write(chunk)
    progress.bytes += chunk.length
    progress.lastOutputAt = Date.now()
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  try {
    const result = await waitForIntegrationProcess(child, { log, progress, idleTimeoutMs: 200,
      fileTimeoutMs: 2000, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(result.code, 0)
    assert.equal(result.timedOut, false)
    assert.equal(statSync(log).size, 10)
    assert.ok(progress.bytes > 10)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    output.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a file with a known duration gets three times that, at least a minute more, scaled and capped', () => {
  assert.equal(adaptiveDeadlineMs(20_000, 3_600_000), 80_000)
  assert.equal(adaptiveDeadlineMs(120_000, 3_600_000), 360_000)
  assert.equal(adaptiveDeadlineMs(120_000, 3_600_000, 2), 720_000)
  assert.equal(adaptiveDeadlineMs(120_000, 3_600_000, 0.5), 360_000)
  assert.equal(adaptiveDeadlineMs(30 * 60_000, 3_600_000), 3_600_000)
  for (const unknown of [undefined, null, 0, -5, Number.NaN, '20000']) assert.equal(adaptiveDeadlineMs(unknown, 3_600_000), null)
})

test('a file still logging past its adaptive deadline is stopped and reported as hung', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-hung-'))
  const log = join(directory, 'hung.log')
  const child = loggedChild(log, "console.log('ready'); setInterval(() => console.log('still waiting'), 20)")
  try {
    await waitForLog(log, 'ready')
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 2000,
      fileTimeoutMs: 3000, deadlineMs: 300, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 124)
    assert.equal(outcome.timedOut, true)
    assert.equal(outcome.hung, true)
    assert.match(outcome.error.message, /hung: still running after its 300 ms deadline/)
    assert.match(readFileSync(log, 'utf8'), /TIMEOUT: hung/)
    assert.equal(groupUsed(child.pid), false)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the idle watchdog still stops a silent file before its adaptive deadline, and is not called hung', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-silent-'))
  const log = join(directory, 'silent.log')
  const child = loggedChild(log, "console.log('ready'); setInterval(() => {}, 1000)")
  try {
    await waitForLog(log, 'ready')
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 200,
      fileTimeoutMs: 3000, deadlineMs: 2500, pollIntervalMs: 20, graceMs: 100 })
    assert.equal(outcome.code, 124)
    assert.equal(outcome.hung, undefined)
    assert.match(outcome.error.message, /no log output for 200 ms/)
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a file within its adaptive deadline finishes normally', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-watchdog-on-time-'))
  const log = join(directory, 'on-time.log')
  const child = loggedChild(log, "console.log('ready'); console.log('done')")
  try {
    const outcome = await waitForIntegrationProcess(child, { log, idleTimeoutMs: 2000,
      fileTimeoutMs: 3000, deadlineMs: 2000, pollIntervalMs: 20, graceMs: 100 })
    assert.deepEqual(outcome, { code: 0, timedOut: false })
  } finally {
    await stopGroup(child.pid, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

// Speaks the slot coordinator protocol: one JSON command per stdin line, output, then the done line. A file named
// "leak" leaves a lingering test worker with a grandchild; "hang" never finishes; "fail" exits 1.
const fakeSlotServer = `
const { spawn } = require('node:child_process')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { file } = JSON.parse(line)
  process.stdout.write('output of ' + file + '\\n')
  if (file === 'hang') return setInterval(() => process.stdout.write('still running\\n'), 20)
  if (file === 'leak') spawn(process.execPath, ['-e', "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); setInterval(() => {}, 1000)", '/vitest/dist/workers/forks.js'], { stdio: 'ignore' })
  process.stdout.write('\\n[integration-slot] done ' + (file === 'fail' ? 1 : 0) + '\\n')
})`

test('one slot coordinator runs consecutive files with separate output, statuses and leftover cleanup', async () => {
  const server = startSlotServer(process.env, undefined, { args: ['-e', fakeSlotServer] })
  const pid = server.child.pid
  try {
    const outputs = {}
    const run = (file) => server.run({ file }, (chunk) => { outputs[file] = (outputs[file] ?? '') + chunk })
    assert.equal(await run('first'), 0)
    assert.equal(await run('fail'), 1)
    assert.equal(await run('leak'), 0)
    await new Promise((done) => setTimeout(done, 200))
    assert.equal(strayProcesses(pid).length, 2)
    await stopStrayProcesses(pid, { graceMs: 1000, settleMs: 20 })
    assert.deepEqual(strayProcesses(pid), [])
    assert.equal(server.alive, true)
    assert.equal(await run('last'), 0)
    assert.equal(server.child.pid, pid)
    for (const file of ['first', 'fail', 'leak', 'last']) assert.equal(outputs[file].trim(), `output of ${file}`)
  } finally {
    await stopSlotServer(server, { graceMs: 500 })
  }
  assert.equal(groupUsed(pid), false)
})

test('a reused coordinator reports a finished file without exiting and a hung file still loses its whole group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'integration-slot-'))
  const server = startSlotServer(process.env, undefined, { args: ['-e', fakeSlotServer] })
  const pid = server.child.pid
  const supervise = (file) => {
    const log = join(directory, `${file}.log`)
    const output = boundedLog(log, 1024 * 1024)
    const progress = integrationProcessProgress()
    const finished = server.run({ file }, (chunk) => { progress.lastOutputAt = Date.now(); output.write(chunk) })
    return superviseIntegrationProcess(server.child, { log, progress, finished, idleTimeoutMs: 2000,
      fileTimeoutMs: 3000, deadlineMs: 300, pollIntervalMs: 20, graceMs: 100,
      stopProcesses: (outcome, graceMs) => outcome.timedOut ? stopGroup(pid, { graceMs })
        : stopStrayProcesses(pid, { graceMs, settleMs: 20 }) }).finally(() => { server.detach(); output.close() })
  }
  try {
    assert.deepEqual(await supervise('first'), { code: 0, timedOut: false })
    assert.equal(server.alive, true)
    const hung = await supervise('hang')
    assert.equal(hung.code, 124)
    assert.equal(hung.hung, true)
    assert.equal(groupUsed(pid), false)
  } finally {
    await stopSlotServer(server, { graceMs: 100 })
    rmSync(directory, { recursive: true, force: true })
  }
})

test('only ordinary files share a slot coordinator, and its file status follows the Vitest CLI', () => {
  assert.equal(reusableIntegrationFile('apps/api/test/agent-chat-g4.integration.test.ts'), true)
  assert.equal(reusableIntegrationFile('apps/api/test/operator-chat-controls.integration.test.ts'), false)
  assert.equal(reusableIntegrationFile('apps/api/test/native-service-restart.integration.test.ts'), false)
  assert.equal(reusableIntegrationFile('apps/api/test/historical-chat-placement-fork.integration.test.ts'), false)
  const module = (state) => ({ state: () => state })
  assert.equal(slotFileCode(module('passed'), []), 0)
  assert.equal(slotFileCode(module('skipped'), []), 0)
  assert.equal(slotFileCode(module('failed'), []), 1)
  assert.equal(slotFileCode(module('passed'), [new Error('unhandled')]), 1)
  assert.equal(slotFileCode(undefined, []), 1)
})
