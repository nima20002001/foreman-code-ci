import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { CiRunOutputSchema, type CiRunInput } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { HostCiService, type CiCommits, type HostCiComputer, type HostCiEndpoint } from './service.js'

const caller: ManagementPrincipal = {
  id: 'fixture-operator', name: 'Operator', audience: 'operator', grants: [],
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture(branch: string | undefined, status?: HostCiEndpoint['request'],
  rows: (sql: string) => unknown[] = () => []) {
  const workspaceId = randomUUID()
  const workspace = { id: workspaceId, name: 'CI fixture', repository: {
    provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main',
  } }
  const pool = { query: vi.fn(async (sql: string) => ({
    rows: sql.includes('from workspaces') ? [{ record: workspace }] : rows(sql), rowCount: 1,
  })) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async () => ({ workspaceId, principal: caller }) }
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  const computers: HostCiComputer[] = [
    { key: 'fixture-host', label: 'Build executor', priority: 60,
      hostRef: { kind: 'main', mainId: 'fixture-main' } },
    ...Array.from({ length: 8 }, (_, slot) => ({ key: `fixture-cloud-${slot}`, label: `Cloud ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture-main', provider: 'github' as const, slot } })),
  ]
  const entered = deferred()
  const release = deferred()
  let paused = false
  const endpoint: HostCiEndpoint = {
    computers: async () => {
      if (!paused) {
        paused = true
        entered.resolve()
        await release.promise
      }
      return computers
    },
    request: status ?? (async (_computer, request) => {
      if (request.operation !== 'status') throw new Error('Unexpected executor request')
      return { operation: 'status', ready: true, reasons: [], cpuCount: 8,
        memoryBytes: 16 * 2 ** 30, slotsTotal: 1, slotsUsed: 0, runs: [] }
    }),
  }
  const commits: CiCommits = {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    unitInventory: async () => ({ files: ['apps/api/src/site.test.ts'], durations: {}, heavy: [] }),
    integrationInventory: async () => ({ files: ['apps/api/test/site.integration.test.ts'], durations: {} }),
    ...(branch === undefined ? {} : { branch: async () => branch, isAncestor: async () => true }),
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  return { service, entered, release, computers }
}

it.each(['gate', 'main', 'unknown', 'smoke', 'feature'] as const)(
  'returns a %s request through the CI service while dispatch is still in flight', async kind => {
    let branch: string | undefined
    if (kind === 'gate' || kind === 'feature') branch = 'feature'
    if (kind === 'main') branch = 'main'
    const f = fixture(branch)
    let finished = false
    const dispatch = f.service.dispatch().then(() => { finished = true })
    let timeout: NodeJS.Timeout | undefined
    try {
      await f.entered.promise
      const input: CiRunInput = { suite: 'install', commit: 'a'.repeat(40), scope: 'full' }
      if (kind === 'gate') Object.assign(input, { suite: 'integration', gate: true })
      if (kind === 'smoke') Object.assign(input, { suite: 'unit', scope: 'affected',
        files: ['apps/api/src/site.test.ts'], smokeComputer: f.computers[0]!.hostRef })
      const result = await Promise.race([
        f.service.run(caller, { ...input, workspaceId: 'unused-by-fixture' }),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('CI admission waited for dispatch')), 1000)
        }),
      ])
      expect(CiRunOutputSchema.parse(result).ticketId).toEqual(expect.any(String))
      expect(finished).toBe(false)
    } finally {
      clearTimeout(timeout)
      f.release.resolve()
      await dispatch
      await f.service.close()
    }
  },
)

it('reports an unreachable smoke computer as a retryable unavailable computer', async () => {
  const f = fixture(undefined, async () => { throw Object.assign(new Error('transport'), { code: 'transport' }) })
  f.release.resolve()
  const smokeHost = f.computers[0]!
  await expect(f.service.run(caller, { workspaceId: 'unused-by-fixture', suite: 'integration', commit: 'a'.repeat(40),
    scope: 'affected', files: ['apps/api/test/site.integration.test.ts'], smokeComputer: smokeHost.hostRef }))
    .rejects.toMatchObject({ code: 'CI_SMOKE_COMPUTER_UNAVAILABLE', status: 503, details: { retryable: true } })
})

it('reports an enabled smoke computer whose Worker is still connecting as retryable', async () => {
  const smokeComputer = { kind: 'device' as const, mainId: 'fixture-main', deviceId: 'fixture-laptop' }
  const f = fixture(undefined, undefined, sql => sql.includes('build_computer_preferences') ? [{ build_enabled: true }] : [])
  f.release.resolve()
  await expect(f.service.run(caller, { workspaceId: 'unused-by-fixture', suite: 'integration', commit: 'a'.repeat(40),
    scope: 'affected', files: ['apps/api/test/site.integration.test.ts'], smokeComputer }))
    .rejects.toMatchObject({ code: 'CI_SMOKE_COMPUTER_UNAVAILABLE', status: 503, details: { retryable: true } })
})

it('rejects a smoke computer that is not an enabled build computer', async () => {
  const f = fixture(undefined)
  f.release.resolve()
  await expect(f.service.run(caller, { workspaceId: 'unused-by-fixture', suite: 'integration', commit: 'a'.repeat(40),
    scope: 'affected', files: ['apps/api/test/site.integration.test.ts'],
    smokeComputer: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-laptop' } }))
    .rejects.toMatchObject({ code: 'CI_SMOKE_COMPUTER_UNAVAILABLE', status: 409 })
})
