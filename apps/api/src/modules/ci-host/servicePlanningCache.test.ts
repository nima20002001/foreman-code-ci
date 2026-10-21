import type pg from 'pg'
import { CiRunRecordSchema, type CiHostStatus, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'
import { readyStatus } from './dispatchFleet.testSupport.js'
import type { HostCiComputer } from './serviceTypes.js'

afterEach(() => { vi.useRealTimers() })

it('plans from an observed computer’s capacity while its expired status refresh remains blocked', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T00:00:01Z'))
  const caller: ManagementPrincipal = { id: 'fixture-operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
  const computer: HostCiComputer = { key: 'fixture:worker', label: 'Build executor', priority: 1,
    hostRef: { kind: 'device', mainId: 'fixture', deviceId: 'fixture-worker' } }
  const records: CiRunRecord[] = []
  const pool = { options: { max: 10 }, query: async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('from workspaces')) return { rows: [{ record: {
      id: 'fixture-workspace', name: 'Planning fixture', repository: {
        provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main',
      },
    } }] }
    if (sql.startsWith('insert into ci_runs')) records.push(CiRunRecordSchema.parse(JSON.parse(parameters![3] as string)))
    return { rows: [], rowCount: 1 }
  } } as unknown as pg.Pool
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  const authority: CiAuthority = { resolve: async () => ({ workspaceId: 'fixture-workspace', principal: caller }) }
  const refresh = deferred<CiHostStatus>()
  let stale = false
  const endpoint: HostCiEndpoint = { computers: async () => [computer], request: async (_computer, request) => {
    if (request.operation !== 'status') throw new Error('Unexpected executor request')
    return stale ? refresh.promise : readyStatus({ slotsTotal: 3 })
  } }
  const files = Array.from({ length: 6 }, (_, index) => `apps/api/test/fixture-${index}.integration.test.ts`)
  const commits: CiCommits = { resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }),
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  await service.computers(caller, { workspaceId: 'fixture-workspace' })
  vi.setSystemTime(Date.now() + 6000)
  stale = true
  let admitted = false
  const admission = service.run(caller, { workspaceId: 'fixture-workspace', suite: 'integration', scope: 'full' })
    .then(output => { admitted = true; return output })
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(admitted).toBe(true)
    expect((await admission).partitions).toHaveLength(3)
    expect(records).toHaveLength(3)
  } finally {
    refresh.resolve(readyStatus({ slotsTotal: 3 }))
    await vi.advanceTimersByTimeAsync(1)
    await admission
    await service.close()
  }
})
