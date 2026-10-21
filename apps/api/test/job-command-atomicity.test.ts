import { afterEach, describe, expect, it, vi } from 'vitest'
import pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator, commandInputHash } from '../src/modules/commands/postgres.js'

const principal: ManagementPrincipal = { id: 'job-command-actor', name: 'Job actor', audience: 'operator',
  grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
afterEach(() => vi.restoreAllMocks())

interface CommandRecords {
  jobs: string[]
  dispatches: string[]
  receipts: unknown[]
  audits: unknown[]
}

function fixture(options: { receipt?: unknown; failReceipt?: boolean } = {}) {
  let inTransaction = false
  let rolledBack = false
  const empty = (): CommandRecords => ({ jobs: [], dispatches: [], receipts: [], audits: [] })
  const committed = empty()
  let pending = empty()
  const query = async (text: string, values?: unknown[]) => {
    if (text.includes('pg_try_advisory_lock(')) return { rows: [{ locked: true }], rowCount: 1 }
    if (text === 'begin') {
      inTransaction = true
      pending = empty()
    }
    if (text === 'commit') {
      committed.jobs.push(...pending.jobs)
      committed.dispatches.push(...pending.dispatches)
      committed.receipts.push(...pending.receipts)
      committed.audits.push(...pending.audits)
      inTransaction = false
      pending = empty()
    }
    if (text === 'rollback') {
      inTransaction = false
      rolledBack = true
      pending = empty()
    }
    if (text.startsWith('insert')) {
      const records = inTransaction ? pending : committed
      if (text.includes('job_executions')) records.jobs.push(String(values?.[0]))
      if (text.includes('job_dispatch_intents')) records.dispatches.push(String(values?.[0]))
      if (text.includes('management_command_receipts')) {
        if (options.failReceipt) throw new Error('receipt persistence failed')
        records.receipts.push(JSON.parse(String(values?.[5])))
      }
      if (text.includes('management_audit')) records.audits.push(JSON.parse(String(values?.at(-1))))
    }
    return { rows: text.startsWith('select principal_id, input_hash') && options.receipt ? [options.receipt] : [], rowCount: 0 }
  }
  const client = { query, release: vi.fn() }
  const pool = { options: {}, connect: async () => client, end: vi.fn(async () => undefined), on: () => undefined }
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return pool } as never)
  return { coordinator: new PostgresCommandCoordinator(pool as unknown as pg.Pool), committed,
    inTransaction: () => inTransaction, rolledBack: () => rolledBack }
}

const command = { principal, source: 'mcp' as const, operation: 'job.start', commandId: 'start-command',
  targetKey: 'workspace', payload: { definitionId: 'job-definition' }, dedicatedConnection: true as const }

describe('job acceptance and original command receipt atomicity', () => {
  it('prepares outside SQL and commits the job, dispatch, receipt and audit together', async () => {
    const f = fixture()
    const prepare = vi.fn(async () => { expect(f.inTransaction()).toBe(false) })
    const authorize = vi.fn(async () => undefined)
    const result = await f.coordinator.execute({ ...command, authorize, prepare, perform: async sql => {
      expect(f.inTransaction()).toBe(true)
      await sql.query('insert into job_executions values ($1)', ['job'])
      await sql.query('insert into job_dispatch_intents values ($1)', ['operation'])
      return { id: 'job' }
    } })
    expect(result).toEqual({ value: { id: 'job' }, replayed: false })
    expect(prepare).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(f.committed).toEqual({ jobs: ['job'], dispatches: ['operation'],
      receipts: [{ id: 'job' }], audits: [{ commandId: command.commandId }] })
  })

  it('rolls back the job and dispatch if receipt persistence fails', async () => {
    const f = fixture({ failReceipt: true })
    await expect(f.coordinator.execute({ ...command, source: 'http', prepare: async () => undefined,
      perform: async sql => {
        await sql.query('insert into job_executions values ($1)', ['job'])
        await sql.query('insert into job_dispatch_intents values ($1)', ['operation'])
        return { id: 'job' }
      },
    })).rejects.toThrow('receipt persistence failed')
    expect(f.rolledBack()).toBe(true)
    expect(f.committed).toEqual({ jobs: [], dispatches: [], receipts: [],
      audits: [{ commandId: command.commandId, code: 'INTERNAL_ERROR' }] })
  })

  it('returns the original execution on retry without another preparation or acceptance', async () => {
    const f = fixture({ receipt: { input_hash: commandInputHash(command.payload),
      target_key: command.targetKey, result: { id: 'original-job' } } })
    const prepare = vi.fn()
    const perform = vi.fn()
    expect(await f.coordinator.execute({ ...command, prepare, perform }))
      .toEqual({ value: { id: 'original-job' }, replayed: true })
    expect(prepare).not.toHaveBeenCalled()
    expect(perform).not.toHaveBeenCalled()
    expect(f.committed).toEqual({ jobs: [], dispatches: [], receipts: [], audits: [] })
  })
})
