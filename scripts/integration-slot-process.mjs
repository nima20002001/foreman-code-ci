import { exclusiveIntegrationFiles, requirements } from '../packages/contracts/src/integrationScheduling.mjs'
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { stopGroup } from './integration-process.mjs'
import { slotDonePrefix } from './integration-slot-server.mjs'

const api = fileURLToPath(new URL('../apps/api/', import.meta.url))
const serverPath = fileURLToPath(new URL('./integration-slot-server.mjs', import.meta.url))
const reporterPath = fileURLToPath(new URL('./integration-startup-reporter.mjs', import.meta.url))

/** Exclusive and host-capability files keep a fresh Vitest process each; ordinary files share their slot's. */
export function reusableIntegrationFile(file) {
  return !exclusiveIntegrationFiles.includes(file) && !requirements.has(file)
}

/**
 * Starts a slot's reusable Vitest coordinator. `run` sends one file and resolves with its exit status once all of
 * its output has been delivered to `sink`; output between files is held for the next file's sink.
 */
export function startSlotServer(environment, testNamePattern, { command = process.execPath,
  args = [serverPath, JSON.stringify({ reporter: reporterPath, testNamePattern })] } = {}) {
  const child = spawn(command, args, { cwd: api, env: environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const held = []
  const decoder = new StringDecoder('utf8')
  let sink
  let partial = ''
  let finished
  const deliver = (text) => {
    if (sink) sink(Buffer.from(text))
    else held.push(Buffer.from(text))
  }
  child.stdout.on('data', (chunk) => {
    const lines = (partial + decoder.write(chunk)).split('\n')
    partial = lines.pop()
    for (const line of lines) {
      if (line.startsWith(slotDonePrefix) && finished) {
        const done = finished
        finished = undefined
        sink = undefined
        done(Number(line.slice(slotDonePrefix.length)))
      } else deliver(`${line}\n`)
    }
    // A partial line that cannot become the done line is output now, so the idle watchdog sees progress.
    if (partial && !slotDonePrefix.startsWith(partial.slice(0, slotDonePrefix.length))) {
      deliver(partial)
      partial = ''
    }
  })
  child.stderr.on('data', (chunk) => deliver(chunk.toString('utf8')))
  child.stdin.on('error', () => { /* ignore: an exited server is reported through its exit event */ })
  return {
    child,
    get alive() { return child.exitCode === null && child.signalCode === null },
    run(command, output) {
      if (finished) throw new Error('The slot coordinator is already running a file')
      sink = output
      for (const chunk of held.splice(0)) output(chunk)
      const result = new Promise((resolveDone) => { finished = resolveDone })
      child.stdin.write(`${JSON.stringify(command)}\n`)
      return result
    },
    detach() {
      sink = undefined
      finished = undefined
    },
  }
}

/** Ends an idle coordinator so it runs its global teardown, then stops anything left in its process group. */
export async function stopSlotServer(server, { graceMs = 5000 } = {}) {
  if (!server) return
  if (server.alive) {
    const exited = new Promise((done) => server.child.once('exit', done))
    server.child.stdin.end()
    await Promise.race([exited, new Promise((done) => setTimeout(done, graceMs).unref())])
  }
  await stopGroup(server.child.pid, { graceMs })
}

function processRecords() {
  const records = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const fields = readFileSync(`/proc/${entry}/stat`, 'utf8').split(') ')[1].split(' ')
      records.push({ pid: Number(entry), state: fields[0], parent: Number(fields[1]), group: Number(fields[2]) })
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error
    }
  }
  return records
}

function testWorker(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('/vitest/dist/workers/') }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false
    throw error
  }
}

/** Processes a finished file left in the coordinator's group: its test workers and everything they started. */
export function strayProcesses(serverPid) {
  return processRecords().filter((record) => record.group === serverPid && record.state !== 'Z'
    && record.pid !== serverPid && !(record.parent === serverPid && !testWorker(record.pid)))
    .map((record) => record.pid)
}

async function waitForNone(serverPid, ms) {
  const started = Date.now()
  for (;;) {
    const strays = strayProcesses(serverPid)
    if (!strays.length || Date.now() - started >= ms) return strays
    await new Promise((done) => setTimeout(done, Math.min(50, ms)))
  }
}

function signal(pids, name) {
  for (const pid of pids) {
    try { process.kill(pid, name) }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }
}

/** Stops what a finished file left behind, as a fresh process's group stop would, while keeping its coordinator. */
export async function stopStrayProcesses(serverPid, { graceMs = 5000, settleMs = 1000 } = {}) {
  let strays = await waitForNone(serverPid, settleMs)
  if (!strays.length) return
  signal(strays, 'SIGTERM')
  strays = await waitForNone(serverPid, graceMs)
  if (!strays.length) return
  signal(strays, 'SIGKILL')
  strays = await waitForNone(serverPid, graceMs)
  if (strays.length) throw new Error(`Integration slot coordinator ${serverPid} still owns processes ${strays.join(', ')}`)
}
