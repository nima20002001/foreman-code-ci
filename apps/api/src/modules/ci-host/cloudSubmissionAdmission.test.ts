import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'
import { readCloudRun } from './cloudJournal.js'

vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof fs>()
  return { ...actual, open: vi.fn(actual.open) }
})

afterEach(() => vi.restoreAllMocks())

it.each(['github', 'circleci'] as const)(
  'retries an unsent %s submission after the final journal sync fails', async provider => {
    const f = await fixture({}, { provider })
    const runId = randomUUID()
    const directory = join(f.root, 'ci-cloud', 'runs', runId)
    const path = join(directory, 'meta.json')
    const failure = new Error('Fixture journal directory sync failed')
    const actual = await vi.importActual<typeof fs>('node:fs/promises')
    let interrupted = false
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (String(args[0]) === directory && !interrupted) {
        const saved = await readCloudRun(path)
        if (saved.dispatch?.uncertain) {
          interrupted = true
          vi.spyOn(handle, 'sync').mockRejectedValueOnce(failure)
        }
      }
      return handle
    })
    try {
      await expect(f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
        repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toBe(failure)
      expect(interrupted).toBe(true)
      expect(f.dispatched).toEqual([])
      expect(f.circle.triggered).toEqual([])
      expect(await readCloudRun(path)).toMatchObject({
        dispatch: { uncertain: false, notSent: true, attempts: 1 },
      })
      const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 } as const
      f.advance(74_999)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
      expect([...f.dispatched, ...f.circle.triggered]).toEqual([])
      f.advance(1)
      expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'starting' } })
      expect([...f.dispatched, ...f.circle.triggered]).toHaveLength(1)
      expect(await f.reopen().handle(read)).toMatchObject({
        run: { state: provider === 'github' ? 'starting' : 'running' },
      })
      expect([...f.dispatched, ...f.circle.triggered]).toHaveLength(1)
    } finally {
      vi.mocked(fs.open).mockImplementation(actual.open)
    }
  },
)
