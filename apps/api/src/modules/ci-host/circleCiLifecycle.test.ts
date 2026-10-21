import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { CloudCi } from './cloud.js'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import { withProviderPoll } from './providerPoll.js'
import { fixture } from './cloud.testSupport.js'

const run: CloudRun = {
  runId: 'ticket', repository: 'fixture/site', mirror: 'fixture/site-ci', commit: 'a'.repeat(40),
  suite: 'integration', startedAt: '2026-10-01T00:00:00Z', providerRunId: 'pipeline', state: 'starting',
  finishedAt: null, exitCode: null, message: null,
}
const finishedAt = '2026-10-01T00:04:00Z'

it.each(['created', 'pending', 'setup-pending'])(
  'waits for workflows on a %s CircleCI pipeline and then reads success through HTTP', async state => {
    let visible = false
    let pipelineId = 'pipeline'
    const command = vi.fn<HostCiPorts['run']>(async () => { throw new Error('Unexpected CLI request') })
    const ports: HostCiPorts = { run: command, now: () => new Date(finishedAt), cpus: 4, memoryBytes: 2 ** 30 }
    const fetchCircle: typeof fetch = async input => {
      const path = new URL(String(input)).pathname
      if (path === `/api/v2/pipeline/${pipelineId}`) return Response.json({ state, errors: [] })
      if (path === `/api/v2/pipeline/${pipelineId}/workflow`) {
        return Response.json({ items: visible ? [{ id: 'workflow', status: 'success', stopped_at: finishedAt }] : [] })
      }
      if (path === '/api/v2/workflow/workflow/job') return Response.json({ items: [{ id: 'job' }] })
      if (path === '/api/v3/jobs/job') return Response.json({ data: { attributes: {
        phase: 'ended', outcome: 'succeeded', ended_at: finishedAt, parallel_executions: [],
      } } })
      throw new Error(`Unexpected CircleCI request: ${path}`)
    }
    const provider = new CircleCiProvider(ports, { fetch: fetchCircle, circleToken: async () => 'fixture-token' })
    await withProviderPoll(async () => {
      expect(await provider.find(run)).toBeNull()
      expect(await provider.status(run)).toMatchObject({ done: false })
    })
    visible = true
    await withProviderPoll(async () => {
      expect(await provider.find(run)).toBe('pipeline')
      expect(await provider.status(run)).toMatchObject({ done: true, conclusion: 'success', finishedAt })
    })
    expect(command).not.toHaveBeenCalled()

    const f = await fixture({}, { provider: 'circleci' })
    f.circle.runView = { phase: state, workflows: [] }
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
      repository: 'octo/site', commit: f.commit, suite: 'integration', scope: 'full' })
    pipelineId = 'run-1'
    visible = false
    const reopen = () => new CloudCi('main-1', provider, async () => 'octo/site-ci',
      join(f.root, 'ci-cloud'), f.ports, f.git, { home: f.root, user: 'fixture', host: 'fixture-computer' })
    const request = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
    expect(await reopen().handle(request)).toMatchObject({ run: { state: 'starting', exitCode: null, finishedAt: null } })
    visible = true
    expect(await reopen().handle(request)).toMatchObject({ run: { state: 'passed', exitCode: 0, finishedAt } })
    expect(await reopen().handle(request)).toMatchObject({ run: { state: 'passed', exitCode: 0, finishedAt } })
  },
)

it.each([
  { phase: 'created', current_outcome: 'not_run' },
  { phase: 'setup-pending', current_outcome: 'not_run' },
  { state: 'created', phase: 'ended', current_outcome: 'not_run' },
  { state: 'setup-pending', phase: 'ended', current_outcome: 'not_run' },
  { phase: 'ended' },
  { phase: 'ended', current_outcome: 'not_run' },
  { phase: 'ended', current_outcome: '' },
  { phase: 'ended', current_outcome: 'unknown' },
])('keeps an incomplete CircleCI CLI pipeline pending until work or cancellation is verified: %j', async pending => {
  let view: unknown = { ...pending, errors: [], workflows: [] }
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(finishedAt),
    run: async () => ({ code: 0, stdout: JSON.stringify(view), stderr: '' }) }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.find(run)).toBeNull()
  expect(await provider.status(run)).toMatchObject({ done: false })
  view = { phase: 'ended', workflows: [{ phase: 'ended', outcome: 'succeeded', stopped_at: finishedAt }] }
  expect(await provider.find(run)).toBe('pipeline')
  expect(await provider.status(run)).toMatchObject({ done: true, conclusion: 'success', finishedAt })
})

it.each(['failed', 'errored', 'unauthorized', 'not_run', 'skipped', 'infrastructure_fail', 'timedout'])(
  'settles an explicitly ended CircleCI failing outcome: %s', async outcome => {
    const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(finishedAt),
      run: async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ phase: 'ended',
        workflows: [{ phase: 'ended', outcome, jobs: [] }] }) }) }
    const provider = new CircleCiProvider(ports, { circleToken: async () => null })
    expect(await provider.status(run)).toMatchObject({ done: true, conclusion: 'failure' })
  },
)

it.each([
  { phase: 'created', current_outcome: 'not_run' },
  { state: 'created', phase: 'ended', current_outcome: 'not_run' },
])('verifies an empty CLI pipeline after a real cancellation and another read: %j', async pending => {
  let now = Date.parse(finishedAt)
  let visible = false
  const command = vi.fn<HostCiPorts['run']>(async (_file, args) => {
    if (args[1] === 'cancel') return { code: 1, stdout: '', stderr: 'no active workflows' }
    if (args[1] === 'get') return { code: 0, stderr: '', stdout: JSON.stringify(visible
      ? { phase: 'started', workflows: [{ phase: 'started', jobs: [{ id: 'job' }] }] }
      : { ...pending, errors: [], workflows: [] }) }
    throw new Error(`Unexpected CircleCI command: ${args.join(' ')}`)
  })
  const ports: HostCiPorts = { run: command, cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(now) }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.status(run)).toMatchObject({ done: false })
  expect(await provider.cancel(run)).toEqual({ empty: true })
  const checked = { ...run, emptyPipelineCancellations: { pipeline: new Date(now).toISOString() } }
  now += 4_000
  expect(await provider.cancel(checked)).toEqual({ empty: true })
  expect(await provider.status(checked)).toMatchObject({ done: true, notStarted: true })
  await withProviderPoll(async () => {
    expect(await provider.find(checked)).toBeNull()
    visible = true
    // The cancellation invalidates the cached empty snapshot even when no workflow accepts it.
    expect(await provider.cancel(checked)).toBe(false)
    expect(await provider.status(checked)).toMatchObject({ done: false })
  })
  expect(command.mock.calls.filter(([, args]) => args[1] === 'cancel')).toHaveLength(3)
})

it('retries an accepted empty pipeline through CLI only after cancellation is rechecked across restart', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.runView = { state: 'created', phase: 'ended', current_outcome: 'not_run', workflows: [] }
  f.circle.cancelError = 'no active workflows'
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace', repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  f.advance(75_000)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.canceled).toEqual(['run-1'])
  expect(f.circle.triggered).toHaveLength(1)
  f.advance(4_000)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.canceled).toEqual(['run-1', 'run-1'])
  expect(f.circle.triggered).toHaveLength(2)
})

it('does not verify an empty CLI pipeline when the workflow listing is absent', async () => {
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(finishedAt),
    run: async (_file, args) => args[1] === 'cancel'
      ? { code: 1, stdout: '', stderr: 'no active workflows' }
      : { code: 0, stderr: '', stdout: JSON.stringify({ state: 'created', phase: 'ended', current_outcome: 'not_run' }) } }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.status(run)).toMatchObject({ done: false })
  expect(await provider.cancel(run)).toBe(false)
  const checked = { ...run, emptyPipelineCancellations: { pipeline: run.startedAt } }
  expect(await provider.status(checked)).toMatchObject({ done: false })
})
