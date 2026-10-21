import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

afterEach(() => { vi.useRealTimers() })

function fixture() {
  const caller: ManagementPrincipal = { id: 'fixture-operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const workspaceId = randomUUID()
  const workspace = { id: workspaceId, name: 'Capacity fixture', repository: {
    provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main',
  } }
  const records: CiRunRecord[] = []
  let occupied = 0
  let ready = true
  let available = true
  const pool = { query: vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('from workspaces')) return { rows: [{ record: workspace }] }
    if (sql.includes('count(*)')) return { rows: [{ host_key: 'fixture-host', count: occupied }] }
    if (sql.startsWith('insert into ci_runs')) {
      records.push(CiRunRecordSchema.parse(JSON.parse(parameters![3] as string)))
    }
    return { rows: [], rowCount: 1 }
  }) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async () => ({ workspaceId, principal: caller }) }
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  let statusDelayMs = 2000
  const wait = (ms = 2000) => new Promise<void>(resolve => { setTimeout(resolve, ms) })
  const endpoint: HostCiEndpoint = {
    computers: vi.fn<HostCiEndpoint['computers']>(async () => {
      await wait()
      return available ? [{ key: 'fixture-host', label: 'Build executor', priority: 60,
        hostRef: { kind: 'main', mainId: 'fixture-main' } }] : []
    }),
    request: vi.fn<HostCiEndpoint['request']>(async (_computer, request) => {
      if (request.operation !== 'status') throw new Error('Unexpected executor request')
      await wait(statusDelayMs)
      return { operation: 'status', ready, reasons: ready ? [] : ['Executor unavailable'], cpuCount: 8,
        memoryBytes: 16 * 2 ** 30, slotsTotal: 5, slotsUsed: 0, runs: [] }
    }),
  }
  const files = Array.from({ length: 6 }, (_, index) => `apps/api/src/feature-${index}.test.ts`)
  const commits: CiCommits = {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    unitInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 100_000])), heavy: [] }),
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  // Keep the regression focused on admission; dispatch has its own live-status tests.
  vi.spyOn(service, 'dispatch').mockResolvedValue(undefined)
  const run = () => service.run(caller, { workspaceId, suite: 'unit', scope: 'affected', files })
  return { service, run, records, endpoint,
    occupy: (count: number) => { occupied = count }, slowStatus: () => { statusDelayMs = 60_000 }, unavailable: () => { ready = false }, hide: () => { available = false } }
}

it('reuses slow computer capacity reads on a second admission without shrinking shards for busy slots', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const first = f.run()
    await vi.advanceTimersByTimeAsync(4000)
    expect((await first).partitions).toHaveLength(5)
    f.occupy(4)
    const second = f.run()
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Admission awaited a slow capacity read')), 500)
    })
    const result = Promise.race([second, deadline])
    const assertion = expect(result).resolves.toMatchObject({ ticketId: expect.any(String) })
    await vi.advanceTimersByTimeAsync(500)
    await assertion
    expect((await second).partitions).toHaveLength(5)
    expect(f.endpoint.computers).toHaveBeenCalledTimes(1)
    expect(f.endpoint.request).toHaveBeenCalledTimes(1)
    expect(f.records.filter(record => record.groupId === f.records.at(-1)!.groupId)).toHaveLength(5)
  } finally {
    await f.service.close()
  }
})

it('plans from the last readiness snapshot while an expired one refreshes in the background', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const first = f.run()
    await vi.advanceTimersByTimeAsync(4000)
    await first
    f.unavailable()
    await vi.advanceTimersByTimeAsync(6000)
    const second = f.run()
    await vi.advanceTimersByTimeAsync(2000)
    expect((await second).partitions).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(2000)
    expect(f.endpoint.request).toHaveBeenCalledTimes(2)
    const third = f.run()
    expect((await third).partitions).toBeUndefined()
  } finally {
    await f.service.close()
  }
})

it('does not let a stalled computer status read delay admission once a snapshot exists', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const first = f.run()
    await vi.advanceTimersByTimeAsync(4000)
    await first
    f.slowStatus()
    await vi.advanceTimersByTimeAsync(6000)
    const second = f.run()
    const deadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('Admission awaited a stalled status read')), 2500)
    })
    const result = Promise.race([second, deadline])
    const assertion = expect(result).resolves.toMatchObject({ ticketId: expect.any(String) })
    await vi.advanceTimersByTimeAsync(2500)
    await assertion
    expect((await second).partitions).toHaveLength(5)
  } finally {
    await f.service.close()
  }
})

it('sizes unit shards from eligible capacity when every slot is busy', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    f.occupy(5)
    const admitted = f.run()
    await vi.advanceTimersByTimeAsync(4000)
    expect((await admitted).partitions).toHaveLength(5)
  } finally {
    await f.service.close()
  }
})

it('lists changed build participation immediately after a cached admission', async () => {
  vi.useFakeTimers()
  const f = fixture()
  try {
    const admitted = f.run()
    await vi.advanceTimersByTimeAsync(4000)
    await admitted
    f.hide()
    const listing = f.service.computers({ id: 'fixture-operator' } as ManagementPrincipal, {})
    await vi.advanceTimersByTimeAsync(2000)
    expect((await listing).computers).toEqual([])
  } finally {
    await f.service.close()
  }
})
