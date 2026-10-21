import pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { deferred } from './helpers/deferred.js'
import { DomainError } from '../src/modules/errors.js'

const principal: ManagementPrincipal = { id: 'actor', name: 'Actor', audience: 'operator', grants: [],
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
const command = { principal, source: 'device' as const, operation: 'job.start', commandId: 'start-1',
  targetKey: 'workspace', payload: { definitionId: 'definition', expectedRevision: 1 }, dedicatedConnection: true as const }
afterEach(() => vi.restoreAllMocks())
function fixture(options: { uncertainCommit?: boolean; failRollback?: boolean; failUnlock?: boolean } = {}) {
  const releases = vi.fn()
  const end = vi.fn(async () => undefined)
  const secondLock = deferred()
  const state = {
    receiptReads: 0,
    receiptWrites: 0,
    rollbacks: 0,
    unlocks: 0,
    audits: [] as Array<{
      principalId: unknown
      source: unknown
      action: unknown
      targetKey: unknown
      outcome: unknown
      details: unknown
    }>,
  }
  let receipt: { principal_id: unknown; input_hash: unknown; target_key: unknown; result: unknown } | undefined
  const lockOwners = new Map<unknown, symbol>()
  let commits = 0
  let lockRequests = 0
  const makeClient = () => {
    const owner = Symbol('command session')
    let pending: typeof receipt
    return { release: releases, query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('pg_try_advisory_lock(')) {
        if (++lockRequests === 2) secondLock.resolve()
        const lockOwner = lockOwners.get(values?.[0])
        const locked = lockOwner === undefined || lockOwner === owner
        if (locked) lockOwners.set(values?.[0], owner)
        return { rows: [{ locked }], rowCount: 1 }
      }
      if (sql.includes('pg_advisory_unlock(')) {
        if (options.failUnlock) throw new Error('unlock failed')
        if (lockOwners.get(values?.[0]) === owner) lockOwners.delete(values?.[0])
        state.unlocks++
      }
      if (sql.trimStart().startsWith('select') && sql.includes('from management_command_receipts')) {
        state.receiptReads++
        return { rows: receipt ? [receipt] : [], rowCount: receipt ? 1 : 0 }
      }
      if (sql.includes('insert into management_command_receipts')) {
        state.receiptWrites++
        pending = {
          principal_id: values?.[0], input_hash: values?.[4], target_key: values?.[3], result: JSON.parse(String(values?.[5])),
        }
      }
      if (sql.includes('insert into management_audit')) {
        const parameterizedOutcome = values?.length === 6
        state.audits.push({
          principalId: values?.[0],
          source: values?.[1],
          action: values?.[2],
          targetKey: values?.[3],
          outcome: parameterizedOutcome ? values?.[4] : 'succeeded',
          details: JSON.parse(String(values?.[parameterizedOutcome ? 5 : 4])),
        })
      }
      if (sql === 'commit') {
        if (pending) { receipt = pending; pending = undefined }
        commits++
        if (options.uncertainCommit && commits === 2) throw new Error('commit acknowledgment lost')
      }
      if (sql === 'rollback') {
        state.rollbacks++
        if (options.failRollback) throw new Error('rollback failed')
        pending = undefined
      }
      return { rows: [], rowCount: 0 }
    }) }
  }
  const pool = { options: {}, connect: async () => makeClient(), query: makeClient().query, end, on: () => undefined }
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return { ...pool } } as never)
  return { coordinator: new PostgresCommandCoordinator(pool as unknown as pg.Pool), releases, end, secondLock, state }
}

describe('retained command preparation ownership', () => {
  it('serializes duplicate commands through preparation and returns the original receipt', async () => {
    const f = fixture(), entered = deferred(), resume = deferred()
    const prepare = vi.fn(async () => { entered.resolve(); await resume.promise })
    const perform = vi.fn(async () => ({ id: 'accepted-job' }))
    const first = f.coordinator.execute({ ...command, prepare, perform })
    await entered.promise
    const second = f.coordinator.execute({ ...command, prepare, perform })
    await f.secondLock.promise
    expect(prepare).toHaveBeenCalledOnce()
    resume.resolve()
    expect(await first).toEqual({ value: { id: 'accepted-job' }, replayed: false })
    expect(await second).toEqual({ value: { id: 'accepted-job' }, replayed: true })
    expect(prepare).toHaveBeenCalledOnce(); expect(perform).toHaveBeenCalledOnce()
    expect(f.releases).toHaveBeenCalledTimes(2); expect(f.end).not.toHaveBeenCalled()
  })

  it('fails changed command input before repeating preparation', async () => {
    const f = fixture(), prepare = vi.fn(async () => undefined), perform = vi.fn(async () => 'accepted')
    await f.coordinator.execute({ ...command, prepare, perform })
    await expect(f.coordinator.execute({ ...command, payload: { expectedRevision: 2 }, prepare, perform }))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect(prepare).toHaveBeenCalledOnce(); expect(perform).toHaveBeenCalledOnce()
  })

  it('audits preparation failure and releases the session without admission or receipt writes', async () => {
    const f = fixture(), error = new Error('capture failed'), perform = vi.fn()
    await expect(f.coordinator.execute({ ...command, prepare: async () => { throw error }, perform })).rejects.toBe(error)
    expect(perform).not.toHaveBeenCalled()
    expect(f.state.audits).toEqual([{
      principalId: principal.id,
      source: command.source,
      action: command.operation,
      targetKey: command.targetKey,
      outcome: 'failed',
      details: { commandId: command.commandId, code: 'INTERNAL_ERROR' },
    }])
    expect(f.state.receiptWrites).toBe(0)
    expect(f.state.unlocks).toBe(1)
    expect(f.releases).toHaveBeenCalledOnce(); expect(f.end).not.toHaveBeenCalled()
  })

  it('does not prepare bytes or read receipts when initial live authority is denied', async () => {
    const f = fixture(), prepare = vi.fn(), perform = vi.fn(), error = new Error('authority denied')
    await expect(f.coordinator.execute({ ...command, prepare, perform, authorize: async () => { throw error } })).rejects.toBe(error)
    expect(prepare).not.toHaveBeenCalled(); expect(perform).not.toHaveBeenCalled()
    expect(f.state.receiptReads).toBe(0)
    expect(f.state.rollbacks).toBe(1)
  })

  it('reauthorizes after preparation and rolls back if authority was revoked', async () => {
    const f = fixture(), perform = vi.fn(), error = new Error('authority revoked')
    let revoked = false
    const authorize = vi.fn(async () => { if (revoked) throw error })
    await expect(f.coordinator.execute({ ...command, authorize, prepare: async () => { revoked = true }, perform })).rejects.toBe(error)
    expect(authorize).toHaveBeenCalledTimes(2); expect(perform).not.toHaveBeenCalled()
    expect(f.state.rollbacks).toBe(1)
    expect(f.state.receiptWrites).toBe(0)
  })

  it('replays a committed receipt after lost commit acknowledgment without preparing again', async () => {
    const f = fixture({ uncertainCommit: true }), prepare = vi.fn(async () => undefined), perform = vi.fn(async () => 'accepted')
    await expect(f.coordinator.execute({ ...command, prepare, perform })).rejects.toThrow('commit acknowledgment lost')
    expect(await f.coordinator.execute({ ...command, prepare, perform })).toEqual({ value: 'accepted', replayed: true })
    expect(prepare).toHaveBeenCalledOnce(); expect(perform).toHaveBeenCalledOnce()
  })

  it('evicts uncertain rollback connections and preserves the original admission error', async () => {
    const f = fixture({ failRollback: true }), error = new Error('admission failed')
    await expect(f.coordinator.execute({ ...command, prepare: async () => undefined, perform: async () => { throw error } })).rejects.toBe(error)
    expect(f.releases).toHaveBeenCalledWith(expect.objectContaining({ message: 'rollback failed' }))
    expect(f.state.unlocks).toBe(0)
    expect(f.state.audits).toEqual([])
  })

  it('evicts a connection whose session lock cannot be released after success', async () => {
    const f = fixture({ failUnlock: true })
    expect(await f.coordinator.execute({ ...command, prepare: async () => undefined, perform: async () => 'accepted' }))
      .toEqual({ value: 'accepted', replayed: false })
    expect(f.releases).toHaveBeenCalledWith(expect.objectContaining({ message: 'unlock failed' }))
    expect(f.end).not.toHaveBeenCalled()
  })
})

const preparedMutation = {
  releaseDuringPreparation: true as const,
  resourceLock: 'workspace:configuration',
  validate: async () => true,
}

describe('command retries after concurrent preparation', () => {
  it.each(['http', 'mcp'] as const)('returns the committed matching result after preparation fails (%s)', async source => {
    const f = fixture()
    const entered = deferred()
    const resume = deferred()
    let created = false
    const perform = vi.fn(async () => {
      created = true
      return { id: 'created-agent' }
    })
    const prepare = vi.fn(async () => {
      if (created) throw new DomainError('AGENT_ID_CONFLICT', 'The Agent ID already exists.', 409)
    })
    const replayResult = vi.fn((result: unknown) => result as { id: string })
    const delayed = f.coordinator.execute({ ...command, source, preparedMutation, perform, replayResult,
      prepare: async () => {
        entered.resolve()
        await resume.promise
        await prepare()
      },
    })
    const outcome = delayed.then(value => ({ value }), (error: unknown) => ({ error }))
    await entered.promise
    const winner = await f.coordinator.execute({ ...command, source, preparedMutation, prepare, perform })
    expect(winner).toEqual({ value: { id: 'created-agent' }, replayed: false })
    resume.resolve()
    expect(await outcome).toEqual({ value: { value: winner.value, replayed: true } })
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(perform).toHaveBeenCalledOnce()
    expect(replayResult).toHaveBeenCalledExactlyOnceWith(winner.value)
    expect(f.state.receiptWrites).toBe(1)
    expect(f.state.audits.map(audit => audit.outcome)).toEqual(['succeeded'])
  })

  it('preserves and audits preparation failure when no retry committed', async () => {
    const f = fixture()
    const failure = new DomainError('REVISION_CONFLICT', 'Settings changed.', 409)
    const perform = vi.fn()
    const prepare = vi.fn(async () => { throw failure })
    await expect(f.coordinator.execute({ ...command, preparedMutation, prepare, perform })).rejects.toBe(failure)
    expect(prepare).toHaveBeenCalledOnce()
    expect(perform).not.toHaveBeenCalled()
    expect(f.state.receiptWrites).toBe(0)
    expect(f.state.audits).toEqual([{
      principalId: principal.id,
      source: command.source,
      action: command.operation,
      targetKey: command.targetKey,
      outcome: 'failed',
      details: { commandId: command.commandId, code: failure.code },
    }])
  })

  it.each(['payload', 'targetKey'] as const)('rejects a concurrent receipt with different %s', async field => {
    const f = fixture()
    const entered = deferred()
    const resume = deferred()
    const perform = vi.fn(async () => 'accepted')
    const delayed = f.coordinator.execute({ ...command, preparedMutation, perform, prepare: async () => {
      entered.resolve()
      await resume.promise
      throw new DomainError('REVISION_CONFLICT', 'Settings changed.', 409)
    } })
    const outcome = delayed.catch((error: unknown) => error)
    await entered.promise
    await f.coordinator.execute({ ...command,
      ...(field === 'payload' ? { payload: { expectedRevision: 2 } } : { targetKey: 'other-workspace' }),
      preparedMutation, prepare: async () => undefined, perform,
    })
    resume.resolve()
    expect(await outcome).toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect(perform).toHaveBeenCalledOnce()
    expect(f.state.receiptWrites).toBe(1)
  })

  it('denies a committed result if authorization is revoked during preparation', async () => {
    const f = fixture()
    const entered = deferred()
    const resume = deferred()
    let revoked = false
    const denied = new DomainError('FORBIDDEN', 'Authority revoked.', 403)
    const authorize = vi.fn(async () => { if (revoked) throw denied })
    const perform = vi.fn(async () => 'accepted')
    const delayed = f.coordinator.execute({ ...command, preparedMutation, authorize, perform, prepare: async () => {
      entered.resolve()
      await resume.promise
      throw new DomainError('REVISION_CONFLICT', 'Settings changed.', 409)
    } })
    const outcome = delayed.catch((error: unknown) => error)
    await entered.promise
    await f.coordinator.execute({ ...command, preparedMutation, prepare: async () => undefined, perform })
    revoked = true
    resume.resolve()
    expect(await outcome).toBe(denied)
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(perform).toHaveBeenCalledOnce()
    expect(f.state.receiptWrites).toBe(1)
  })
})
