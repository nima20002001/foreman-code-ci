import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

const fixtures: { root: string; runner: HostCiRunner }[] = []
afterEach(async () => {
  for (const { root, runner } of fixtures.splice(0)) {
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
  }
})

async function computer(stall?: 'fetch' | 'checkout') {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-prewarm-'))
  const pidFile = join(root, 'preparation-pid')
  const childPidFile = join(root, 'transport-pid')
  const units = new Set<string>()
  const launches: string[] = []
  const system = systemHostCiPorts()
  const transport = `
    process.on('SIGTERM', () => {})
    require('node:fs').writeFileSync(process.argv[1], String(process.pid))
    setInterval(() => {}, 1000)
  `
  let stalled = false
  const ports: HostCiPorts = {
    cpus: 16, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args, options) => {
      if (file === 'git' && args.includes('rev-list')) return { code: 1, stdout: '', stderr: '' }
      const fetching = file === 'git' && args.includes('fetch')
      const checkingOut = file === 'git' && args.includes('worktree') && args.includes('add')
      if (!stalled && (stall === 'fetch' && fetching || stall === 'checkout' && checkingOut)) {
        stalled = true
        return system.run(process.execPath, ['-e', `
          process.on('SIGTERM', () => {})
          require('node:child_process').spawn(process.execPath,
            ['-e', ${JSON.stringify(transport)}, process.argv[2]], { stdio: 'inherit' })
          require('node:fs').writeFileSync(process.argv[1], String(process.pid))
          setInterval(() => {}, 1000)
        `, pidFile, childPidFile], { ...options, timeoutMs: 10_000 })
      }
      if (checkingOut) {
        const source = args.at(-2)!
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
      }
      if (file === 'systemd-run') {
        const unit = args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length)
        launches.push(unit)
        units.add(unit)
      }
      if (file === 'systemctl' && args.includes('show')) {
        const stdout = args.filter(arg => arg.endsWith('.service')).map(unit => {
          const state = units.has(unit.replace(/\.service$/, '')) ? 'active' : 'inactive'
          return `Id=${unit}\nLoadState=loaded\nActiveState=${state}\n`
        }).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      if (file === 'systemctl') {
        const unit = args.at(-1)!.replace(/\.service$/, '')
        if (args.includes('stop')) units.delete(unit)
        return { code: 0, stdout: units.has(unit) ? 'active' : 'inactive', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const runner = new HostCiRunner(root, ports, {})
  fixtures.push({ root, runner })
  const request = { operation: 'start', runId: randomUUID(), repository: 'example/project', commit: 'a'.repeat(40),
    suite: 'install', scope: 'full', warmup: true }
  return { root, runner, ports, request, launches, pidFile, childPidFile }
}

it('removes warmups rejected when memory drops after reservation, including retries with new IDs', async () => {
  const f = await computer()
  let memory = f.ports.memoryBytes
  f.ports.availableMemoryBytes = () => memory
  const command = f.ports.run
  f.ports.run = async (file, args, options) => {
    if (file === 'git' && args.includes('fetch')) memory = 1
    return command(file, args, options)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    memory = f.ports.memoryBytes
    const runId = randomUUID()
    await expect(f.runner.handle({ ...f.request, runId })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    await expect(f.runner.handle({ operation: 'status' })).resolves.toMatchObject({ slotsUsed: 0, runs: [] })
    await expect(f.runner.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 }))
      .rejects.toMatchObject({ code: 'CI_RUN_UNKNOWN' })
    expect(existsSync(join(f.root, 'runs', runId))).toBe(false)
  }
  expect(f.launches).toEqual([])
})

it.each(['fetch', 'checkout'] as const)('reaps a stalled warmup %s before starting real CI', async stall => {
  const f = await computer(stall)
  const warmup = f.runner.handle(f.request)
  let real: ReturnType<HostCiRunner['handle']> | undefined
  let pid: number | undefined
  let childPid: number | undefined
  try {
    await vi.waitFor(() => expect(existsSync(f.pidFile)).toBe(true))
    pid = Number(await readFile(f.pidFile, 'utf8'))
    await vi.waitFor(() => expect(existsSync(f.childPidFile)).toBe(true))
    childPid = Number(await readFile(f.childPidFile, 'utf8'))
    const runId = randomUUID()
    real = f.runner.handle({ ...f.request, runId, suite: 'lint', warmup: false })
    await vi.waitFor(() => expect(f.launches).toEqual([`foreman-ci-${runId}`]), { timeout: 1500 })
    expect(() => process.kill(pid!, 0)).toThrow()
    await warmup
    await expect(f.runner.handle({ operation: 'read', runId: f.request.runId, afterOffset: 0, maxBytes: 100 }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
    await expect(real).resolves.toMatchObject({ run: { runId } })
  } finally {
    for (const processId of [pid, childPid]) {
      if (processId === undefined) continue
      try { process.kill(processId, 'SIGKILL') }
      catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe('ESRCH')
      }
    }
    await Promise.all([warmup, real])
  }
})

it.each(['passed', 'failed', 'canceled', 'lost'])(
  'removes a terminal %s warmup directory on status without deleting its persistent checkout', async state => {
    const f = await computer()
    const directory = join(f.root, 'runs', f.request.runId)
    const source = join(f.root, 'slots', f.request.repository, '0', 'src')
    await mkdir(directory, { recursive: true })
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), '{}')
    await writeFile(join(directory, 'meta.json'), JSON.stringify({ ...f.request,
      partition: null, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z',
      state, exitCode: state === 'passed' ? 0 : 1, message: null, cleaned: false, slot: 0 }))
    await writeFile(join(directory, 'log'), 'warmup output')
    await writeFile(join(directory, 'step'), 'install')
    await expect(f.runner.handle({ operation: 'status' })).resolves.toMatchObject({ slotsUsed: 0, runs: [] })
    expect(existsSync(directory)).toBe(false)
    expect(await readFile(join(source, 'package.json'), 'utf8')).toBe('{}')
  },
)

it('removes a preempted warmup directory while retaining the real run and its shared checkout', async () => {
  const f = await computer()
  await f.runner.handle(f.request)
  await vi.waitFor(() => expect(f.launches).toHaveLength(1))
  const runId = randomUUID()
  await f.runner.handle({ ...f.request, runId, suite: 'lint', warmup: false })
  await vi.waitFor(() => expect(f.launches).toHaveLength(2))
  await expect(f.runner.handle({ operation: 'status' }))
    .resolves.toMatchObject({ runs: [expect.objectContaining({ runId, state: 'running' })] })
  expect(existsSync(join(f.root, 'runs', f.request.runId))).toBe(false)
  expect(existsSync(join(f.root, 'runs', runId))).toBe(true)
  expect(existsSync(join(f.root, 'slots', f.request.repository, '0', 'src', 'package.json'))).toBe(true)
})


it.each(['fetch', 'checkout'] as const)('cancels a stalled real CI %s and frees preparation for the next ticket', async stall => {
  const f = await computer(stall)
  const first = f.runner.handle({ ...f.request, warmup: false, suite: 'lint' })
  let next: ReturnType<HostCiRunner['handle']> | undefined
  let cancel: ReturnType<HostCiRunner['handle']> | undefined
  let pid: number | undefined
  let childPid: number | undefined
  try {
    await vi.waitFor(() => expect(existsSync(f.pidFile)).toBe(true))
    pid = Number(await readFile(f.pidFile, 'utf8'))
    await vi.waitFor(() => expect(existsSync(f.childPidFile)).toBe(true))
    childPid = Number(await readFile(f.childPidFile, 'utf8'))
    cancel = f.runner.handle({ operation: 'cancel', runId: f.request.runId })
    const runId = randomUUID()
    next = f.runner.handle({ ...f.request, runId, warmup: false, suite: 'lint' })
    await vi.waitFor(() => expect(f.launches).toEqual([`foreman-ci-${runId}`]), { timeout: 1500 })
    expect(() => process.kill(pid!, 0)).toThrow()
    // Acknowledgement can precede process closure; the read below checks final cancellation after it closes.
    await expect(cancel).resolves.toMatchObject({ operation: 'cancel', run: { runId: f.request.runId } })
    await first
    await expect(f.runner.handle({ operation: 'read', runId: f.request.runId, afterOffset: 0, maxBytes: 100 }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
    await expect(next).resolves.toMatchObject({ run: { runId } })
    await expect(f.runner.status()).resolves.toMatchObject({ slotsUsed: 1,
      runs: expect.arrayContaining([expect.objectContaining({ runId: f.request.runId, state: 'canceled' })]) })
  } finally {
    for (const processId of [pid, childPid]) {
      if (processId === undefined) continue
      try { process.kill(processId, 'SIGKILL') }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH') }
    }
    await Promise.all([first, next, cancel])
  }
})
