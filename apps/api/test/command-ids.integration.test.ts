import { expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agent3Database } from './helpers/wave25Agent3.js'

it('generates distinct persisted command IDs when callers omit them', async () => {
  const db = await agent3Database()
  try {
    const caller = await new PostgresAccessService(db.pool).issue({
      name: 'Synthetic command caller', audience: 'operator', grants: [],
      expiresAt: new Date(Date.now() + 600_000),
    })
    const coordinator = new PostgresCommandCoordinator(db.pool)
    let effects = 0
    const request = { principal: caller.principal, source: 'mcp' as const,
      operation: 'synthetic.update', targetKey: 'synthetic', payload: { value: 1 },
      perform: async () => ++effects }
    expect(await coordinator.execute(request)).toEqual({ value: 1, replayed: false })
    expect(await coordinator.execute(request)).toEqual({ value: 2, replayed: false })
    const receipts = (await db.pool.query<{ command_id: string }>(
      'select command_id from management_command_receipts where principal_id=$1', [caller.principal.id])).rows
    expect(receipts).toHaveLength(2)
    expect(new Set(receipts.map(row => row.command_id)).size).toBe(2)
    for (const receipt of receipts) expect(receipt.command_id).toMatch(/^[a-f0-9-]{36}$/)
  } finally {
    await db.close()
  }
})
