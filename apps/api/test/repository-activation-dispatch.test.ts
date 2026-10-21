import { afterEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { PostgresRunRepository, runRepositorySemantics } from '../src/modules/runs/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { unavailableRuntime, currentRepositoryFixture } from './eng04-runtime-repository-fixture.js'

// Snapshot delegation is doubled here; the PostgreSQL suite tests real reads.
function fixture() {
  const f = currentRepositoryFixture(), query = vi.fn(async () => ({ rows: [{ id: f.run.id }], rowCount: 1 }))
  const pool = { query } as unknown as pg.Pool
  type Args = ConstructorParameters<typeof PostgresRunRepository>
  const owner = { runId: f.run.id, client: { query }, oneShotConnection: () => ({ unusable: false }), assertOwned: vi.fn() } as unknown as RunOwnership
  const repository = new PostgresRunRepository(pool, {} as Args[1], { revalidateRunAuthorization: async () => { throw new Error('unexpected authority work') } } as unknown as Args[2], unavailableRuntime())
  const read = vi.spyOn(repository, 'getRepeatSnapshot').mockResolvedValue({ run: f.run, version: f.version,
    configurations: f.f.configurations, stopRequested: false, cleanupPending: false })
  return { f, query, pool, owner, repository, read }
}
afterEach(() => vi.restoreAllMocks())
describe('current repository activation and immutable pins', () => {
  it('rejects repository composition without its native capture proof service', () => {
    expect(() => Reflect.construct(PostgresRunRepository, [{}, {}, {}, undefined]))
      .toThrowError(expect.objectContaining({ code: 'NATIVE_CAPTURE_COMPOSITION_REQUIRED' }))
  })
  it('accepts only explicit semantics 3', () => expect(runRepositorySemantics({ executionSemanticsVersion: 3 })).toBe(3))
  it.each([undefined, null, 1, 2, '3', 0, 4, true, {}, []])('rejects unsupported saved tag %j', (tag) => {
    expect(() => runRepositorySemantics({ executionSemanticsVersion: tag })).toThrowError(expect.objectContaining({ code: 'EXECUTION_SEMANTICS_UNSUPPORTED' }))
  })
  it('rejects an absent saved tag', () => expect(() => runRepositorySemantics({})).toThrow())
  it.each([null, undefined, [], '3'])('rejects non-record %j', (record) => expect(() => runRepositorySemantics(record)).toThrow())
  it('reads semantics from the exact accepted snapshot', async () => {
    const t = fixture()
    await expect(t.repository.executionSemantics(t.f.run.id, t.owner)).resolves.toBe(3)
    expect(t.read).toHaveBeenCalledExactlyOnceWith(t.f.run.id, t.owner)
  })
  it('reads the accepted Run with the same owner', async () => {
    const t = fixture()
    await expect(t.repository.get(t.f.run.id, t.owner)).resolves.toEqual(t.f.run)
    expect(t.read).toHaveBeenCalledExactlyOnceWith(t.f.run.id, t.owner)
  })
  it('rejects cross-Run owners before querying', async () => {
    const t = fixture()
    await expect(t.repository.get('another-run', t.owner)).rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
    expect(t.query).not.toHaveBeenCalled(); expect(t.read).not.toHaveBeenCalled()
  })
  it('one factory retains one store per owner without transferring launch permits', async () => {
    const t = fixture(), first = await t.repository.repeat(t.owner)
    expect(await t.repository.repeat(t.owner)).toBe(first)
    const successor = { ...t.owner } as RunOwnership
    expect(await t.repository.repeat(successor)).not.toBe(first)
    expect(t.repository.consumeRepeatLaunch('unadmitted', successor)).toBe(false)
    expect(t.repository.repeatRepositoryFactory()).toBe(t.repository.repeatRepositoryFactory())
  })
  it('lost owners cannot consume launch permits or open a store', async () => {
    const t = fixture(); vi.mocked(t.owner.assertOwned).mockImplementation(() => { throw new Error('owner lost') })
    await expect(t.repository.repeat(t.owner)).rejects.toThrow('owner lost')
    expect(() => t.repository.consumeRepeatLaunch('unadmitted', t.owner)).toThrow('owner lost')
  })
  it('a version cannot be read under another immutable pin', async () => {
    const t = fixture()
    await expect(t.repository.getRepeatVersion(t.f.run.id, 'different-version', t.owner)).rejects.toMatchObject({ code: 'RUN_PIN_CONFLICT' })
  })
})
