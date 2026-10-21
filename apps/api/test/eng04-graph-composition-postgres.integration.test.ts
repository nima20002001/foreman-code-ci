import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalGraphJson, RepeatGraphPageV3Schema, reduceRepeatGraphPageV3, RUN_GRAPH_LIMITS,
  type RepeatGraphFactV3,
} from '@foreman-code/contracts/wave25'
import { currentDatabase as agent3Database, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import {
  graphFixture, graphPosition, ownedGraph, changeRunState, privateCanary,
  type GraphFixture, type GraphTestDatabase,
} from './eng04-graph-composition-fixture.js'
import { beforeGraphCommit, withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { openRunGraphPublication, graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { publishRepeatRunStateLocked } from '../src/modules/run-graph/repeatPublication.js'
import { publishRepeatStoppedRunLocked, repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { RepeatGraphReadService } from '../src/modules/run-graph/repeatReadService.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'

/** Actual application migrations, independent PG owner sessions, primary reads
 * and canonical producers. Explicit disposable DB opt-in; no native adapters.
 * The source-only handoff does NOT claim these tests ran in its authoring host.
 */
describe.skipIf(!postgresEnabled)('ENG04 graph composition / disposable PostgreSQL', () => {
  let db: GraphTestDatabase
  const fixtures: GraphFixture[] = []
  beforeAll(async () => { db = await agent3Database() }, 60000)
  afterEach(async () => { await Promise.all(fixtures.splice(0).map((t) => t.app.close())) })
  afterAll(async () => { await db?.close() })
  async function fixture(insert = true) {
    const t = await graphFixture(db, { insert, qualifiedReads: true }); fixtures.push(t); return t
  }
  const snapshot = (t: GraphFixture) => t.repeat.snapshot(t.writer.principal, t.readRequest)
  const events = (t: GraphFixture, afterSequence: string) => t.repeat.events(t.writer.principal, { ...t.readRequest, afterSequence })

  it('initializes exactly the queued admission cut and permanent revision-zero receipt without lazy children or private fields', async () => {
    const t = await fixture(), value = await snapshot(t)
    expect(value).toMatchObject({ asOfSequence: '1', historyCoverage: 'from_admission', state: {
      run: { executionState: 'queued', outcome: 'pending', stopRequested: false }, occurrences: [], executions: [],
      decisions: [], results: [], resolutions: [], bindings: [],
    } })
    const receipt = (await db.pool.query(`select source_digest,semantic_digest,first_sequence::text from run_graph_sources
      where run_id=$1 and source_kind='run' and source_id=$1 and source_revision=0`, [t.run.id])).rows
    expect(receipt).toEqual([{ source_digest: graphSourceDigest(t.run), semantic_digest: graphSourceDigest([
      { type: 'repeat.run.state', state: value.state.run },
    ]), first_sequence: '1' }])
    const current = await t.repeat.current(t.writer.principal, t.readRequest)
    expect(current).toEqual({ ...value, kind: 'current' })
    const serialized = canonicalGraphJson({ current, page: await events(t, '0') })
    expect(serialized).not.toContain(privateCanary)
    expect(serialized).not.toContain(db.directory)
    expect(serialized).not.toContain(t.writer.principal.id)
    await expect(withExclusiveGraphConnection(db.pool, (connection) => connection.transaction((sql) =>
      repeatStartPublication.initializeLocked(sql, t.accepted)))).rejects.toMatchObject({ code: 'GRAPH_SOURCE_CONFLICT' })
    expect(await graphPosition(db, t)).toBe('1')
  })

  it('rolls back the Run, baseline and receipts when the accepted cut changes before COMMIT', async () => {
    const t = await fixture(false)
    await expect(withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      await insertRepeatRun(sql, t.accepted, repeatStartPublication)
      await sql.query(`update runs set execution_state='running',record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [t.run.id])
    }))).rejects.toBeDefined()
    for (const table of ['runs', 'run_graph_heads', 'run_graph_sources']) {
      expect((await db.pool.query(`select 1 from ${table} where ${table === 'runs' ? 'id' : 'run_id'}=$1`, [t.run.id])).rowCount).toBe(0)
    }
  })

  it('does not collapse A→B→A, sorts source revisions numerically beyond nine, and survives owner/reader reconstruction', async () => {
    const t = await fixture(), initial = await snapshot(t)
    for (let i = 0; i < 12; i++) await changeRunState(db, t, i % 2 === 0 ? 'running' : 'waiting')
    expect(await graphPosition(db, t)).toBe('13')
    // Each helper releases the old real owner. The new reader has no cached cut.
    const restarted = new RepeatGraphReadService(db.pool, { qualifiedReads: true })
    const after = await restarted.snapshot(t.writer.principal, t.readRequest)
    const page = RepeatGraphPageV3Schema.parse(await events(t, '1'))
    expect(page).toMatchObject({ throughSequence: '13', headSequence: '13', hasMore: false })
    expect(reduceRepeatGraphPageV3(initial, page)).toEqual(after)
    await changeRunState(db, t, 'waiting')
    expect(await graphPosition(db, t)).toBe('13')
    expect(await snapshot(t)).toEqual(after)
  }, 15_000)

  it('enlists a real ownerless SQL Stop, permits exact receipt replay and rejects progress after Stop', async () => {
    const t = await fixture(), initial = await snapshot(t)
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      await sql.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [t.run.id])
      await publishRepeatStoppedRunLocked(publication)
    }))
    expect(await graphPosition(db, t)).toBe('2')
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) =>
      publishRepeatStoppedRunLocked(await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked))))
    expect(await graphPosition(db, t)).toBe('2')
    const page = RepeatGraphPageV3Schema.parse(await events(t, '1'))
    expect(reduceRepeatGraphPageV3(initial, page)).toEqual(await snapshot(t))
    let mutated = false
    await expect(ownedGraph(db, t, (owner) => owner.oneShotConnection().transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      await publication.repeatChange({ evidence: { sourceKind: 'run', sourceId: 'test-stop-progress', sourceRevision: '1' },
        sourceDigest: graphSourceDigest('stop-progress'), effect: null }, owner,
      async () => { mutated = true }, async () => [{ type: 'repeat.run.state', state: initial.state.run }])
    }))).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
    expect(mutated).toBe(false)
    expect(await graphPosition(db, t)).toBe('2')
  })

  it('rolls back on actual advisory owner-fence loss before COMMIT, even after publication was staged', async () => {
    const t = await fixture()
    await expect(ownedGraph(db, t, (owner) => owner.oneShotConnection().transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      await sql.query(`update runs set execution_state='running',record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [t.run.id])
      await publishRepeatRunStateLocked(publication, owner)
      // Real session lock loss; not a mocked owner or a native process claim.
      expect((await sql.query<{ unlocked: boolean }>('select pg_advisory_unlock(810002,hashtext($1)) as unlocked', [t.run.id])).rows[0]?.unlocked).toBe(true)
    }))).rejects.toBeDefined()
    expect(await graphPosition(db, t)).toBe('1')
    expect((await snapshot(t)).state.run.executionState).toBe('queued')
  })

  it('rolls back after actual owner loss in an intervening commit finalizer', async () => {
    const t = await fixture(), before = await snapshot(t)
    await expect(ownedGraph(db, t, owner => owner.oneShotConnection().transaction(async sql => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      await sql.query(`update runs set execution_state='running',record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [t.run.id])
      await publishRepeatRunStateLocked(publication, owner)
      beforeGraphCommit(sql, async () => {
        expect((await sql.query<{ unlocked: boolean }>('select pg_advisory_unlock(810002,hashtext($1)) as unlocked', [t.run.id])).rows[0]?.unlocked).toBe(true)
      })
      await publication.repeatRunReadback({ evidence: { sourceKind: 'run', sourceId: 'after-finalizer', sourceRevision: '1' },
        sourceDigest: graphSourceDigest('after-finalizer') }, owner,
      async () => [{ type: 'repeat.run.state', state: { ...before.state.run, executionState: 'running' } }])
    }))).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
    expect(await graphPosition(db, t)).toBe('1')
    expect((await snapshot(t)).state.run.executionState).toBe('queued')
    expect((await db.pool.query("select 1 from run_graph_sources where run_id=$1 and source_id='after-finalizer'", [t.run.id])).rowCount).toBe(0)
  })

  it('cannot borrow a real owner on a different PostgreSQL session', async () => {
    const t = await fixture()
    await expect(ownedGraph(db, t, (owner) => withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      await publishRepeatRunStateLocked(publication, owner)
    })))).rejects.toBeDefined()
    expect(await graphPosition(db, t)).toBe('1')
  })

  describe('oversized atomic publication fixture', () => {
    let t: GraphFixture
    let before: Awaited<ReturnType<typeof snapshot>>
    beforeEach(async () => { t = await fixture(); before = await snapshot(t) })
    it('uses one bounded reset for an oversized atomic change and retains every source after pruning its batch', async () => {
    const fact: RepeatGraphFactV3 = { type: 'repeat.run.state', state: before.state.run }
    const count = RUN_GRAPH_LIMITS.batchEvents + 1
    // White-box journal capacity test: distinct test source identities point to
    // the ACTUAL same physical metadata. No engine/native evidence is invented.
    const publish = () => ownedGraph(db, t, (owner) => owner.oneShotConnection().transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      for (let i = 0; i < count; i++) await publication.repeatRunReadback({
        evidence: { sourceKind: 'run', sourceId: `capacity-source-${i}`, sourceRevision: '1' },
        sourceDigest: graphSourceDigest({ testSource: i, fact }),
      }, owner, async () => [fact])
    }))
    await publish()
    expect(await graphPosition(db, t)).toBe('2')
    expect((await db.pool.query('select kind,payload from run_graph_batches where run_id=$1 and sequence=2', [t.run.id])).rows)
      .toEqual([{ kind: 'reset', payload: null }])
    expect(await events(t, '1')).toMatchObject({ kind: 'reset', reason: 'atomic_change_too_large', action: 'fetch_snapshot' })
    expect((await snapshot(t)).state).toEqual(before.state)
    const receiptCount = async () => (await db.pool.query(`select count(*)::int as n from run_graph_sources
      where run_id=$1 and source_id like 'capacity-source-%'`, [t.run.id])).rows[0]!.n as number
    expect(await receiptCount()).toBe(count)
    await withExclusiveGraphConnection(db.pool, (connection) => connection.transaction(async (sql) => {
      await sql.query('select run_id from run_graph_heads where run_id=$1 for update', [t.run.id])
      await sql.query('update run_graph_heads set retention_floor=2 where run_id=$1', [t.run.id])
      await sql.query('delete from run_graph_batches where run_id=$1 and sequence<=2', [t.run.id])
    }))
    await publish()
    expect(await graphPosition(db, t)).toBe('2')
    expect(await receiptCount()).toBe(count)
    expect(await events(t, '1')).toMatchObject({ kind: 'reset', reason: 'history_expired' })
    expect(await events(t, '2')).toMatchObject({ kind: 'page', batches: [], throughSequence: '2', hasMore: false })
    })
  })

  it('rejects a reordered complete source group via its permanent ordered-envelope receipt', async () => {
    const t = await fixture(), initial = await snapshot(t)
    await ownedGraph(db, t, (owner) => owner.oneShotConnection().transaction(async (sql) => {
      const publication = await openRunGraphPublication(sql, t.scope, readPublicProjectionLocked)
      for (const id of ['ordering-a', 'ordering-b']) await publication.repeatRunReadback({
        evidence: { sourceKind: 'run', sourceId: id, sourceRevision: '1' }, sourceDigest: graphSourceDigest(id),
      }, owner, async () => [{ type: 'repeat.run.state', state: initial.state.run }])
    }))
    const original = RepeatGraphPageV3Schema.parse(await events(t, '1'))
    const reversed = { ...original.batches[0]!, events: [...original.batches[0]!.events].reverse() }
    // Every individual source/effect receipt is unchanged. Only order differs.
    await db.pool.query('update run_graph_batches set payload=$2 where run_id=$1 and sequence=2', [t.run.id, canonicalGraphJson(reversed)])
    expect(await events(t, '1')).toMatchObject({ kind: 'reset', reason: 'schema_changed' })
    await db.pool.query('delete from run_graph_batches where run_id=$1 and sequence=2', [t.run.id])
    expect(await events(t, '1')).toMatchObject({ kind: 'reset', reason: 'gap' })
  })

  it('refuses a false complete empty delta after an unjournaled domain mutation', async () => {
    const t = await fixture()
    await db.pool.query(`update runs set execution_state='running',record=jsonb_set(record,'{executionState}','"running"') where id=$1`, [t.run.id])
    await expect(snapshot(t)).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
    await expect(events(t, '1')).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
  })

  it('rechecks physical configuration pins even for an empty delta', async () => {
    const t = await fixture()
    const id = t.f.configurations[0]!.id
    // Intentional fixture corruption: immutable parser must compare physical
    // identity/version with its JSON, rather than trusting current Agent heads.
    await db.pool.query(`update agent_configuration_versions set record=jsonb_set(record,'{id}','"other-configuration"') where id=$1`, [id])
    await expect(snapshot(t)).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
    await expect(events(t, '1')).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
  })
})
