import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { fixture } from './cloud.testSupport.js'

afterEach(() => vi.restoreAllMocks())

it.each(['github', 'circleci'] as const)(
  'retains an early %s comparison publication created during the remote listing', async provider => {
    const f = await fixture({}, { provider })
    const listing = deferred()
    const releaseListing = deferred()
    const original = f.git.git.bind(f.git)
    let mainPushes = 0
    vi.spyOn(f.git, 'git').mockImplementation(async (args, options) => {
      if (args[0] === 'ls-remote') {
        listing.resolve()
        await releaseListing.promise
      }
      if (args[0] === 'push' && args.some(arg => arg.endsWith(':refs/heads/main'))) mainPushes++
      return original(args, options)
    })
    try {
      await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId: randomUUID(),
        repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
      await listing.promise
      await f.write('README.md', 'Later source snapshot\n')
      f.run('add', '.')
      f.run('commit', '-qm', 'later source snapshot')
      f.push('main')
      const commit = f.run('rev-parse', 'HEAD')
      await f.cloud.publishMirror({ repository: 'octo/site', mirror: 'octo/site-ci', commit,
        defaultBranch: 'main' })
      const branch = `refs/heads/ci-default/${commit}`
      const comparison = f.mirrorGit('rev-parse', branch)
      releaseListing.resolve()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')

      const runId = randomUUID()
      const started = await f.reopen().handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
        repository: 'octo/site', commit, suite: 'lint', scope: 'affected', defaultBranch: 'main' })
      expect(mainPushes).toBe(2)
      expect(started).toMatchObject({ run: { provenance: { sourceCommit: commit, workflowCommit: comparison } } })
      const command = (provider === 'github' ? f.dispatched : f.circle.triggered).at(-1)!
      expect(command).toContain(`default_branch=ci-default/${commit}`)
      expect(f.mirrorGit('for-each-ref', '--format=%(refname)', branch)).toBe(branch)
      expect(f.mirrorGit('rev-parse', branch)).toBe(comparison)
      expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
        .toMatchObject({ run: { provenance: { sourceCommit: commit, workflowCommit: comparison } } })
    } finally {
      releaseListing.resolve()
      await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    }
  },
)
