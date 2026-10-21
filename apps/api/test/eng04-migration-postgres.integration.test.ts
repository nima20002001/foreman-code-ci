import assert from 'node:assert/strict'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { repeatOccurrenceMigration } from '../src/infrastructure/repeatOccurrenceMigration.js'
import {
  acceptResult, acceptedResult, decision, digest, disposableDatabase, evidenceTables,
  execution, finishOccurrence, insertDecision, insertExecution, insertOccurrence,
  insertResolution, installPreRepeatRegistry, now, occurrence, seedRun, text, transaction,
  type JsonObject,
} from './eng04-migration-fixtures.js'

const timeout = 120_000

async function rejectsTransaction(pool: pg.Pool, work: (sql: pg.PoolClient) => Promise<unknown>,
  codes: readonly string[], message?: RegExp): Promise<void> {
  let failure: unknown
  try { await transaction(pool, work) } catch (error) { failure = error }
  expect(failure, 'The invalid transaction must fail, including deferred COMMIT checks').toBeInstanceOf(Error)
  expect(codes).toContain((failure as { code?: string }).code)
  if (message) expect((failure as Error).message).toMatch(message)
}

async function migrated<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
  return disposableDatabase(async (pool) => {
    await applyApplicationMigrations(pool)
    return work(pool)
  })
}

async function counts(pool: pg.Pool, runId: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const table of evidenceTables) {
    const rows = await pool.query<{ n: string }>(`select count(*) as n from ${table} where run_id=$1`, [runId])
    result[table] = Number(rows.rows[0]!.n)
  }
  return result
}

async function completeTwoOccurrences(pool: pg.Pool, id: string) {
  return transaction(pool, async (sql) => {
    const run = await seedRun(sql, id)
    const first = occurrence(run)
    await insertOccurrence(sql, first)
    const one = execution(run, first)
    await insertExecution(sql, one)
    const progressed = await finishOccurrence(sql, one)
    assert.ok(progressed.successor)
    const two = execution(run, progressed.successor)
    await insertExecution(sql, two)
    const final = await finishOccurrence(sql, two)
    expect(final.decision.record.reason).toBe('limit_exit')
    expect(final.successor).toBeNull()
    return { run, first, one, second: progressed.successor, two, firstDecision: progressed.decision, final: final.decision }
  })
}

async function schemaState(pool: pg.Pool) {
  const constraints = await pool.query(`select conname, pg_get_constraintdef(oid) as definition
    from pg_constraint where conrelid in ('workflow_versions'::regclass,'harness_executions'::regclass)
    order by conname`)
  const columns = await pool.query(`select column_name, data_type, is_nullable from information_schema.columns
    where table_schema='public' and table_name='harness_executions' order by ordinal_position`)
  const indexes = await pool.query(`select indexname,indexdef from pg_indexes where schemaname='public'
    and tablename='harness_executions' order by indexname`)
  const versions = await pool.query('select version,applied_at::text from application_migrations order by version')
  const repeat = await pool.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname like 'run_repeat_%' order by c.relname`)
  const functions = await pool.query(`select p.proname,pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and (p.proname like '%repeat%' or p.proname like '%run_graph%') order by p.proname`)
  return { constraints: constraints.rows, columns: columns.rows, indexes: indexes.rows,
    versions: versions.rows, repeat: repeat.rows, functions: functions.rows }
}

describe('ENG04 migration successor — real PostgreSQL 17 V3 constraint gate', () => {
  it('installs the current registry idempotently and retains the exact execution identity FK target', async () => {
    await migrated(async (pool) => {
      const installed = await schemaState(pool)
      await applyApplicationMigrations(pool)
      expect(await schemaState(pool)).toEqual(installed)
      expect(migrations.filter((item) => item.version === repeatOccurrenceMigration.version)).toHaveLength(1)
      expect(new Set(migrations.map((item) => item.version)).size).toBe(migrations.length)
      const target = await pool.query(`select i.indisunique,i.indisvalid,i.indpred is null as unconditional,
        pg_get_indexdef(i.indexrelid) as definition from pg_index i where i.indexrelid='run_graph_execution_identity'::regclass`)
      expect(target.rows[0]).toMatchObject({ indisunique: true, indisvalid: true, unconditional: true })
      const fks = await pool.query(`select conname from pg_constraint where contype='f'
        and confrelid='harness_executions'::regclass and conindid='run_graph_execution_identity'::regclass`)
      expect(fks.rows.length).toBeGreaterThan(0)
    })
  }, timeout)

  it('rolls back complete DDL after a transaction failure and rejects semantics-check drift atomically', async () => {
    await disposableDatabase(async (pool) => {
      await installPreRepeatRegistry(pool)
      const before = await schemaState(pool)
      await rejectsTransaction(pool, async (sql) => {
        await sql.query(repeatOccurrenceMigration.sql)
        // This executes on PostgreSQL after the full DDL, not a fake DB adapter.
        await sql.query('select 1/0')
      }, ['22012'])
      expect(await schemaState(pool)).toEqual(before)
      await pool.query(`alter table workflow_versions rename constraint
        workflow_versions_execution_semantics_version_check to owner_changed_semantics_check`)
      const drifted = await schemaState(pool)
      await expect(applyApplicationMigrations(pool)).rejects.toThrow('REPEAT_SEMANTICS_CONSTRAINT_DRIFT')
      expect(await schemaState(pool)).toEqual(drifted)
      await pool.query(`alter table workflow_versions rename constraint
        owner_changed_semantics_check to workflow_versions_execution_semantics_version_check`)
      await applyApplicationMigrations(pool)
      const installed = await schemaState(pool)
      // Registry retry is idempotent; a direct second SQL invocation fails closed.
      await rejectsTransaction(pool, (sql) => sql.query(repeatOccurrenceMigration.sql), ['P0001'], /REPEAT_SEMANTICS_CONSTRAINT_DRIFT/)
      expect(await schemaState(pool)).toEqual(installed)
    })
  }, timeout)

  it('supports deferred occurrence references, generated keys and independent business/technical attempts', async () => {
    await migrated(async (pool) => {
      const baseline = await transaction(pool, async (sql) => {
        const run = await seedRun(sql, 'deferred')
        const first = occurrence(run), one = execution(run, first)
        // The occurrence does not yet exist; AFTER/deferred checks must allow
        // both the generated composite key and FK to settle by COMMIT.
        await insertExecution(sql, one)
        await insertOccurrence(sql, first)
        return { run, first, one }
      })
      const outside = execution(baseline.run, null)
      await transaction(pool, sql => insertExecution(sql, outside))
      await rejectsTransaction(pool, sql => insertExecution(sql,
        execution(baseline.run, null, { id: 'duplicate-outside-attempt' }), false), ['23505'])
      await rejectsTransaction(pool, sql => insertExecution(sql,
        execution(baseline.run, baseline.first, { nodeId: 'outside', id: 'outside-with-occurrence' }), false),
      ['P0001'], /REPEAT_EXECUTION_SCOPE_CONFLICT/)
      await rejectsTransaction(pool, sql => insertExecution(sql,
        execution(baseline.run, null, { nodeId: 'body', id: 'member-without-occurrence' }), false),
      ['P0001'], /REPEAT_EXECUTION_SCOPE_CONFLICT/)
      const generated = (await pool.query(`select occurrence_key,workflow_node_id,previous_technical_attempt
        from run_repeat_executions where execution_id=$1`, [baseline.one.id])).rows[0]!
      expect(generated).toEqual({ occurrence_key: baseline.first.id, workflow_node_id: 'body', previous_technical_attempt: null })
      await rejectsTransaction(pool, (sql) => insertExecution(sql,
        execution(baseline.run, baseline.first, { id: 'duplicate-business-attempt' }), false), ['23505'])
      await rejectsTransaction(pool, (sql) => insertExecution(sql,
        execution(baseline.run, baseline.first, { id: 'technical-gap', attempt: 3, previous: baseline.one }), false), ['23503'])
      const retry = execution(baseline.run, baseline.first, { attempt: 2, previous: baseline.one })
      await transaction(pool, (sql) => insertExecution(sql, retry, false))
      const retried = (await pool.query('select previous_technical_attempt from run_repeat_executions where execution_id=$1', [retry.id])).rows[0]!
      expect(retried.previous_technical_attempt).toBe(1)
      const progressed = await transaction(pool, (sql) => finishOccurrence(sql, retry))
      assert.ok(progressed.successor)
      const second = execution(baseline.run, progressed.successor)
      await transaction(pool, (sql) => insertExecution(sql, second))
      expect((await pool.query('select attempt from harness_executions where id=$1', [second.id])).rows[0]!.attempt).toBe(1)
      await rejectsTransaction(pool, (sql) => sql.query(`insert into run_repeat_slots
        (slot_id,run_id,workflow_node_id,input_json,input_digest,occurrence_key)
        values('generated-override',$1,'outside',$2,$3,'invented')`,
      [baseline.run.id, text(execution(baseline.run, null).input), digest(execution(baseline.run, null).input)]), ['428C9'])
      const duplicate = occurrence(baseline.run, 1, undefined, 'block', 'duplicate-occurrence-index')
      await rejectsTransaction(pool, (sql) => insertOccurrence(sql, duplicate), ['23505'])
    })
  }, timeout)

  it('retains exact object/string/text results and enforces early exit before the cap', async () => {
    await migrated(async (pool) => {
      for (const carrier of ['object', 'string', 'text'] as const) {
        const { value, accepted } = await transaction(pool, async (sql) => {
          const run = await seedRun(sql, `carrier-${carrier}`, 3, { cap: 1 })
          const first = occurrence(run), value = execution(run, first)
          await insertOccurrence(sql, first)
          await insertExecution(sql, value)
          const finished = await finishOccurrence(sql, value, 'pass', carrier)
          expect(finished.decision.record.reason).toBe('early_exit')
          return { value, accepted: acceptedResult('pass', carrier) }
        })
        const stored = (await pool.query('select result_json,result_digest from run_repeat_results where execution_id=$1', [value.id])).rows[0]!
        expect(stored.result_json).toBe(text(accepted))
        expect(stored.result_digest).toBe(digest(accepted))
      }
      const chain = await completeTwoOccurrences(pool, 'cap-chain')
      const rows = (await pool.query('select record,input_json,input_digest from run_repeat_occurrences where run_id=$1 order by occurrence_index', [chain.run.id])).rows
      expect(rows).toHaveLength(2)
      expect(JSON.parse(rows[1]!.input_json).carry).toEqual({ decisionId: chain.firstDecision.id,
        execution: chain.one.identity, acceptedResultDigest: digest(chain.firstDecision.accepted), acceptedResult: chain.firstDecision.accepted })
      expect(rows[1]!.input_digest).toBe(digest(JSON.parse(rows[1]!.input_json)))
      expect((await pool.query('select record from run_repeat_decisions where occurrence_id=$1', [chain.second.id])).rows[0]!.record)
        .toMatchObject({ reason: 'limit_exit', target: { kind: 'branch_end' }, resultData: chain.final.record.resultData })
    })
  }, timeout)

  it('rejects malformed caps, foreign scope, unknown semantics and changed V3 pins without residual rows', async () => {
    await migrated(async (pool) => {
      for (const [index, cap] of [null, '2', 0, 1.5, 2147483648].entries()) {
        await rejectsTransaction(pool, async (sql) => {
          const run = await seedRun(sql, `bad-cap-${index}`, 3, { versionPatch(version) {
            const blocks = ((version.definition as JsonObject).repeat as JsonObject).blocks as JsonObject[]
            blocks[0]!.maxOccurrences = cap
          } })
          await insertOccurrence(sql, occurrence(run))
        }, ['P0001'], /REPEAT_(LIMIT|BLOCK)_INVALID/)
      }
      const [run, foreign] = await transaction(pool, async (sql) => [
        await seedRun(sql, 'scope-one'), await seedRun(sql, 'scope-two'),
      ])
      assert.ok(run && foreign)
      for (const field of ['workspaceId', 'workflowId', 'workflowVersionId'] as const) {
        const first = occurrence(run)
        first.record.identity.scope[field] = field === 'workspaceId' ? foreign.workspaceId : field === 'workflowId' ? foreign.workflowId : foreign.versionId
        await rejectsTransaction(pool, (sql) => insertOccurrence(sql, first), ['P0001'], /REPEAT_SCOPE_CONFLICT/)
      }
      const stringSemantics = occurrence(run)
      ;(stringSemantics.record.identity.scope as unknown as JsonObject).executionSemanticsVersion = '3'
      await rejectsTransaction(pool, (sql) => insertOccurrence(sql, stringSemantics), ['23514'])
      const nonmember = occurrence(run, 1, undefined, 'other-block')
      await transaction(pool, (sql) => insertOccurrence(sql, nonmember))
      await rejectsTransaction(pool, (sql) => insertExecution(sql, execution(run, nonmember, { nodeId: 'body' })), ['P0001'], /REPEAT_EXECUTION_SCOPE_CONFLICT/)
      await rejectsTransaction(pool, (sql) => sql.query(`update workflow_versions set execution_semantics_version=4,
        record=jsonb_set(record,'{executionSemanticsVersion}','4') where id=$1`, [run.versionId]), ['P0001'], /REPEAT_VERSION_IMMUTABLE/)
      await rejectsTransaction(pool, (sql) => sql.query(`update runs set record=jsonb_set(record,'{executionSemanticsVersion}','2') where id=$1`, [run.id]), ['P0001'], /REPEAT_RUN_PIN_IMMUTABLE/)
      expect((await pool.query("select count(*)::integer as n from runs where id like 'bad-cap-%'")).rows[0]!.n).toBe(0)
    })
  }, timeout)

  it('rejects NULL predecessor bypass, wrong lineage, forged carry and a non-atomic successor', async () => {
    await migrated(async (pool) => {
      const { run, first, value } = await transaction(pool, async (sql) => {
        const run = await seedRun(sql, 'lineage')
        const first = occurrence(run), value = execution(run, first)
        await insertOccurrence(sql, first)
        await insertExecution(sql, value)
        return { run, first, value }
      })
      const accepted = acceptedResult(), route = decision(value, accepted, 'issues')
      await rejectsTransaction(pool, async (sql) => {
        await acceptResult(sql, value, accepted)
        await insertResolution(sql, value, accepted)
        await insertDecision(sql, route)
      }, ['P0001'], /REPEAT_SUCCESSOR_MISSING/)
      const second = occurrence(run, 2, route)
      const missingIndex = structuredClone(second)
      // An adversarial SQL row, not a malformed cast accepted as contract input.
      ;(missingIndex.record.input.previous as unknown as JsonObject).occurrenceIndex = null
      await rejectsTransaction(pool, (sql) => insertOccurrence(sql, missingIndex), ['23514'])
      await rejectsTransaction(pool, async (sql) => {
        await acceptResult(sql, value, accepted)
        await insertResolution(sql, value, accepted)
        await insertDecision(sql, route)
        const forged = occurrence(run, 2, route)
        ;(forged.input.carry as JsonObject).acceptedResult = acceptedResult('pass')
        forged.record.input.inputDigest = digest(forged.input)
        await insertOccurrence(sql, forged)
      }, ['P0001'], /REPEAT_LINEAGE_CONFLICT/)
      const otherBlock = occurrence(run, 2, route, 'other-block')
      await rejectsTransaction(pool, async (sql) => {
        await acceptResult(sql, value, accepted)
        await insertResolution(sql, value, accepted)
        await insertDecision(sql, route)
        await insertOccurrence(sql, otherBlock)
      }, ['23503', 'P0001'])
      expect(await counts(pool, run.id)).toMatchObject({ run_repeat_occurrences: 1, run_repeat_results: 0, run_repeat_decisions: 0 })
      const valid = await transaction(pool, (sql) => finishOccurrence(sql, value))
      assert.ok(valid.successor)
      expect(valid.successor.record.input.previous!.occurrenceId).toBe(first.id)
    })
  }, timeout)

  it('rejects forged result digests, NULL result namespaces, missing acceptance and incomplete carry bindings', async () => {
    await migrated(async (pool) => {
      const { run, first, value } = await transaction(pool, async (sql) => {
        const run = await seedRun(sql, 'evidence'), first = occurrence(run), value = execution(run, first)
        await insertOccurrence(sql, first)
        await insertExecution(sql, value)
        return { run, first, value }
      })
      const accepted = acceptedResult()
      const rawInsert = (sql: pg.PoolClient, result: string, resultDigest: string, occurrenceId: string | null) => sql.query(`
        insert into run_repeat_results(execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at)
          values($1,$2,$3,$4,$5,$6)`, [value.id, run.id, occurrenceId, result, resultDigest, now])
      await rejectsTransaction(pool, (sql) => rawInsert(sql, text(accepted), `sha256:${'0'.repeat(64)}`, first.id), ['23514'])
      await rejectsTransaction(pool, (sql) => rawInsert(sql, text(accepted), digest(accepted), first.id), ['P0001'], /REPEAT_RESULT_NOT_ACCEPTED/)
      await rejectsTransaction(pool, (sql) => rawInsert(sql, text(accepted), digest(accepted), null), ['23503', 'P0001'])
      const huge = { outcome: 'succeeded', output: 'x'.repeat(65536) }
      await rejectsTransaction(pool, (sql) => rawInsert(sql, text(huge), digest(huge), first.id), ['23514'])
      const progressed = await transaction(pool, (sql) => finishOccurrence(sql, value))
      assert.ok(progressed.successor)
      const next = execution(run, progressed.successor)
      await rejectsTransaction(pool, async (sql) => {
        await insertExecution(sql, next)
        // Deletion is also retention-protected; the earlier execution constraint
        // must detect missing evidence even before the deferred retention trigger.
        await sql.query('delete from run_repeat_bindings where recipient_execution_id=$1', [next.id])
      }, ['P0001'], /REPEAT_(INPUT_BINDINGS_INCOMPLETE|RETAIN_WITH_RUN)/)
      await transaction(pool, (sql) => insertExecution(sql, next))
      expect((await pool.query('select record from run_repeat_bindings where recipient_execution_id=$1', [next.id])).rows[0]!.record)
        .toMatchObject({ kind: 'carry', ordinal: 0, source: { decisionId: progressed.decision.id } })
    })
  }, timeout)

  it('retains every evidence table, protects accepted pins and permits only whole-Run cascade deletion', async () => {
    await migrated(async (pool) => {
      const chain = await completeTwoOccurrences(pool, 'retention')
      const other = await completeTwoOccurrences(pool, 'retention-other')
      const before = await counts(pool, chain.run.id), untouched = await counts(pool, other.run.id)
      expect(Object.values(before).every((count) => count > 0)).toBe(true)
      for (const table of evidenceTables) {
        await rejectsTransaction(pool, (sql) => sql.query(`update ${table} set run_id=run_id where run_id=$1`, [chain.run.id]),
          // run_id is generated on decisions, so the generated-column fence wins.
          table === 'run_repeat_decisions' ? ['428C9'] : ['P0001'])
        await rejectsTransaction(pool, (sql) => sql.query(`delete from ${table} where run_id=$1`, [chain.run.id]), ['P0001', '23503'])
        await rejectsTransaction(pool, (sql) => sql.query(`truncate table ${table} cascade`), ['P0001'], /REPEAT_TRUNCATE_FORBIDDEN/)
        expect(await counts(pool, chain.run.id)).toEqual(before)
      }
      await rejectsTransaction(pool, (sql) => sql.query('delete from harness_executions where id=$1', [chain.one.id]), ['P0001', '23503'])
      await rejectsTransaction(pool, (sql) => sql.query("update harness_executions set record=jsonb_set(record,'{result}','{}') where id=$1", [chain.one.id]),
        ['P0001'], /REPEAT_ACCEPTED_RESULT_IMMUTABLE/)
      await rejectsTransaction(pool, (sql) => sql.query('update harness_executions set repeat_occurrence_id=null where id=$1', [chain.one.id]),
        ['P0001'], /REPEAT_EXECUTION_IDENTITY_IMMUTABLE/)
      await rejectsTransaction(pool, (sql) => sql.query("update runs set record=jsonb_set(record,'{input}','{}') where id=$1", [chain.run.id]),
        ['P0001'], /REPEAT_RUN_PIN_IMMUTABLE/)
      await rejectsTransaction(pool, async (sql) => {
        await sql.query('delete from runs where id=$1', [chain.run.id])
        await sql.query('select 1/0')
      }, ['22012'])
      expect(await counts(pool, chain.run.id)).toEqual(before)
      await transaction(pool, (sql) => sql.query('delete from runs where id=$1', [chain.run.id]))
      expect(Object.values(await counts(pool, chain.run.id))).toEqual(evidenceTables.map(() => 0))
      expect((await pool.query('select id from harness_executions where run_id=$1', [chain.run.id])).rows).toHaveLength(0)
      expect(await counts(pool, other.run.id)).toEqual(untouched)
      expect((await pool.query('select id from workflow_versions where id=$1', [chain.run.versionId])).rows).toHaveLength(1)
    })
  }, timeout)
})
