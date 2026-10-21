import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CloudCi } from './cloud.js'
import { CircleCiProvider } from './cloudProviders.js'
import { readCloudRun } from './cloudJournal.js'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

async function retainedFixture() {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.cancelError = 'no active workflows'
  const pipelines = new Map<string, { state?: string; status?: string; errors?: { type: string; message: string }[] }>()
  const fetchCircle: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    if (path === '/fixture/suite.log') return new Response('Suite completed\n')
    const pipeline = /^\/api\/v2\/pipeline\/([^/]+)$/.exec(path)
    if (pipeline) {
      const view = pipelines.get(pipeline[1]!)
      return Response.json({ state: view?.state ?? 'created', errors: view?.errors ?? [] })
    }
    const workflows = /^\/api\/v2\/pipeline\/([^/]+)\/workflow$/.exec(path)
    if (workflows) {
      const status = pipelines.get(workflows[1]!)?.status
      return Response.json({ items: status ? [{ id: workflows[1], status }] : [] })
    }
    const jobs = /^\/api\/v2\/workflow\/([^/]+)\/job$/.exec(path)
    if (jobs) return Response.json({ items: [{ id: jobs[1] }] })
    const job = /^\/api\/v3\/jobs\/([^/]+)$/.exec(path)
    if (job) {
      const status = pipelines.get(job[1]!)?.status
      return Response.json({ data: { attributes: { phase: status === 'running' ? 'started' : 'ended',
        outcome: status === 'success' ? 'succeeded' : status, parallel_executions: [] } } })
    }
    if (path.endsWith('/artifacts')) return Response.json({ data: [{ attributes: {
      path: 'durations/suite.log', url: 'https://artifacts.example/fixture/suite.log',
    } }] })
    throw new Error(`Unexpected CircleCI request: ${path}`)
  }
  const provider = new CircleCiProvider(f.ports, { fetch: fetchCircle, circleToken: async () => 'fixture-token' })
  const reopen = () => new CloudCi('fixture-main', provider, async () => 'octo/site-ci',
    join(f.root, 'ci-cloud'), f.ports, f.git, { home: f.root, user: 'fixture', host: 'fixture-host' })
  const runId = randomUUID()
  const start = { operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' } as const
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  const meta = () => readCloudRun(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json'))
  await reopen().handle(start)
  const retry = async () => {
    f.advance(75_000)
    await reopen().handle(read)
    f.advance(4_000)
    await reopen().handle(read)
    expect(f.circle.triggered).toHaveLength(2)
  }
  return { ...f, pipelines, reopen, runId, start, read, meta, retry }
}

it.each(['passed', 'failed', 'canceled'] as const)(
  'reconciles unresolved accepted attempts after a ticket is %s and collection has finished', async state => {
    const f = await retainedFixture()
    if (state === 'canceled') {
      await f.reopen().handle({ operation: 'cancel', runId: f.runId })
      f.advance(75_000)
    } else {
      await f.retry()
      f.pipelines.set('run-2', { status: state === 'passed' ? 'success' : 'failed' })
    }
    expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state } })
    f.advance(61_000)
    const completed = await f.reopen().handle(f.read)
    expect(completed).toMatchObject({ run: { state } })
    if (completed.operation !== 'read') throw new Error('Expected a read reply')
    const finishedAt = completed.run.finishedAt
    if (state !== 'canceled') expect(completed.run.collection).toBe('complete')
    const cancellations = f.circle.canceled.length
    f.pipelines.set('run-1', { status: 'running' })
    f.circle.cancelError = ''
    f.advance(4_000)
    const restarted = f.reopen()
    await restarted.reconcile()
    expect(f.circle.canceled.slice(cancellations)).toContain('run-1')
    expect(await restarted.handle(f.read)).toMatchObject({ run: { state, finishedAt, executorCleanupPending: true } })
    f.pipelines.set('run-1', { status: 'canceled' })
    f.advance(4_000)
    await f.reopen().reconcile()
    expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state, finishedAt, executorCleanupPending: false } })
    expect((await f.meta()).dispatchHistory?.find(attempt => attempt.providerRunId === 'run-1'))
      .toMatchObject({ terminated: true })
  },
)

it('retains a terminal empty pipeline journal and mirror refs until confirmed termination', async () => {
  const f = await retainedFixture()
  await f.reopen().handle({ operation: 'cancel', runId: f.runId })
  f.advance(75_000)
  expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'canceled' } })
  await f.prune(new Set())
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/ci/${f.commit}`)).not.toBe('')
  expect(await f.reopen().handle({ operation: 'status', cleanupRunIds: [f.runId] }))
    .toMatchObject({ removedRunIds: [] })
  expect(await f.meta()).toMatchObject({ state: 'canceled' })
})

it.each(['system', 'config'])(
  'retires a historical %s pipeline error without failing or poisoning the replacement', async type => {
    const f = await retainedFixture()
    await f.retry()
    f.pipelines.set('run-1', { state: 'errored', errors: [{ type, message: 'Previous pipeline could not be processed' }] })
    f.pipelines.set('run-2', { status: 'running' })
    expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'running' } })
    expect(f.circle.canceled).not.toContain('run-2')
    expect(await f.meta()).toMatchObject({ providerRunId: 'run-2', dispatchHistory: expect.arrayContaining([
      expect.objectContaining({ providerRunId: 'run-1', terminated: true,
        failure: expect.objectContaining({ message: expect.stringContaining('Previous pipeline could not be processed') }) }),
    ]) })
    f.pipelines.set('run-2', { status: 'success' })
    f.advance(4_000)
    expect(await f.reopen().handle(f.read)).toMatchObject({ run: { state: 'passed' } })
    expect(await f.reopen().handle({ ...f.start, runId: randomUUID() })).toMatchObject({ run: { state: 'starting' } })
    expect(f.circle.triggered).toHaveLength(3)
  },
)
