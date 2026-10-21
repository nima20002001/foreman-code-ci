import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunRecordSchema, type CiHostStatus, type CiRunRecord } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'
import type { HostCiComputer } from './serviceTypes.js'
import { readCiSlots } from './planningCapacity.js'

async function admit(computers: HostCiComputer[], statuses: CiHostStatus[], reservations: number[]) {
  const caller: ManagementPrincipal = { id: 'fixture-operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const workspaceId = randomUUID()
  const workspace = { id: workspaceId, name: 'Planning fixture', repository: {
    provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main',
  } }
  const records: CiRunRecord[] = []
  const pool = { query: async (sql: string, parameters?: unknown[]) => {
    if (sql.includes('from workspaces')) return { rows: [{ record: workspace }] }
    if (sql.includes('count(*)')) return { rows: computers.map((computer, index) => ({
      host_key: computer.key, count: reservations[index] ?? 0,
    })) }
    if (sql.startsWith('insert into ci_runs')) {
      records.push(CiRunRecordSchema.parse(JSON.parse(parameters![3] as string)))
    }
    return { rows: [], rowCount: 1 }
  } } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async () => ({ workspaceId, principal: caller }) }
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request) => {
      if (request.operation !== 'status') throw new Error('Unexpected executor request')
      return statuses[computers.indexOf(computer)]!
    },
  }
  const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/example-${index}.integration.test.ts`)
  const commits: CiCommits = {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }),
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  vi.spyOn(service, 'dispatch').mockResolvedValue(undefined)
  try {
    const output = await service.run(caller, { workspaceId, suite: 'integration', scope: 'full' })
    return { output, records }
  } finally {
    await service.close()
  }
}

const computers: HostCiComputer[] = [
  { key: 'fixture-cloud', label: 'Cloud executor', priority: 1,
    hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'github', slot: 0 } },
  { key: 'fixture-build', label: 'Build executor', priority: 1,
    hostRef: { kind: 'main', mainId: 'fixture-main' } },
]
function status(slotsTotal: number, slotsUsed: number): CiHostStatus {
  return { operation: 'status', ready: true, reasons: [], cpuCount: 8,
    memoryBytes: 16 * 2 ** 30, slotsTotal, slotsUsed, runs: [] }
}

it('keeps queued integration parts sized to eligible capacity when runners and persisted reservations are busy', async () => {
  const { output, records } = await admit(computers, [status(4, 4), status(3, 0)], [0, 3])
  expect(output.partitions).toHaveLength(7)
  expect(records).toHaveLength(7)
  expect(records.every(record => record.state === 'queued' && record.partition?.count === 7)).toBe(true)
})

it('includes three free build slots alongside one free cloud slot for ordinary integration work', async () => {
  const { output, records } = await admit(computers, [status(1, 0), status(3, 0)], [0, 0])
  expect(output.partitions).toHaveLength(4)
  expect(records).toHaveLength(4)
  expect(records.every(record => record.requiresBuildComputer === false)).toBe(true)
})

it('counts free local ordinary slots even while cloud capacity is available', async () => {
  const pool = { query: async () => ({ rows: [{ host_key: computers[1]!.key, count: 1 }] }) } as unknown as pg.Pool
  const statuses = [status(2, 1), status(4, 0)]
  const capacity = await readCiSlots(pool, {
    computers: async () => computers,
    request: async computer => statuses[computers.indexOf(computer)]!,
  })
  expect(capacity).toMatchObject({ host: 3, ordinary: 4 })
  expect(capacity.usedByComputer.get(computers[1]!.key)).toBe(1)
})
