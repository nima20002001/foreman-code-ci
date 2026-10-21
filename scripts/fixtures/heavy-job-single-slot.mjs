import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const root = resolve(dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(import.meta.url)
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' })
const commonResult = git('rev-parse', '--path-format=absolute', '--git-common-dir')
if (commonResult.status !== 0) throw new Error(commonResult.stderr || 'Cannot find Git common directory')
const common = realpathSync(commonResult.stdout.trim())
const state = join(common, 'graphql-heavy-jobs')
const queue = join(state, 'queue')
const active = join(state, 'active')
const baseTmp = process.env.GRAPHQL_HEAVY_BASE_TMPDIR || tmpdir()
const tempRoot = join(baseTmp, `graphql-heavy-${createHash('sha256').update(common).digest('hex').slice(0, 16)}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const ageMs = (path) => { try { return Date.now() - statSync(path).mtimeMs } catch { return 0 } }
const isDirectory = (path) => { try { return lstatSync(path).isDirectory() } catch { return false } }
const procStart = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] } catch { return null } }
const namespace = { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: readlinkSync('/proc/self/ns/pid') }
const gone = (error) => error.code === 'ENOENT' || error.code === 'ESRCH'
const alive = (record) => {
  // A PID/start pair has meaning only in the namespace that recorded it.
  // Legacy, foreign, malformed, or unreadable ownership is unknown, not stale.
  if (record?.namespace?.boot !== namespace.boot || record?.namespace?.pid !== namespace.pid || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.start !== 'string' || !/^\d+$/.test(record.start) || typeof record.token !== 'string' || !record.token) return true
  try {
    const text = readFileSync(`/proc/${record.pid}/stat`, 'utf8')
    const fields = text.slice(text.lastIndexOf(') ') + 2).split(' ')
    if (!/^\d+$/.test(fields[19])) return true
    return fields[19] === record.start && fields[0] !== 'Z'
  } catch (error) { return !gone(error) }
}
const tokenUsed = (token, exceptPid = 0, conservative = false) => {
  if (!token) return false
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      if (Number(entry) === exceptPid) continue
      try { if (readFileSync(`/proc/${entry}/environ`).includes(Buffer.from(`GRAPHQL_HEAVY_JOB_TOKEN=${token}\0`))) return true } catch (error) { if (conservative && !gone(error)) return true }
    }
  } catch { return true }
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
      } catch (error) { if (conservative && !gone(error)) return true }
    }
  } catch { return true }
  return false
}
const usedPath = (path) => {
  try {
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue
      for (const kind of ['cwd', 'root']) {
        try { const target = realpathSync(`/proc/${entry}/${kind}`); if (target === path || target.startsWith(`${path}${sep}`)) return true } catch (error) { if (!gone(error)) return true }
      }
      try {
        for (const fd of readdirSync(`/proc/${entry}/fd`)) {
          try { const target = readlinkSync(`/proc/${entry}/fd/${fd}`); if (target === path || target.startsWith(`${path}${sep}`) || target.startsWith(`${path} (deleted)`)) return true } catch (error) { if (!gone(error)) return true }
        }
      } catch (error) { if (!gone(error)) return true }
    }
  } catch { return true }
  return false
}
function cleanTemps() {
  mkdirSync(tempRoot, { recursive: true })
  for (const entry of readdirSync(tempRoot)) {
    const path = join(tempRoot, entry)
    const marker = readJson(join(path, 'owner.json'))
    if (!isDirectory(path) || ageMs(path) < 10 * 60_000 || !marker || marker.common !== common || alive(marker) || groupUsed(marker.pgid, true) || tokenUsed(marker.token, 0, true) || usedPath(path)) continue
    // Verify whether the recorded checkout still belongs to this common Git directory.
    const check = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: marker.worktree, encoding: 'utf8' })
    if (check.status === 0 && realpathSync(check.stdout.trim()) !== common) continue
    rmSync(path, { recursive: true, force: true })
  }
}
function cleanQueue() {
  mkdirSync(queue, { recursive: true })
  const held = readJson(join(active, 'owner.json'))
  if (held?.common === common && ageMs(active) > 10_000 && !alive(held) && !groupUsed(held.pgid, true) && !tokenUsed(held.token, 0, true)) rmSync(active, { recursive: true, force: true })
  for (const name of readdirSync(queue)) {
    const path = join(queue, name)
    const record = readJson(path)
    if (record?.common === common && !alive(record) && !groupUsed(record.pgid, true) && !tokenUsed(record.token, 0, true)) rmSync(path, { force: true })
  }
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
  writeFileSync(join(queue, ticket), JSON.stringify({ common, pid: Number(process.argv[3]), start: process.argv[4], worktree: process.argv[5], pgid: null, namespace: process.argv[6] ? JSON.parse(process.argv[6]) : undefined, token: process.argv[7] }))
  process.stdout.write(ticket)
  process.exit(0)
}
if (process.argv[2] === '__hold') {
  // Vitest global setup keeps stdin open until teardown. A coordinator crash
  // closes it; wait for any token-bearing workers before letting the slot go.
  process.stdin.resume()
  process.stdin.once('end', async () => {
    while (tokenUsed(process.env.GRAPHQL_HEAVY_JOB_TOKEN, process.pid)) await sleep(200)
    process.exit(0)
  })
} else {
function inputHash(kind) {
  const list = git('ls-files', '-z', '--cached', '--others', '--exclude-standard')
  if (list.status !== 0) return null
  const hash = createHash('sha256').update(process.version).update(process.platform).update(process.arch).update(common).update(root)
  const scope = kind === 'contracts' ? 'packages/contracts' : `apps/${kind}`
  const tools = kind === 'web' ? ['typescript', 'vite', '@vitejs/plugin-react', '@tailwindcss/vite'] : ['typescript']
  try {
    for (const name of tools) {
      const path = require.resolve(name, { paths: [join(root, scope)] })
      hash.update(name).update(path).update(readFileSync(path))
    }
  } catch { return null }
  for (const relative of list.stdout.split('\0').filter(Boolean).sort()) {
    const path = join(root, relative)
    try {
      if (!statSync(path).isFile()) continue
      hash.update(relative).update(readFileSync(path))
    } catch { return null }
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
  try { visit(base); return count ? hash.digest('hex') : null } catch { return null }
}
function freshBuild(kind) {
  // The API build also probes installed harness binaries and environment.
  // Those can change without any source or output change, so always run it.
  if (kind === 'api') return { fresh: false, stamp: null }
  if (!outputs[kind]) return { fresh: false, stamp: null }
  const signature = inputHash(kind)
  const stamp = join(root, '.logs', `heavy-build-${kind}.json`)
  const recorded = readJson(stamp)
  return { fresh: Boolean(signature && recorded?.signature === signature && recorded?.output === outputHash(kind)), stamp, signature }
}
function stampBuild(kind, freshness) {
  if (kind === 'api') return
  if (!freshness?.signature || freshness.signature !== inputHash(kind)) return
  const output = outputHash(kind)
  if (!output) return
  mkdirSync(dirname(freshness.stamp), { recursive: true })
  writeFileSync(freshness.stamp, JSON.stringify({ signature: freshness.signature, output }))
}
async function waitGroup(pgid, graceMs = 5000) {
  const start = Date.now()
  while (groupUsed(pgid) && Date.now() - start < graceMs) await sleep(100)
  if (groupUsed(pgid)) {
    try { process.kill(-pgid, 'SIGKILL') } catch { /* already exited */ }
    while (groupUsed(pgid)) await sleep(100)
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
  const command = process.argv.slice(divider + 1)
  const inherited = readJson(join(active, 'owner.json'))
  const nested = inherited?.token && process.env.GRAPHQL_HEAVY_JOB_COMMON === common && process.env.GRAPHQL_HEAVY_JOB_TOKEN === inherited.token
  mkdirSync(state, { recursive: true })
  if (nested) {
    const freshness = buildKind ? freshBuild(buildKind) : null
    if (freshness?.fresh) { console.log(`[heavy-job] ${buildKind} build is current in this worktree`); return }
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env })
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1))) })
    if (buildKind && process.exitCode === 0) stampBuild(buildKind, freshness)
    return
  }
  cleanQueue()
  cleanTemps()
  const token = randomUUID()
  const ticket = register(token)
  const ticketPath = join(queue, ticket)
  let child, timer, killTimer, interrupted = false, exitCode = 1, tempPath
  const stop = (signal) => {
    interrupted = true
    if (child?.pid && !killTimer) {
      try { process.kill(-child.pid, signal || 'SIGTERM') } catch { /* exited */ }
      killTimer = setTimeout(() => {
        if (groupUsed(child.pid)) { try { process.kill(-child.pid, 'SIGKILL') } catch { /* exited */ } }
      }, stopGraceMs)
    }
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  try {
    let announced = false
    while (!interrupted) {
      cleanQueue()
      const first = readdirSync(queue).sort()[0]
      if (first === ticket && !existsSync(active)) {
        try { mkdirSync(active) } catch { await sleep(200); continue }
        break
      }
      if (!announced) { console.log(`[heavy-job] queued ${ticket}; waiting for project test/build slot`); announced = true }
      await sleep(300)
    }
    if (interrupted) { exitCode = 130; return }
    writeFileSync(join(active, 'owner.json'), JSON.stringify({ common, pid: process.pid, start: procStart(process.pid), pgid: null, namespace, token }))
    const freshness = buildKind ? freshBuild(buildKind) : null
    if (freshness?.fresh) { console.log(`[heavy-job] running ${ticket}`); console.log(`[heavy-job] ${buildKind} build is current in this worktree`); exitCode = 0; return }
    tempPath = join(tempRoot, randomUUID())
    mkdirSync(tempPath)
    writeFileSync(join(tempPath, 'owner.json'), JSON.stringify({ common, worktree: root, pid: process.pid, start: procStart(process.pid), pgid: null, namespace, token }))
    const environment = { ...process.env, TMPDIR: tempPath, TMP: tempPath, TEMP: tempPath, GRAPHQL_HEAVY_BASE_TMPDIR: baseTmp, GRAPHQL_HEAVY_JOB_COMMON: common, GRAPHQL_HEAVY_JOB_TOKEN: token }
    child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: environment, detached: true })
    const pgid = child.pid
    for (const path of [join(active, 'owner.json'), join(ticketPath), join(tempPath, 'owner.json')]) {
      const record = readJson(path); if (record?.token === token) writeFileSync(path, JSON.stringify({ ...record, pgid, ...(path === join(active, 'owner.json') ? { tempPath } : {}) }))
    }
    console.log(`[heavy-job] running ${ticket}`)
    if (interrupted) stop('SIGTERM')
    if (timeoutMs) timer = setTimeout(() => { console.error(`[heavy-job] timed out after ${timeoutMs} ms`); stop('SIGTERM') }, timeoutMs)
    exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 1))) })
    await waitGroup(pgid, interrupted ? stopGraceMs : 1000)
    if (command.at(-1) === '__hold') while (tokenUsed(token)) await sleep(200)
    if (interrupted && exitCode === 0) exitCode = 124
    if (buildKind && exitCode === 0) stampBuild(buildKind, freshness)
  } finally {
    clearTimeout(timer)
    clearTimeout(killTimer)
    process.off('SIGINT', stop); process.off('SIGTERM', stop)
    if (tempPath && readJson(join(tempPath, 'owner.json'))?.token === token) rmSync(tempPath, { recursive: true, force: true })
    if (readJson(join(active, 'owner.json'))?.token === token) rmSync(active, { recursive: true, force: true })
    if (readJson(ticketPath)?.token === token) rmSync(ticketPath, { force: true })
    process.exitCode = exitCode
  }
}
main().catch((error) => { console.error(`[heavy-job] ${error.message}`); process.exitCode = 1 })
}
