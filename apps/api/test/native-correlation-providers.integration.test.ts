import { expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { nativeCorrelationProvidersMigration } from '../src/infrastructure/nativeCorrelationProvidersMigration.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'

it('upgrades existing native correlations for Claude while preserving historical providers and rejecting unknown ones', async () => {
  const f = await checkpointRuntimeFixture()
  try {
    await f.engine.start(f.f.run.id)
    const before = (await f.db.pool.query<{ execution_id: string; native_session_id: string }>(
      'select execution_id,native_session_id from run_native_correlations where run_id=$1 order by execution_id',
      [f.f.run.id])).rows
    expect(before.length).toBeGreaterThan(0)
    // Recreate the installed schema before this migration, retaining its existing rows.
    await f.db.pool.query(`alter table run_native_correlations drop constraint run_native_correlations_provider_check;
      alter table run_native_correlations add constraint run_native_correlations_provider_check
        check (provider in ('codex','opencode'))`)
    await f.db.pool.query('delete from application_migrations where version=$1', [nativeCorrelationProvidersMigration.version])
    const update = (provider: string) => f.db.pool.query(
      'update run_native_correlations set provider=$2 where run_id=$1', [f.f.run.id, provider])
    await expect(update('claude')).rejects.toMatchObject({ code: '23514' })
    await applyApplicationMigrations(f.db.pool)
    for (const provider of ['claude', 'codex', 'opencode']) {
      await update(provider)
      const rows = (await f.db.pool.query<{ execution_id: string; native_session_id: string; provider: string }>(
        'select execution_id,native_session_id,provider from run_native_correlations where run_id=$1 order by execution_id',
        [f.f.run.id])).rows
      expect(rows).toEqual(before.map(row => ({ ...row, provider })))
    }
    await expect(update('unknown')).rejects.toMatchObject({ code: '23514' })
    await applyApplicationMigrations(f.db.pool)
    expect((await f.db.pool.query<{ provider: string }>(
      'select provider from run_native_correlations where run_id=$1', [f.f.run.id])).rows)
      .toEqual(before.map(() => ({ provider: 'opencode' })))
  } finally {
    await f.close()
  }
}, 60_000)
