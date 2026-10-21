import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { readCloudRun } from './cloudJournal.js'

it('leaves a start interrupted by API shutdown for the next process instead of failing it', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  const ref = `ci/${f.commit}-${runId}`
  const original = f.git.git
  let shuttingDown = true
  f.git.git = async (args, options) => {
    if (shuttingDown && args[0] === 'push' && args.some(value => value.endsWith(`:refs/heads/${ref}`))) {
      // The API begins shutdown while publication runs; its database pool is then closed.
      f.cloud.stop()
      throw new Error('Cannot use a pool after calling end on the pool')
    }
    return original(args, options)
  }
  const start = { operation: 'start', runId, workspaceId: 'ci-workspace', repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full', deferMirror: true } as const
  await f.cloud.handle(start)
  await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  const meta = join(f.root, 'ci-cloud', 'runs', runId, 'meta.json')
  const interrupted = await readCloudRun(meta)
  expect(interrupted).toMatchObject({ state: 'starting', finishedAt: null, providerRunId: null })
  expect(interrupted.publicationRequest).toBeDefined()
  expect(f.circle.triggered).toEqual([])

  shuttingDown = false
  const next = f.reopen()
  expect(await next.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'starting' } })
  await next.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  expect(f.circle.triggered).toHaveLength(1)
  expect(await readCloudRun(meta)).toMatchObject({ state: 'running' })
})
