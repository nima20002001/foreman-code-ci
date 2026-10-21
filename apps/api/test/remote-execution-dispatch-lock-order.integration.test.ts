import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DispatchIntentSchema } from '@foreman-code/contracts/node-placement'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { readReconciledDispatchIntent } from '../src/modules/runs/remote/persistence.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { readUntil } from './helpers/observableCondition.js'

it.runIf(postgresEnabled)('reads artifact dispatch authority alongside an execution writer without a lock cycle', async () => {
  const database = await agent3Database()
  const schema = `execution_locks_${randomUUID().replaceAll('-', '')}`
  const intent = DispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1,
    mainId: randomUUID(), runId: 'run', nodeId: 'node', executionId: 'execution',
    occurrenceId: null, occurrenceIndex: 0, technicalAttempt: 1,
    attemptId: randomUUID(), operationId: randomUUID(), bindingHash: 'a'.repeat(64),
    inputDigest: `sha256:${'b'.repeat(64)}`, owner: { grantId: randomUUID(), epoch: '1' } })
  let reading: Promise<{ value: unknown } | { error: unknown }> | undefined
  try {
    await createFixtureSchema(database.pool, schema)
    await database.pool.query(`create table ${schema}.runs(id text primary key)`)
    await database.pool.query(`create table ${schema}.harness_executions(id text primary key,run_id text)`)
    await database.pool.query(`create table ${schema}.execution_dispatch_intents(
      operation_id text primary key,run_id text,execution_id text,record jsonb)`)
    await database.pool.query(`create table ${schema}.remote_execution_owner_reconciliations(
      operation_id text,ordinal integer,transition jsonb)`)
    await database.pool.query(`insert into ${schema}.runs values($1)`, [intent.runId])
    await database.pool.query(`insert into ${schema}.harness_executions values($1,$2)`, [intent.executionId, intent.runId])
    await database.pool.query(`insert into ${schema}.execution_dispatch_intents values($1,$2,$3,$4::jsonb)`,
      [intent.operationId, intent.runId, intent.executionId, JSON.stringify(intent)])
    await withTransaction(database.pool, async writer => {
      await writer.query(`set local search_path to ${schema}`)
      await writer.query("set local lock_timeout='2s'")
      await writer.query('select id from harness_executions where id=$1 for update', [intent.executionId])
      let identify!: (pid: number) => void
      const identified = new Promise<number>(resolve => { identify = resolve })
      reading = withTransaction(database.pool, async reader => {
        await reader.query(`set local search_path to ${schema}`)
        await reader.query("set local lock_timeout='2s'")
        identify((await reader.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
        const value = await readReconciledDispatchIntent(reader, intent.operationId, true)
        await reader.query('select id from harness_executions where id=$1 for share', [intent.executionId])
        return value
      }).then(value => ({ value }), error => ({ error }))
      const readerPid = await identified
      await readUntil(async () => (await database.pool.query<{ waiting: boolean }>(
        'select cardinality(pg_blocking_pids($1))>0 as waiting', [readerPid])).rows[0]!.waiting,
      value => value, { timeoutMs: 1000, description: 'artifact reader waiting for the execution writer' })
      expect(await readReconciledDispatchIntent(writer, intent.operationId, true)).toEqual(intent)
    })
    expect(await reading).toEqual({ value: intent })
  } finally {
    await reading
    try { await dropFixtureSchema(database.pool, schema) }
    finally { await database.close() }
  }
}, 30000)
