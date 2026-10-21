import { sleep } from './sleep.mjs'
import { readProductEnvironment } from '../packages/contracts/src/productEnvironment.mjs'
import { retainedHeavyJobTokens, writeHeavyJobRecord } from './heavy-job-slots.mjs'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, readlinkSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
const queueDirectoryArgument = process.env.CI_HOST_RUNNER === '1' ? '--git-dir' : '--git-common-dir'
const commonResult = git('rev-parse', '--path-format=absolute', queueDirectoryArgument)
if (commonResult.status !== 0) throw new Error(commonResult.stderr || 'Cannot find Git common directory')
const common = realpathSync(commonResult.stdout.trim())
const state = join(common, 'graphql-heavy-jobs')
const queue = join(state, 'queue')
const active = join(state, 'active')
// Keep slot records outside active: an old wrapper removes that entire directory.
const running = join(state, 'running')
// Deliberately has no PID/token: old cleanup treats this gate as unknown/live.
const gate = { common, multiSlotGate: true }
const baseTmp = readProductEnvironment(process.env, 'HEAVY_BASE_TMPDIR') || tmpdir()
const tempRoot = join(baseTmp, `graphql-heavy-${createHash('sha256').update(common).digest('hex').slice(0, 16)}`)
const diagnosticCounts = new Map()
const diagnosticWarnings = new Map()
function warnMetadata(operation, error) {
  if (error.code === 'ENOENT' || error.code === 'ESRCH') return
  const failureCount = (diagnosticCounts.get(operation) ?? 0) + 1
  diagnosticCounts.set(operation, failureCount)
  const now = Date.now()
  if (diagnosticWarnings.has(operation) && now - diagnosticWarnings.get(operation) < 30_000) return
  diagnosticWarnings.set(operation, now)
  console.warn(JSON.stringify({ operation, status: 'degraded',
    lastError: error.code ?? 'INVALID_SCHEDULER_METADATA', failureCount }))
}
process.on('exit', () => {
  for (const [operation, failureCount] of diagnosticCounts) {
    if (failureCount > 1) console.warn(JSON.stringify({ operation, status: 'degraded', failureCount }))
  }
})
const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) { warnMetadata('read scheduler owner metadata', error); return null }
}
// Staging outside queue/running keeps incomplete records invisible to all callers.
const writeRecord = (path, record) => writeHeavyJobRecord(path, record,
  path.startsWith(`${state}${sep}`) ? state : dirname(path))
const ageMs = path => {
  try { return Date.now() - statSync(path).mtimeMs }
  catch (error) { warnMetadata('read scheduler metadata age', error); return 0 }
}
const isDirectory = path => {
  try { return lstatSync(path).isDirectory() }
  catch (error) { warnMetadata('inspect scheduler directory', error); return false }
}
const procStart = pid => {
  try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] }
  catch (error) { warnMetadata('read scheduler process identity', error); return null }
}
const namespace = { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: readlinkSync('/proc/self/ns/pid') }
const gone = (error) => error.code === 'ENOENT' || error.code === 'ESRCH'
const validOwner = record => typeof record?.namespace?.boot === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.namespace.boot)
  && typeof record.namespace.pid === 'string' && /^pid:\[\d+\]$/.test(record.namespace.pid)
  && Number.isSafeInteger(record.pid) && record.pid > 0 && typeof record.start === 'string'
  && /^\d+$/.test(record.start) && typeof record.token === 'string' && Boolean(record.token)
const localOwner = record => validOwner(record)
  && record.namespace.boot === namespace.boot && record.namespace.pid === namespace.pid
const alive = (record) => {
  if (!validOwner(record)) return true
  // Processes from an earlier boot cannot survive, even if their PIDs are reused.
  if (record.namespace.boot !== namespace.boot) return false
  // A PID/start pair has meaning only in the namespace that recorded it.
  // Foreign PID namespaces and unreadable ownership remain unknown, not stale.
  if (!localOwner(record)) return true
  try {
    const text = readFileSync(`/proc/${record.pid}/stat`, 'utf8')
    const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ')
    if (!/^\d+$/.test(fields[19])) return true
    return fields[19] === record.start && fields[0] !== 'Z'
  } catch (error) { warnMetadata('read scheduler owner process', error); return !gone(error) }
}
const ownEnvironment = pid => statSync(`/proc/${pid}/environ`).uid === process.geteuid()
const tokenUsed = (token, exceptPid = 0, conservative = false) => {
  if (!token) return false
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      if (Number(entry) === exceptPid) continue
      try {
        // Other users and non-dumpable processes cannot expose an environment to this scheduler.
        if (!ownEnvironment(entry)) continue
        const environment = readFileSync(`/proc/${entry}/environ`)
        if (['FOREMAN_CODE_', 'GRAPHQL_'].some(prefix =>
          environment.includes(Buffer.from(`${prefix}HEAVY_JOB_TOKEN=${token}\0`)))) return true
      } catch (error) {
        warnMetadata('inspect scheduler process usage', error)
        if (conservative && !gone(error)) return true
      }
    }
  } catch (error) { warnMetadata('inspect scheduler process usage', error); return true }
  return false
}
const groupUsed = (pgid, conservative = false) => {
  if (pgid === null) return false
  if (!Number.isSafeInteger(pgid) || pgid <= 0) return conservative
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const text = readFileSync(`/proc/${entry}/stat`, 'utf8')
        const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ')
        if (conservative && !/^\d+$/.test(fields[2])) return true
        if (Number(fields[2]) === pgid && fields[0] !== 'Z') return true
      } catch (error) { warnMetadata('inspect scheduler process usage', error); if (conservative && !gone(error)) return true }
    }
  } catch (error) { warnMetadata('inspect scheduler process usage', error); return true }
  return false
}
const workUsed = (record) => {
  const launchedGroup = record.phase === 'running' && Number.isSafeInteger(record.pgid) && record.pgid > 0
  // A published empty group is not retained by unrelated unreadable environments.
  // Visible token-bearing workers still retain ownership after detaching.
  return groupUsed(record.pgid, true) || tokenUsed(record.token, 0, !launchedGroup)
}
const usedPath = (path) => {
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      try { if (!ownEnvironment(entry)) continue }
      catch (error) {
        warnMetadata('inspect scheduler process paths', error)
        if (!gone(error)) return true
        continue
      }
      for (const kind of ['cwd', 'root']) {
        try { const target = realpathSync(`/proc/${entry}/${kind}`); if (target === path || target.startsWith(`${path}${sep}`)) return true } catch (error) { warnMetadata('inspect scheduler process paths', error); if (!gone(error)) return true }
      }
      try {
        for (const fd of readdirSync(`/proc/${entry}/fd`)) {
          try { const target = readlinkSync(`/proc/${entry}/fd/${fd}`); if (target === path || target.startsWith(`${path}${sep}`) || target.startsWith(`${path} (deleted)`)) return true } catch (error) { warnMetadata('inspect scheduler process paths', error); if (!gone(error)) return true }
        }
      } catch (error) { warnMetadata('inspect scheduler process paths', error); if (!gone(error)) return true }
    }
  } catch (error) { warnMetadata('inspect scheduler process usage', error); return true }
  return false
}
function cleanTemps() {
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 })
  for (const entry of readdirSync(tempRoot)) {
    const path = join(tempRoot, entry)
    const marker = readJson(join(path, 'owner.json'))
    if (!isDirectory(path) || ageMs(path) < 10 * 60_000 || !marker || marker.common !== common || alive(marker) || groupUsed(marker.pgid, true) || tokenUsed(marker.token, 0, true) || usedPath(path)) continue
    // Verify the recorded checkout still belongs to this admission queue.
    const check = spawnSync('git', ['rev-parse', '--path-format=absolute', queueDirectoryArgument],
      { cwd: marker.worktree, encoding: 'utf8' })
    if (check.status === 0 && realpathSync(check.stdout.trim()) !== common) continue
    rmSync(path, { recursive: true, force: true })
  }
}
async function waitGroup(pgid, graceMs = 5000) {
  const start = Date.now()
  while (groupUsed(pgid) && Date.now() - start < graceMs) await sleep(100)
  if (groupUsed(pgid)) {
    try { process.kill(-pgid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
    while (groupUsed(pgid)) await sleep(100)
  }
}
async function reapDeletedWorktree(record) {
  if (!localOwner(record) || typeof record.worktree !== 'string') return false
  try {
    if (statSync(record.worktree).isDirectory()) return false
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      warnMetadata('inspect scheduler worktree', error)
      return false
    }
  }
  if (Number.isSafeInteger(record.pgid) && record.pgid > 0) {
    try { process.kill(-record.pgid, 'SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
    await waitGroup(record.pgid, 500)
  }
  return true
}
async function cleanQueue() {
  mkdirSync(queue, { recursive: true })
  mkdirSync(running, { recursive: true })
  const reaped = new Set()
  for (const name of readdirSync(running)) {
    const path = join(running, name)
    const record = readJson(path)
    if (record?.common === common && (await reapDeletedWorktree(record)
      || !alive(record) && (record.phase === 'running' || ageMs(path) > 10_000 && !workUsed(record)))) {
      reaped.add(record.token)
      rmSync(path, { force: true })
    }
  }
  const held = readJson(join(active, 'owner.json'))
  // Allow an older caller time to publish its owner after creating the directory.
  if (!held && isDirectory(active) && ageMs(active) > 10_000) {
    try {
      // A legacy writer can briefly leave an existing owner file empty.
      if (readdirSync(active).length === 0) rmdirSync(active)
    } catch (error) { warnMetadata('reap empty scheduler directory', error) }
  }
  if (held?.common === common && (reaped.has(held.token) || await reapDeletedWorktree(held)
    || held.phase === 'running' && !alive(held)
    || ageMs(active) > 10_000 && !alive(held) && !workUsed(held))) {
    reaped.add(held.token)
    rmSync(active, { recursive: true, force: true })
  }
  for (const name of readdirSync(queue)) {
    const path = join(queue, name)
    const record = readJson(path)
    // A queued coordinator has not acquired a slot or spawned token-bearing work.
    // The durable phase changes before acquisition, including its crash windows.
    const neverLaunched = record?.phase === 'queued' && record.pgid === null
    if (record?.common === common && (reaped.has(record.token) || await reapDeletedWorktree(record)
      || !alive(record) && (record.phase === 'running' || neverLaunched || !workUsed(record)))) {
      rmSync(path, { force: true })
    }
  }
}
const slotRecords = () => readdirSync(running).map((name) => readJson(join(running, name)))
const isGate = (record) => record?.common === common && record.multiSlotGate === true && !record.token
function logSlotHolders(waitedMs) {
  const entries = readdirSync(running).map(name => ({ path: join(running, name), record: readJson(join(running, name)) }))
  const path = join(active, 'owner.json')
  const held = readJson(path)
  if (existsSync(active) && !isGate(held) && !entries.some(entry => entry.record?.token === held?.token)) {
    entries.push({ path, record: held })
  }
  const holders = entries.map(({ path, record }) => ({
    pid: record?.pid ?? null,
    worktree: record?.worktree ?? null,
    ageMs: Number.isFinite(record?.startedAt) ? Date.now() - record.startedAt : ageMs(path),
  }))
  console.warn(JSON.stringify({ operation: 'waiting for project test/build slot', waitedMs, holders }))
}
function slotCount() {
  try {
    const value = readFileSync(join(state, 'slots'), 'utf8').trim()
    if (!/^[1-8]$/.test(value)) throw new Error('Invalid heavy-job slot count; expected an integer from 1 to 8.')
    return Number(value)
  } catch (error) {
    if (error.code === 'ENOENT') return 1
    throw error
  }
}
function schedule(action, ticket, token) {
  const result = spawnSync('flock', ['-x', join(state, 'register.lock'), process.execPath, import.meta.filename, '__schedule', action, ticket, token], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Slot scheduling failed')
  return result.stdout.trim() === 'admitted'
}
if (process.argv[2] === '__schedule') {
  const [, , , action, ticket, token] = process.argv
  await cleanQueue()
  const path = join(running, ticket)
  if (action === 'release') {
    if (readJson(path)?.token === token) rmSync(path, { force: true })
    const held = readJson(join(active, 'owner.json'))
    if (held?.token === token || isGate(held)) {
      if (readdirSync(running).length) writeRecord(join(active, 'owner.json'), gate)
      else rmSync(active, { recursive: true, force: true })
    }
  } else {
    let records = slotRecords()
    const held = readJson(join(active, 'owner.json'))
    const legacy = existsSync(active) && !isGate(held) && !records.some((record) => record?.token && record.token === held?.token)
    const tickets = readdirSync(queue).sort().map(name => ({ name, record: readJson(join(queue, name)) }))
    const retained = retainedHeavyJobTokens(tickets.map(ticket => ticket.record), records, held)
    // Repair the original reservation so older coordinators also retain its capacity and skip its FIFO ticket.
    for (const ticket of tickets) {
      if (retained.has(ticket.record?.token)) writeRecord(join(running, ticket.name), ticket.record)
    }
    records = slotRecords()
    const occupied = records.length + Number(legacy)
    // Running tickets stay in queue to fence old callers after their active
    // directory disappears. Only skip those tickets when admitting new code.
    const first = tickets.find(({ record }) => !(record?.token && (retained.has(record.token)
      || records.some(slot => slot?.token === record.token) || record.token === held?.token)))?.name
    const record = readJson(join(queue, ticket))
    if (first === ticket && record?.token === token && occupied < slotCount()) {
      const acquiring = { ...record, phase: 'acquiring', startedAt: Date.now() }
      writeRecord(join(queue, ticket), acquiring)
      if (!existsSync(active)) {
        // mkdir still arbitrates with old callers, which do not take this lock.
        try { mkdirSync(active) } catch (error) { if (error.code === 'EEXIST') process.exit(0); throw error }
        writeRecord(join(active, 'owner.json'), records.length ? gate : acquiring)
      }
      writeRecord(path, acquiring)
      process.stdout.write('admitted')
    } else if (!records.length && isGate(held)) rmSync(active, { recursive: true, force: true })
  }
  process.exit(0)
}
function register(token) {
  mkdirSync(queue, { recursive: true })
  // flock serializes sequence assignment; the short registration lock is never held during work.
  const result = spawnSync('flock', ['-x', join(state, 'register.lock'), process.execPath, import.meta.filename, '__ticket', String(process.pid), procStart(process.pid), root, JSON.stringify(namespace), token], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'Queue registration failed')
  return result.stdout.trim()
}
if (process.argv[2] === '__ticket') {
  mkdirSync(queue, { recursive: true })
  const existing = readdirSync(queue).map((name) => Number(name.split('-')[0])).filter(Number.isFinite)
  const ticket = `${String(Math.max(0, ...existing) + 1).padStart(12, '0')}-${randomUUID()}`
  writeRecord(join(queue, ticket), {
    common, pid: Number(process.argv[3]), start: process.argv[4], worktree: process.argv[5],
    pgid: null, phase: 'queued', namespace: process.argv[6] ? JSON.parse(process.argv[6]) : undefined,
    token: process.argv[7],
  })
  process.stdout.write(ticket)
  process.exit(0)
}
if (process.argv[2] === '__hold') {
  // Vitest global setup keeps stdin open until teardown. A coordinator crash
  // closes it; wait for any token-bearing workers before letting the slot go.
  process.stdin.resume()
  process.stdin.once('end', async () => {
    while (tokenUsed(readProductEnvironment(process.env, 'HEAVY_JOB_TOKEN'), process.pid)) await sleep(200)
    process.exit(0)
  })
} else {
function inputHash(kind) {
  const list = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
  if (list.status !== 0) throw new Error('Build cache source inventory could not be read.')
  const hash = createHash('sha256').update(process.version).update(process.platform).update(process.arch).update(common).update(root)
  const scope = kind === 'contracts' ? 'packages/contracts' : `apps/${kind}`
  const tools = kind === 'web' ? ['typescript', 'vite', '@vitejs/plugin-react', '@tailwindcss/vite'] : ['typescript']
  try {
    for (const name of tools) {
      const path = require.resolve(name, { paths: [join(root, scope)] })
      hash.update(name).update(path).update(readFileSync(path))
    }
  } catch { throw new Error('Build cache hashing tools are unavailable.') }
  for (const relative of list.stdout.split('\0').filter(Boolean).sort()) {
    const path = join(root, relative)
    try {
      if (!statSync(path).isFile()) continue
      hash.update(relative).update(readFileSync(path))
    } catch { throw new Error('Build cache source files could not be read.') }
  }
  return hash.digest('hex')
}
const outputs = { contracts: 'packages/contracts/dist/index.js', api: 'apps/api/dist/server.js', web: 'apps/web/dist/index.html' }
function outputHash(kind) {
  const primary = join(root, outputs[kind])
  if (!existsSync(primary)) return null
  const base = dirname(primary)
  const hash = createHash('sha256')
  let count = 0
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) { hash.update(child.slice(base.length)).update(readFileSync(child)); count++ }
      else throw new Error('Unexpected build output')
    }
  }
  try {
    visit(base)
    return count ? hash.digest('hex') : null
  } catch { throw new Error('Build cache artifacts could not be hashed.') }
}
function recordBuildCache(kind, fresh, lastError) {
  const path = join(root, '.logs', `heavy-cache-${kind}.json`)
  let previous = null
  try { previous = JSON.parse(readFileSync(path, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') console.warn('Build cache diagnostic history is unavailable.')
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
  let cacheStatus = 'miss'
  if (fresh) cacheStatus = 'hit'
  if (lastError) cacheStatus = 'invalid'
  const status = { status: cacheStatus, lastError,
    missCount: count(previous?.missCount) + Number(!fresh),
    rebuildCount: count(previous?.rebuildCount) + Number(!fresh) }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(status))
  if (lastError) console.warn('Build cache unavailable; rebuilding', JSON.stringify(status))
  else console.log('Build cache status', JSON.stringify(status))
}
function readBuildStamp(path) {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'))
    if (!/^[a-f0-9]{64}$/.test(record?.signature) || !/^[a-f0-9]{64}$/.test(record?.output)) {
      throw new SyntaxError('Invalid build cache metadata')
    }
    return record
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error(error instanceof SyntaxError ? 'Build cache metadata is invalid.' : 'Build cache metadata could not be read.',
      { cause: error })
  }
}
function freshBuild(kind) {
  // The API build also probes installed harness binaries and environment.
  // Those can change without any source or output change, so always run it.
  if (kind === 'api' || process.env.FOREMAN_CODE_VERIFICATION_ROOT === root) return { fresh: false, stamp: null }
  if (!outputs[kind]) return { fresh: false, stamp: null }
  const stamp = join(root, '.logs', `heavy-build-${kind}.json`)
  let signature = null
  let fresh = false
  let lastError = null
  try {
    signature = inputHash(kind)
    const recorded = readBuildStamp(stamp)
    if (recorded?.signature === signature) {
      const output = outputHash(kind)
      fresh = recorded.output === output
      if (!fresh) lastError = output ? 'Build cache artifacts have changed.' : 'Build cache artifacts are missing.'
    }
  } catch (error) { lastError = error.message }
  recordBuildCache(kind, fresh, lastError)
  return { fresh, stamp, signature }
}
function stampBuild(kind, freshness) {
  if (kind === 'api') return
  if (!freshness?.signature) return
  try {
    if (freshness.signature !== inputHash(kind)) return
    const output = outputHash(kind)
    if (!output) throw new Error('Build cache artifacts are missing after the build.')
    mkdirSync(dirname(freshness.stamp), { recursive: true })
    writeFileSync(freshness.stamp, JSON.stringify({ signature: freshness.signature, output }))
  } catch (error) {
    const reason = error.message.startsWith('Build cache ')
      ? error.message : 'Build cache metadata could not be saved.'
    recordBuildCache(kind, true, reason)
  }
}
async function main() {
  const divider = process.argv.indexOf('--')
  if (divider < 0 || divider === process.argv.length - 1) throw new Error('Usage: heavy-job.mjs [--build kind] [--timeout-ms N] -- command [args...]')
  const options = process.argv.slice(2, divider)
  const buildIndex = options.indexOf('--build')
  const timeoutIndex = options.indexOf('--timeout-ms')
  const graceIndex = options.indexOf('--stop-grace-ms')
  const buildKind = buildIndex >= 0 ? options[buildIndex + 1] : null
  if (buildKind && !outputs[buildKind]) throw new Error('Unknown build kind')
  const timeoutMs = timeoutIndex >= 0 ? Number(options[timeoutIndex + 1]) : 0
  if (timeoutIndex >= 0 && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new Error('Invalid timeout')
  const stopGraceMs = graceIndex >= 0 ? Number(options[graceIndex + 1]) : 30_000
  if (!Number.isSafeInteger(stopGraceMs) || stopGraceMs <= 0) throw new Error('Invalid stop grace')
  let command = process.argv.slice(divider + 1)
  if (buildKind === 'contracts' && process.env.FOREMAN_CODE_CI_CONTRACTS_CACHE) {
    const cache = resolve(root, process.env.FOREMAN_CODE_CI_CONTRACTS_CACHE)
    command = [process.execPath, fileURLToPath(new URL('./ci-contracts.mjs', import.meta.url)),
      'build', root, cache, '--', ...command]
  }
  const reported = process.env.FOREMAN_CODE_VERIFICATION_ROOT === root
    && (buildKind || command[0] === 'vitest' || command[0] === 'tsc' || command[0] === 'eslint'
      || (command[0].endsWith('/node') || command[0] === 'node') && command.includes('--test'))
  const inheritedToken = readProductEnvironment(process.env, 'HEAVY_JOB_TOKEN')
  const inherited = [readJson(join(active, 'owner.json')), ...(existsSync(running) ? slotRecords() : [])].find((record) => inheritedToken && record?.token === inheritedToken)
  const nested = inherited?.token && readProductEnvironment(process.env, 'HEAVY_JOB_COMMON') === common && readProductEnvironment(process.env, 'HEAVY_JOB_TOKEN') === inherited.token
  mkdirSync(state, { recursive: true })
  if (nested) {
    const freshness = buildKind ? freshBuild(buildKind) : null
    if (freshness?.fresh) { console.log(`[heavy-job] ${buildKind} build is current in this worktree`); return }
    if (reported) {
      const { runVerificationCommand } = await import('./verification-reports.mjs')
      process.exitCode = await runVerificationCommand(command, { root, cwd: process.cwd(), env: process.env,
        script: process.env.npm_lifecycle_event })
      return
    }
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env })
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1))) })
    if (buildKind && process.exitCode === 0) stampBuild(buildKind, freshness)
    return
  }
  cleanTemps()
  const token = randomUUID()
  const ticket = register(token)
  const ticketPath = join(queue, ticket)
  let child, timer, killTimer, interrupted = false, exitCode = 1, tempPath
  const stop = (signal) => {
    interrupted = true
    if (child?.pid && !killTimer) {
      try { process.kill(-child.pid, signal || 'SIGTERM') }
      catch (error) { if (error.code !== 'ESRCH') console.warn('[heavy-job] Could not stop process group', error) }
      killTimer = setTimeout(() => {
        if (groupUsed(child.pid)) {
          try { process.kill(-child.pid, 'SIGKILL') }
          catch (error) { if (error.code !== 'ESRCH') console.warn('[heavy-job] Could not kill process group', error) }
        }
      }, stopGraceMs)
    }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    let announced = false
    const waitingSince = Date.now()
    let lastHoldersLog = waitingSince
    while (!interrupted) {
      if (schedule('admit', ticket, token)) break

      if (!announced) { console.log(`[heavy-job] queued ${ticket}; waiting for project test/build slot`); announced = true }
      const now = Date.now()
      if (now - lastHoldersLog >= 60_000) {
        logSlotHolders(now - waitingSince)
        lastHoldersLog = now
      }
      await sleep(300)
    }
    if (interrupted) { exitCode = 130; return }

    const freshness = buildKind ? freshBuild(buildKind) : null
    if (freshness?.fresh) { console.log(`[heavy-job] running ${ticket}`); console.log(`[heavy-job] ${buildKind} build is current in this worktree`); exitCode = 0; return }
    tempPath = join(tempRoot, randomUUID())
    mkdirSync(tempPath, { mode: 0o700 })
    writeRecord(join(tempPath, 'owner.json'), {
      common, worktree: root, pid: process.pid, start: procStart(process.pid),
      pgid: null, phase: 'acquiring', namespace, token,
    })
    const environment = { ...process.env, TMPDIR: tempPath, TMP: tempPath, TEMP: tempPath, FOREMAN_CODE_HEAVY_BASE_TMPDIR: baseTmp, FOREMAN_CODE_HEAVY_JOB_COMMON: common, FOREMAN_CODE_HEAVY_JOB_TOKEN: token, GRAPHQL_HEAVY_BASE_TMPDIR: baseTmp, GRAPHQL_HEAVY_JOB_COMMON: common, GRAPHQL_HEAVY_JOB_TOKEN: token }
    const launch = reported
      ? [process.execPath, fileURLToPath(new URL('./verification-reports.mjs', import.meta.url)), '__command',
        root, process.cwd(), process.env.npm_lifecycle_event, ...command]
      : command
    child = spawn(launch[0], launch.slice(1), { stdio: 'inherit', env: environment, detached: true })
    const pgid = child.pid
    for (const path of [join(active, 'owner.json'), join(running, ticket), ticketPath, join(tempPath, 'owner.json')]) {
      const record = readJson(path)
      if (record?.token === token) {
        const ownsTemp = path === join(active, 'owner.json') || path === join(running, ticket)
        writeRecord(path, { ...record, pgid, phase: 'running', ...(ownsTemp ? { tempPath } : {}) })
      }
    }
    console.log(`[heavy-job] running ${ticket}`)
    if (interrupted) stop('SIGTERM')
    if (timeoutMs) timer = setTimeout(() => { console.error(`[heavy-job] timed out after ${timeoutMs} ms`); stop('SIGTERM') }, timeoutMs)
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1))) })
    await waitGroup(pgid, interrupted ? stopGraceMs : 1000)
    if (command.at(-1) === '__hold') while (tokenUsed(token)) await sleep(200)
    if (interrupted && exitCode === 0) exitCode = 124
    if (buildKind && exitCode === 0) stampBuild(buildKind, freshness)
  } catch (error) {
    // Marker publication can fail after spawn. Stop our group before releasing
    // its reservations, just as cancellation does.
    if (child?.pid) { stop('SIGTERM'); await waitGroup(child.pid, stopGraceMs) }
    throw error
  } finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    if (tempPath && readJson(join(tempPath, 'owner.json'))?.token === token) rmSync(tempPath, { recursive: true, force: true })
    schedule('release', ticket, token)
    if (readJson(ticketPath)?.token === token) rmSync(ticketPath, { force: true })
    process.exitCode = exitCode
  }
}
main().catch((error) => { console.error(`[heavy-job] ${error.message}`); process.exitCode = 1 })
}
