import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import { fixture } from './cloud.testSupport.js'
import { CircleStandby } from './circleStandby.js'

afterEach(() => vi.restoreAllMocks())

it.each(['cancel', 'recheck policy'] as const)('recovers a failed pre-trigger policy read by %s without inventing a submission', async recovery => {
  const f = await fixture({}, { provider: 'circleci', account: 'fixture-org' })
  const failure = new Error('Fixture credit allowance read failed')
  let readings = 0
  const policy = new CircleStandby(async () => [{ owner: 'fixture-org', circleAccountId: 'default',
    role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) }], { reading: async () => {
    readings++
    if (readings === 3) throw failure
    const remaining = readings > 3 ? 0 : 400_000
    return { credits: { total: 400_000, used: 400_000 - remaining, remaining, asOf: f.ports.now().toISOString() } }
  } })
  f.cloud.setCircleStandby(policy)
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'api') {
      return { code: 0, stdout: JSON.stringify({ items: [], next_page_token: null }), stderr: '' }
    }
    return original(file, args, options)
  })
  const runId = randomUUID()
  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace', repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toBe(failure)
  expect(f.circle.triggered).toEqual([])
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  if (recovery === 'cancel') await f.reopen().handle({ operation: 'cancel', runId })
  else await policy.recordCreditRefusal('fixture-org')
  f.advance(75_001)
  const cloud = recovery === 'cancel' ? f.reopen() : f.cloud
  expect(await cloud.handle(read)).toMatchObject({ run: { state: recovery === 'cancel' ? 'canceled' : 'failed' } })
  expect(f.circle.triggered).toEqual([])
})

it('rechecks active policy after a pre-trigger read failure and submits once despite a zero usage estimate', async () => {
  const f = await fixture({}, { provider: 'circleci', account: 'fixture-org' })
  const failure = new Error('Fixture credit allowance read failed')
  let readings = 0
  f.cloud.setCircleStandby(new CircleStandby(async () => [{ owner: 'fixture-org', circleAccountId: 'default',
    role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) }], { reading: async () => {
    readings++
    if (readings === 3) throw failure
    const remaining = readings > 3 ? 0 : 400_000
    return { credits: { total: 400_000, used: 400_000 - remaining, remaining, asOf: f.ports.now().toISOString() } }
  } }))
  const discovery = vi.fn(async () => ({ code: 0,
    stdout: JSON.stringify({ items: [], next_page_token: null }), stderr: '' }))
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) =>
    file === 'circleci' && args[0] === 'api' ? discovery() : original(file, args, options))
  const runId = randomUUID()
  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace', repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toBe(failure)
  expect(f.circle.triggered).toEqual([])
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  f.advance(74_999)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.triggered).toEqual([])
  f.advance(2)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'starting' } })
  expect(f.circle.triggered).toHaveLength(1)
  expect(await f.cloud.schedulingReading('site-ci')).toMatchObject({ schedulingRole: 'active', credits: { remaining: 0 } })
  f.advance(4_001)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(1)
  expect(f.circle.canceled).toEqual([])
  expect(discovery).not.toHaveBeenCalled()
})

it.each([false, true])('adopts an accepted CircleCI submission after its reply is lost, delayed visibility: %s', async delayed => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  let visible = !delayed
  let submissionBranch = ''
  const original = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'run' && args[1] === 'trigger') {
      await original(file, args, options)
      submissionBranch = args[args.indexOf('--branch') + 1]!
      if (f.circle.triggered.length === 1) throw new Error('Trigger reply lost')
      return { code: 0, stderr: '', stdout: JSON.stringify({ id: `run-${f.circle.triggered.length}` }) }
    }
    if (file === 'circleci' && args[0] === 'api') {
      expect(new URL(`https://circleci.com/${args[1]}`).searchParams.get('branch')).toBe(submissionBranch)
      return { code: 0, stderr: '', stdout: JSON.stringify({ items: visible ? [
        { id: 'unrelated', vcs: { branch: 'ci/another-ticket', revision: f.commit }, trigger: { type: 'api' } },
        { id: 'push-pipeline', vcs: { branch: submissionBranch, revision: f.mirrorGit('rev-parse', submissionBranch) },
          trigger: { type: 'webhook' } },
        { id: 'run-1', vcs: { branch: submissionBranch, revision: f.mirrorGit('rev-parse', submissionBranch) },
          trigger: { type: 'api' } },
      ] : [], next_page_token: null }) }
    }
    return original(file, args, options)
  })
  await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toThrow('Trigger reply lost')
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
  f.advance(75_001)
  if (delayed) {
    expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting', finishedAt: null } })
    expect(f.circle.triggered).toHaveLength(1)
    visible = true
    f.advance(4_001)
  }
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(1)
  expect(submissionBranch).toContain(runId)
  expect(await f.reopen().handle({ operation: 'cancel', runId })).toMatchObject({ run: { state: 'running' } })
  expect(f.circle.canceled).toContain('run-1')
  f.circle.runView = { phase: 'ended', current_outcome: 'canceled', workflows: [] }
  f.advance(75_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'canceled' } })
})

it('discovers CircleCI submissions through paginated REST reads and checks snapshot identity', async () => {
  const branch = 'ci/abc-ticket'
  const requests: string[] = []
  let mismatch = false
  const fetch: typeof globalThis.fetch = async input => {
    const url = new URL(String(input))
    requests.push(url.pathname + url.search)
    const second = url.searchParams.get('page-token') === 'next'
    return Response.json({ items: second ? [{ id: 'pipeline', trigger: { type: 'api' },
      vcs: { branch, revision: mismatch ? 'wrong' : 'snapshot' } }] : [], next_page_token: second ? null : 'next' })
  }
  const f = await fixture({}, { provider: 'circleci' })
  const provider = new CircleCiProvider(f.ports, { fetch, circleToken: async () => 'fixture-token' })
  const run: CloudRun = { runId: 'ticket', repository: 'octo/site', mirror: 'octo/site-ci', commit: 'abc', suite: 'lint',
    startedAt: f.ports.now().toISOString(), providerRunId: null, state: 'starting', finishedAt: null,
    exitCode: null, message: null, provenance: { sourceCommit: 'abc', workflowCommit: 'snapshot', workflowRef: branch },
    dispatch: { input: { mirror: 'octo/site-ci', branch, workflowRef: branch, runId: 'ticket', suite: 'lint', slice: '' },
      attempts: 1, at: f.ports.now().toISOString(), uncertain: true } }
  expect(await provider.discover(run)).toEqual(['pipeline'])
  expect(requests).toEqual([
    '/api/v2/project/gh/octo/site-ci/pipeline?branch=ci%2Fabc-ticket',
    '/api/v2/project/gh/octo/site-ci/pipeline?branch=ci%2Fabc-ticket&page-token=next',
  ])
  mismatch = true
  await expect(provider.discover(run)).rejects.toMatchObject({ code: 'CI_CLOUD_PROVENANCE_MISMATCH' })
})
