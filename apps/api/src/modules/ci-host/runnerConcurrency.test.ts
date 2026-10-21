import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostCiRunner, type HostCiPorts } from './runner.js'

const writes = vi.hoisted(() => ({ duringRunningWrite: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    const [path, data, options] = args
    if (writes.duringRunningWrite && typeof data === 'string' && data.startsWith('{')
      && (JSON.parse(data) as { state?: string }).state === 'running') {
      // Pause after opening/truncating the destination, before its JSON bytes are written.
      await actual.writeFile(path, '', options)
      await writes.duringRunningWrite()
      return actual.writeFile(path, data, { mode: 0o600 })
    }
    return actual.writeFile(...args)
  } }
})

function barrier() {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { entered, release, pause: async () => {
    enter()
    await released
  } }
}

const fixtures: { root: string; runner: HostCiRunner }[] = []
afterEach(async () => {
  writes.duringRunningWrite = null
  for (const { root, runner } of fixtures.splice(0)) {
    await vi.waitFor(async () => {
      const status = await runner.status()
      if (status.operation !== 'status' || status.runs.some(run => run.state === 'starting')) {
        throw new Error('The launch has not finished.')
      }
      for (const run of status.runs) {
        if (run.state === 'running') await runner.cancel(run.runId)
      }
    }, { interval: 5, timeout: 10_000 })
    await rm(root, { recursive: true, force: true })
  }
})

async function computer(beforeGithub?: () => Promise<void>, cpuCount = 8, isolatedDatabase = false,
  beforeCheckout?: () => Promise<void>, beforeFetch?: () => Promise<void>) {
  const directory = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(directory, { recursive: true })
  const root = await mkdtemp(join(directory, 'host-ci-concurrency-'))
  const launches: { args: readonly string[] }[] = []
  const activeUnits = new Set<string>()
  const ports: HostCiPorts = { cpus: cpuCount, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'gh') await beforeGithub?.()
      if (file === 'git' && args.includes('rev-list') && beforeFetch) {
        return { code: 1, stdout: '', stderr: 'Commit not fetched' }
      }
      if (file === 'git' && args.includes('fetch')) await beforeFetch?.()
      if (file === 'git' && args.includes('show')) {
        return { code: 0, stdout: JSON.stringify({ foremanCi: { hostSlots: isolatedDatabase ? 1 : 0 } }), stderr: '' }
      }
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        await beforeCheckout?.()
        const source = args.at(-2)!
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), JSON.stringify({
          scripts: { lint: 'fixture', unit: 'fixture', integration: 'fixture' },
        }))
      }
      if (file === 'systemd-run') {
        launches.push({ args })
        activeUnits.add(args.find(arg => arg.startsWith('--unit='))!.slice('--unit='.length))
      }
      if (file === 'systemctl') {
        const unit = args.at(-1)!.replace('.service', '')
        if (args.includes('stop')) activeUnits.delete(unit)
        const stdout = args.filter(arg => arg.endsWith('.service')).map(service => {
          const state = activeUnits.has(service.replace('.service', '')) ? 'active' : 'inactive'
          return `Id=${service}\nLoadState=loaded\nActiveState=${state}\n`
        }).join('\n')
        return { code: 0, stdout, stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports)
  fixtures.push({ root, runner })
  const request = { operation: 'start', runId: randomUUID(), repository: 'octo/site', commit: 'a'.repeat(40),
    suite: 'lint', scope: 'full' }
  return { root, runner, request, launches, ports }
}

describe('host CI runner concurrent starts', () => {
  it('starts a warm repository while another repository fetch is stalled and retains the reserved slot', async () => {
    const fetch = barrier()
    const { runner, request, launches, ports } = await computer(undefined, 16, true, undefined, fetch.pause)
    const command = ports.run
    ports.run = async (file, args, options) => {
      if (file === 'git' && args.includes('rev-list') && args.includes('b'.repeat(40))) {
        return { code: 0, stdout: '', stderr: '' }
      }
      return command(file, args, options)
    }
    const first = runner.handle(request)
    let warm: ReturnType<HostCiRunner['handle']> | undefined
    let retry: ReturnType<HostCiRunner['handle']> | undefined
    try {
      await fetch.entered
      retry = runner.handle(request)
      const warmRequest = { ...request, runId: randomUUID(), repository: 'octo/other', commit: 'b'.repeat(40) }
      warm = runner.handle(warmRequest)
      await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 1000 })
      await expect(warm).resolves.toMatchObject({ run: { runId: warmRequest.runId } })
      await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 2,
        runs: expect.arrayContaining([expect.objectContaining({ runId: request.runId, state: 'starting' })]) })
      await expect(runner.handle({ ...request, runId: randomUUID() })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    } finally {
      fetch.release()
      await Promise.all([first, warm, retry])
    }
    await vi.waitFor(() => expect(launches).toHaveLength(2))
  })

  it('coordinates concurrent repository fetches after reserving distinct slots', async () => {
    const fetch = barrier()
    let fetches = 0
    const { runner, request, launches } = await computer(undefined, 16, true, undefined, async () => {
      fetches++
      await fetch.pause()
    })
    const first = runner.handle(request)
    let second: ReturnType<HostCiRunner['handle']> | undefined
    try {
      await fetch.entered
      second = runner.handle({ ...request, runId: randomUUID(), commit: 'b'.repeat(40) })
      await vi.waitFor(async () => {
        await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 2 })
      }, { timeout: 1000 })
      expect(fetches).toBe(1)
    } finally {
      fetch.release()
      await Promise.all([first, second])
    }
    await vi.waitFor(() => expect(launches).toHaveLength(2))
    expect(fetches).toBe(2)
    expect(new Set(launches.map(launch => launch.args.find(arg => arg.startsWith('--working-directory=')))).size)
      .toBe(2)
  })

  it('fetches the commit once for concurrent affected parts of the same commit', async () => {
    const { runner, request, ports } = await computer(undefined, 16, true)
    const affected = { ...request, scope: undefined }
    const command = ports.run
    let fetches = 0
    let present = false
    ports.run = async (file, args, options) => {
      if (file === 'git' && args.includes('rev-list')) return { code: present ? 0 : 1, stdout: '', stderr: '' }
      if (file === 'git' && args.includes('fetch')) {
        fetches++
        present = true
      }
      return command(file, args, options)
    }
    await Promise.all([runner.handle(affected), runner.handle({ ...affected, runId: randomUUID() })])
    expect(fetches).toBe(1)
  })

  it('keeps database suites exclusive for commits without isolated database support', async () => {
    const { runner, request, launches } = await computer(undefined, 16)
    const unit = { ...request, suite: 'unit' }
    await runner.handle(unit)
    await expect(runner.handle({ ...unit, runId: randomUUID() })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    await expect(runner.handle({ ...request, runId: randomUUID() })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 1, slotsTotal: 1 })
    await vi.waitFor(() => expect(launches).toHaveLength(1))
    expect(launches[0]!.args).toContain('--property=CPUQuota=1600%')
  })

  it.each(['unit', 'integration'] as const)(
    'releases a rejected %s preparation and retries the same run when exclusive capacity is free', async suite => {
      const { runner, request, launches, root, ports } = await computer(undefined, 16)
      await runner.handle(request)
      await vi.waitFor(() => expect(launches).toHaveLength(1))
      const waiting = { ...request, runId: randomUUID(), suite }
      await expect(runner.handle(waiting)).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
      await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 1,
        runs: expect.arrayContaining([expect.objectContaining({ runId: waiting.runId, state: 'queued',
          exitCode: null, finishedAt: null, message: expect.stringContaining('exclusive database capacity') })]) })
      expect(launches).toHaveLength(1)
      await runner.cancel(request.runId)
      await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 0 })
      const restarted = new HostCiRunner(root, ports)
      await expect(restarted.handle(waiting)).resolves.toMatchObject({ run: { runId: waiting.runId } })
      await vi.waitFor(async () => {
        await expect(restarted.handle({ operation: 'read', runId: waiting.runId, afterOffset: 0, maxBytes: 1 }))
          .resolves.toMatchObject({ run: { state: 'running', exitCode: null, finishedAt: null } })
      })
      expect(launches).toHaveLength(2)
    })

  it('requeues a preparation when memory capacity drops after reservation', async () => {
    const { runner, request, ports, launches } = await computer(undefined, 16, true)
    await runner.handle(request)
    await vi.waitFor(() => expect(launches).toHaveLength(1))
    let memory = 16 * 2 ** 30
    ports.availableMemoryBytes = () => memory
    const command = ports.run
    ports.run = async (file, args, options) => {
      if (file === 'git' && args.includes('show')) memory = 1
      return command(file, args, options)
    }
    const waiting = { ...request, runId: randomUUID(), suite: 'unit' }
    await expect(runner.handle(waiting)).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 1,
      runs: expect.arrayContaining([expect.objectContaining({ runId: waiting.runId, state: 'queued',
        exitCode: null, finishedAt: null })]) })
    expect(launches).toHaveLength(1)
  })

  it('cancels a queued preparation and prevents a later start from launching it', async () => {
    const { runner, request, launches } = await computer(undefined, 16)
    await runner.handle(request)
    await vi.waitFor(() => expect(launches).toHaveLength(1))
    const waiting = { ...request, runId: randomUUID(), suite: 'unit' }
    await expect(runner.handle(waiting)).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    await expect(runner.handle({ operation: 'cancel', runId: waiting.runId }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
    await runner.cancel(request.runId)
    await expect(runner.handle(waiting)).resolves.toMatchObject({ run: { state: 'canceled' } })
    expect(launches).toHaveLength(1)
  })

  it('keeps repository command failures terminal and releases their slot', async () => {
    const { runner, request, ports, launches } = await computer()
    const command = ports.run
    ports.run = async (file, args, options) => {
      if (file === 'git' && args.includes('rev-list')) return { code: 1, stdout: '', stderr: '' }
      if (file === 'git' && args.includes('fetch')) return { code: 1, stdout: '', stderr: 'Fetch failed' }
      return command(file, args, options)
    }
    await expect(runner.handle(request)).rejects.toThrow('Fetch failed')
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 0,
      runs: [expect.objectContaining({ runId: request.runId, state: 'failed',
        message: expect.stringContaining('Fetch failed') })] })
    expect(launches).toHaveLength(0)
  })

  it('releases the slot of a canceled run only after preparation has stopped', async () => {
    const checkout = barrier()
    const { runner, request } = await computer(undefined, 16, true, checkout.pause)
    await runner.handle(request)
    await checkout.entered
    const canceled = runner.cancel(request.runId)
    try {
      await vi.waitFor(async () => {
        await expect(runner.handle({ operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 1 }))
          .resolves.toMatchObject({ run: { state: 'starting', message: expect.stringContaining('Cancellation requested') } })
      })
    } finally {
      checkout.release()
    }
    await expect(canceled).resolves.toMatchObject({ state: 'canceled' })
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 0 })
  })

  it('admits two different jobs into two slots, queues a third, and releases one slot on cancellation', async () => {
    const { runner, request, launches } = await computer(undefined, 16)
    const second = { ...request, runId: randomUUID() }
    const third = { ...request, runId: randomUUID() }
    await Promise.all([runner.handle(request), runner.handle(second), runner.handle(request)])
    await expect(runner.handle(third)).rejects.toMatchObject({ code: 'CI_HOST_BUSY',
      message: expect.stringContaining('(2/2)') })
    await vi.waitFor(() => expect(launches).toHaveLength(2))
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 2, slotsTotal: 2 })
    for (const launch of launches) {
      expect(launch.args).toContain('--property=CPUQuota=800%')
      expect(launch.args).toContain(`--property=MemoryMax=${Math.floor(16 * 2 ** 30 * 0.9 / 2)}`)
    }
    expect(new Set(launches.map(launch => launch.args.find(arg => arg.startsWith('--working-directory=')))).size)
      .toBe(2)
    await runner.cancel(request.runId)
    await expect(runner.handle(third)).resolves.toMatchObject({ run: { runId: third.runId } })
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 2, slotsTotal: 2 })
  })

  it('reports an empty exit status and settles when the complete status arrives', async () => {
    const { root, runner, request } = await computer()
    await runner.handle(request)
    const read = { operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 1 }
    await vi.waitFor(async () => {
      await expect(runner.handle(read)).resolves.toMatchObject({ run: { state: 'running' } })
    })
    await runner.beginDrain()
    const exit = join(root, 'runs', request.runId, 'exit')
    await writeFile(exit, '')
    await expect(runner.handle(read)).rejects.toMatchObject({ code: 'CI_EXIT_STATUS_INVALID' })
    await writeFile(join(root, 'runs', request.runId, 'log'), 'Lint failed')
    await writeFile(exit, '3\n')
    await expect(runner.handle(read)).resolves.toMatchObject({ run: { state: 'failed', exitCode: 3 } })
  })

  it('admits one start and preserves same-run retries during GitHub preflight', async () => {
    const github = barrier()
    const { runner, request } = await computer(github.pause)
    const first = runner.handle(request)
    await github.entered
    const retry = runner.handle(request)
    const second = runner.handle({ ...request, runId: randomUUID() })
    const rejected = expect(second).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    github.release()
    await expect(first).resolves.toMatchObject({ run: { runId: request.runId } })
    await expect(retry).resolves.toMatchObject({ run: { runId: request.runId } })
    await rejected
  })

  it('reports a start during preflight and launches it once when a retry arrives before acknowledgement', async () => {
    const fetch = barrier()
    const { runner, request, launches } = await computer(undefined, 8, false, undefined, fetch.pause)
    const first = runner.handle(request)
    await fetch.entered
    const retry = runner.handle(request)
    try {
      await expect(runner.status()).resolves.toMatchObject({ runs: [expect.objectContaining({
        runId: request.runId, state: 'starting', step: 'dispatch',
      })] })
      fetch.release()
      await Promise.all([first, retry])
      await vi.waitFor(() => expect(launches).toHaveLength(1))
    } finally {
      fetch.release()
      await Promise.all([first, retry])
    }
  })

  it('keeps the run readable and rejects a second start while launch writes its running state', async () => {
    const writing = barrier()
    const { root, runner, request, ports, launches } = await computer()
    writes.duringRunningWrite = writing.pause
    try {
      await runner.handle(request)
      await writing.entered
      await expect(runner.handle({ operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 1 }))
        .resolves.toMatchObject({ run: { runId: request.runId, state: 'running', exitCode: null, finishedAt: null } })
      await expect(runner.handle({ ...request, runId: randomUUID() }))
        .rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
      const restarted = new HostCiRunner(root, ports)
      await expect(restarted.handle({ operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 1 }))
        .resolves.toMatchObject({ run: { runId: request.runId, state: 'running', exitCode: null, finishedAt: null } })
      await expect(restarted.handle({ ...request, runId: randomUUID() }))
        .rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
      expect(launches).toHaveLength(1)
    } finally {
      writing.release()
    }
  })
})


it.each([false, true])('fences cancellation during repository fetch across restart=%s', async restarted => {
  const fetch = barrier()
  const { root, runner, request, launches, ports } = await computer(undefined, 8, false, undefined, fetch.pause)
  const command = ports.run
  let preparationSignal: AbortSignal | undefined
  ports.run = async (file, args, options) => {
    if (file === 'git' && args.includes('fetch')) preparationSignal = options?.signal
    return command(file, args, options)
  }
  const canceler = restarted ? new HostCiRunner(root, ports) : runner
  const start = runner.handle(request)
  try {
    await fetch.entered
    await expect(canceler.handle({ operation: 'cancel', runId: request.runId }))
      .resolves.toMatchObject({ operation: 'cancel', run: { state: 'starting', finishedAt: null } })
    expect(preparationSignal).toBeInstanceOf(AbortSignal)
    expect(preparationSignal!.aborted).toBe(!restarted)
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 1 })
    await expect(runner.handle({ ...request, runId: randomUUID() })).rejects.toMatchObject({ code: 'CI_HOST_BUSY' })
    expect(launches).toHaveLength(0)
    fetch.release()
    await expect(start).resolves.toMatchObject({ run: { state: 'canceled' } })
    await expect(runner.handle(request)).resolves.toMatchObject({ run: { state: 'canceled' } })
    await expect(runner.status()).resolves.toMatchObject({ slotsUsed: 0 })
    expect(launches).toHaveLength(0)
  } finally {
    fetch.release()
    await start
  }
})

it('persists cancellation before delayed start delivery and rejects native entry on replay', async () => {
  const { root, runner, request, launches, ports } = await computer()
  await expect(runner.handle({ operation: 'cancel', runId: request.runId }))
    .resolves.toMatchObject({ run: { state: 'canceled' } })
  const restarted = new HostCiRunner(root, ports)
  await expect(restarted.handle(request)).resolves.toMatchObject({ run: { state: 'canceled' } })
  expect(launches).toHaveLength(0)
})

it('returns a log page while native launch is waiting for acknowledgement', async () => {
  const launch = barrier()
  const { root, runner, request, ports } = await computer()
  const command = ports.run
  ports.run = async (file, args, options) => {
    const result = await command(file, args, options)
    if (file === 'systemd-run') await launch.pause()
    return result
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let reading: ReturnType<HostCiRunner['handle']> | undefined
  try {
    await runner.handle(request)
    await launch.entered
    await writeFile(join(root, 'runs', request.runId, 'log'), 'Launching the suite.\n')
    reading = runner.handle({ operation: 'read', runId: request.runId, afterOffset: 0, maxBytes: 100 })
    const result = await Promise.race([reading,
      new Promise<'blocked'>(resolve => { timeout = setTimeout(() => resolve('blocked'), 1000) })])
    expect(result).toMatchObject({ operation: 'read', text: 'Launching the suite.\n',
      run: { runId: request.runId, state: 'running', exitCode: null, finishedAt: null } })
  } finally {
    clearTimeout(timeout)
    launch.release()
    await reading
    await runner.beginDrain()
  }
})
