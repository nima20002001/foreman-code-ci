import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'

const source = new URL('./heavy-job.mjs', import.meta.url).pathname
const hookSource = new URL('./vitest-heavy-setup.mjs', import.meta.url).pathname
// Frozen, unmodified scheduler from 4fb7c5b4; exercise real old callers.
const legacySource = new URL('./fixtures/heavy-job-single-slot.mjs', import.meta.url).pathname
const namespace = { boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: readlinkSync('/proc/self/ns/pid') }
const jobEnv = (cwd) => {
  const env = { ...process.env, GRAPHQL_HEAVY_BASE_TMPDIR: dirname(cwd) }
  const hook = join(dirname(cwd), 'proc-hook.mjs')
  if (existsSync(hook)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(hook).href}`
  delete env.GRAPHQL_HEAVY_JOB_COMMON
  delete env.GRAPHQL_HEAVY_JOB_TOKEN
  delete env.FOREMAN_CODE_HEAVY_JOB_COMMON
  delete env.FOREMAN_CODE_HEAVY_JOB_TOKEN
  delete env.FOREMAN_CODE_HEAVY_BASE_TMPDIR
  delete env.FOREMAN_CODE_CI_CONTRACTS_CACHE
  delete env.CI_HOST_RUNNER
  return env
}
const run = (cwd, args, { signal, onQueued } = {}) => new Promise((resolve) => {
  const env = jobEnv(cwd)
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const abort = () => child.kill('SIGTERM')
  signal?.addEventListener('abort', abort, { once: true })
  let output = ''
  child.stdout.on('data', (data) => {
    output += data
    if (/\[heavy-job\] queued/.test(output)) onQueued?.()
  })
  child.stderr.on('data', (data) => { output += data })
  child.once('exit', (code) => {
    signal?.removeEventListener('abort', abort)
    resolve({ code, output, child })
  })
  if (signal?.aborted) abort()
})
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function fixture(checkoutName = 'one') {
  const home = mkdtempSync(join(tmpdir(), 'graphql-heavy-test-'))
  const first = join(home, checkoutName)
  mkdirSync(join(first, 'scripts'), { recursive: true })
  copyFileSync(source, join(first, 'scripts/heavy-job.mjs'))
  copyFileSync(new URL('./sleep.mjs', import.meta.url), join(first, 'scripts/sleep.mjs'))
  copyFileSync(new URL('./heavy-job-slots.mjs', import.meta.url), join(first, 'scripts/heavy-job-slots.mjs'))
  mkdirSync(join(first, 'packages/contracts/src'), { recursive: true })
  copyFileSync(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url), join(first, 'packages/contracts/src/productEnvironment.mjs'))
  writeFileSync(join(first, 'package.json'), '{"type":"module"}')
  writeFileSync(join(first, 'source.txt'), 'first')
  writeFileSync(join(first, '.gitignore'), 'count\ndist/\n.logs/\n')
  git(first, 'init', '-q')
  git(first, 'add', '.')
  git(first, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  const second = join(home, 'two')
  git(first, 'worktree', 'add', '-q', '--detach', second)
  for (const worktree of [first, second]) {
    mkdirSync(join(worktree, 'packages/contracts'), { recursive: true })
    symlinkSync(join(new URL('..', import.meta.url).pathname, 'packages/contracts/node_modules'), join(worktree, 'packages/contracts/node_modules'), 'dir')
  }
  const common = git(first, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  const state = join(common, 'graphql-heavy-jobs')
  const tempRoot = join(home, `graphql-heavy-${createHash('sha256').update(common).digest('hex').slice(0, 16)}`)
  return { home, first, second, common, state, tempRoot }
}
test('checkout paths with spaces, Unicode and percent characters retain queue ownership', async () => {
  const f = fixture('space فارسی 100%')
  try {
    for (const cwd of [f.first, f.second]) {
      const result = await run(cwd, ['--', process.execPath, '-e',
        'console.log(JSON.stringify({cwd:process.cwd(),common:process.env.FOREMAN_CODE_HEAVY_JOB_COMMON}))'])
      assert.equal(result.code, 0, result.output)
      const receipt = JSON.parse(result.output.split('\n').find(line => line.startsWith('{"cwd":')))
      assert.deepEqual(receipt, { cwd, common: f.common })
    }
    assert.deepEqual(readdirSync(join(f.state, 'queue')), [])
    assert.deepEqual(readdirSync(join(f.state, 'running')), [])
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})
test('temporary directories exclude other writers under a shared group umask', t => {
  const f = fixture()
  t.after(() => rmSync(f.home, { recursive: true, force: true }))
  const command = 'const fs=require("node:fs"),path=require("node:path");console.log("modes="+JSON.stringify([process.env.TMPDIR,path.dirname(process.env.TMPDIR)].map(value=>fs.statSync(value).mode&0o777)))'
  const entry = `process.umask(0o002);process.argv=[process.execPath,${JSON.stringify(join(f.first, 'scripts/heavy-job.mjs'))},'--',process.execPath,'-e',${JSON.stringify(command)}];await import(${JSON.stringify(pathToFileURL(join(f.first, 'scripts/heavy-job.mjs')).href)})`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', entry],
    { cwd: f.first, env: jobEnv(f.first), encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const modes = JSON.parse(result.stdout.split('\n').find(line => line.startsWith('modes=')).slice('modes='.length))
  assert.deepEqual(modes, [0o700, 0o700])
})
function mockProc(f, declarations) {
  writeFileSync(join(f.home, 'proc-hook.mjs'), `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const actualReadFileSync = fs.readFileSync
const actualReaddirSync = fs.readdirSync
const actualStatSync = fs.statSync
${declarations}
fs.readFileSync = readFileSync
fs.readdirSync = readdirSync
fs.statSync = (path, ...args) => /^\\/proc\\/999999\\d+\\/environ$/.test(String(path))
  ? { uid: process.geteuid() } : actualStatSync(path, ...args)
syncBuiltinESMExports()
`)
}
const waitFile = async (path) => {
  if (existsSync(path)) return
  let timer
  let watcher
  try {
    await new Promise((resolve, reject) => {
      const check = () => { if (existsSync(path)) resolve() }
      watcher = watch(dirname(path), check)
      watcher.on('error', reject)
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${path}`)), 5000)
      check()
    })
  } finally {
    watcher?.close()
    clearTimeout(timer)
  }
}
async function waitQueued(queued, exited) {
  let timer
  try {
    await Promise.race([
      queued,
      exited.then(() => assert.fail('The job exited before queuing')),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The job did not queue')), 5000) }),
    ])
  } finally { clearTimeout(timer) }
}

const pidRunning = (pid) => {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return text.split(') ')[1][0] !== 'Z' } catch { return false }
}

// Each probe uses the normal scheduler in a disposable Git common directory.
// Stop only the fixture waiter once it reports admission or queuing.
async function probe(f) {
  const ran = join(f.home, 'probe-ran')
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'yes')`], { cwd: f.first, env: jobEnv(f.first), stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', ready
  const announced = new Promise((resolve) => { ready = resolve })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  child.stdout.on('data', (data) => { output += data; if (/\[heavy-job\] (queued|running)/.test(output)) ready() })
  child.stderr.on('data', (data) => { output += data })
  child.once('exit', ready)
  const timer = setTimeout(() => { child.kill('SIGTERM'); ready() }, 4000)
  try {
    await announced
    if (child.exitCode === null) child.kill('SIGTERM')
    await exited
    return { output, ran: existsSync(ran) }
  } finally { clearTimeout(timer) }
}

for (const [name, identity] of [
  ['foreign PID namespace', { ...namespace, pid: 'pid:[foreign-fixture]' }],
  ['foreign boot', { ...namespace, boot: 'foreign-fixture' }],
  ['legacy ownership without namespace', undefined],
]) {
  test(`cleanup preserves ${name} queue, active slot, and temp`, { timeout: 6000 }, async () => {
    const f = fixture()
    try {
      const record = JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null, token: randomUUID(), namespace: identity })
      const ticket = join(f.state, 'queue', '000000000001-foreign')
      const active = join(f.state, 'active')
      const temp = join(f.tempRoot, 'peer-temp')
      mkdirSync(dirname(ticket), { recursive: true })
      mkdirSync(active)
      mkdirSync(temp, { recursive: true })
      for (const path of [ticket, join(active, 'owner.json'), join(temp, 'owner.json')]) writeFileSync(path, record)
      for (const path of [ticket, active, temp]) utimesSync(path, new Date(0), new Date(0))
      const result = await probe(f)
      assert.match(result.output, /queued .*waiting/)
      assert.equal(result.ran, false)
      for (const path of [ticket, join(active, 'owner.json'), join(temp, 'owner.json')]) assert.equal(readFileSync(path, 'utf8'), record)
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })
}

for (const [name, pgid, denied] of [
  ['owner', null, '/proc/99999999/stat'],
  ['process group', 99999998, '/proc/99999998/stat'],
  ['token', null, '/proc/99999998/environ'],
]) test(`unreadable local ${name} evidence remains reserved`, { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === ${JSON.stringify(denied)}) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const path = join(f.state, 'queue', '000000000001-unreadable')
    mkdirSync(dirname(path), { recursive: true })
    const record = JSON.stringify({ common: f.common, pid: 99999999, start: '0', pgid, token: randomUUID(), namespace })
    writeFileSync(path, record)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(path, 'utf8'), record)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('a dead queued owner cannot retain FIFO behind unrelated unreadable environments', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ') throw Object.assign(new Error('unrelated fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const ticket = join(f.state, 'queue', '000000000001-queued')
    mkdirSync(dirname(ticket), { recursive: true })
    writeFileSync(ticket, JSON.stringify({ common: f.common, pid: 99999999, start: '0', pgid: null, phase: 'queued', namespace, token: randomUUID() }))
    const result = await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(result.code, 0, result.output)
    assert.equal(existsSync(ticket), false)
    assert.equal(existsSync(join(f.state, 'active')), false)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

for (const owner of ['absent', 'reused']) {
  test(`reclaims an empty running slot after its coordinator is ${owner}, despite unrelated unreadable environments`,
    { timeout: 6000 }, async (context) => {
      const f = fixture()
      try {
        mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ') throw Object.assign(new Error('unrelated fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
        const pid = owner === 'absent' ? 99999999 : process.pid
        const start = owner === 'absent' ? '0'
          : String(BigInt(readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]) + 1n)
        const ticket = '000000000001-abandoned'
        const record = JSON.stringify({ common: f.common, worktree: f.first, pid, start,
          pgid: 99999997, phase: 'running', namespace, token: randomUUID() })
        for (const folder of ['queue', 'running', 'active']) mkdirSync(join(f.state, folder), { recursive: true })
        for (const path of [join(f.state, 'queue', ticket), join(f.state, 'running', ticket),
          join(f.state, 'active', 'owner.json')]) {
          writeFileSync(path, record)
          utimesSync(path, new Date(0), new Date(0))
        }
        utimesSync(join(f.state, 'active'), new Date(0), new Date(0))
        const result = await run(f.first, ['--', process.execPath, '-e', 'console.log("replacement admitted")'],
          { signal: context.signal })
        assert.equal(result.code, 0, result.output)
        assert.match(result.output, /replacement admitted/)
      } finally { rmSync(f.home, { recursive: true, force: true }) }
    })
}

test('a dead running owner is reaped even with a live detached token-bearing worker', { timeout: 6000 }, async context => {
  const f = fixture()
  const token = randomUUID()
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { detached: true, stdio: 'ignore', env: { ...jobEnv(f.first), FOREMAN_CODE_HEAVY_JOB_TOKEN: token } })
  const exited = new Promise(resolve => worker.once('exit', resolve))
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ') throw Object.assign(new Error('unrelated fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998', ${JSON.stringify(String(worker.pid))}] : actualReaddirSync(path, ...args) }`)
    const ticket = '000000000001-detached-running'
    const record = JSON.stringify({ common: f.common, pid: 99999999, start: '0',
      pgid: 99999997, phase: 'running', namespace, token })
    for (const folder of ['queue', 'running', 'active']) mkdirSync(join(f.state, folder), { recursive: true })
    for (const path of [join(f.state, 'queue', ticket), join(f.state, 'running', ticket),
      join(f.state, 'active', 'owner.json')]) {
      writeFileSync(path, record)
      utimesSync(path, new Date(0), new Date(0))
    }
    utimesSync(join(f.state, 'active'), new Date(0), new Date(0))
    const result = await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'], { signal: context.signal })
    assert.equal(result.code, 0, result.output)
    assert.equal(existsSync(join(f.state, 'running', ticket)), false)
    assert.equal(worker.exitCode, null)
  } finally {
    worker.kill('SIGTERM')
    await exited
    rmSync(f.home, { recursive: true, force: true })
  }
})

for (const [name, phase, pid, pgid, identity] of [
  ['live queued owner', 'queued', process.pid, null, namespace],
  ['queued foreign ownership', 'queued', 99999999, null, { ...namespace, boot: 'foreign' }],
  ['queued unreadable owner', 'queued', 99999998, null, namespace],
  ['acquisition crash before the child PID is recorded', 'acquiring', 99999999, null, namespace],
  ['unknown phase', 'unknown', 99999999, null, namespace],
  ['inconsistent queued process group', 'queued', 99999999, 99999998, namespace],
]) test(`${name} remains reserved with unreadable evidence`, { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ' || path === '/proc/99999998/stat') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const ticket = join(f.state, 'queue', '000000000001-reserved')
    mkdirSync(dirname(ticket), { recursive: true })
    const start = pid === process.pid ? readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] : '0'
    const record = JSON.stringify({ common: f.common, pid, start, pgid, phase, namespace: identity, token: randomUUID() })
    writeFileSync(ticket, record)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(ticket, 'utf8'), record)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

for (const pgidRecorded of [false, true]) test(`detached worker retains a dead running owner with ${pgidRecorded ? 'recorded group' : 'unrecorded group/token evidence'}`, { timeout: 6000 }, async () => {
  const f = fixture()
  const token = randomUUID()
  const worker = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, stdio: 'ignore', env: { ...process.env, GRAPHQL_HEAVY_JOB_TOKEN: token } })
  const exited = new Promise((resolve) => worker.once('exit', resolve))
  try {
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? [${JSON.stringify(String(worker.pid))}] : actualReaddirSync(path, ...args) }`)
    const ticket = join(f.state, 'queue', '000000000001-detached')
    mkdirSync(dirname(ticket), { recursive: true })
    const record = JSON.stringify({ common: f.common, pid: 99999999, start: '0', pgid: pgidRecorded ? worker.pid : null, phase: 'acquiring', namespace, token })
    writeFileSync(ticket, record)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(ticket, 'utf8'), record)
  } finally {
    worker.kill('SIGTERM')
    await exited
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('a coordinator crash at spawn leaves acquiring provenance in every marker', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const crashHook = join(f.home, 'crash-at-spawn.mjs')
    writeFileSync(crashHook, `
      import childProcess from 'node:child_process'
      import { syncBuiltinESMExports } from 'node:module'
      childProcess.spawn = () => { process.kill(process.pid, 'SIGKILL') }
      syncBuiltinESMExports()
    `)
    const result = spawnSync(process.execPath,
      ['--import', crashHook, 'scripts/heavy-job.mjs', '--', process.execPath, '-e', 'process.exit(0)'],
      { cwd: f.first, env: jobEnv(f.first), encoding: 'utf8', timeout: 4000 })
    assert.equal(result.signal, 'SIGKILL', result.stderr || result.error?.message)
    const ticket = join(f.state, 'queue', readdirSync(join(f.state, 'queue'))[0])
    const active = join(f.state, 'active', 'owner.json')
    const temp = join(f.tempRoot, readdirSync(f.tempRoot)[0], 'owner.json')
    for (const path of [ticket, active, temp]) {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(record.phase, 'acquiring')
      assert.equal(record.pgid, null)
    }
    mockProc(f, `function readFileSync(path, ...args) { if (path === '/proc/99999998/environ') throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }); return actualReadFileSync(path, ...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999998'] : actualReaddirSync(path, ...args) }`)
    const next = await probe(f)
    assert.match(next.output, /queued .*waiting/)
    assert.equal(next.ran, false)
    for (const path of [ticket, active, temp]) assert.equal(existsSync(path), true)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('marker publication failure stops the spawned group before releasing its slot', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const pidPath = join(f.home, 'unpublished-pid')
    const hook = join(f.home, 'proc-hook.mjs')
    writeFileSync(hook, `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const write = fs.writeFileSync
fs.writeFileSync = (path, data, ...args) => {
  if (String(path).startsWith(${JSON.stringify(f.state)}) && typeof data === 'string'
    && data.startsWith('{') && JSON.parse(data).phase === 'running') {
    write(${JSON.stringify(pidPath)}, String(JSON.parse(data).pgid))
    throw new Error('fixture marker publication failure')
  }
  return write(path, data, ...args)
}
syncBuiltinESMExports()
`)
    const result = await run(f.first, ['--stop-grace-ms', '100', '--', process.execPath, '-e', 'setInterval(()=>{},1000)'])
    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /fixture marker publication failure/)
    assert.equal(pidRunning(Number(readFileSync(pidPath, 'utf8'))), false)
    assert.equal(existsSync(join(f.state, 'active')), false)
    assert.deepEqual(readdirSync(join(f.state, 'queue')), [])
    rmSync(hook)
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('malformed queue blocks admission while a stale empty active directory is reclaimed', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const path = join(f.state, 'queue', '000000000001-aaaaaaaa')
    const active = join(f.state, 'active')
    mkdirSync(dirname(path), { recursive: true })
    mkdirSync(active)
    writeFileSync(path, '{')
    for (const entry of [path, active]) utimesSync(entry, new Date(0), new Date(0))
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(path, 'utf8'), '{')
    assert.equal(existsSync(active), false)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

for (const metadata of ['empty', 'truncated', 'unreadable']) {
  test(`preserves an old active directory with ${metadata} owner metadata`, { timeout: 6000 }, async () => {
    const f = fixture()
    try {
      const active = join(f.state, 'active')
      const owner = join(active, 'owner.json')
      mkdirSync(active, { recursive: true })
      const contents = metadata === 'truncated' ? '{' : ''
      writeFileSync(owner, contents)
      utimesSync(active, new Date(0), new Date(0))
      if (metadata === 'unreadable') {
        mockProc(f, `
function readFileSync(path, ...args) {
  if (path === ${JSON.stringify(owner)}) {
    throw Object.assign(new Error('fixture owner read denied'), { code: 'EACCES' })
  }
  return actualReadFileSync(path, ...args)
}
function readdirSync(path, ...args) { return actualReaddirSync(path, ...args) }
`)
      }
      const result = await probe(f)
      assert.match(result.output, /queued .*waiting/)
      assert.equal(result.ran, false)
      assert.equal(existsSync(active), true)
      assert.equal(readFileSync(owner, 'utf8'), contents)
    } finally { rmSync(f.home, { recursive: true, force: true }) }
  })
}

test('preserves a stale active directory when its contents cannot be listed', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const active = join(f.state, 'active')
    mkdirSync(active, { recursive: true })
    utimesSync(active, new Date(0), new Date(0))
    mockProc(f, `
function readFileSync(path, ...args) { return actualReadFileSync(path, ...args) }
function readdirSync(path, ...args) {
  if (path === ${JSON.stringify(active)}) {
    throw Object.assign(new Error('fixture directory read denied'), { code: 'EACCES' })
  }
  return actualReaddirSync(path, ...args)
}
`)
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(existsSync(active), true)
    assert.deepEqual(readdirSync(active), [])
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('matching namespace with complete dead-process evidence reclaims stale reservations', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999999'] : actualReaddirSync(path, ...args) }`)
    const record = JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null, token: randomUUID(), namespace })
    const ticket = join(f.state, 'queue', '000000000001-stale')
    const active = join(f.state, 'active')
    const temp = join(f.tempRoot, 'stale-temp')
    mkdirSync(dirname(ticket), { recursive: true })
    mkdirSync(active)
    mkdirSync(temp, { recursive: true })
    for (const path of [ticket, join(active, 'owner.json'), join(temp, 'owner.json')]) writeFileSync(path, record)
    for (const path of [ticket, active, temp]) utimesSync(path, new Date(0), new Date(0))
    const result = await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(result.code, 0, result.output)
    for (const path of [ticket, active, temp]) assert.equal(existsSync(path), false)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('one stable token owns ticket, active slot, and temp; release preserves replacement ownership', { timeout: 6000 }, async () => {
  const f = fixture()
  const started = join(f.home, 'started')
  const released = join(f.home, 'released')
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `const fs=require('fs');const watcher=fs.watch(${JSON.stringify(f.home)},()=>{if(fs.existsSync(${JSON.stringify(released)})) watcher.close()});fs.writeFileSync(${JSON.stringify(started)},'yes')`], { cwd: f.first, env: jobEnv(f.first), stdio: 'pipe' })
  const exited = new Promise((resolve) => child.once('exit', resolve))
  try {
    await waitFile(started)
    const activePath = join(f.state, 'active', 'owner.json')
    const owner = JSON.parse(readFileSync(activePath, 'utf8'))
    const ticketPath = join(f.state, 'queue', readdirSync(join(f.state, 'queue'))[0])
    const tempPath = join(owner.tempPath, 'owner.json')
    const replacement = randomUUID()
    for (const path of [ticketPath, activePath, tempPath]) {
      const record = JSON.parse(readFileSync(path, 'utf8'))
      assert.equal(record.token, owner.token)
      assert.deepEqual(record.namespace, namespace)
      assert.equal(record.phase, 'running')
      writeFileSync(path, JSON.stringify({ ...record, token: replacement }))
    }
    writeFileSync(released, 'yes')
    assert.equal(await exited, 0)
    for (const path of [ticketPath, activePath, tempPath]) assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, replacement)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('nested worktree jobs reuse the same integration owner', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const result = await run(f.first, ['--', process.execPath, join(f.second, 'scripts/heavy-job.mjs'), '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(f.home, 'nested-ran'))},'yes')`])
    assert.equal(result.code, 0, result.output)
    assert.equal((result.output.match(/\[heavy-job\] running /g) || []).length, 1)
    assert.equal(existsSync(join(f.home, 'nested-ran')), true)
    assert.equal(existsSync(join(f.state, 'active')), false)
    assert.deepEqual(readdirSync(join(f.state, 'queue')), [])
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('linked worktrees take one visible slot in ticket order', async () => {
  const f = fixture()
  try {
    const started = join(f.home, 'started')
    const released = join(f.home, 'released')
    const secondRan = join(f.home, 'second-ran')
    const first = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `const fs=require('fs');const watcher=fs.watch(${JSON.stringify(f.home)},()=>{if(fs.existsSync(${JSON.stringify(released)})) watcher.close()});fs.writeFileSync(${JSON.stringify(started)},'yes')`], { cwd: f.first, env: jobEnv(f.first), stdio: 'pipe' })
    await waitFile(started)
    const queued = Promise.withResolvers()
    const second = run(f.second, ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(secondRan)},'yes')`], { onQueued: queued.resolve })
    await waitQueued(queued.promise, second)
    assert.equal(existsSync(secondRan), false)
    const pending = readdirSync(join(f.state, 'queue')).sort().at(-1)
    assert.equal(JSON.parse(readFileSync(join(f.state, 'queue', pending), 'utf8')).phase, 'queued')
    writeFileSync(released, 'yes')
    assert.equal(await new Promise((resolve) => first.once('exit', resolve)), 0)
    const result = await second
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(existsSync(secondRan), true)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('termination stops descendants before releasing the slot', async () => {
  const f = fixture()
  try {
    const pidFile = join(f.home, 'descendant-pid')
    const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', `const c=require('child_process').spawn('sleep',['60']); require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid)); setInterval(()=>{},1000)`], { cwd: f.first, env: jobEnv(f.first), stdio: 'pipe' })
    await waitFile(pidFile)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    child.kill('SIGTERM')
    await new Promise((resolve) => child.once('exit', resolve))
    assert.equal(pidRunning(pid), false)
    const next = await run(f.second, ['--', process.execPath, '-e', 'process.exit(0)'])
    assert.equal(next.code, 0, next.output)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('timeout terminates the process group and frees the next ticket', async () => {
  const f = fixture()
  try {
    const pidFile = join(f.home, 'timeout-descendant')
    const result = await run(f.first, ['--timeout-ms', '300', '--', process.execPath, '-e', `const c=require('child_process').spawn('sleep',['60']);require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`])
    assert.notEqual(result.code, 0)
    assert.match(result.output, /timed out/)
    assert.equal(pidRunning(Number(readFileSync(pidFile, 'utf8'))), false)
    assert.equal((await run(f.second, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('a TERM-ignoring child is killed after the grace period', async () => {
  const f = fixture()
  try {
    const started = Date.now()
    const result = await run(f.first, ['--timeout-ms', '300', '--stop-grace-ms', '250', '--', process.execPath, '-e', `process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`])
    assert.notEqual(result.code, 0)
    assert.match(result.output, /timed out/)
    assert.ok(Date.now() - started < 3000, 'cancellation exceeded its grace period')
    assert.equal((await run(f.second, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('build freshness stays local and invalidates on source change; legacy temp is preserved', async () => {
  const f = fixture()
  try {
    const script = `const fs=require('fs');fs.mkdirSync('packages/contracts/dist',{recursive:true});fs.writeFileSync('packages/contracts/dist/index.js','built');fs.appendFileSync('count','x')`
    const args = ['--build', 'contracts', '--', process.execPath, '-e', script]
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), 'x')
    assert.equal((await run(f.second, args)).code, 0)
    assert.equal(readFileSync(join(f.second, 'count'), 'utf8'), 'x')
    writeFileSync(join(f.first, 'source.txt'), 'changed')
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), 'xx')
    const stale = join(f.tempRoot, 'legacy-owned')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'owner.json'), JSON.stringify({ common: f.common, worktree: f.first, pid: 99999999, start: '0', pgid: null }))
    utimesSync(stale, new Date(0), new Date(0))
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
    assert.equal(existsSync(stale), true, 'legacy temp liveness is unknown')
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('API build always runs its dynamic harness check', async () => {
  const f = fixture()
  try {
    const check = `require('fs').appendFileSync('count','x')`
    const args = ['--build', 'api', '--', process.execPath, '-e', check]
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal((await run(f.first, args)).code, 0)
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), 'xx')
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('Vitest coordinator hook admits once and releases after teardown', async () => {
  const f = fixture()
  let teardown
  try {
    copyFileSync(hookSource, join(f.first, 'scripts/vitest-heavy-setup.mjs'))
    const { default: setup } = await import(pathToFileURL(join(f.first, 'scripts/vitest-heavy-setup.mjs')).href)
    teardown = await setup()
    assert.equal(typeof teardown, 'function')
    assert.equal(typeof process.env.GRAPHQL_HEAVY_JOB_TOKEN, 'string')
    const ran = join(f.home, 'hook-second-ran')
    const queued = Promise.withResolvers()
    const second = run(f.second, ['--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(ran)},'yes')`], { onQueued: queued.resolve })
    await waitQueued(queued.promise, second)
    assert.equal(existsSync(ran), false)
    await teardown()
    teardown = null
    const result = await second
    assert.equal(result.code, 0, result.output)
    assert.equal(existsSync(ran), true)
  } finally {
    if (teardown) await teardown()
    rmSync(f.home, { recursive: true, force: true })
  }
})

const waitFor = async (check) => {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('Timed out waiting for scheduler state')
}
function heldJob(f, label, cwd = f.first, environment = {}) {
  const started = join(f.home, `${label}-started`)
  const released = join(f.home, `${label}-released`)
  const script = `const fs=require('fs');const watcher=fs.watch(${JSON.stringify(f.home)},()=>{if(fs.existsSync(${JSON.stringify(released)})) watcher.close()});fs.writeFileSync(${JSON.stringify(started)},'yes')`
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', script], {
    cwd, env: { ...jobEnv(cwd), ...environment }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const queued = Promise.withResolvers()
  child.stdout.on('data', (data) => {
    output += data
    if (/\[heavy-job\] queued/.test(output)) queued.resolve()
  })
  child.stderr.on('data', (data) => { output += data })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, output })))
  return { child, started, exited, queued: () => waitQueued(queued.promise, exited),
    running: () => waitFor(() => /\[heavy-job\] running /.test(output)),
    release: () => writeFileSync(released, 'yes') }
}
async function stopJobs(jobs) {
  for (const job of jobs) if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill('SIGTERM')
  await Promise.all(jobs.map((job) => job.exited))
}
function configureSlots(f, value) {
  mkdirSync(f.state, { recursive: true })
  writeFileSync(join(f.state, 'slots'), String(value))
}

test('host CI worktrees run concurrently while nested commands retain their own admission', async () => {
  const f = fixture()
  const jobs = []
  try {
    jobs.push(heldJob(f, 'first', f.first, { CI_HOST_RUNNER: '1' }))
    await waitFile(jobs[0].started)
    jobs.push(heldJob(f, 'second', f.second, { CI_HOST_RUNNER: '1' }))
    await waitFile(jobs[1].started)
    for (const job of jobs) job.release()
    for (const job of jobs) assert.equal((await job.exited).code, 0)
  } finally {
    await stopJobs(jobs)
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('Vitest setup uses the private admission queue in a host CI worktree', { timeout: 6000 }, () => {
  const f = fixture()
  try {
    copyFileSync(hookSource, join(f.second, 'scripts/vitest-heavy-setup.mjs'))
    const entry = `const { default: setup } = await import('./scripts/vitest-heavy-setup.mjs');
      const teardown = await setup();
      console.log('suite admitted');
      await teardown();`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', entry], {
      cwd: f.second,
      env: { ...jobEnv(f.second), CI_HOST_RUNNER: '1' },
      encoding: 'utf8',
      timeout: 4000,
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /suite admitted/)
    assert.equal((result.stdout.match(/\[heavy-job\] running /g) ?? []).length, 1)
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

test('host CI worktrees remove abandoned temporary directories after a crashed job', { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const env = { ...jobEnv(f.second), CI_HOST_RUNNER: '1' }
    const crash = spawnSync(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e',
      "console.log('temporary=' + process.env.TMPDIR); setTimeout(() => process.kill(process.ppid, 'SIGKILL'), 100)"],
    { cwd: f.second, env, encoding: 'utf8', timeout: 3000 })
    assert.equal(crash.signal, 'SIGKILL', crash.stderr)
    const abandoned = crash.stdout.split('\n').find(line => line.startsWith('temporary=')).slice('temporary='.length)
    utimesSync(abandoned, new Date(0), new Date(0))
    const state = join(git(f.second, 'rev-parse', '--path-format=absolute', '--git-dir'), 'graphql-heavy-jobs')
    const reservations = readdirSync(join(state, 'running'))
    assert.equal(reservations.length, 1)
    assert.equal(JSON.parse(readFileSync(join(state, 'running', reservations[0]), 'utf8')).phase, 'running')
    const idleNamespace = join(f.home, 'idle-namespace.mjs')
    writeFileSync(idleNamespace, `import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const readDirectory = fs.readdirSync;
      fs.readdirSync = (path, ...args) => path === '/proc' ? [] : readDirectory(path, ...args);
      syncBuiltinESMExports();`)
    const next = spawnSync(process.execPath, ['--import', idleNamespace,
      'scripts/heavy-job.mjs', '--', process.execPath, '-e', 'process.exit(0)'],
      { cwd: f.second, env, encoding: 'utf8', timeout: 3000 })
    assert.equal(next.status, 0, next.stdout + next.stderr)
    assert.equal(existsSync(abandoned), false)
    assert.deepEqual(readdirSync(join(state, 'running')), [])
    assert.deepEqual(readdirSync(join(state, 'queue')), [])
  } finally {
    rmSync(f.home, { recursive: true, force: true })
  }
})

for (const setting of ['1']) test(`slot setting ${setting} keeps single-slot admission`, { timeout: 8000 }, async () => {
  const f = fixture(), jobs = []
  try {
    configureSlots(f, setting)
    const first = heldJob(f, 'first'); jobs.push(first)
    await waitFile(first.started)
    const second = heldJob(f, 'second', f.second); jobs.push(second)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 2)
    await second.queued()
    assert.equal(existsSync(second.started), false)
    first.release()
    assert.equal((await first.exited).code, 0)
    await waitFile(second.started)
    second.release()
    assert.equal((await second.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

for (const setting of ['0', '9', 'garbage']) test(`rejects invalid slot setting ${setting} before entry`, async t => {
  const f = fixture()
  t.after(() => rmSync(f.home, { recursive: true, force: true }))
  configureSlots(f, setting)
  const result = await run(f.first, ['--', process.execPath, '-e', "console.log('entered')"])
  assert.notEqual(result.code, 0)
  assert.match(result.output, /Invalid heavy-job slot count/)
  assert.equal(result.output.includes('entered'), false)
})

test('three slots admit three jobs and preserve FIFO for waiting jobs', { timeout: 12000 }, async () => {
  const f = fixture(), jobs = []
  try {
    configureSlots(f, 3)
    for (let i = 0; i < 3; i++) {
      const job = heldJob(f, `active-${i}`, i % 2 ? f.second : f.first); jobs.push(job)
      await waitFile(job.started)
    }
    assert.equal(readdirSync(join(f.state, 'running')).length, 3)
    for (let i = 3; i < 5; i++) {
      jobs.push(heldJob(f, `waiting-${i}`))
      await waitFor(() => readdirSync(join(f.state, 'queue')).length === i + 1)
    }
    assert.equal(existsSync(jobs[3].started), false)
    assert.equal(existsSync(jobs[4].started), false)
    // Releasing the legacy owner must preserve the other two active records.
    jobs[0].release()
    assert.equal((await jobs[0].exited).code, 0)
    await waitFile(jobs[3].started)
    assert.equal(existsSync(jobs[4].started), false)
    assert.equal(readdirSync(join(f.state, 'running')).length, 3)
    jobs[1].release()
    assert.equal((await jobs[1].exited).code, 0)
    await waitFile(jobs[4].started)
    for (const job of jobs.slice(2)) job.release()
    for (const job of jobs.slice(2)) assert.equal((await job.exited).code, 0)
    assert.deepEqual(readdirSync(join(f.state, 'running')), [])
    assert.equal(existsSync(join(f.state, 'active')), false)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('a live legacy owner consumes one slot; legacy release cannot erase new reservations', { timeout: 12000 }, async () => {
  const f = fixture(), jobs = []
  try {
    copyFileSync(legacySource, join(f.second, 'scripts/heavy-job.mjs'))
    configureSlots(f, 3)
    const old = heldJob(f, 'old', f.second); jobs.push(old)
    await waitFile(old.started)
    const ownerPath = join(f.state, 'active', 'owner.json')
    const original = readFileSync(ownerPath, 'utf8')
    for (let i = 1; i < 3; i++) {
      const job = heldJob(f, `new-${i}`); jobs.push(job)
      await waitFile(job.started)
    }
    assert.equal(readFileSync(ownerPath, 'utf8'), original, 'new jobs must not rewrite legacy ownership')
    assert.equal(readdirSync(join(f.state, 'running')).length, 2)
    const nextOld = heldJob(f, 'next-old', f.second); jobs.push(nextOld)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 4)
    old.release()
    assert.equal((await old.exited).code, 0)
    assert.equal(readdirSync(join(f.state, 'running')).length, 2)
    // A waiting old ticket remains ahead of new tickets even with capacity free.
    const nextNew = heldJob(f, 'next-new'); jobs.push(nextNew)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 4)
    await nextNew.queued()
    // Allow one legacy retry (300 ms) after the original owner exits.
    await new Promise((resolve) => setTimeout(resolve, 310))
    assert.equal(existsSync(nextOld.started), false)
    assert.equal(existsSync(nextNew.started), false)
    for (const job of jobs.slice(1, 3)) job.release()
    for (const job of jobs.slice(1, 3)) assert.equal((await job.exited).code, 0)
    await waitFile(nextOld.started)
    await waitFile(nextNew.started)
    nextOld.release(); nextNew.release()
    assert.equal((await nextOld.exited).code, 0)
    assert.equal((await nextNew.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('old callers wait for all new jobs to drain and old cleanup preserves a live gate', { timeout: 12000 }, async () => {
  const f = fixture(), jobs = []
  try {
    copyFileSync(legacySource, join(f.second, 'scripts/heavy-job.mjs'))
    configureSlots(f, 3)
    for (let i = 0; i < 3; i++) {
      const job = heldJob(f, `new-${i}`); jobs.push(job)
      await waitFile(job.started)
    }
    jobs[0].release()
    assert.equal((await jobs[0].exited).code, 0)
    utimesSync(join(f.state, 'active'), new Date(0), new Date(0))
    const old = heldJob(f, 'old', f.second); jobs.push(old)
    await waitFor(() => readdirSync(join(f.state, 'queue')).length === 3)
    await old.queued()
    assert.equal(existsSync(old.started), false)
    assert.equal(existsSync(join(f.state, 'active')), true)
    for (const job of jobs.slice(1, 3)) job.release()
    for (const job of jobs.slice(1, 3)) assert.equal((await job.exited).code, 0)
    await waitFile(old.started)
    old.release()
    assert.equal((await old.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('multi-slot cleanup reclaims dead owners but preserves foreign and replacement records', { timeout: 8000 }, async () => {
  const f = fixture()
  try {
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? ['99999999'] : actualReaddirSync(path, ...args) }`)
    configureSlots(f, 3)
    const running = join(f.state, 'running')
    mkdirSync(running)
    const base = { common: f.common, pid: 99999999, start: '0', pgid: null, namespace, token: randomUUID() }
    const stale = join(running, '000000000001-stale')
    const foreign = join(running, '000000000002-foreign')
    writeFileSync(stale, JSON.stringify(base))
    const unknown = JSON.stringify({ ...base, namespace: { ...namespace, boot: 'foreign' }, token: randomUUID() })
    writeFileSync(foreign, unknown)
    for (const path of [stale, foreign]) utimesSync(path, new Date(0), new Date(0))
    assert.equal((await run(f.first, ['--', process.execPath, '-e', 'process.exit(0)'])).code, 0)
    assert.equal(existsSync(stale), false)
    assert.equal(readFileSync(foreign, 'utf8'), unknown)
    // Release must never remove a record whose ownership token has changed.
    const job = heldJob(f, 'replacement')
    try {
      await waitFile(job.started)
      const path = readdirSync(running).map((name) => join(running, name)).find((path) => JSON.parse(readFileSync(path, 'utf8')).pid === job.child.pid)
      const replacement = { ...JSON.parse(readFileSync(path, 'utf8')), token: randomUUID() }
      writeFileSync(path, JSON.stringify(replacement))
      job.release()
      assert.equal((await job.exited).code, 0)
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), replacement)
    } finally { await stopJobs([job]) }
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('a crashed running wrapper releases its slot while its detached descendants remain alive', { timeout: 10000 }, async () => {
  const f = fixture(), jobs = []
  try {
    // Model fixture descendants independently of unrelated host processes.
    const visible = join(f.home, 'visible-pids')
    writeFileSync(visible, '[]')
    mockProc(f, `function readFileSync(...args) { return actualReadFileSync(...args) }\nfunction readdirSync(path, ...args) { return path === '/proc' ? JSON.parse(actualReadFileSync(${JSON.stringify(visible)}, 'utf8')) : actualReaddirSync(path, ...args) }`)
    configureSlots(f, 1)
    const crashed = heldJob(f, 'crashed'); jobs.push(crashed)
    await waitFile(crashed.started)
    // The child can start before the wrapper publishes all process-group records.
    await crashed.running()
    crashed.child.kill('SIGKILL')
    await crashed.exited
    const recordPath = join(f.state, 'running', readdirSync(join(f.state, 'running'))[0])
    const crashedOwner = JSON.parse(readFileSync(recordPath, 'utf8'))
    assert.equal(crashedOwner.phase, 'running')
    assert.ok(pidRunning(crashedOwner.pgid))
    utimesSync(recordPath, new Date(0), new Date(0))
    utimesSync(join(f.state, 'active'), new Date(0), new Date(0))
    // Publish descendant visibility before the next scheduler can inspect ownership.
    writeFileSync(visible, JSON.stringify([crashed.child.pid, crashedOwner.pgid].map(String)))
    const next = heldJob(f, 'next'); jobs.push(next)
    await waitFile(next.started)
    assert.equal(existsSync(recordPath), false)
    assert.ok(pidRunning(crashedOwner.pgid))
    crashed.release()
    await waitFor(() => !pidRunning(crashedOwner.pgid))
    next.release()
    assert.equal((await next.exited).code, 0)
  } finally { for (const job of jobs) job.release(); await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('Vitest secondary-slot setup and nested jobs reuse their own token', { timeout: 8000 }, async () => {
  const f = fixture(), jobs = []
  let teardown
  try {
    configureSlots(f, 3)
    const primary = heldJob(f, 'primary'); jobs.push(primary)
    await waitFile(primary.started)
    copyFileSync(hookSource, join(f.first, 'scripts/vitest-heavy-setup.mjs'))
    const { default: setup } = await import(pathToFileURL(join(f.first, 'scripts/vitest-heavy-setup.mjs')).href)
    teardown = await setup()
    const record = readdirSync(join(f.state, 'running')).map((name) => JSON.parse(readFileSync(join(f.state, 'running', name), 'utf8'))).find((record) => record.token === process.env.GRAPHQL_HEAVY_JOB_TOKEN)
    assert.ok(record)
    assert.notEqual(record.pid, primary.child.pid)
    assert.equal(await setup(), undefined, 'nested hook must reuse its own slot')
    const nested = spawn(process.execPath, [join(f.second, 'scripts/heavy-job.mjs'), '--', process.execPath, '-e', 'process.exit(0)'], { cwd: f.second, env: { ...process.env }, stdio: 'pipe' })
    assert.equal(await new Promise((resolve) => nested.once('exit', resolve)), 0)
    assert.equal(readdirSync(join(f.state, 'running')).length, 2)
    await teardown(); teardown = null
    assert.equal(readdirSync(join(f.state, 'running')).length, 1)
  } finally { if (teardown) await teardown(); await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

test('queued callers reread a changed shared slot count without restarting', { timeout: 10000 }, async () => {
  const f = fixture(), jobs = []
  try {
    configureSlots(f, 1)
    const first = heldJob(f, 'first'); jobs.push(first)
    await waitFile(first.started)
    for (let i = 1; i < 3; i++) {
      jobs.push(heldJob(f, `queued-${i}`))
      await waitFor(() => readdirSync(join(f.state, 'queue')).length === i + 1)
    }
    await Promise.all(jobs.slice(1).map(job => job.queued()))
    assert.equal(existsSync(jobs[1].started), false)
    configureSlots(f, 3)
    for (const job of jobs.slice(1)) await waitFile(job.started)
    assert.equal(readdirSync(join(f.state, 'running')).length, 3)
    for (const job of jobs) job.release()
    for (const job of jobs) assert.equal((await job.exited).code, 0)
  } finally { await stopJobs(jobs); rmSync(f.home, { recursive: true, force: true }) }
})

for (const [name, contents] of [
  ['malformed', '{'],
  ['missing namespace', JSON.stringify({ pid: 99999999, start: '0', pgid: null, token: 'unknown' })],
]) test(`new ${name} slot records remain reserved`, { timeout: 6000 }, async () => {
  const f = fixture()
  try {
    const path = join(f.state, 'running', '000000000001-unknown')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
    utimesSync(path, new Date(0), new Date(0))
    const result = await probe(f)
    assert.match(result.output, /queued .*waiting/)
    assert.equal(result.ran, false)
    assert.equal(readFileSync(path, 'utf8'), contents)
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})

test('verification builds execute each time and return machine-readable command results', async () => {
  const f = fixture()
  try {
    for (const path of [
      'scripts/verification-reports.mjs',
      'scripts/integration-capabilities.mjs',
      'apps/worker/src/diagnostics.mjs',
      'packages/contracts/src/verificationEnvironment.mjs',
      'packages/contracts/src/integrationScheduling.mjs',
    ]) {
      const destination = join(f.first, path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(new URL(`../${path}`, import.meta.url), destination)
    }
    const reports = join(f.first, '.logs', 'verification')
    const environment = { ...jobEnv(f.first), FOREMAN_CODE_VERIFICATION_ROOT: f.first,
      FOREMAN_CODE_VERIFICATION_REPORT_DIR: reports, FOREMAN_CODE_VERIFICATION_LOG_BYTES: '8192',
      FOREMAN_CODE_VERIFICATION_REPORT_BYTES: '65536', npm_lifecycle_event: 'build' }
    const script = "const fs = require('fs'); const n = fs.existsSync('count') ? +fs.readFileSync('count') : 0; fs.writeFileSync('count', String(n+1)); fs.mkdirSync('packages/contracts/dist', {recursive:true}); fs.writeFileSync('packages/contracts/dist/index.js', 'export {}');"
    const argumentsList = ['--build', 'contracts', '--', process.execPath, '-e', script]
    assert.equal((await run(f.first, argumentsList)).code, 0)
    const cached = await run(f.first, argumentsList)
    assert.equal(cached.code, 0, cached.output)
    assert.match(cached.output, /build is current/)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await new Promise((done) => {
        const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--build', 'contracts', '--',
          process.execPath, '-e', script], { cwd: f.first, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
        let output = ''
        child.stdout.on('data', (chunk) => { output += chunk })
        child.stderr.on('data', (chunk) => { output += chunk })
        child.once('exit', (code) => done({ code, output }))
      })
      assert.equal(result.code, 0, result.output)
      const receipt = JSON.parse(readFileSync(join(reports, 'parts', 'root_build.command.json'), 'utf8'))
      assert.equal(receipt.key, 'root:build')
      assert.equal(receipt.code, 0)
      assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt))
      // Each invocation is a separate command execution, with a fresh report destination.
      rmSync(reports, { recursive: true, force: true })
    }
    assert.equal(readFileSync(join(f.first, 'count'), 'utf8'), '3')
  } finally { rmSync(f.home, { recursive: true, force: true }) }
})
