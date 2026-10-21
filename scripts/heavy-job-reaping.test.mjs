import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const namespace = {
  boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  pid: readlinkSync('/proc/self/ns/pid'),
}
const startTime = pid => {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  return stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
}
function fixture(t, pathKind = 'direct') {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(base, { recursive: true })
  const directory = mkdtempSync(join(base, 'heavy-reaping-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = pathKind === 'symlinked' ? join(directory, 'checkout-link') : directory
  if (pathKind === 'symlinked') {
    mkdirSync(join(directory, 'checkout'))
    symlinkSync('checkout', root)
  }
  mkdirSync(join(root, 'scripts'))
  mkdirSync(join(root, 'packages/contracts/src'), { recursive: true })
  for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs']) {
    copyFileSync(new URL(name, import.meta.url), join(root, 'scripts', name))
  }
  copyFileSync(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url),
    join(root, 'packages/contracts/src/productEnvironment.mjs'))
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0)
  const common = realpathSync(join(root, '.git'))
  const state = join(common, 'graphql-heavy-jobs')
  for (const folder of ['queue', 'running']) mkdirSync(join(state, folder), { recursive: true })
  const env = { ...process.env, TMPDIR: base, FOREMAN_CODE_HEAVY_BASE_TMPDIR: root }
  for (const key of ['FOREMAN_CODE_HEAVY_JOB_TOKEN', 'FOREMAN_CODE_HEAVY_JOB_COMMON',
    'GRAPHQL_HEAVY_JOB_TOKEN', 'GRAPHQL_HEAVY_JOB_COMMON', 'CI_HOST_RUNNER', 'NODE_OPTIONS']) delete env[key]
  const record = overrides => ({ common, pid: process.pid, start: startTime(process.pid),
    worktree: root, pgid: null, phase: 'running', namespace, token: 'occupied', ...overrides })
  const occupy = value => {
    mkdirSync(join(state, 'active'), { recursive: true })
    for (const path of ['queue/0001-occupied', 'running/0001-occupied', 'active/owner.json']) {
      writeFileSync(join(state, path), JSON.stringify(value))
    }
  }
  const hook = body => {
    const path = join(root, 'hook.mjs')
    writeFileSync(path, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';\n${body}\nsyncBuiltinESMExports()\n`)
    env.NODE_OPTIONS = `--import=${path}`
  }
  const run = () => spawnSync(process.execPath,
    ['scripts/heavy-job.mjs', '--', process.execPath, '-e', 'console.log("replacement admitted")'],
    { cwd: root, env, encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' })
  return { root, common, state, env, record, occupy, hook, run }
}

test('reaps an empty active directory older than the ownership grace and admits the next job', t => {
  const f = fixture(t)
  const active = join(f.state, 'active')
  mkdirSync(active)
  const earlier = new Date(Date.now() - 20_000)
  utimesSync(active, earlier, earlier)

  const result = f.run()
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.match(result.stdout, /replacement admitted/)
  assert.equal(existsSync(active), false, 'the replacement did not release its active directory')
})

test('waits for a fresh empty active directory within the ownership grace', t => {
  const f = fixture(t)
  const active = join(f.state, 'active')
  mkdirSync(active)

  const result = f.run()
  assert.equal(result.error?.code, 'ETIMEDOUT', result.stderr)
  assert.match(result.stdout, /waiting for project test\/build slot/)
  assert.doesNotMatch(result.stdout, /replacement admitted/)
  assert.equal(existsSync(active), true)
  assert.deepEqual(readdirSync(active), [])
})

test('preserves a readable legacy owner after the ownership grace', t => {
  const f = fixture(t)
  const active = join(f.state, 'active')
  mkdirSync(active)
  const owner = { common: f.common, pid: process.pid, token: 'legacy-owner' }
  writeFileSync(join(active, 'owner.json'), JSON.stringify(owner))
  const earlier = new Date(Date.now() - 20_000)
  utimesSync(active, earlier, earlier)

  const result = f.run()
  assert.equal(result.error?.code, 'ETIMEDOUT', result.stderr)
  assert.match(result.stdout, /waiting for project test\/build slot/)
  assert.doesNotMatch(result.stdout, /replacement admitted/)
  assert.deepEqual(JSON.parse(readFileSync(join(active, 'owner.json'), 'utf8')), owner)
})

test('release removes the active directory and allows another job to run', t => {
  const f = fixture(t)
  for (let job = 0; job < 2; job++) {
    const result = f.run()
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.match(result.stdout, /replacement admitted/)
    assert.equal(existsSync(join(f.state, 'active')), false)
    for (const folder of ['queue', 'running']) assert.deepEqual(readdirSync(join(f.state, folder)), [])
  }
})

for (const slots of ['active only', 'running and active']) {
  test(`reaps a previous boot's held slot and admits the next job (${slots})`, t => {
    const f = fixture(t)
    const boot = randomUUID()
    assert.notEqual(boot, namespace.boot)
    // A PID and start time can be reused across boots, even for a live process.
    f.occupy(f.record({ namespace: { ...namespace, boot } }))
    if (slots === 'active only') rmSync(join(f.state, 'running/0001-occupied'))

    const result = f.run()
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.match(result.stdout, /replacement admitted/)
    for (const path of ['running/0001-occupied', 'queue/0001-occupied', 'active']) {
      assert.equal(existsSync(join(f.state, path)), false, `${path} was not released`)
    }
  })
}

for (const pathKind of ['direct', 'symlinked']) {
  for (const owner of ['gone', 'reused']) {
    test(`immediately reaps a ${owner} running owner despite unreadable process usage (${pathKind} checkout)`, t => {
      const f = fixture(t, pathKind)
      const pid = owner === 'gone' ? 999999999 : process.pid
      f.occupy(f.record({ pid, start: '0', pgid: owner === 'gone' ? null : process.pid }))
      if (owner === 'reused') {
        const earlier = new Date(Date.now() - 19 * 60 * 60_000)
        for (const path of ['running/0001-occupied', 'active', 'queue/0001-occupied']) {
          utimesSync(join(f.state, path), earlier, earlier)
        }
      }
      f.hook(`
const read = fs.readFileSync, list = fs.readdirSync
fs.readdirSync = (path, ...args) => path === '/proc' ? ['999999998'] : list(path, ...args)
fs.readFileSync = (path, ...args) => {
  if (String(path).startsWith('/proc/999999998/')) throw Object.assign(new Error('denied'), { code: 'EACCES' })
  return read(path, ...args)
}`)
      const result = f.run()
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      assert.match(result.stdout, /replacement admitted/)
      assert.equal(existsSync(join(f.state, 'running/0001-occupied')), false)
      assert.equal(existsSync(join(f.state, 'queue/0001-occupied')), false)
    })
  }

  test(`reaps a deleted worktree and kills its TERM-ignoring process group after a short grace (${pathKind} checkout)`, async t => {
    const f = fixture(t, pathKind)
    const worktree = join(f.root, 'removed-checkout')
    mkdirSync(worktree)
    const childScript = `process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)`
    const script = `
const { spawn } = require('node:child_process')
process.on('SIGTERM', () => {})
const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
child.once('message', () => console.log(child.pid))
setInterval(() => {}, 1000)
`
    const child = spawn(process.execPath, ['-e', script], { cwd: worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    t.after(async () => {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
      await exited
    })
    const [data] = await once(child.stdout, 'data')
    const descendant = Number(String(data).trim())
    rmSync(worktree, { recursive: true })
    f.occupy(f.record({ worktree, pgid: child.pid }))
    const result = f.run()
    assert.equal(result.status, 0, result.stderr || result.error?.message)
    assert.equal((await exited)[1], 'SIGKILL')
    let state = 'gone'
    try {
      const stat = readFileSync(`/proc/${descendant}/stat`, 'utf8')
      state = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0]
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    assert.ok(['gone', 'Z'].includes(state), `descendant remains ${state}`)
  })
}

test('ignores foreign and protected process environments without degrading token inspection', t => {
  const f = fixture(t)
  f.hook(`
const read = fs.readFileSync, list = fs.readdirSync, stat = fs.statSync
fs.readdirSync = (path, ...args) => path === '/proc' ? ['999999998', '999999997'] : list(path, ...args)
fs.statSync = (path, ...args) => /^\\/proc\\/99999999[78](?:\\/environ)?$/.test(String(path))
  ? { uid: process.geteuid() + Number(String(path) !== '/proc/999999997') } : stat(path, ...args)
fs.readFileSync = (path, ...args) => {
  if (/^\\/proc\\/99999999[78]\\/environ$/.test(String(path))) {
    throw Object.assign(new Error('foreign or non-dumpable environment'), { code: 'EACCES' })
  }
  return read(path, ...args)
}`)
  const result = spawnSync(process.execPath, ['scripts/heavy-job.mjs', '__hold'],
    { cwd: f.root, env: { ...f.env, FOREMAN_CODE_HEAVY_JOB_TOKEN: 'finished' },
      input: '', encoding: 'utf8', timeout: 3000 })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(result.stderr, /degraded|EACCES/)
})

test('publishes complete scheduler JSON while other processes read during writes', t => {
  const f = fixture(t)
  const failures = join(f.root, 'invalid-snapshots')
  const observer = `
const fs = require('node:fs'), path = require('node:path')
const state = ${JSON.stringify(f.state)}
for (const folder of ['queue', 'running', 'active']) {
  if (!fs.existsSync(path.join(state, folder))) continue
  for (const name of fs.readdirSync(path.join(state, folder))) {
    if (name.startsWith('.')) continue
    try { JSON.parse(fs.readFileSync(path.join(state, folder, name), 'utf8')) }
    catch (error) { if (error instanceof SyntaxError) fs.appendFileSync(${JSON.stringify(failures)}, 'invalid\\n') }
  }
}
`
  f.hook(`
import { spawnSync } from 'node:child_process'
const write = fs.writeFileSync
fs.writeFileSync = (path, data, ...args) => {
  if (typeof data === 'string' && data.startsWith('{') && String(path).includes('graphql-heavy-jobs')) {
    write(path, '', ...args)
    const result = spawnSync(process.execPath, ['-e', ${JSON.stringify(observer)}],
      { env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  return write(path, data, ...args)
}`)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  assert.equal(existsSync(failures), false, 'a reader observed truncated scheduler JSON')
})

test('a caller waiting over sixty seconds logs the pid, worktree and age of slot holders', async t => {
  const f = fixture(t)
  f.occupy(f.record({ startedAt: Date.now() - 19 * 60 * 60_000 }))
  f.hook(`const now = Date.now, begin = now(); Date.now = () => now() + (now() - begin > 700 ? 61_000 : 0)`)
  const child = spawn(process.execPath, ['scripts/heavy-job.mjs', '--', process.execPath, '-e', 'process.exit(0)'],
    { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  t.after(async () => { child.kill('SIGTERM'); await exited })
  let output = ''
  child.stderr.on('data', data => { output += data })
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2500)
    child.stderr.on('data', () => {
      if (output.includes('"holders"')) { clearTimeout(timer); resolve() }
    })
  })
  const diagnostic = output.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line) } catch { return null /* ignore: other stderr is not structured diagnostics. */ }
  }).find(value => value?.holders)
  assert.ok(diagnostic, `missing slot holder diagnostic: ${output}`)
  assert.ok(diagnostic.waitedMs >= 60_000)
  assert.equal(diagnostic.holders[0].pid, process.pid)
  assert.equal(diagnostic.holders[0].worktree, f.root)
  assert.ok(diagnostic.holders[0].ageMs >= 19 * 60 * 60_000)
})
