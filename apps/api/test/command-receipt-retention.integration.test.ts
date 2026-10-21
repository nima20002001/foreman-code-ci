import type pg from 'pg'
import { expect, it } from 'vitest'
import { PostgresCommandReceiptRetention } from '../src/modules/commands/receiptRetention.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

const now = Date.parse('2026-10-16T00:00:00.000Z')
const old = new Date(now - 31 * 86_400_000)
interface Plan {
  'Actual Rows': number
  'Actual Loops': number
  'Rows Removed by Filter'?: number
  Plans?: Plan[]
}

function visitedRows(plan: Plan): number {
  if (plan.Plans?.length) return plan.Plans.reduce((sum, child) => sum + visitedRows(child), 0)
  return (plan['Actual Rows'] + (plan['Rows Removed by Filter'] ?? 0)) * plan['Actual Loops']
}

async function principal(pool: pg.Pool) {
  await pool.query(`insert into management_principals(id,name,audience,token_hash,grants,expires_at)
    values('retention-operator','Operator','operator','retention-operator-token-hash','[]'::jsonb,'2099-01-01')`)
}

async function seed(pool: pg.Pool, count: number, pending = false) {
  await pool.query(`insert into management_command_receipts
    (principal_id,operation,command_id,target_key,input_hash,result,created_at)
    select 'retention-operator',case when $3 then 'agent_chat_control'
        when n%2=0 then 'workflow.update' else 'harness.defaults.update' end,
      'command-'||n,'target','hash',case when $3 then '{"status":"pending"}'::jsonb else '{}'::jsonb end,
      $2::timestamptz+interval '123 microseconds' from generate_series(1,$1::int) n`,
  [count, old, pending])
  await pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details,occurred_at)
    select principal_id,'http',operation,target_key,'succeeded',jsonb_build_object('commandId',command_id),created_at
    from management_command_receipts`)
  await pool.query('analyze management_command_receipts')
  await pool.query('analyze management_audit')
}

it('selects a bounded indexed page across multiple operations even with a large eligible backlog', async () => {
  const database = await migratedDatabase()
  try {
    await principal(database.pool)
    await seed(database.pool, 20_000)
    const reads: number[] = []
    let measureNext = true
    const measured = { query: async (statement: string, values: unknown[]) => {
      if (measureNext) {
        measureNext = false
        const explained = await database.pool.query<{ 'QUERY PLAN': { Plan: Plan }[] }>(
          `explain (analyze,buffers,format json) ${statement}`, values)
        reads.push(visitedRows(explained.rows[0]!['QUERY PLAN'][0]!.Plan))
      }
      return database.pool.query(statement, values)
    } } as Pick<pg.Pool, 'query'>
    const retention = new PostgresCommandReceiptRetention(measured)
    expect(await retention.prune(now)).toBe(100)
    expect(reads).toHaveLength(1)
    expect(reads[0]).toBeLessThanOrEqual(300)
    measureNext = true
    expect(await retention.prune(now)).toBe(100)
    expect(reads).toHaveLength(2)
    expect(reads[1]).toBeLessThanOrEqual(300)
    expect((await database.pool.query('select count(*)::int as count from management_command_receipts')).rows)
      .toEqual([{ count: 19_800 }])
  } finally { await database.close() }
}, 60_000)

it('advances past a full page of pending receipts instead of scanning ahead or starving later operations', async () => {
  const database = await migratedDatabase()
  try {
    await principal(database.pool)
    await seed(database.pool, 100, true)
    await seed(database.pool, 105)
    const retention = new PostgresCommandReceiptRetention(database.pool)
    expect(await retention.prune(now)).toBe(0)
    expect(await retention.prune(now)).toBe(100)
    expect(await retention.prune(now)).toBe(5)
    expect((await database.pool.query('select count(*)::int as count from management_command_receipts')).rows)
      .toEqual([{ count: 100 }])
  } finally { await database.close() }
}, 60_000)
