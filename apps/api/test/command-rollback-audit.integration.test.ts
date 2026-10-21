import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'

import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('persists failed command audits after rollback without borrowing another pool connection', async () => {
  const db = await agent3Database()
  const pool = new pg.Pool({ ...db.pool.options, max: 1, connectionTimeoutMillis: 1_000 })
  try {
    const caller = await new PostgresAccessService(db.pool).issue({
      name: 'Synthetic command caller',
      audience: 'operator',
      grants: [{ actions: ['workspaces:create'], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000),
    })
    await db.pool.query('create table command_effects (id text primary key)')
    const connect = vi.spyOn(pool, 'connect')
    const query = vi.spyOn(pool, 'query')
    const coordinator = new PostgresCommandCoordinator(pool)

    for (const source of ['http', 'mcp'] as const) {
      const commandId = randomUUID()
      const original = new Error('Command failed')
      await expect(coordinator.execute({
        principal: caller.principal,
        source,
        operation: 'workspace.location.set',
        commandId,
        targetKey: 'workspace:synthetic',
        payload: {},
        perform: async client => {
          await client.query('insert into command_effects (id) values ($1)', [commandId])
          throw original
        },
      })).rejects.toBe(original)

      expect(query).not.toHaveBeenCalled()
      expect(connect).toHaveBeenCalledTimes(1)
      expect(pool.totalCount).toBe(1)
      expect(pool.idleCount).toBe(1)
      expect((await db.pool.query('select id from command_effects')).rows).toEqual([])
      expect((await db.pool.query(
        `select source, action, target_key, outcome, details from management_audit
         where principal_id = $1 and details->>'commandId' = $2`,
        [caller.principal.id, commandId],
      )).rows).toEqual([{
        source,
        action: 'workspace.location.set',
        target_key: 'workspace:synthetic',
        outcome: 'failed',
        details: { commandId, code: 'INTERNAL_ERROR' },
      }])
      expect((await db.pool.query(
        'select command_id from management_command_receipts where principal_id = $1 and command_id = $2',
        [caller.principal.id, commandId],
      )).rows).toEqual([])
      connect.mockClear()
    }
  } finally {
    await pool.end()
    await db.close()
  }
}, 60_000)
