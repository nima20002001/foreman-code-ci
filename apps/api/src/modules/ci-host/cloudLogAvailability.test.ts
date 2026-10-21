import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { confirmCancellation, fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each(['github', 'circleci'] as const)('reads a running %s ticket before any output exists', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  const request = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
  for (const cloud of [f.cloud, f.reopen()]) {
    expect(await cloud.handle(request)).toMatchObject({ run: { state: 'running', logBytes: 0 },
      text: '', nextOffset: 0 })
  }
})

it.each(['github', 'circleci'] as const)('reads a %s ticket canceled before its first output', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  const activeState = provider === 'github' ? 'starting' : 'running'
  expect(await f.cloud.handle({ operation: 'cancel', runId }))
    .toMatchObject({ run: { state: activeState, logBytes: 0 } })
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: activeState, logBytes: 0 }, text: '', nextOffset: 0 })
  expect(await confirmCancellation(f, runId)).toMatchObject({ run: { state: 'canceled' } })
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: 'canceled', logBytes: 0 }, text: '', nextOffset: 0 })
  expect(provider === 'github' ? f.github.canceled : f.circle.canceled).toHaveLength(1)
})

it.each(['github', 'circleci'] as const)('reports pending %s collection when its first log is unavailable', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = 'failure'
  f.circle.outcome = 'failed'
  vi.spyOn(f.cloud.provider, 'log').mockRejectedValue(new Error('Provider log not yet available'))
  const request = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
  expect(await f.cloud.handle(request)).toMatchObject({ run: { state: 'failed', collection: 'pending', logBytes: 0 },
    text: '', nextOffset: 0 })
  f.advance(4_001)
  vi.mocked(f.cloud.provider.log).mockResolvedValue('Retained provider output\n')
  expect(await f.reopen().handle(request)).toMatchObject({ run: { state: 'failed', collection: 'complete' },
    text: 'Retained provider output\n' })
})

it('rejects lost live output with a typed error instead of reporting an empty log', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.circle.steps = [{ num: 1, name: 'Suite', phase: 'started' }]
  f.circle.output = 'First output\n'
  const request = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
  expect(await f.cloud.handle(request)).toMatchObject({ text: expect.stringContaining('First output') })
  await rm(join(f.root, 'ci-cloud', 'runs', runId, 'log'))
  await expect(f.cloud.handle(request)).rejects.toMatchObject({ code: 'CI_LOG_UNAVAILABLE' })
})

it('reads a failed mirror publication before any provider log can exist', async () => {
  const f = await fixture()
  const runId = randomUUID()
  const original = f.ports.run.bind(f.ports)
  vi.spyOn(f.ports, 'run').mockImplementation((file, args, options) => file === 'tailscale'
    ? Promise.resolve({ code: 1, stdout: '', stderr: 'Inventory unavailable' })
    : original(file, args, options))
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full', deferMirror: true })
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: 'failed', logBytes: 0, mirrorPublication: { state: 'failed' },
      message: expect.stringContaining('fleet identity inventory') }, text: '', nextOffset: 0 })
  expect(f.dispatched).toHaveLength(0)
})

it.each(['github', 'circleci'] as const)('reads a %s ticket that failed before dispatch without a provider log', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'integration', scope: 'affected', files: ['apps/api/test/renamed-away.integration.test.ts'], deferMirror: true })
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .toMatchObject({ run: { state: 'failed', logBytes: 0, message: expect.stringContaining('Selected integration files are absent from the commit.') },
      text: '', nextOffset: 0 })
  expect(f.dispatched).toHaveLength(0)
})

it.each(['starting', 'running', 'queued', 'canceled', 'failed', 'passed'] as const)(
  'rejects a missing collected log even when the retained state is %s', async state => {
    const f = await fixture()
    const runId = randomUUID()
    const path = join(f.root, 'ci-cloud', 'runs', runId)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'meta.json'), JSON.stringify({ runId, state, repository: 'octo/site',
      mirror: 'octo/site-ci', commit: f.commit, suite: 'lint', providerRunId: null,
      startedAt: f.ports.now().toISOString(), finishedAt: null, exitCode: null, message: null,
      collection: { log: true, artifacts: true } }))
    await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
      .rejects.toMatchObject({ code: 'CI_LOG_UNAVAILABLE' })
  },
)

it('propagates unreadable log storage instead of treating it as pending output', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  await mkdir(join(f.root, 'ci-cloud', 'runs', runId, 'log'))
  await expect(f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }))
    .rejects.toMatchObject({ code: 'EISDIR' })
})
