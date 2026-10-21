import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!()
})

async function setup() {
  const schema = `command_retry_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  await createFixtureSchema(admin, schema)
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` })
  cleanups.push(async () => { await pool.end(); await dropFixtureSchema(admin, schema); await admin.end() })
  await pool.query(`
    create table harness_executions(id text primary key, run_id text, work_activation_id text);
    create table run_repeat_executions(execution_id text primary key, slot_id text);
    create table worker_credential_bindings(principal_id text primary key, execution_id text);
    create table management_command_receipts(principal_id text, operation text, command_id text,
      target_key text, input_hash text, result jsonb, primary key(principal_id,operation,command_id));
    create table management_audit(principal_id text, source text, action text, target_key text, outcome text, details jsonb);
  `)
  async function caller(name: string, activation: string | null, slot = 'slot', run = 'run'): Promise<ManagementPrincipal> {
    const executionId = `execution-${name}`
    await pool.query('insert into harness_executions values($1,$2,$3)', [executionId, run, activation])
    await pool.query('insert into run_repeat_executions values($1,$2)', [executionId, slot])
    await pool.query('insert into worker_credential_bindings values($1,$2)', [name, executionId])
    return { id: name, name: 'Synthetic worker', audience: 'worker', agentId: 'agent', grants: [],
      expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  }
  const perform = vi.fn(async () => ({ ticketId: randomUUID() }))
  const authorize = vi.fn(async () => undefined)
  const coordinator = new PostgresCommandCoordinator(pool)
  const request = { source: 'mcp' as const, operation: 'ci.run', commandId: 'same-command',
    targetKey: 'workspace', payload: { suite: 'unit' }, perform, authorize }
  return { pool, caller, perform, authorize, coordinator, request }
}

it.each(['work activation', 'ordinary repeat slot'] as const)(
  'replays one command across replacement credentials for the same %s', async kind => {
    const f = await setup()
    const activation = kind === 'work activation' ? 'activation' : null
    const original = await f.caller('original', activation)
    const replacement = await f.caller('replacement', activation)
    const first = await f.coordinator.execute({ ...f.request, principal: original })
    expect(await f.coordinator.execute({ ...f.request, principal: replacement }))
      .toEqual({ value: first.value, replayed: true })
    expect(f.perform).toHaveBeenCalledOnce()
    expect(f.authorize).toHaveBeenCalledTimes(2)
    expect((await f.pool.query('select result from management_command_receipts')).rows).toEqual([{ result: first.value }])

    await expect(f.coordinator.execute({ ...f.request, principal: replacement, payload: { suite: 'lint' } }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    f.authorize.mockRejectedValueOnce(new DomainError('ACCESS_DENIED', 'Caller lost access', 403))
    await expect(f.coordinator.execute({ ...f.request, principal: replacement })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.perform).toHaveBeenCalledOnce()
  },
)

it('serializes concurrent retry attempts and keeps separate activations and Runs independent', async () => {
  const f = await setup()
  const original = await f.caller('original', 'activation')
  const replacement = await f.caller('replacement', 'activation')
  const results = await Promise.all([original, replacement].map(principal => f.coordinator.execute({ ...f.request, principal })))
  expect(results[0]!.value).toEqual(results[1]!.value)
  expect(results.map(result => result.replayed).sort()).toEqual([false, true])
  expect(f.perform).toHaveBeenCalledOnce()
  for (const principal of [await f.caller('other-activation', 'another'), await f.caller('other-run', 'activation', 'slot', 'another-run')]) {
    expect((await f.coordinator.execute({ ...f.request, principal })).replayed).toBe(false)
  }
  expect(f.perform).toHaveBeenCalledTimes(3)
})
