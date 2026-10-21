import assert from 'node:assert/strict'
import pg from 'pg'
import { describe, expect, it } from 'vitest'

import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { repeatOccurrenceMigration } from '../src/infrastructure/repeatOccurrenceMigration.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { readRepeatDecision, readRepeatOccurrences } from '../src/modules/runs/repeatPostgres.js'
import {
  acceptedResult,
  acceptResult,
  decision,
  digest,
  disposableDatabase,
  evidenceTables,
  execution,
  finishOccurrence,
  insertDecision,
  insertExecution,
  insertOccurrence,
  insertResolution,
  now,
  occurrence,
  seedRun,
  text,
  transaction,
  type JsonObject,
  type RunFixture,
} from './eng04-migration-fixtures.js'

const timeout = 120_000

function repeatScope(run: RunFixture) {
  return {
    workspaceId: run.workspaceId,
    workflowId: run.workflowId,
    workflowVersionId: run.versionId,
    runId: run.id,
    executionSemanticsVersion: 3 as const,
  }
}

async function rejectsTransaction(
  pool: pg.Pool,
  work: (sql: pg.PoolClient) => Promise<unknown>,
  codes: readonly string[],
  message?: RegExp,
): Promise<void> {
  let failure: unknown
  try {
    await transaction(pool, work)
  } catch (error) {
    failure = error
  }
  expect(failure, 'The invalid transaction must fail, including deferred COMMIT checks').toBeInstanceOf(Error)
  expect(codes).toContain((failure as { code?: string }).code)
  if (message) expect((failure as Error).message).toMatch(message)
}

async function disposableRepeatDatabase<T>(work: (pool: pg.Pool) => Promise<T>): Promise<T> {
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
    const run = await seedRun(sql, id, 3, { cap: 2 })
    const first = occurrence(run)
    await insertOccurrence(sql, first)
    const one = execution(run, first)
    await insertExecution(sql, one)
    const progressed = await finishOccurrence(sql, one)
    assert.ok(progressed.successor)
    const two = execution(run, progressed.successor)
    await insertExecution(sql, two)
    const finished = await finishOccurrence(sql, two)
    assert.equal(finished.decision.record.reason, 'limit_exit')
    return { run, first, one, second: progressed.successor, two, firstDecision: progressed.decision, finalDecision: finished.decision }
  })
}

describe('NIM-2648 ENG04-D real PostgreSQL repeat regression', () => {
  it('persists an ordinary semantics-3 Run with repeat absent and creates no repeat-specific rows', async () => {
    await disposableRepeatDatabase(async (pool) => {
      const run = await transaction(pool, (sql) => seedRun(sql, 'eng04-d-v3-no-repeat', 3, { versionPatch(version) {
        const definition = version.definition as JsonObject
        delete definition.repeat
      } }))
      expect((run.version.definition as JsonObject).repeat).toBeUndefined()
      expect(run.version.executionSemanticsVersion).toBe(3)
      expect(run.record.executionSemanticsVersion).toBe(3)

      const record = {
        id: 'eng04-d-v3-no-repeat-execution-1',
        runId: run.id,
        workflowNodeId: 'outside',
        agentId: run.agentIds.outside,
        agentConfigurationVersionId: run.configIds.outside,
        attempt: 1,
        state: 'queued',
        input: { executionSemanticsVersion: 3, runInput: run.record.input, predecessors: [] },
        createdAt: now,
      }
      await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record)
        values($1,$2,$3,$4,1,null,$5::jsonb)`, [record.id, run.id, record.workflowNodeId, record.agentId, text(record)])

      expect(await counts(pool, run.id)).toEqual(Object.fromEntries(evidenceTables.map((table) => [table, 0])))
      const stored = (await pool.query<{ record: JsonObject; repeat_occurrence_id: string | null }>(
        'select record,repeat_occurrence_id from harness_executions where id=$1 and run_id=$2', [record.id, run.id],
      )).rows[0]!
      expect(stored.repeat_occurrence_id).toBeNull()
      expect(stored.record).toEqual(record)
      expect((await pool.query(`select execution_semantics_version,record from workflow_versions where id=$1`,
        [run.versionId])).rows[0]).toMatchObject({ execution_semantics_version: 3 })
    })
  }, timeout)

  it('uses the production registry and preserves V3 lineage, ordinary/repeat uniqueness, technical attempts and exact readback', async () => {
    await disposableRepeatDatabase(async (pool) => {
      const installed = await pool.query<{ version: number }>(
        'select version from application_migrations where version=$1',
        [repeatOccurrenceMigration.version],
      )
      expect(installed.rows).toEqual([{ version: repeatOccurrenceMigration.version }])

      const seeded = await transaction(pool, async (sql) => {
        const run = await seedRun(sql, 'eng04-d-lineage', 3, { cap: 2 })
        const first = occurrence(run)
        await insertOccurrence(sql, first)
        const initial = execution(run, first)
        await insertExecution(sql, initial)
        const failedRecord = {
          ...initial.record,
          state: 'completed',
          finishedAt: now,
          result: { outcome: 'failed', error: { code: 'PROVIDER_TRANSIENT', message: 'retryable', retryable: true } },
        }
        await sql.query('update harness_executions set record=$2::jsonb where id=$1', [initial.id, text(failedRecord)])
        const retry = execution(run, first, { attempt: 2, previous: initial })
        await insertExecution(sql, retry, false)
        return { run, first, initial, retry }
      })

      await rejectsTransaction(
        pool,
        (sql) => insertExecution(sql, execution(seeded.run, seeded.first, { id: 'eng04-d-duplicate-business-attempt' }), false),
        ['23505'],
      )
      await rejectsTransaction(
        pool,
        (sql) => insertExecution(sql, execution(seeded.run, seeded.first, {
          id: 'eng04-d-technical-gap', attempt: 4, previous: seeded.retry,
        }), false),
        ['23503'],
      )

      const progressed = await transaction(pool, (sql) => finishOccurrence(sql, seeded.retry))
      assert.ok(progressed.successor)
      const secondExecution = execution(seeded.run, progressed.successor)
      await transaction(pool, (sql) => insertExecution(sql, secondExecution))
      expect((await pool.query('select attempt from harness_executions where id=$1', [secondExecution.id])).rows[0]!.attempt).toBe(1)
      expect((await pool.query('select previous_technical_attempt from run_repeat_executions where execution_id=$1', [seeded.retry.id])).rows[0]!.previous_technical_attempt).toBe(1)

      const outside = execution(seeded.run, null, { nodeId: 'outside', id: 'eng04-d-outside-1' })
      await transaction(pool, (sql) => insertExecution(sql, outside))
      await rejectsTransaction(
        pool,
        (sql) => insertExecution(sql, execution(seeded.run, null, { nodeId: 'outside', id: 'eng04-d-outside-duplicate' }), false),
        ['23505'],
      )

      const scope = repeatScope(seeded.run)
      const occurrences = await readRepeatOccurrences(pool, scope, seeded.first.blockId)
      expect(occurrences.map((value) => value.identity.occurrenceIndex)).toEqual([1, 2])
      expect(occurrences[1]!.input.previous).toEqual({
        occurrenceId: seeded.first.id,
        occurrenceIndex: 1,
        decisionId: progressed.decision.id,
        acceptedResultDigest: digest(progressed.decision.accepted),
      })
      const metadata = await readRepeatDecision(pool, scope, seeded.first.id)
      expect(metadata).toMatchObject({
        decisionId: progressed.decision.id,
        acceptedResultDigest: digest(progressed.decision.accepted),
        reason: 'repeat',
      })
      expect(metadata && 'resultData' in metadata).toBe(false)

      const storedOccurrence = (await pool.query<{ input_json: string; input_digest: string }>(
        'select input_json,input_digest from run_repeat_occurrences where occurrence_id=$1',
        [progressed.successor.id],
      )).rows[0]!
      expect(storedOccurrence.input_digest).toBe(digest(JSON.parse(storedOccurrence.input_json)))
      expect(JSON.parse(storedOccurrence.input_json).carry).toEqual({
        decisionId: progressed.decision.id,
        execution: progressed.decision.execution.identity,
        acceptedResultDigest: digest(progressed.decision.accepted),
        acceptedResult: progressed.decision.accepted,
      })

      const storedSlot = (await pool.query<{ input_json: string; input_digest: string }>(
        'select input_json,input_digest from run_repeat_slots where slot_id=$1',
        [seeded.retry.slotId],
      )).rows[0]!
      expect(storedSlot.input_json).toBe(text(seeded.retry.input))
      expect(storedSlot.input_digest).toBe(digest(seeded.retry.input))

      const storedResult = (await pool.query<{ result_json: string; result_digest: string }>(
        'select result_json,result_digest from run_repeat_results where execution_id=$1',
        [seeded.retry.id],
      )).rows[0]!
      expect(storedResult.result_json).toBe(text(progressed.decision.accepted))
      expect(storedResult.result_digest).toBe(digest(progressed.decision.accepted))
      const persistedDecision = (await pool.query<{ record: JsonObject }>(
        'select record from run_repeat_decisions where decision_id=$1',
        [progressed.decision.id],
      )).rows[0]!
      expect(persistedDecision.record).toEqual(progressed.decision.record)

      const native = (await pool.query<{ accepted: boolean; record: JsonObject }>(
        'select accepted,record from harness_executions where id=$1',
        [seeded.retry.id],
      )).rows[0]!
      expect(native.accepted).toBe(true)
      assert(seeded.retry.identity.kind !== 'job', 'native retry fixture requires an Agent identity')
      expect(native.record).toMatchObject({
        id: seeded.retry.id,
        runId: seeded.run.id,
        agentConfigurationVersionId: seeded.retry.identity.agentConfigurationVersionId,
        input: seeded.retry.input,
        state: 'completed',
        result: progressed.decision.accepted,
      })
      const versionAndRun = (await pool.query<{
        version_semantics: number
        run_semantics: string
        pinned: JsonObject
        version_record: JsonObject
        run_record: JsonObject
      }>(`
        select v.execution_semantics_version as version_semantics,
          r.record->>'executionSemanticsVersion' as run_semantics,
          r.record->'agentConfigurationVersionIds' as pinned,
          v.record as version_record,r.record as run_record
        from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [seeded.run.id])).rows[0]!
      expect(versionAndRun).toEqual({
        version_semantics: 3,
        run_semantics: '3',
        pinned: seeded.run.record.agentConfigurationVersionIds,
        version_record: seeded.run.version,
        run_record: seeded.run.record,
      })
    })
  }, timeout)

  it('replays one exact command receipt and rejects the same raw command ID with changed input', async () => {
    await disposableRepeatDatabase(async (pool) => {
      const principal = {
        id: 'operator-eng04-d',
        name: 'ENG04 D',
        audience: 'operator' as const,
        expiresAt: '2099-01-01T00:00:00.000Z',
        revokedAt: null,
        grants: [],
      }
      await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at,revoked_at)
        values($1,$2,$3,$4,$5::jsonb,$6,$7)`, [principal.id, principal.name, principal.audience,
        `sha256:${'d'.repeat(64)}`, text(principal.grants), principal.expiresAt, principal.revokedAt])

      const coordinator = new PostgresCommandCoordinator(pool)
      let performs = 0
      const execute = (payload: unknown) => coordinator.execute({
        principal,
        source: 'mcp',
        operation: 'repeat.save',
        commandId: 'raw-command-eng04-d-0001',
        targetKey: 'workflow:wf-eng04-d:repeat',
        payload,
        perform: async () => ({ persisted: ++performs, rawCommandId: 'raw-command-eng04-d-0001' }),
      })
      const first = await execute({ cap: 3, expectedRevision: 7 })
      const duplicate = await execute({ expectedRevision: 7, cap: 3 })
      expect(first.replayed).toBe(false)
      expect(duplicate).toEqual({ value: first.value, replayed: true })
      expect(performs).toBe(1)
      await expect(execute({ cap: 2, expectedRevision: 7 })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
      expect(performs).toBe(1)

      const receipts = await pool.query<{ command_id: string; result: JsonObject }>(
        'select command_id,result from management_command_receipts where principal_id=$1 and operation=$2',
        [principal.id, 'repeat.save'],
      )
      expect(receipts.rows).toEqual([{ command_id: 'raw-command-eng04-d-0001', result: first.value }])
    })
  }, timeout)

  it('fails closed on malformed scope, digests and decision provenance without residual evidence', async () => {
    await disposableRepeatDatabase(async (pool) => {
      const [scopeRun, foreignRun] = await transaction(pool, async (sql) => [
        await seedRun(sql, 'eng04-d-scope'),
        await seedRun(sql, 'eng04-d-foreign'),
      ])
      assert.ok(scopeRun && foreignRun)
      const foreignScope = occurrence(scopeRun)
      foreignScope.record.identity.scope.workspaceId = foreignRun.workspaceId
      await rejectsTransaction(pool, (sql) => insertOccurrence(sql, foreignScope), ['P0001'], /REPEAT_SCOPE_CONFLICT/)

      const badDigest = occurrence(scopeRun)
      badDigest.record.input.inputDigest = `sha256:${'0'.repeat(64)}`
      await rejectsTransaction(pool, (sql) => insertOccurrence(sql, badDigest), ['23514'])
      expect((await pool.query('select count(*)::integer as n from run_repeat_occurrences where run_id=$1', [scopeRun.id])).rows[0]!.n).toBe(0)

      const evidence = await transaction(pool, async (sql) => {
        const run = await seedRun(sql, 'eng04-d-evidence')
        const first = occurrence(run)
        const value = execution(run, first)
        await insertOccurrence(sql, first)
        await insertExecution(sql, value)
        return { run, first, value }
      })
      const accepted = acceptedResult()
      await rejectsTransaction(pool, (sql) => sql.query(`insert into run_repeat_results
        (execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at)
        values($1,$2,$3,$4,$5,$6)`, [evidence.value.id, evidence.run.id, evidence.first.id,
        text(accepted), `sha256:${'0'.repeat(64)}`, now]), ['23514'])

      const forged = decision(evidence.value, accepted, 'issues')
      forged.record.resultData = { ...(forged.record.resultData as JsonObject), latestDeliverable: { forged: true } }
      await rejectsTransaction(pool, async (sql) => {
        await acceptResult(sql, evidence.value, accepted)
        await insertResolution(sql, evidence.value, accepted)
        await insertDecision(sql, forged)
      }, ['P0001'], /REPEAT_DECISION_PROVENANCE_CONFLICT/)

      const valid = decision(evidence.value, accepted, 'issues')
      await rejectsTransaction(pool, async (sql) => {
        await acceptResult(sql, evidence.value, accepted)
        await insertResolution(sql, evidence.value, accepted)
        await insertDecision(sql, valid)
      }, ['P0001'], /REPEAT_SUCCESSOR_MISSING/)

      expect(await counts(pool, evidence.run.id)).toMatchObject({
        run_repeat_occurrences: 1,
        run_repeat_results: 0,
        run_repeat_decisions: 0,
      })
      const progressed = await transaction(pool, (sql) => finishOccurrence(sql, evidence.value))
      assert.ok(progressed.successor)
      expect(progressed.successor.record.input.previous!.occurrenceId).toBe(evidence.first.id)
    })
  }, timeout)

  it('retains repeat evidence with its Run and permits only whole-Run cascade retention cleanup', async () => {
    await disposableRepeatDatabase(async (pool) => {
      const chain = await completeTwoOccurrences(pool, 'eng04-d-retention')
      const other = await completeTwoOccurrences(pool, 'eng04-d-retention-other')
      const before = await counts(pool, chain.run.id)
      const untouched = await counts(pool, other.run.id)
      expect(Object.values(before).every((count) => count > 0)).toBe(true)

      for (const table of evidenceTables) {
        await rejectsTransaction(
          pool,
          (sql) => sql.query(`delete from ${table} where run_id=$1`, [chain.run.id]),
          ['P0001', '23503'],
        )
        expect(await counts(pool, chain.run.id)).toEqual(before)
      }
      await rejectsTransaction(
        pool,
        (sql) => sql.query('delete from harness_executions where id=$1', [chain.one.id]),
        ['P0001', '23503'],
      )
      await rejectsTransaction(
        pool,
        (sql) => sql.query("update harness_executions set record=jsonb_set(record,'{result}','{}') where id=$1", [chain.one.id]),
        ['P0001'],
        /REPEAT_ACCEPTED_RESULT_IMMUTABLE/,
      )
      await rejectsTransaction(
        pool,
        (sql) => sql.query("update runs set record=jsonb_set(record,'{input}','{}') where id=$1", [chain.run.id]),
        ['P0001'],
        /REPEAT_RUN_PIN_IMMUTABLE/,
      )
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
