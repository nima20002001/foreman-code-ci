import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'

vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('ends an expired session lock wait with a retryable domain error before executing the command', async () => {
  const principal: ManagementPrincipal = { id: 'fixture', name: 'Fixture', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const release = vi.fn()
  const end = vi.fn(async () => undefined)
  const client = { release, query: async (statement: string) => ({
    rows: statement.includes('advisory_lock(') ? [{ locked: false }] : [], rowCount: 0,
  }) }
  const pool = { options: {}, connect: vi.fn(), end: vi.fn() }
  const dedicatedPool = { connect: vi.fn(async () => client), end, on: () => undefined }
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return dedicatedPool } as never)
  vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(600_001)
  const perform = vi.fn(async () => 'captured')
  const coordinator = new PostgresCommandCoordinator(pool as unknown as pg.Pool)
  await expect(coordinator.execute({ principal, source: 'mcp', operation: 'source.project.capture',
    commandId: 'capture', targetKey: 'workspace', payload: {}, dedicatedConnection: true, perform,
  })).rejects.toMatchObject({ code: 'COMMAND_LOCK_TIMEOUT', status: 503,
    details: { retryable: true, newCommandRequired: false } })
  expect(perform).not.toHaveBeenCalled()
  expect(pool.connect).not.toHaveBeenCalled()
  expect(dedicatedPool.connect).toHaveBeenCalledOnce()
  expect(release).toHaveBeenCalledOnce()
  expect(end).not.toHaveBeenCalled()
})

it.each([0, 0.99])('backs off contended session locks with bounded jitter (random=%s)', async random => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  vi.spyOn(Math, 'random').mockReturnValue(random)
  const principal: ManagementPrincipal = { id: 'fixture', name: 'Fixture', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const attempts: number[] = []
  let available = false
  const client = { release: vi.fn(), query: async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock(')) {
      attempts.push(performance.now())
      return { rows: [{ locked: available }] }
    }
    return { rows: [] }
  } }
  const dedicatedPool = { connect: async () => client, end: vi.fn(async () => undefined), on: () => undefined }
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return dedicatedPool } as never)
  const coordinator = new PostgresCommandCoordinator({ options: {}, end: vi.fn() } as unknown as pg.Pool)
  const perform = vi.fn(async () => 'captured')
  const pending = coordinator.execute({ principal, source: 'mcp', operation: 'capture',
    commandId: 'capture', targetKey: 'workspace', payload: {}, dedicatedConnection: true, perform })
  await vi.advanceTimersByTimeAsync(10_000)
  available = true
  await vi.advanceTimersByTimeAsync(1000)
  await expect(pending).resolves.toEqual({ value: 'captured', replayed: false })
  expect(attempts.length).toBeLessThan(35)
  const gaps = attempts.slice(1).map((time, index) => time - attempts[index]!)
  expect(gaps[1]).toBeGreaterThan(gaps[0]!)
  expect(gaps[0]).toBeGreaterThanOrEqual(random === 0 ? 25 : 37)
  expect(Math.max(...gaps)).toBeLessThanOrEqual(1000)
  expect(perform).toHaveBeenCalledOnce()
  expect(client.release).toHaveBeenCalledOnce()
  expect(dedicatedPool.end).not.toHaveBeenCalled()
})

it('keeps the ten-minute deadline while backing off a permanently contended lock', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'performance'] })
  vi.spyOn(Math, 'random').mockReturnValue(0.99)
  const principal: ManagementPrincipal = { id: 'fixture', name: 'Fixture', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  let attempts = 0
  const client = { release: vi.fn(), query: async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock(')) {
      attempts++
      return { rows: [{ locked: false }] }
    }
    return { rows: [] }
  } }
  const dedicatedPool = { connect: async () => client, end: vi.fn(async () => undefined), on: () => undefined }
  vi.spyOn(pg, 'Pool').mockImplementation(function () { return dedicatedPool } as never)
  const coordinator = new PostgresCommandCoordinator({ options: {}, end: vi.fn() } as unknown as pg.Pool)
  const perform = vi.fn()
  const failure = coordinator.execute({ principal, source: 'mcp', operation: 'capture',
    commandId: 'capture', targetKey: 'workspace', payload: {}, dedicatedConnection: true, perform,
  }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(600_000)
  expect(await failure).toMatchObject({ code: 'COMMAND_LOCK_TIMEOUT',
    details: { retryable: true, newCommandRequired: false } })
  expect(attempts).toBeLessThan(1000)
  expect(perform).not.toHaveBeenCalled()
  expect(client.release).toHaveBeenCalledOnce()
  expect(dedicatedPool.end).not.toHaveBeenCalled()
})
