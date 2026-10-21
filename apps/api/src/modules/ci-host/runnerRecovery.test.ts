import { randomUUID } from 'node:crypto'
import { CI_HOST_START_PROTOCOL_VERSION } from '@foreman-code/contracts'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { readOperationalFailures } from '../diagnostics/logger.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const writes = vi.hoisted(() => ({ running: undefined as (() => Promise<void>) | undefined }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (typeof args[1] === 'string' && args[1].startsWith('{') && JSON.parse(args[1]).state === 'running') {
      const running = writes.running
      writes.running = undefined
      await running?.()
    }
    return actual.writeFile(...args)
  } }
})

const roots: string[] = []
afterEach(async () => {
  writes.running = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(options: { launch?: () => Promise<void> } = {}) {
  const root = await privateFixtureDirectory('host-ci-recovery-')
  roots.push(root)
  const control = { state: 'active', code: 0, stopCode: 0, launches: 0 }
  const ports: HostCiPorts = {
    cpus: 8, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        await mkdir(args.at(-2)!, { recursive: true })
        await writeFile(join(args.at(-2)!, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
      }
      if (file === 'systemd-run') {
        control.launches++
        await options.launch?.()
      }
      if (file === 'systemctl' && args.includes('stop')) {
        if (control.stopCode === 0) control.state = 'inactive'
        return { code: control.stopCode, stdout: '', stderr: control.stopCode ? 'Manager unavailable' : '' }
      }
      if (file === 'systemctl') {
        const stdout = args.filter(arg => arg.endsWith('.service'))
          .map(unit => `Id=${unit}\nLoadState=loaded\nActiveState=${control.state}\n`).join('\n')
        return { code: control.code, stdout, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const runner = new HostCiRunner(root, ports, {})
  const request = { operation: 'start', runId: randomUUID(), repository: 'fixture/site',
    commit: 'a'.repeat(40), suite: 'lint', scope: 'full' }
  const read = { operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 100 }
  // The run's persistent slot checkout.
  const source = join(root, 'slots', 'fixture', 'site', '0', 'src')
  return { root, ports, runner, control, request, read, source }
}

it('retains a Stop received before Start across a runner restart without launching', async () => {
  const f = await fixture()
  await expect(f.runner.handle({ operation: 'cancel', runId: f.request.runId }))
    .resolves.toMatchObject({ operation: 'cancel', run: { state: 'canceled', runId: f.request.runId } })
  const restarted = new HostCiRunner(f.root, f.ports, {})
  await expect(restarted.handle(f.request))
    .resolves.toMatchObject({ operation: 'start', run: { state: 'canceled', runId: f.request.runId } })
  await expect(restarted.handle(f.read)).resolves.toMatchObject({ run: { state: 'canceled' } })
  expect(f.control.launches).toBe(0)
})

it('accepts start metadata from newer Main releases while still validating known fields', async () => {
  const f = await fixture()
  await expect(f.runner.handle({ ...f.request, workspaceId: 'fixture-workspace', ciMirror: 'fixture/mirror',
    futureOptionalHint: { enabled: true } })).resolves.toMatchObject({ operation: 'start', run: { runId: f.request.runId } })
  await vi.waitFor(async () => {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
  })
  await expect(f.runner.handle({ ...f.request, runId: randomUUID(), commit: 'invalid' })).rejects.toThrow()
  await f.runner.cancel(f.request.runId)
})

it('reserves admissions for startup smoke and resumes them after validation', async () => {
  const f = await fixture()
  let pending = true
  const runner = new HostCiRunner(f.root, f.ports, {}, () => pending)
  await expect(runner.handle({ operation: 'status' })).resolves.toMatchObject({ ready: false,
    reasons: ['Worker update CI smoke is pending; this computer is reserved for validation.'] })
  await expect(runner.handle(f.request)).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
  expect(f.control.launches).toBe(0)
  pending = false
  await expect(runner.handle({ operation: 'status' })).resolves.toMatchObject({ ready: true,
    startProtocolVersion: CI_HOST_START_PROTOCOL_VERSION })
  await expect(runner.handle(f.request)).resolves.toMatchObject({ operation: 'start' })
  await vi.waitFor(async () => {
    await expect(runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
  })
  await runner.cancel(f.request.runId)
})

it.each(['before', 'after'] as const)(
  'recovers the original service after restart between native entry and the running metadata write (exit %s write)',
  async completion => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const paused = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  writes.running = async () => { entered(); await gate }
  const complete = async () => {
    await writeFile(join(f.root, 'runs', f.request.runId, 'log'), 'Completed lint')
    await writeFile(join(f.root, 'runs', f.request.runId, 'exit'), '0\n')
  }
  try {
    await f.runner.handle(f.request)
    await paused
    const recovered = new HostCiRunner(f.root, f.ports, {})
    await expect(recovered.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
    await expect(access(f.source)).resolves.toBeUndefined()
    await expect(recovered.handle(f.request)).resolves.toMatchObject({ run: { state: 'running' } })
    expect(f.control.launches).toBe(1)
    if (completion === 'before') await complete()
    expect(f.runner.isUpdateIdle()).toBe(false)
    await expect(recovered.handle(f.read)).resolves.toMatchObject({
      run: { state: 'running', exitCode: null },
    })
    release()
    // A running read can come from the service marker while launch still holds the metadata lock.
    await f.runner.beginDrain()
    expect(f.runner.isUpdateIdle()).toBe(true)
    if (completion === 'after') {
      await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
      await complete()
    }
    await expect(recovered.handle(f.read)).resolves.toMatchObject({ run: { state: 'passed', exitCode: 0 } })
    await expect(new HostCiRunner(f.root, f.ports, {}).handle(f.read))
      .resolves.toMatchObject({ run: { state: 'passed', exitCode: 0 } })
    expect(f.control.launches).toBe(1)
  } finally {
    writes.running = undefined
    release()
    await f.runner.beginDrain()
    const reply = await f.runner.handle(f.read)
    expect('run' in reply && reply.run.state).not.toBe('starting')
  }
})

it.each([
  { state: '', code: 1 },
  { state: 'deactivating', code: 3 },
  { state: 'inactive', code: 1 },
])('retains the run and source when service status is unresolved: $state/$code', async control => {
  const f = await fixture()
  await f.runner.handle(f.request)
  await vi.waitFor(async () => {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
  })
  Object.assign(f.control, control)
  await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
  await expect(access(f.source)).resolves.toBeUndefined()
  await expect(f.runner.status()).resolves.toMatchObject({ slotsUsed: 1 })
})

it.each([
  { state: '', code: 1 },
  { state: 'deactivating', code: 3 },
  { state: 'inactive', code: 1 },
])('keeps an observed running state during a slow launch with unresolved status: $state/$code', async control => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({ launch: async () => {
    entered.resolve()
    await release.promise
  } })
  try {
    await f.runner.handle(f.request)
    await entered.promise
    expect(f.runner.isUpdateIdle()).toBe(false)
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
    Object.assign(f.control, control)
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
    const recovered = new HostCiRunner(f.root, f.ports, {})
    await expect(recovered.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
    await expect(access(f.source)).resolves.toBeUndefined()
    await expect(recovered.status()).resolves.toMatchObject({ slotsUsed: 1 })
    expect(f.control.launches).toBe(1)
  } finally {
    release.resolve()
    await f.runner.beginDrain()
  }
  await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
})

it('records a background launch failure when its run directory disappears without rejecting drain', async () => {
  const entered = deferred()
  const release = deferred()
  const f = await fixture({ launch: async () => {
    entered.resolve()
    await release.promise
  } })
  try {
    await f.runner.handle(f.request)
    await entered.promise
    await rm(join(f.root, 'runs', f.request.runId), { recursive: true })
    const drained = f.runner.beginDrain()
    release.resolve()
    await expect(drained).resolves.toBeUndefined()
    expect(f.runner.isUpdateIdle()).toBe(true)
    await expect(f.runner.handle(f.read)).rejects.toMatchObject({ code: 'CI_RUN_UNKNOWN' })
    expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
      component: 'jobs', operation: 'record CI launch failure', lastError: 'CI_RUN_UNKNOWN',
    }))
  } finally {
    release.resolve()
    await f.runner.beginDrain()
  }
})

it('persists failed cancellation, retains capacity after restart and retries before releasing the slot', async () => {
  const f = await fixture()
  await f.runner.handle(f.request)
  await vi.waitFor(async () => {
    await expect(f.runner.handle(f.read)).resolves.toMatchObject({ run: { state: 'running' } })
  })
  f.control.stopCode = 1
  await expect(f.runner.handle({ operation: 'cancel', runId: f.request.runId }))
    .resolves.toMatchObject({ run: { state: 'running', finishedAt: null } })
  await expect(readFile(join(f.source, 'package.json'), 'utf8')).resolves.toContain('fixture')
  const recovered = new HostCiRunner(f.root, f.ports, {})
  await expect(recovered.status()).resolves.toMatchObject({ slotsUsed: 1 })
  await expect(recovered.handle({ ...f.request, runId: randomUUID() }))
    .rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
  f.control.stopCode = 0
  await expect(recovered.handle(f.read)).resolves.toMatchObject({ run: { state: 'canceled' } })
  await expect(recovered.status()).resolves.toMatchObject({ slotsUsed: 0 })
  // The released slot keeps its checkout for the next part.
  await expect(readFile(join(f.source, 'package.json'), 'utf8')).resolves.toContain('fixture')
})
