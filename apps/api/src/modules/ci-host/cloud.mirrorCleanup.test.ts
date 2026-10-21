import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { confirmCancellation, fixture } from './cloud.testSupport.js'

function expectMirrorDispatch(provider: 'github' | 'circleci', command: string[] | undefined) {
  const option = provider === 'github' ? '-R' : '--project'
  const target = provider === 'github' ? 'octo/site-ci' : 'gh/octo/site-ci'
  const optionIndex = command?.indexOf(option) ?? -1
  expect(optionIndex).toBeGreaterThanOrEqual(0)
  expect(command?.[optionIndex + 1]).toBe(target)
}

it.each(['github', 'circleci'] as const)('prunes stale mirror branches and keeps shared %s branches until every ticket finishes', async provider => {
  const f = await fixture({}, { provider })
  const stale = `ci/${'a'.repeat(40)}`
  f.mirrorGit('update-ref', `refs/heads/${stale}`, 'main')
  f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
  f.mirrorGit('update-ref', 'refs/heads/feature/keep', 'main')
  const first = randomUUID()
  const second = randomUUID()
  const request = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  const activeState = provider === 'circleci' ? 'running' : 'starting'
  expect(await f.cloud.handle({ ...request, runId: first }))
    .toMatchObject({ operation: 'start', run: { state: activeState } })
  expectMirrorDispatch(provider, (provider === 'github' ? f.dispatched : f.circle.triggered)[0])
  expect(await f.cloud.handle({ ...request, runId: second }))
    .toMatchObject({ operation: 'start', run: { state: activeState } })
  expectMirrorDispatch(provider, (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1))
  expect(await f.reopen().handle({ operation: 'read', runId: second, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: activeState } })
  expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(2)
  const refs = () => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/')
  await expect.poll(refs, { timeout: 5_000 }).not.toContain(`refs/heads/${stale}`)
  await expect.poll(refs, { timeout: 5_000 }).not.toContain('refs/heads/ci/retired-run')
  expect(refs()).toContain('refs/heads/feature/keep')
  f.github.listed = [first, second].map((runId, index) => ({ databaseId: index + 8, displayTitle: `ci ${runId}` }))
  expect(await f.cloud.handle({ operation: 'cancel', runId: first }))
    .toMatchObject({ run: { state: activeState } })
  expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
  expect(await confirmCancellation(f, first)).toMatchObject({ run: { state: 'canceled' } })
  expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
  f.advance(5 * 60_000)
  expect(await confirmCancellation(f, second)).toMatchObject({ run: { state: 'canceled' } })
  await expect.poll(refs, { timeout: 5_000 }).not.toContain(`refs/heads/ci/${f.commit}`)
  expect(refs()).toContain('refs/heads/feature/keep')
  f.circle.runView = null
  Object.assign(f.github, { status: 'in_progress', conclusion: '' })
  await f.reopen().handle({ ...request, runId: randomUUID() })
  expectMirrorDispatch(provider, (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1))
  expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
})

it.each(['success', 'failure'] as const)('removes mirror branches after a %s result without losing persisted results', async conclusion => {
  const f = await fixture()
  const runId = randomUUID()
  expect(await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site', commit: f.commit,
    suite: 'lint', scope: 'affected', files: [] }))
    .toMatchObject({ operation: 'start', run: { state: 'starting' } })
  expect(f.dispatched[0]).toContain('octo/site-ci')
  f.github.listed = [{ databaseId: 8, displayTitle: `ci ${runId}` }]
  f.github.status = 'completed'
  f.github.conclusion = conclusion
  const read = { operation: 'read' as const, runId, afterOffset: 0, maxBytes: 65_536 }
  const state = conclusion === 'success' ? 'passed' : 'failed'
  f.advance(5 * 60_000)
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state }, text: expect.stringContaining('all green') })
  await expect.poll(() => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'), { timeout: 5_000 }).toBe('')
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state }, text: expect.stringContaining('all green') })
})


it.each(['configured', 'admitted'] as const)(
  'republishes a branch removed by maintenance after cleanup failed using its %s CircleCI mirror', async mirrorSource => {
  const f = await fixture({}, { provider: 'circleci', mirror: mirrorSource === 'configured' })
  const request = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    ...(mirrorSource === 'admitted' ? { ciMirror: 'octo/site-ci' } : {}),
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  const runId = randomUUID()
  expect(await f.cloud.handle({ ...request, runId }))
    .toMatchObject({ operation: 'start', run: { state: 'running' } })
  expectMirrorDispatch('circleci', f.circle.triggered[0])
  f.cleanup.unavailable = true
  f.advance(5 * 60_000)
  f.circle.outcome = 'succeeded'
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 }))
    .toMatchObject({ run: { state: 'passed' } })
  await expect.poll(() => f.cleanup.failures, { timeout: 5_000 }).toBeGreaterThan(0)
  const branch = `refs/heads/ci/${f.commit}`
  expect(f.mirrorGit('rev-parse', branch)).toMatch(/^[a-f0-9]{40}$/)
  // Maintenance in another process deletes the ref without touching the live publisher's memory.
  f.mirrorGit('update-ref', '-d', branch)
  f.cleanup.unavailable = false
  f.circle.outcome = ''
  const replacement = randomUUID()
  expect(await f.cloud.handle({ ...request, runId: replacement }))
    .toMatchObject({ operation: 'start', run: { state: 'running' } })
  expect(await f.reopen().handle({ operation: 'read', runId: replacement, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: 'running' } })
  expect(f.circle.triggered).toHaveLength(2)
  expectMirrorDispatch('circleci', f.circle.triggered.at(-1))
  expect(f.mirrorGit('rev-parse', branch)).toMatch(/^[a-f0-9]{40}$/)
})


it('releases stale provider records only when no active Main ticket still uses their branch', async () => {
  const f = await fixture()
  const first = randomUUID()
  const second = randomUUID()
  const start = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  expect(await f.cloud.handle({ ...start, runId: first }))
    .toMatchObject({ operation: 'start', run: { state: 'starting' } })
  expect(f.dispatched[0]).toContain('octo/site-ci')
  await f.cloud.handle({ ...start, runId: second })
  const branch = `refs/heads/ci/${f.commit}`
  await f.prune(new Set([second]))
  expect(f.mirrorGit('rev-parse', branch)).toMatch(/^[a-f0-9]{40}$/)
  await f.prune(new Set())
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
  // Sweeping refs does not rewrite the provider's saved observations.
  expect(await f.reopen().handle({ operation: 'read', runId: first, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'starting' } })
})


it.each(['github', 'circleci'] as const)('keeps publication scoped after cancellation and a %s provider restart', async provider => {
  const f = await fixture({}, { provider })
  const first = randomUUID()
  const second = randomUUID()
  const request = { operation: 'start' as const, workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
    suite: 'lint' as const, scope: 'affected' as const, files: [] }
  const activeState = provider === 'circleci' ? 'running' : 'starting'
  expect(await f.cloud.handle({ ...request, runId: first }))
    .toMatchObject({ operation: 'start', run: { state: activeState } })
  expect(await f.cloud.handle({ operation: 'cancel', runId: first }))
    .toMatchObject({ operation: 'cancel', run: { state: activeState } })
  expect(await confirmCancellation(f, first))
    .toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
  f.circle.runView = null
  Object.assign(f.github, { status: 'in_progress', conclusion: '' })
  const reopened = f.reopen()
  expect(await reopened.handle({ ...request, runId: second }))
    .toMatchObject({ operation: 'start', run: { state: activeState, provenance: { sourceCommit: f.commit } } })
  expect(await reopened.handle({ operation: 'read', runId: first, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: 'canceled' } })
  const commands = provider === 'github' ? f.dispatched : f.circle.triggered
  expect(commands).toHaveLength(2)
  for (const command of commands) {
    expectMirrorDispatch(provider, command)
  }
  expect(await f.reopen().handle({ operation: 'read', runId: second, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ operation: 'read', run: { state: activeState, provenance: { sourceCommit: f.commit } } })
  expect(commands).toHaveLength(2)
})
