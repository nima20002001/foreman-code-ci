import { beforeEach, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { workerCredentialBudgetFixture } from './helpers/workerCredentialBudgetFixture.js'

const fixture = workerCredentialBudgetFixture()
let pool: typeof fixture.pool
let execution: typeof fixture.execution
let budgets: typeof fixture.budgets

beforeEach(() => {
  ({ pool, execution, budgets } = fixture)
})

it('finalizes at the durable finish time exactly once and prevents later resume', async () => {
  await pool.query(
    `update approval_execution_state set active_elapsed_ms=1000,active_started_at=$2,
     approval_wait_started_at=null where execution_id=$1`, [execution.id, '2026-09-16T00:00:00.000Z'],
  )
  const finishedAt = '2026-09-16T00:00:03.000Z'
  const completed = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result: { outcome: 'succeeded' }, finishedAt })
  await pool.query('update harness_executions set record=$2::jsonb where id=$1', [execution.id, JSON.stringify(completed)])
  await budgets.finish(execution.id, finishedAt)
  const read = async () => (await pool.query(
    `select active_elapsed_ms::text,active_started_at,approval_wait_started_at,stopped_at,revision::text
     from approval_execution_state where execution_id=$1`, [execution.id],
  )).rows[0]
  const first = await read()
  expect(first).toMatchObject({ active_elapsed_ms: '4000', active_started_at: null, approval_wait_started_at: null })
  expect(first.stopped_at).toBe(null)
  await budgets.finish(execution.id, '2026-09-16T02:00:00.000Z')
  expect(await read()).toEqual(first)
  await expect(budgets.resume(execution.id)).rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
  await expect(budgets.beginWait(execution.id)).rejects.toMatchObject({ code: 'EXECUTION_NOT_WAITABLE' })
  // The service checks this before returning an already-delivered decision on replay.
  await expect(budgets.assertActive(execution.id)).resolves.toBeUndefined()
  expect(await read()).toEqual(first)
  await budgets.stop(execution.id)
  await expect(budgets.assertActive(execution.id)).rejects.toMatchObject({ code: 'EXECUTION_STOPPED' })
})

it('does not add approval waiting time when finalizing a waiting execution', async () => {
  await pool.query(
    `update approval_execution_state set active_elapsed_ms=1234,active_started_at=null,
     approval_wait_started_at=now()-interval '2 hours' where execution_id=$1`, [execution.id],
  )
  await budgets.finish(execution.id)
  const row = (await pool.query(
    'select active_elapsed_ms::text,active_started_at,approval_wait_started_at from approval_execution_state where execution_id=$1', [execution.id],
  )).rows[0]
  expect(row).toEqual({ active_elapsed_ms: '1234', active_started_at: null, approval_wait_started_at: null })
})

it('does not subtract elapsed time when recovering a completion older than its budget row', async () => {
  await pool.query(
    `update approval_execution_state set active_elapsed_ms=1234,active_started_at=$2,
     approval_wait_started_at=null where execution_id=$1`, [execution.id, '2026-09-16T00:00:05.000Z'],
  )
  await budgets.finish(execution.id, '2026-09-16T00:00:03.000Z')
  expect((await pool.query('select active_elapsed_ms::text from approval_execution_state where execution_id=$1', [execution.id])).rows[0].active_elapsed_ms).toBe('1234')
})
