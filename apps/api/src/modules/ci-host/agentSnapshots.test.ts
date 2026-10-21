import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { agentSnapshots } from './agentSnapshots.js'

it.each(['main', 'device'] as const)('reads unchanged files on %s using the accepted worktree commit', async host => {
  const mainId = randomUUID()
  const deviceId = host === 'device' ? randomUUID() : null
  const commit = 'a'.repeat(40)
  const read = vi.fn(async () => ({ commit, bundle: null }))
  const pool = { query: async () => ({ rows: [{ record: {
    materialization: { receipt: { binding: { mainId, deviceId },
      worktree: { repository: 'octo/site', branch: 'foreman/agent', commit } } },
    workingTree: { canonicalProjectRoot: '/managed/agent/tree' },
  } }] }) } as unknown as pg.Pool
  expect(await agentSnapshots(pool, read)('execution')).toEqual({ baseCommit: commit, commit, bundle: null })
  expect(read).toHaveBeenCalledWith(deviceId ? { kind: 'device', mainId, deviceId } : { kind: 'main', mainId },
    '/managed/agent/tree', commit)
})

it('preserves a historical worktree startCommit as the base when its old approval named another commit', async () => {
  const commit = 'a'.repeat(40)
  const startCommit = 'b'.repeat(40)
  const read = vi.fn(async () => ({ commit: startCommit, bundle: null }))
  const pool = { query: async () => ({ rows: [{ record: {
    materialization: { receipt: { binding: { mainId: randomUUID(), deviceId: null },
      worktree: { repository: 'octo/site', branch: 'foreman/agent', commit, startCommit } } },
    workingTree: { canonicalProjectRoot: '/managed/agent/tree' },
  } }] }) } as unknown as pg.Pool
  expect(await agentSnapshots(pool, read)('execution'))
    .toEqual({ baseCommit: startCommit, commit: startCommit, bundle: null })
})

it('rejects an unchanged-file reply that names another commit', async () => {
  const pool = { query: async () => ({ rows: [{ record: {
    materialization: { receipt: { binding: { mainId: randomUUID(), deviceId: null },
      worktree: { repository: 'octo/site', branch: 'foreman/agent', commit: 'a'.repeat(40) } } },
    workingTree: { canonicalProjectRoot: '/managed/agent/tree' },
  } }] }) } as unknown as pg.Pool
  await expect(agentSnapshots(pool, async () => ({ commit: 'b'.repeat(40), bundle: null }))('execution'))
    .rejects.toMatchObject({ code: 'SOURCE_SNAPSHOT_INVALID' })
})
