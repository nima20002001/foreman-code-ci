import { expect, it, vi } from 'vitest'
import { PostgresCommandReceiptRetention } from '../src/modules/commands/receiptRetention.js'
import { workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, httpAdd, add, clones } from './helpers/workspaceRepositoryOnboarding.js'

it('recovers a committed repository location after cleanup runs beyond the retry snapshot window', async () => {
  const f = await workspaceRepositoryFixture()
  try {
    const input = await workspace(f)
    const set = f.roots.set.bind(f.roots)
    vi.spyOn(f.roots, 'set').mockImplementationOnce(async (...args) => {
      await set(...args)
      throw new Error('Location acknowledgment lost')
    })
    expect((await httpAdd(f, input)).status).toBe(500)
    const retention = new PostgresCommandReceiptRetention(f.pool)
    const future = Date.now() + 31 * 86_400_000
    for (let page = 0; page < 3; page++) await retention.prune(future)
    f.services.workspaceRepositories = f.recreate()
    const saved = await add(f, input)
    expect(saved.value).toMatchObject({ state: 'ready', operation: { commit: f.commit },
      location: { locationRevision: input.expectedLocationRevision + 1 } })
    expect(clones(f)).toBe(1)
    expect(await add(f, input)).toEqual({ ...saved, replayed: true })
  } finally {
    vi.restoreAllMocks()
    await f.close()
  }
}, 30_000)
