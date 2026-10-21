import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('audits a lost commit reply as uncertain and resolves an identical retry through its persisted receipt', async () => {
  const db = await agent3Database()
  const caller = await new PostgresAccessService(db.pool).issue({ name: 'Command owner', audience: 'operator',
    grants: [], expiresAt: new Date(Date.now() + 600_000) })
  const client = await db.pool.connect()
  const failure = new Error('Commit acknowledgement lost')
  let loseReply = true
  const proxy = { release: () => undefined, query: async (statement: string, values?: unknown[]) => {
    const result = await client.query(statement, values)
    if (statement === 'commit' && loseReply) { loseReply = false; throw failure }
    return result
  } } as unknown as pg.PoolClient
  const coordinator = new PostgresCommandCoordinator({ connect: async () => proxy } as unknown as pg.Pool)
  const perform = vi.fn(async () => ({ accepted: true }))
  const afterRollback = vi.fn()
  const input = { principal: caller.principal, source: 'mcp' as const, operation: 'workflow.defaults.update',
    commandId: randomUUID(), targetKey: 'workflow-defaults-v1', payload: {}, perform, afterRollback }
  try {
    await expect(coordinator.execute(input)).rejects.toBe(failure)
    const audit = (await db.pool.query('select outcome from management_audit where principal_id=$1 and action=$2 order by sequence',
      [caller.principal.id, input.operation])).rows
    expect(audit.map(row => row.outcome)).toEqual(['succeeded', 'uncertain'])
    expect(afterRollback).not.toHaveBeenCalled()
    await expect(coordinator.execute(input)).resolves.toEqual({ replayed: true, value: { accepted: true } })
    expect(perform).toHaveBeenCalledOnce()
    expect((await db.pool.query('select result from management_command_receipts where principal_id=$1 and command_id=$2',
      [caller.principal.id, input.commandId])).rows).toEqual([{ result: { accepted: true } }])
  } finally {
    client.release()
    await db.close()
  }
}, 60_000)

it('records a definite deferred database rejection as failed', async () => {
  const db = await agent3Database()
  const caller = await new PostgresAccessService(db.pool).issue({ name: 'Rejected command owner', audience: 'operator',
    grants: [], expiresAt: new Date(Date.now() + 600_000) })
  const client = await db.pool.connect()
  const coordinator = new PostgresCommandCoordinator({ connect: async () => new Proxy(client, {
    get(target, property) {
      if (property === 'release') return () => undefined
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) } as unknown as pg.Pool)
  const afterRollback = vi.fn()
  try {
    await client.query('create temporary table command_parent (id integer primary key)')
    await client.query(`create temporary table command_child
      (parent_id integer references command_parent(id) deferrable initially deferred)`)
    await expect(coordinator.execute({ principal: caller.principal, source: 'http', operation: 'workspace.defaults.update',
      commandId: randomUUID(), targetKey: 'workspace-defaults-v1', payload: {}, afterRollback,
      perform: async sql => { await sql.query('insert into command_child values (1)'); return { accepted: true } },
    })).rejects.toMatchObject({ code: '23503' })
    expect(afterRollback).toHaveBeenCalledOnce()
    expect((await db.pool.query('select outcome from management_audit where principal_id=$1',
      [caller.principal.id])).rows).toEqual([{ outcome: 'failed' }])
    expect((await client.query('select * from command_child')).rows).toEqual([])
  } finally {
    client.release()
    await db.close()
  }
}, 60_000)
