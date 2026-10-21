import pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

const principal: ManagementPrincipal = {
  id: 'operator', name: 'Operator', audience: 'operator', grants: [],
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
}

function fixture(options: { commitError?: Error; rollbackError?: Error } = {}) {
  let rolledBack = false
  const release = vi.fn()
  const client = {
    release,
    query: async (sql: string) => {
      if (sql === 'commit' && options.commitError) throw options.commitError
      if (sql === 'rollback') {
        if (options.rollbackError) throw options.rollbackError
        rolledBack = true
      }
      return { rows: [], rowCount: 0 }
    },
  } as unknown as pg.PoolClient
  const pool = { connect: async () => client } as unknown as pg.Pool
  const command = { principal, source: 'mcp' as const, operation: 'workspace.create',
    commandId: 'create-project', targetKey: 'workspaces:new', payload: {} }
  return { coordinator: new PostgresCommandCoordinator(pool), command, release, rolledBack: () => rolledBack }
}

describe('command rollback compensation', () => {
  it('compensates only after confirming rollback and preserves the command error', async () => {
    const f = fixture()
    const error = new Error('Receipt could not be written')
    const afterRollback = vi.fn(async () => { expect(f.rolledBack()).toBe(true) })
    await expect(f.coordinator.execute({ ...f.command, afterRollback,
      perform: async () => { throw error },
    })).rejects.toBe(error)
    expect(afterRollback).toHaveBeenCalledOnce()
  })

  it('does not compensate when rollback cannot be confirmed', async () => {
    const rollbackError = new Error('Connection lost during rollback')
    const f = fixture({ rollbackError })
    const error = new Error('Receipt could not be written')
    const afterRollback = vi.fn()
    await expect(f.coordinator.execute({ ...f.command, afterRollback,
      perform: async () => { throw error },
    })).rejects.toBe(error)
    expect(afterRollback).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledWith(rollbackError)
  })

  it('preserves external effects when commit acknowledgement is ambiguous', async () => {
    const error = new Error('Commit acknowledgement lost')
    const f = fixture({ commitError: error })
    const afterRollback = vi.fn()
    await expect(f.coordinator.execute({ ...f.command, afterRollback, perform: async () => 'project' })).rejects.toBe(error)
    expect(f.rolledBack()).toBe(true)
    expect(afterRollback).not.toHaveBeenCalled()
  })

  it('compensates a server-rejected commit', async () => {
    const error = new pg.DatabaseError('Deferred constraint rejected commit', 0, 'error')
    error.code = '23514'
    error.severity = 'ERROR'
    const f = fixture({ commitError: error })
    const afterRollback = vi.fn(async () => { expect(f.rolledBack()).toBe(true) })
    await expect(f.coordinator.execute({ ...f.command, afterRollback, perform: async () => 'project' })).rejects.toBe(error)
    expect(afterRollback).toHaveBeenCalledOnce()
  })

  it('compensates a localized server rejection using its SQLSTATE', async () => {
    const error = new pg.DatabaseError('Division durch Null', 0, 'error')
    error.code = '22012'
    error.severity = 'FEHLER'
    const f = fixture({ commitError: error })
    const afterRollback = vi.fn(async () => { expect(f.rolledBack()).toBe(true) })
    await expect(f.coordinator.execute({ ...f.command, afterRollback, perform: async () => 'project' }))
      .rejects.toBe(error)
    expect(afterRollback).toHaveBeenCalledOnce()
  })

  it.each(['08006', '40003'])('preserves external effects for ambiguous SQLSTATE %s', async code => {
    const error = new pg.DatabaseError('Uncertain transaction completion', 0, 'error')
    error.code = code
    error.severity = 'FEHLER'
    const f = fixture({ commitError: error })
    const afterRollback = vi.fn()
    await expect(f.coordinator.execute({ ...f.command, afterRollback, perform: async () => 'project' }))
      .rejects.toBe(error)
    expect(f.rolledBack()).toBe(true)
    expect(afterRollback).not.toHaveBeenCalled()
  })

  it('reports cleanup failure and restores its connection before failure auditing', async () => {
    const f = fixture()
    const error = new Error('Receipt could not be written')
    const cleanupError = new Error('The directory was replaced')
    await expect(f.coordinator.execute({ ...f.command,
      perform: async () => { throw error },
      afterRollback: async () => { throw cleanupError },
    })).rejects.toMatchObject({ errors: [error, cleanupError] })
    expect(f.release).toHaveBeenCalledWith(undefined)
  })
})
