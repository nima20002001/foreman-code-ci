import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { retainedHeavyJobTokens } from './heavy-job-slots.mjs'

test('reserves unresolved acquired work without blocking the remaining queued tickets', () => {
  const slots = [{ token: 'first' }, { token: 'second' }]
  const tickets = [{ token: 'retained', phase: 'running', pgid: 100 },
    ...slots.map(slot => ({ ...slot, phase: 'running' })), { token: 'waiting', phase: 'queued', pgid: null }]
  const retained = retainedHeavyJobTokens(tickets, slots, { multiSlotGate: true })
  assert.deepEqual([...retained], ['retained'])
  assert.equal(slots.length + retained.size, 3)
  assert.equal(retained.has('waiting'), false)
})

test('does not count a legacy owner or registered ticket twice', () => {
  const tickets = [{ token: 'legacy', phase: 'running' }, { token: 'registered', phase: 'acquiring' },
    { token: 'unknown', phase: 'acquiring' }, { token: 'unknown', phase: 'running' }]
  assert.deepEqual([...retainedHeavyJobTokens(tickets, [{ token: 'registered' }], { token: 'legacy' })], ['unknown'])
})

test('retains prior unphased process groups and excludes never-launched coordinators', () => {
  const tickets = [{ token: 'prior', pgid: 100 }, { token: 'waiting', pgid: null },
    { token: 'queued', phase: 'queued', pgid: null }, null]
  assert.deepEqual([...retainedHeavyJobTokens(tickets, [], undefined)], ['prior'])
})

test('repairs a lost reservation, admits the next coordinator and keeps its original child alive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'heavy-retained-slot-'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  const exited = once(child, 'exit')
  try {
    await once(child, 'spawn')
    execFileSync('git', ['init', '-q', root])
    await mkdir(join(root, 'scripts'))
    await mkdir(join(root, 'packages', 'contracts', 'src'), { recursive: true })
    for (const name of ['heavy-job.mjs', 'heavy-job-slots.mjs', 'sleep.mjs']) {
      await cp(new URL(name, import.meta.url), join(root, 'scripts', name))
    }
    await cp(new URL('../packages/contracts/src/productEnvironment.mjs', import.meta.url),
      join(root, 'packages', 'contracts', 'src', 'productEnvironment.mjs'))
    const common = join(root, '.git')
    const state = join(common, 'graphql-heavy-jobs')
    await mkdir(join(state, 'queue'), { recursive: true })
    await mkdir(join(state, 'running'))
    await writeFile(join(state, 'slots'), '2')
    const retained = { common, pid: 999999999, start: '0', pgid: child.pid, phase: 'running', token: 'retained-child' }
    const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8')
    const start = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]
    const waiting = { common, pid: process.pid, start, pgid: null, phase: 'queued', token: 'waiting' }
    await writeFile(join(state, 'queue', '0001-retained'), JSON.stringify(retained))
    await writeFile(join(state, 'queue', '0002-waiting'), JSON.stringify(waiting))
    const output = execFileSync(process.execPath, ['scripts/heavy-job.mjs', '__schedule', 'admit', '0002-waiting', 'waiting'],
      { cwd: root, encoding: 'utf8', timeout: 10000 })
    assert.equal(output, 'admitted')
    assert.deepEqual((await readdir(join(state, 'running'))).sort(), ['0001-retained', '0002-waiting'])
    assert.deepEqual(JSON.parse(await readFile(join(state, 'running', '0001-retained'), 'utf8')), retained)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    child.kill('SIGTERM')
    await exited
    await rm(root, { recursive: true, force: true })
  }
})
