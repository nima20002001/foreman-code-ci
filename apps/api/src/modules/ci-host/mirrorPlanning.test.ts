import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { CiAuthority } from '../jobs/ciAuthority.js'
import { ProductionHostCiEndpoint } from './endpoint.js'
import { fixture } from './cloud.testSupport.js'
import { HostCiService, type CiCommits, type HostCiEndpoint } from './service.js'

it('starts mirror publication after resolving the commit while planning is blocked', async () => {
  const workspaceId = randomUUID()
  const workspace = { id: workspaceId, name: 'CI fixture', repository: {
    provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main',
  }, ciMirror: { provider: 'github', owner: 'fixture', name: 'site-ci' } }
  const caller: ManagementPrincipal = { id: 'fixture-operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const pool = { query: vi.fn(async (sql: string) => ({
    rows: sql.includes('from workspaces') ? [{ record: workspace }] : [], rowCount: 1,
  })) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async () => ({ workspaceId, principal: caller }) }
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  let releasePlan!: () => void
  const planning = new Promise<void>(resolve => { releasePlan = resolve })
  let releasePublish!: () => void
  const publishing = new Promise<void>(resolve => { releasePublish = resolve })
  const publishMirror = vi.fn(async () => publishing)
  const endpoint: HostCiEndpoint = Object.assign({
    computers: async () => [],
    request: async () => { throw new Error('No executor request expected') },
  }, { publishMirror })
  const commits: CiCommits = {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => {
      await planning
      return { parts: false, integrationPartitions: false, affected: true }
    },
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  const run = service.run(caller, { workspaceId, suite: 'lint', scope: 'affected', baseCommit: 'b'.repeat(40) })
  try {
    await expect.poll(() => publishMirror.mock.calls.length).toBe(1)
    expect(publishMirror).toHaveBeenCalledWith(expect.objectContaining({ repository: 'fixture/site',
      mirror: 'fixture/site-ci', commit: 'a'.repeat(40), baseCommit: 'b'.repeat(40) }))
    releasePlan()
    // Admission does not wait for the mirror push.
    await expect(run).resolves.toMatchObject({ ticketId: expect.any(String) })
  } finally {
    releasePlan()
    releasePublish()
    await run
    await service.close()
  }
})

it('publishes the unit mirror snapshot with the learned durations the queued tickets carry', async () => {
  const workspaceId = randomUUID()
  const workspace = { id: workspaceId, name: 'CI fixture', repository: {
    provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main',
  }, ciMirror: { provider: 'github', owner: 'fixture', name: 'site-ci' } }
  const caller: ManagementPrincipal = { id: 'fixture-operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const queuedDurations: unknown[] = []
  const pool = { query: vi.fn(async (sql: string, parameters?: unknown[]) => {
    if (sql.startsWith('insert into ci_runs')) queuedDurations.push(JSON.parse(parameters![4] as string))
    if (sql.includes('from ci_file_durations')) return { rows: [{ file: 'apps/api/src/a.test.ts', duration_ms: 70_000 }] }
    return { rows: sql.includes('from workspaces') ? [{ record: workspace }] : [], rowCount: 1 }
  }) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async () => ({ workspaceId, principal: caller }) }
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  const publishMirror = vi.fn(async () => undefined)
  const endpoint: HostCiEndpoint = Object.assign({
    computers: async () => [],
    request: async () => { throw new Error('No executor request expected') },
  }, { publishMirror })
  const files = ['apps/api/src/a.test.ts', 'apps/api/src/b.test.ts']
  const commits: CiCommits = {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: false, affected: true }),
    unitInventory: async () => ({ files, durations: { 'apps/api/src/b.test.ts': 40_000 }, heavy: [] }),
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  vi.spyOn(service, 'dispatch').mockResolvedValue(undefined)
  try {
    await service.run(caller, { workspaceId, suite: 'unit', scope: 'full' })
    await expect.poll(() => publishMirror.mock.calls.length).toBeGreaterThan(0)
    const published = (publishMirror.mock.calls as unknown as { durations?: unknown }[][])
      .map(([input]) => input!.durations)
    expect(queuedDurations[0]).toEqual({ 'apps/api/src/a.test.ts': 70_000, 'apps/api/src/b.test.ts': 40_000 })
    expect(published).toEqual([queuedDurations[0]])
  } finally {
    await service.close()
  }
})

it('dispatch reuses a mirror push started during planning with the same learned durations', async () => {
  const f = await fixture()
  const workspaceId = randomUUID()
  const workspace = { id: workspaceId, name: 'CI fixture', repository: {
    provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main',
  }, ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } }
  const caller: ManagementPrincipal = { id: 'fixture-operator', name: 'Operator', audience: 'operator',
    grants: [], expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const pool = { query: vi.fn(async (sql: string) => ({
    rows: sql.includes('from workspaces') ? [{ record: workspace }] : [], rowCount: 1,
  })) } as unknown as pg.Pool
  const authority: CiAuthority = { resolve: async () => ({ workspaceId, principal: caller }) }
  const commands = { execute: async (input: Parameters<PostgresCommandCoordinator['execute']>[0]) => {
    await input.prepare?.(pool)
    return { value: await input.perform(pool as unknown as pg.PoolClient), replayed: false }
  } } as PostgresCommandCoordinator
  let releasePlan!: () => void
  const planning = new Promise<void>(resolve => { releasePlan = resolve })
  let releasePush!: () => void
  const pushing = new Promise<void>(resolve => { releasePush = resolve })
  let pushes = 0
  const original = f.git.git.bind(f.git)
  vi.spyOn(f.git, 'git').mockImplementation(async (args, options) => {
    if (args[0] === 'push' && args.includes('--force')) {
      pushes++
      await pushing
    }
    return original(args, options)
  })
  const endpoint = new ProductionHostCiEndpoint(pool, 'fixture-main', () => undefined,
    { handle: async () => { throw new Error('No local executor expected') } }, [f.cloud])
  vi.spyOn(endpoint, 'computers').mockResolvedValue([])
  const durations = { 'apps/api/test/a.integration.test.ts': 500 }
  const commits: CiCommits = {
    resolve: async () => f.commit,
    capabilities: async () => {
      await planning
      return { parts: false, integrationPartitions: true, affected: true }
    },
    integrationInventory: async () => ({ files: Object.keys(durations), durations }),
  }
  const service = new HostCiService(pool, commands, authority, commits, endpoint)
  const run = service.run(caller, { workspaceId, suite: 'integration', scope: 'full' })
  let start: Promise<unknown> | undefined
  try {
    await expect.poll(() => pushes, { timeout: 5000 }).toBe(1)
    releasePlan()
    await run
    start = endpoint.request(f.cloud.computers()[0]!, { operation: 'start', runId: randomUUID(),
      repository: 'octo/site', ciMirror: 'octo/site-ci', commit: f.commit,
      suite: 'integration', scope: 'full', durations })
    releasePush()
    await start
    expect(pushes).toBe(1)
    expect(f.dispatched).toHaveLength(1)
  } finally {
    releasePlan()
    releasePush()
    await run
    await start
    await service.close()
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
  }
})

it('refreshes tickets often enough to observe a cloud completion within three seconds', async () => {
  const endpoint: HostCiEndpoint = { computers: async () => [],
    request: async () => { throw new Error('No executor request expected') } }
  const service = new HostCiService({} as pg.Pool, {} as PostgresCommandCoordinator,
    {} as CiAuthority, {} as CiCommits, endpoint)
  const dispatch = vi.spyOn(service, 'dispatch').mockResolvedValue(undefined)
  vi.useFakeTimers()
  try {
    service.start()
    await vi.advanceTimersByTimeAsync(2500)
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(3)
  } finally {
    await service.close()
    vi.useRealTimers()
  }
})
