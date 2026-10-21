import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'

afterEach(() => vi.restoreAllMocks())

it.each([
  { stderr: 'Error: artifacts.not_found (exit_code 5): No resource found', absent: true },
  { stderr: 'Error: permission denied', absent: false },
  { stderr: 'Error: No resource found', absent: false },
])('handles CircleCI artifact lookup failure: $stderr', async ({ stderr, absent }) => {
  const f = await fixture({}, { provider: 'circleci' })
  const runCli = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'job' && args[1] === 'artifact') {
      return { code: 5, stdout: '', stderr }
    }
    return runCli(file, args, options)
  })
  const provider = new CircleCiProvider(f.ports, { circleToken: async () => null })
  const run: CloudRun = {
    runId: randomUUID(),
    repository: 'octo/site',
    mirror: 'octo/site-ci',
    commit: f.commit,
    suite: 'lint',
    startedAt: f.ports.now().toISOString(),
    providerRunId: 'run-1',
    state: 'canceled',
    finishedAt: f.ports.now().toISOString(),
    exitCode: 1,
    message: null,
  }
  const artifacts = provider.artifacts(run, join(f.root, 'artifacts'))
  if (absent) {
    await expect(artifacts).resolves.toMatchObject({ durations: null, testResults: null })
  } else {
    await expect(artifacts).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  }
})

it('persists completed collection for canceled CircleCI jobs without artifacts and stops retrying', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({
    operation: 'start',
    workspaceId: 'ci-workspace',
    runId,
    repository: 'octo/site',
    commit: f.commit,
    suite: 'lint',
    scope: 'full',
  })
  f.circle.outcome = 'canceled'
  f.advance(4_000)
  const runCli = f.ports.run
  let artifactReads = 0
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'job' && args[1] === 'artifact') {
      artifactReads++
      return { code: 5, stdout: '', stderr: 'Error: artifacts.not_found (exit_code 5): No resource found' }
    }
    return runCli(file, args, options)
  })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 100 }
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'canceled', collection: 'complete' } })
  expect(artifactReads).toBe(1)
  expect(f.circle.downloaded).toEqual([])

  const reopened = f.reopen()
  for (let poll = 0; poll < 3; poll++) {
    f.advance(4_000)
    await reopened.reconcile()
    expect(await reopened.handle(read)).toMatchObject({ run: { state: 'canceled', collection: 'complete' } })
  }
  expect(artifactReads).toBe(1)
  expect(f.circle.triggered).toHaveLength(1)
})

it('keeps a just-finished CircleCI job pending until its artifacts become visible', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runCli = f.ports.run
  vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
    if (file === 'circleci' && args[0] === 'job' && args[1] === 'artifact') {
      return { code: 5, stdout: '', stderr: 'Error: artifacts.not_found (exit_code 5): No resource found' }
    }
    return runCli(file, args, options)
  })
  const provider = new CircleCiProvider(f.ports, { circleToken: async () => null })
  const run: CloudRun = { runId: randomUUID(), repository: 'octo/site', mirror: 'octo/site-ci', commit: f.commit,
    suite: 'integration', startedAt: f.ports.now().toISOString(), providerRunId: 'run-1', state: 'passed',
    finishedAt: f.ports.now().toISOString(), exitCode: 0, message: null }
  await expect(provider.artifacts(run, join(f.root, 'artifacts'))).rejects.toMatchObject({ code: 'CI_CLOUD_FAILED' })
  f.advance(5 * 60_000)
  await expect(provider.artifacts(run, join(f.root, 'artifacts'))).resolves.toMatchObject({ testResults: null })
})
