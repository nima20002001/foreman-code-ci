import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { HarnessExecutionSchema, HarnessNativeEventSchema, WorkflowRunSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, expect } from 'vitest'

import { applyApplicationMigrations, migrations } from '../src/infrastructure/migrations.js'
import { nativeActivityNoiseMigration } from '../src/infrastructure/nativeActivityNoiseMigration.js'
import { nativeEventSequenceMigration } from '../src/infrastructure/nativeEventSequenceMigration.js'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'

const connectionString = process.env.TEST_DATABASE_URL!
export const timestamp = '2026-09-17T00:00:00.000Z'

export async function createDatabase(existingPR17 = false) {
  const schema = `event_allocation_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 8 })
  try {
    if (existingPR17) {
      // Execute the actual historical migration objects with their original
      // versions, transaction and advisory lock. No synthetic schema/downgrade.
      const client = await pool.connect()
      try {
        await client.query('begin')
        await client.query('select pg_advisory_xact_lock($1)', [810_001])
        for (const migration of migrations) {
          // Later redefinitions of the append function belong after 1702 as well.
          if (([nativeEventSequenceMigration.version, nativeActivityNoiseMigration.version] as number[]).includes(migration.version)) continue
          await client.query(migration.sql)
          await client.query('insert into application_migrations(version) values($1)', [migration.version])
        }
        await client.query('commit')
      } catch (error) {
        await client.query('rollback')
        throw error
      } finally { client.release() }
      expect((await pool.query('select version from application_migrations where version=1701')).rowCount).toBe(1)
      expect((await pool.query("select to_regprocedure('append_harness_native_event(jsonb)') as fn")).rows[0].fn).toBeNull()
    } else {
      await applyApplicationMigrations(pool)
    }
    await seed(pool)
    return { pool, close }
  } catch (error) {
    await close()
    throw error
  }
  async function close() {
    await pool.end()
    try { await dropFixtureSchema(admin, schema) } finally { await admin.end() }
  }
}

export function withDatabaseFixture(createFixture: () => ReturnType<typeof createDatabase>) {
  let fixture: Awaited<ReturnType<typeof createDatabase>> | undefined
  beforeEach(async () => {
    fixture = await createFixture()
  }, 60_000)
  afterEach(async () => {
    const current = fixture
    fixture = undefined
    await current?.close()
  }, 60_000)
  return (test: (pool: pg.Pool) => Promise<void>) => test(fixture!.pool)
}

async function seed(pool: pg.Pool) {
  await ensureAcceptanceSeed(pool)
  const run = WorkflowRunSchema.parse({ id: 'run', workspaceId: 'workspace-1', workflowId: 'workflow-content-pipeline',
    workflowVersionId: 'workflow-content-pipeline-v1', executionSemanticsVersion: 3,
    agentConfigurationVersionIds: { 'agent-researcher': 'agent-researcher-config-v1',
      'agent-developer': 'agent-developer-config-v1', 'agent-reviewer': 'agent-reviewer-config-v1' },
    approval: { handler: 'user' }, executionCondition: { kind: 'manual' }, executionState: 'running',
    outcome: 'pending', input: {}, createdAt: timestamp })
  await pool.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record)
    values($1,$2,$3,$4,$5,$6::jsonb)`, [run.id, run.workspaceId, run.workflowId, run.workflowVersionId,
    run.executionState, JSON.stringify(run)])
  for (const [id, nodeId, agentId, configurationId] of [
    ['execution', 'node-developer', 'agent-developer', 'agent-developer-config-v1'],
    ['other-execution', 'node-reviewer', 'agent-reviewer', 'agent-reviewer-config-v1'],
  ]) {
    const execution = HarnessExecutionSchema.parse({ id, runId: run.id, workflowNodeId: nodeId, agentId,
      agentConfigurationVersionId: configurationId, attempt: 1, input: {}, state: 'running', createdAt: timestamp })
    await pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,1,$5::jsonb)`, [id, run.id, nodeId, agentId, JSON.stringify(execution)])
  }
}

export function event(sequence = 17, overrides: Partial<HarnessNativeEvent> = {}): HarnessNativeEvent {
  return HarnessNativeEventSchema.parse({ executionId: 'execution', connectionId: 'connection-1', sequence,
    type: 'assistant.delta', occurredAt: timestamp, payload: { text: `event-${sequence}` }, ...overrides })
}

export async function nextSequence(pool: pg.Pool) {
  return (await pool.query<{ value: string }>(
    "select native_event_next_sequence::text as value from harness_executions where id='execution'",
  )).rows[0]!.value
}

export async function counts(pool: pg.Pool) {
  return (await pool.query<{ events: number; activity: number }>(`select
    (select count(*)::integer from harness_native_events) as events,
    (select count(*)::integer from run_activity where kind='harness_output') as activity`)).rows[0]
}

async function waitForBlocked(pool: pg.Pool, waiter: number, holder: number) {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(`select
      $2::integer=any(pg_blocking_pids($1::integer)) and
      exists(select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock') as blocked`, [waiter, holder])
    if (result.rows[0]?.blocked) return
    await delay(10)
  }
  throw new Error('The second PostgreSQL transaction never reached the forced execution-lock wait.')
}

/** Start the second statement BEFORE the first commits and prove its database lock wait. */
export async function forcedRace(pool: pg.Pool, first: HarnessNativeEvent, second: HarnessNativeEvent) {
  const a = await pool.connect(); const b = await pool.connect()
  let secondWrite: Promise<void> | undefined
  try {
    const holder = (await a.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    const waiter = (await b.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    expect(holder).not.toBe(waiter)
    await a.query('begin isolation level read committed')
    await b.query('begin isolation level read committed')
    await b.query("set local statement_timeout='10s'")
    await appendNativeEvent(a, first)
    secondWrite = appendNativeEvent(b, second)
    void secondWrite.catch(() => undefined) // Observe failures while the test polls the independent observer.
    await waitForBlocked(pool, waiter, holder)
    expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
    await a.query('commit')
    await secondWrite
    expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
    await b.query('commit')
  } finally {
    // Release the holder BEFORE awaiting the waiter, including on a failed assertion.
    await a.query('rollback')
    await secondWrite?.catch(() => undefined)
    await b.query('rollback')
    a.release(); b.release()
  }
}

// These cases only append events; clear their writes without repeating migrations.
export function withSharedAllocationDatabase() {
  let fixture: Awaited<ReturnType<typeof createDatabase>> | undefined
  beforeAll(async () => {
    fixture = await createDatabase()
  }, 60_000)
  beforeEach(async () => {
    await fixture!.pool.query('delete from harness_native_events')
    await fixture!.pool.query("delete from run_activity where kind='harness_output'")
    await fixture!.pool.query('update harness_executions set native_event_next_sequence=0')
  })
  afterAll(async () => {
    const current = fixture
    fixture = undefined
    await current?.close()
  }, 60_000)
  return (test: (pool: pg.Pool) => Promise<void>) => test(fixture!.pool)
}
