import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import { CloudCi } from './cloud.js'
import { readCloudRun } from './cloudJournal.js'
import { fixture } from './cloud.testSupport.js'
import type { HostCiPorts } from './runner.js'

afterEach(() => vi.restoreAllMocks())

const startedAt = '2026-10-01T00:00:00.000Z'
const run: CloudRun = { runId: 'ticket', repository: 'octo/site', mirror: 'octo/site-ci',
  commit: 'a'.repeat(40), suite: 'lint', startedAt, providerRunId: 'pipeline', state: 'starting',
  finishedAt: null, exitCode: null, message: null }

function providerFixture(suppliedPorts?: HostCiPorts) {
  const control = { state: 'created', errors: [] as { type: string; message: string }[],
    workflowStatus: null as string | null, jobs: [] as string[], visiblePipeline: '*',
    createdAt: startedAt, now: Date.parse(startedAt) + 75_000, acceptedAt: new Map<string, string>() }
  const cli = vi.fn<HostCiPorts['run']>(async (_file, args) => {
    if (args[0] === 'run' && args[1] === 'cancel') {
      return { code: 1, stdout: '', stderr: 'no active workflows' }
    }
    throw new Error(`Unexpected CircleCI command: ${args.join(' ')}`)
  })
  const ports = suppliedPorts ?? { cpus: 4, memoryBytes: 2 ** 30,
    now: () => new Date(control.now), run: cli }
  const fetchCircle: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    const pipeline = /^\/api\/v2\/pipeline\/([^/]+)$/.exec(path)
    if (pipeline) return Response.json({ state: control.state, errors: control.errors,
      created_at: control.acceptedAt.get(pipeline[1]!) ?? control.createdAt })
    const workflows = /^\/api\/v2\/pipeline\/([^/]+)\/workflow$/.exec(path)
    if (workflows) return Response.json({ items: control.workflowStatus
      && (control.visiblePipeline === '*' || control.visiblePipeline === workflows[1])
      ? [{ id: 'workflow', status: control.workflowStatus }] : [], next_page_token: null })
    if (path === '/api/v2/workflow/workflow/job') {
      return Response.json({ items: control.jobs.map(id => ({ id })), next_page_token: null })
    }
    if (path === '/api/v3/jobs/job') {
      return Response.json({ data: { attributes: { phase: 'started', parallel_executions: [] } } })
    }
    throw new Error(`Unexpected CircleCI GET: ${path}`)
  }
  const provider = new CircleCiProvider(ports, { fetch: fetchCircle, circleToken: async () => 'fixture-token' })
  return { provider, control, cli }
}

it('keeps a processed empty pipeline pending until a real cancellation and fresh verification', async () => {
  const f = providerFixture()
  expect(await f.provider.find(run)).toBeNull()
  expect(await f.provider.status(run)).toMatchObject({ done: false })
  expect(await f.provider.cancel(run)).toEqual({ empty: true })
  expect(f.cli).toHaveBeenCalledExactlyOnceWith('circleci', ['run', 'cancel', 'pipeline', '--force'], expect.anything())
})

it('requires another empty observation after the cancellation verification window', async () => {
  const f = providerFixture()
  expect(await f.provider.cancel(run)).toEqual({ empty: true })
  const checked = { ...run, emptyPipelineCancellations: { pipeline: new Date(f.control.now).toISOString() } }
  f.control.now += 3_999
  expect(await f.provider.status(checked)).toMatchObject({ done: false })
  f.control.now++
  expect(await f.provider.cancel(checked)).toEqual({ empty: true })
  expect(await f.provider.status(checked)).toMatchObject({ done: true, notStarted: true })
  expect(f.cli).toHaveBeenCalledTimes(2)
})

it.each(['pending', 'setup-pending', 'setup'])(
  'keeps an empty %s pipeline owned while processing can still create work', async state => {
    const f = providerFixture()
    f.control.state = state
    expect(await f.provider.status(run)).toMatchObject({ done: false })
    expect(await f.provider.cancel(run)).toBe(false)
    expect(f.cli).toHaveBeenCalledTimes(1)
  },
)

it.each(['success', 'failed', 'canceled', 'not_run'])(
  'recognizes a terminal %s workflow with no jobs as not started', async status => {
    const f = providerFixture()
    f.control.workflowStatus = status
    expect(await f.provider.find(run)).toBeNull()
    expect(await f.provider.status(run)).toMatchObject({ done: true, conclusion: 'failure', notStarted: true })
    await expect(f.provider.cancel(run)).resolves.toBeUndefined()
    expect(f.cli).not.toHaveBeenCalled()
  },
)

it('keeps a running workflow owned while its jobs are not yet listed', async () => {
  const f = providerFixture()
  f.control.workflowStatus = 'running'
  expect(await f.provider.find(run)).toBe('pipeline')
  expect(await f.provider.status(run)).toMatchObject({ done: false })
  expect(await f.provider.cancel(run)).toBe(false)
})

it.each([{ errors: [] }, { errors: [{ type: 'config', message: 'Invalid workflow configuration' }] }])(
  'settles cancellation of an errored pipeline without jobs or an active-workflow cancellation', async ({ errors }) => {
    const f = providerFixture()
    f.control.state = 'errored'
    f.control.errors = errors
    const canceling = { ...run, cancellation: { at: startedAt, canceledIds: [] } }
    await expect(f.provider.cancel(canceling)).resolves.toBeUndefined()
    expect(await f.provider.status(canceling)).toMatchObject({ done: true, conclusion: 'failure', notStarted: true })
    expect(f.cli).not.toHaveBeenCalled()
  },
)

it.each(['retry', 'cancel', 'late-workflow', 'late-previous-workflow'] as const)(
  'reconciles accepted empty pipelines across restart: %s', async operation => {
    const f = await fixture({}, { provider: 'circleci' })
    f.circle.cancelError = 'no active workflows'
    const api = providerFixture(f.ports)
    api.control.createdAt = f.ports.now().toISOString()
    const original = f.ports.run
    vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
      const result = await original(file, args, options)
      if (file === 'circleci' && args[0] === 'run' && args[1] === 'trigger' && result.code === 0) {
        api.control.acceptedAt.set((JSON.parse(result.stdout) as { id: string }).id, f.ports.now().toISOString())
      }
      return result
    })
    const reopen = () => new CloudCi('main-fixture', api.provider, async () => 'octo/site-ci',
      join(f.root, 'ci-cloud'), f.ports, f.git, { home: f.root, user: 'fixture', host: 'fixture-host' })
    const runId = randomUUID()
    const start = { operation: 'start', workspaceId: 'ci-workspace', runId,
      repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' } as const
    expect(await reopen().handle(start)).toMatchObject({ run: { state: 'starting' } })
    const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
    if (operation === 'cancel') {
      expect(await reopen().handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'starting' } })
      expect(f.circle.canceled).toEqual(['run-1'])
    }
    f.advance(74_999)
    expect(await reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(1)
    f.advance(1)
    expect(await reopen().handle(read)).toMatchObject({ run: { state: operation === 'cancel' ? 'canceled' : 'starting' } })
    expect(f.circle.canceled).toContain('run-1')
    expect(f.circle.triggered).toHaveLength(1)
    const saved = await readCloudRun(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json'))
    expect(saved.dispatchHistory).toContainEqual({ at: api.control.createdAt, providerRunId: 'run-1' })
    if (operation === 'cancel') return
    if (operation === 'late-workflow') {
      api.control.workflowStatus = 'running'
      api.control.jobs = ['job']
      f.circle.cancelError = ''
    }
    f.advance(4_000)
    expect(await reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
    if (operation === 'late-workflow') {
      expect(f.circle.triggered).toHaveLength(1)
      expect(f.circle.canceled.filter(id => id === 'run-1')).toHaveLength(2)
      api.control.workflowStatus = 'canceled'
      f.advance(4_000)
      expect(await reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
    }
    expect(f.circle.triggered).toHaveLength(2)
    if (operation === 'late-previous-workflow') {
      api.control.workflowStatus = 'running'
      api.control.visiblePipeline = 'run-1'
      api.control.jobs = ['job']
      f.advance(4_000)
      expect(await reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
      expect(f.circle.canceled.at(-1)).toBe('run-1')
      expect(f.circle.canceled.filter(id => id === 'run-1')).toHaveLength(3)
      expect(f.circle.triggered).toHaveLength(2)
    } else {
      api.control.workflowStatus = 'running'
      api.control.visiblePipeline = 'run-2'
      api.control.jobs = ['job']
      expect(await reopen().handle(read)).toMatchObject({ run: { state: 'running' } })
      expect(f.circle.triggered).toHaveLength(2)
    }
  },
)
