import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { commandInputHash, PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

/** SQL-client unit fixture only. The authenticated fixture covers persisted
 * principals and transport parity when explicitly run against a test database. */
describe('NIM-2642 exact command authority before replay', () => {
  const principal = { id: 'principal' } as ManagementPrincipal
  const payload = { commandId: 'command', expectedRevision: 7 }
  function fixture() {
    const order: string[] = []
    const query = vi.fn(async (sql: string) => {
      order.push(sql)
      return { rows: sql.trimStart().startsWith('select') && sql.includes('from management_command_receipts')
        ? [{ principal_id: principal.id, input_hash: commandInputHash(payload), target_key: 'draft:draft', result: { saved: 'version-1' } }] : [], rowCount: 1 }
    })
    const release = vi.fn()
    const client = { query, release }
    const pool = { connect: async () => client } as unknown as pg.Pool
    return { coordinator: new PostgresCommandCoordinator(pool), order, query, release }
  }
  const command = { principal, source: 'http' as const, operation: 'graph.save', commandId: 'command', targetKey: 'draft:draft', payload }
  it('revalidates under the command lock before returning a receipt and never repeats the effect', async () => {
    const f = fixture(), perform = vi.fn(async () => ({ saved: 'new-version' }))
    const result = await f.coordinator.execute({ ...command, perform,
      authorize: async () => { f.order.push('authorize') } })
    expect(result).toEqual({ value: { saved: 'version-1' }, replayed: true })
    expect(perform).not.toHaveBeenCalled()
    const authorized = f.order.indexOf('authorize'), receipt = f.order.findIndex((sql) => sql.includes('from management_command_receipts'))
    expect(f.order.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))).toBeLessThan(authorized)
    expect(authorized).toBeLessThan(receipt)
    expect(f.release).toHaveBeenCalledTimes(1)
  })
  it('does not return or overwrite a successful receipt after authority is lost', async () => {
    const f = fixture(), perform = vi.fn(async () => ({ saved: 'new-version' }))
    await expect(f.coordinator.execute({ ...command, perform,
      authorize: async () => { throw new Error('authority lost') } })).rejects.toThrow('authority lost')
    expect(f.order.some((sql) => sql.includes('from management_command_receipts'))).toBe(false)
    expect(f.order.some((sql) => sql.includes('insert into management_command_receipts'))).toBe(false)
    expect(f.order).toContain('rollback')
    expect(perform).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledTimes(1)
  })
})
