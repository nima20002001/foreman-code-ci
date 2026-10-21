import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { JobSql } from './repository.js'
import { openMainJobJournal } from './mainJobJournal.js'

describe('Main Job journal initialization', () => {
  it('creates only the first empty journal and preserves its bytes on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'main-job-journal-'))
    const path = join(root, 'journal')
    const query = vi.fn(async () => ({ rows: [{ owned: false }] }))
    const sql = { query } as unknown as JobSql
    try {
      const first = await openMainJobJournal({ sql, path, mainId: 'main', initialization: 'bootstrap' })
      await first.close()
      const bytes = await readFile(path)
      const restarted = await openMainJobJournal({ sql, path, mainId: 'main', initialization: 'existing-only' })
      await restarted.close()
      expect(await readFile(path)).toEqual(bytes)
      expect(query).toHaveBeenCalledOnce()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['retained-operations', 'runtime-retry'] as const)(
    'refuses missing history for %s without creating a replacement file', async reason => {
      const root = await mkdtemp(join(tmpdir(), 'main-job-journal-'))
      const path = join(root, 'journal')
      const sql = { query: async () => ({ rows: [{ owned: true }] }) } as unknown as JobSql
      try {
        await expect(openMainJobJournal({ sql, path, mainId: 'main',
          initialization: reason === 'runtime-retry' ? 'existing-only' : 'bootstrap' }))
          .rejects.toMatchObject({ code: 'JOB_JOURNAL_RECOVERY_REQUIRED' })
        await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally { await rm(root, { recursive: true, force: true }) }
    })
})
