import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { confirmCancellation, fixture } from './cloud.testSupport.js'

it('protects a live branch journaled under a recovered secondary account root', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const branch = 'ci/protected-execution'
  f.mirrorGit('update-ref', `refs/heads/${branch}`, 'main')
  const runId = randomUUID()
  const directory = join(f.root, 'circleci~reserve@delta', 'runs', runId)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId, mirror: 'octo/site-ci', commit: f.commit,
    state: 'running', startedAt: new Date().toISOString(), mirrorBranch: branch, circleAccountId: 'reserve' }))
  const startedId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: startedId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  await confirmCancellation(f, startedId)
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/${branch}`)).toBe(`refs/heads/${branch}`)
})

it.each(['github', 'circleci'] as const)(
  'waits for cancellation cleanup queued during an active %s sweep', async provider => {
    const f = await fixture({}, { provider })
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstSweep = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondSweep = new Promise<void>(resolve => { releaseSecond = resolve })
    let sweeps = 0
    f.cloud.setActiveRunLookup(async () => {
      sweeps++
      await (sweeps === 1 ? firstSweep : secondSweep)
      return { ids: new Set<string>(), readAt: 0 }
    })
    const runId = randomUUID()
    let cleanup: Promise<void> | undefined
    try {
      await f.cloud.handle({
        operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
        runId, suite: 'lint', scope: 'full',
      })
      await expect.poll(() => sweeps).toBe(1)
      expect(await confirmCancellation(f, runId))
        .toMatchObject({ run: { state: 'canceled' } })
      let cleanupFinished = false
      cleanup = f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci').then(() => {
        cleanupFinished = true
      })
      releaseFirst()
      await expect.poll(() => sweeps).toBe(2)
      expect(cleanupFinished).toBe(false)
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'))
        .toContain(`refs/heads/ci/${f.commit}`)
      releaseSecond()
      await cleanup
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
      expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
        .toMatchObject({ run: { state: 'canceled' } })
      expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
    } finally {
      releaseFirst()
      releaseSecond()
      await cleanup
    }
  },
)

it.each(['github', 'circleci'] as const)(
  'drains a due cancellation sweep queued during %s mirror cleanup', async provider => {
    const f = await fixture({}, { provider })
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const sweeping = new Promise<void>(resolve => { entered = resolve })
    f.cloud.setActiveRunLookup(async () => {
      entered()
      await blocked
      return { ids: new Set<string>(), readAt: 0 }
    })
    const runId = randomUUID()
    const branch = `refs/heads/ci/${f.commit}`
    try {
      await f.cloud.handle({
        operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
        runId, suite: 'lint', scope: 'full',
      })
      await sweeping
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', branch)).toBe(branch)
      f.advance(5 * 60_000)
      expect(await confirmCancellation(f, runId))
        .toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
    } finally {
      release()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    }
    expect(f.mirrorGit('for-each-ref', '--format=%(refname)', branch)).toBe('')
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ operation: 'read', run: { state: 'canceled' } })
    expect(provider === 'github' ? f.dispatched : f.circle.triggered).toHaveLength(1)
  },
)

it.each(['github', 'circleci'] as const)(
  'removes a canceled %s branch after an in-flight sweep already retained it', async provider => {
    const f = await fixture({}, { provider })
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let deleting = false
    const git = f.git.git.bind(f.git)
    vi.spyOn(f.git, 'git').mockImplementation(async (args, options) => {
      if (args[0] === 'push' && args.includes('--atomic')) {
        deleting = true
        await blocked
      }
      return git(args, options)
    })
    const runId = randomUUID()
    try {
      await f.cloud.handle({
        operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
        runId, suite: 'lint', scope: 'full',
      })
      await expect.poll(() => deleting, { timeout: 5_000 }).toBe(true)
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/'))
        .toContain(`refs/heads/ci/${f.commit}`)
      expect(await confirmCancellation(f, runId))
        .toMatchObject({ operation: 'cancel', run: { state: 'canceled' } })
    } finally {
      release()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    }
    expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ operation: 'read', run: { state: 'canceled' } })
  },
)

it.each(['github', 'circleci'] as const)(
  'prunes stale branches while another %s ticket awaits its first metadata write', async provider => {
    const f = await fixture({}, { provider })
    await mkdir(join(f.root, 'ci-cloud', 'runs', randomUUID()), { recursive: true })
    f.mirrorGit('update-ref', 'refs/heads/ci/retired-run', 'main')
    f.mirrorGit('update-ref', 'refs/heads/feature/keep', 'main')
    const runId = randomUUID()
    const activeState = provider === 'github' ? 'starting' : 'running'
    expect(await f.cloud.handle({
      operation: 'start', workspaceId: 'ci-workspace', repository: 'octo/site', commit: f.commit,
      runId, suite: 'lint', scope: 'affected', files: [],
    })).toMatchObject({ operation: 'start', run: { state: activeState } })

    const refs = () => f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/')
    await expect.poll(refs, { timeout: 5_000 }).not.toContain('refs/heads/ci/retired-run')
    expect(refs()).toContain('refs/heads/feature/keep')
    expect(refs()).toContain(`refs/heads/ci/${f.commit}`)
    expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .toMatchObject({ operation: 'read', run: { state: activeState } })
  },
)
