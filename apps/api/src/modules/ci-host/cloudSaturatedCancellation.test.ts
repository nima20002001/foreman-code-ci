import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { readCloudRun } from './cloudJournal.js'

afterEach(() => vi.restoreAllMocks())

it('cancels and inspects a known GitHub attempt while saturated discovery retains ownership', async () => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  expect(await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'running' } })
  f.github.listed = Array.from({ length: 1000 }, (_, index) => ({ databaseId: 1000 + index,
    displayTitle: `ci other-${index}`, headSha: f.commit }))
  const cancel = { operation: 'cancel', runId } as const
  const reads = f.github.jobReads.length
  await expect(f.cloud.handle(cancel)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
  expect(f.github.canceled).toEqual(['91'])
  expect(f.github.jobReads.length).toBeGreaterThan(reads)
  Object.assign(f.github, { status: 'completed', conclusion: 'cancelled' })
  f.advance(75_001)
  await expect(f.reopen().handle(cancel)).rejects.toMatchObject({ code: 'CI_CLOUD_DISCOVERY_INCOMPLETE' })
  const saved = await readCloudRun(join(f.root, 'ci-cloud', 'runs', runId, 'meta.json'))
  expect(saved).toMatchObject({ state: 'running', providerRunId: '91',
    dispatchHistory: expect.arrayContaining([{ at: expect.any(String), providerRunId: '91', terminated: true }]),
    cancellation: { canceledIds: ['91'] } })
  expect(saved.cancellation?.completedAt).toBeUndefined()
  f.github.listed = f.github.listed.slice(0, 200)
  expect(await f.reopen().handle(cancel)).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
})
