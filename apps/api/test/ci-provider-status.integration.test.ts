import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiHostReply } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type pg from 'pg'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { ProductionHostCiEndpoint } from '../src/modules/ci-host/endpoint.js'
import { CircleStandby } from '../src/modules/ci-host/circleStandby.js'
import type { CiUnitInventory } from '../src/modules/ci-host/parts.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { createTestPool } from './helpers/testPool.mjs'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

async function fixture(options: { creditsRemaining?: number; creditRefused?: boolean; unitInventory?: CiUnitInventory } = {}) {
  const pool = createTestPool({ connectionString: database.databaseUrl, max: 2, connectionTimeoutMillis: 100 })
  const query = pool.query.bind(pool) as (text: string, values?: unknown[]) => Promise<pg.QueryResult>
  // Real pool acquisition deadlines expose slot fan-out under modest database latency.
  pool.query = (async (text: string, values?: unknown[]) => {
    const client = await pool.connect()
    try {
      await client.query('select pg_sleep(0.025)')
      return await client.query(text, values)
    } finally { client.release() }
  }) as typeof pool.query
  const workspaceId = randomUUID()
  await query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'Provider status fixture', repository: {
      provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main',
    }, ciMirror: { provider: 'github', owner: 'fixture', name: 'site-ci' } })])
  const computers: HostCiComputer[] = [
    { key: 'builder', label: 'Builder', priority: 60, hostRef: { kind: 'main', mainId: 'fixture' } },
    ...Array.from({ length: 14 }, (_, slot) => ({ key: `github:${slot}`, label: `GitHub ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider: 'github' as const, slot } })),
    ...['alpha', 'beta'].flatMap(account => Array.from({ length: 45 }, (_, slot) => ({
      key: `circleci:${account}:${slot}`, label: `CircleCI ${account} ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider: 'circleci' as const, account, slot },
    }))),
  ]
  const statusReads = new Map<string, number>()
  const productionEndpoint = new ProductionHostCiEndpoint(pool, 'fixture', () => undefined,
    { handle: async () => { throw new Error('Unexpected local runner request') } })
  const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  const remaining = options.creditsRemaining
  const creditsAsOf = new Date().toISOString()
  const circleCredits = remaining === undefined ? undefined : { reading: async () => ({ credits: {
    total: 400_000, used: 400_000 - remaining, remaining, asOf: creditsAsOf,
  } }) }
  const circleStandby = circleCredits && new CircleStandby(async () => ['alpha', 'beta'].map(owner => ({
    owner, circleAccountId: 'default', role: 'primary' as const, ready: true, mirrorNames: new Set(['site-ci']),
  })), circleCredits)
  // CircleCI's own credit refusal marks orgs exhausted; usage estimates alone never do.
  if (options.creditRefused) for (const owner of ['alpha', 'beta']) await circleStandby!.recordCreditRefusal(owner)
  const commands = new PostgresCommandCoordinator(pool)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), {
    resolve: async () => 'a'.repeat(40),
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    integrationInventory: async () => ({ files, durations: Object.fromEntries(files.map(file => [file, 120_000])) }),
    unitInventory: async () => options.unitInventory ?? ({ files: ['apps/api/src/site.test.ts', 'apps/web/src/site.test.ts'],
      durations: {}, heavy: [] }),
  }, {
    statusKey: computer => productionEndpoint.statusKey(computer),
    computers: async () => computers,
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        const key = computer.hostRef.provider ? `${computer.hostRef.provider}:${computer.hostRef.account ?? ''}` : 'builder'
        statusReads.set(key, (statusReads.get(key) ?? 0) + 1)
        return { operation: 'status', ready: true, reasons: [], runs: [], slotsUsed: 0, slotsTotal: 1,
          cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 16, memoryBytes: 16 * 2 ** 30 }
      }
      if (request.operation !== 'start') throw new Error('Unexpected executor request')
      return { operation: 'start', run: { runId: request.runId, state: 'running', step: request.suite,
        startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 } }
    },
  }, undefined, { ...(circleStandby && circleCredits ? { circleStandby, circleCredits } : {}) })
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (write: boolean) => {
    const issued = await access.issue({ name: 'CI fixture caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: write ? [...CI_GET_ACTIONS, ...CI_RUN_ACTIONS]
        : CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }] })
    const client = new Client({ name: 'provider-status-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
    }))
    return client
  }
  const operator = await connect(true)
  const reader = await connect(false)
  const call = (client: Client, name: string, input: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const value = async (name: string, input: Record<string, unknown> = {}) => {
    const result = await call(operator, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  return { pool, ci, files, computers, workspaceId, statusReads, reader, call, value, close: async () => {
    await ci.close()
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.query('delete from ci_runs where workspace_id=$1', [workspaceId])
    await pool.end()
  } }
}

it('lists every slot ready with one provider read per account through MCP and a two-connection pool', async () => {
  const f = await fixture()
  try {
    const output = await f.value('ci_computers_list') as { computers: { ready: boolean; reasons: string[] }[] }
    expect(output.computers).toHaveLength(105)
    expect(output.computers.filter(computer => !computer.ready)).toEqual([])
    expect(Object.fromEntries(f.statusReads)).toEqual({ builder: 1, 'github:': 1, 'circleci:alpha': 1, 'circleci:beta': 1 })
  } finally { await f.close() }
})

it.each(['pending', 'acknowledged'] as const)(
  'lists 45 starting CircleCI slots without losing readiness when start is %s', async phase => {
    const f = await fixture()
    try {
      const at = new Date().toISOString()
      const groupId = randomUUID()
      const slots = f.computers.filter(computer => computer.hostRef.account === 'alpha')
      expect(slots).toHaveLength(45)
      const records = slots.map(computer => CiRunRecordSchema.parse({
        id: randomUUID(), workspaceId: f.workspaceId, groupId, suite: 'integration', part: null, partition: null,
        scope: 'full', files: [f.files[0]!], repository: 'fixture/site', commit: 'a'.repeat(40), state: 'starting',
        computer: { hostRef: computer.hostRef, label: computer.label }, step: 'dispatch',
        queuedAt: at, startedAt: phase === 'pending' ? null : at, finishedAt: null, exitCode: null, message: null,
        initiator: { principalId: 'fixture-operator', executionId: null },
      }))
      for (const [index, record] of records.entries()) {
        await f.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record)
          values($1,$2,$3,$4,$5,$6::jsonb)`,
        [record.id, f.workspaceId, groupId, record.state, slots[index]!.key, JSON.stringify(record)])
      }
      const output = CiComputersOutputSchema.parse(await f.value('ci_computers_list'))
      expect(output.computers).toHaveLength(105)
      expect(output.computers.filter(computer => !computer.ready)).toEqual([])
      const starting = output.computers.filter(computer => computer.hostRef.account === 'alpha')
      expect(starting).toHaveLength(45)
      for (const computer of starting) {
        const record = records.find(record => record.computer!.hostRef.slot === computer.hostRef.slot)!
        expect(computer).toMatchObject({ ready: true, slotsUsed: 1, running: [record.id] })
      }
      const stored = (await f.pool.query('select record from ci_runs where workspace_id=$1', [f.workspaceId])).rows
      expect(stored).toHaveLength(45)
      for (const row of stored) {
        expect(row.record).toMatchObject({ state: 'starting', startedAt: phase === 'pending' ? null : at })
      }
    } finally { await f.close() }
  })

it('persists a large gate split across CircleCI slots through authenticated MCP with a small pool', async () => {
  const f = await fixture()
  try {
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    expect((await f.call(f.reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    await f.ci.close()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const integration = read.partitions!.filter(run => run.suite === 'integration')
    expect(integration.filter(run => run.plannedHostKey?.startsWith('circleci:')).length).toBeGreaterThan(1)
    expect(integration.flatMap(run => run.files).sort()).toEqual([...f.files].sort())
    const records = (await f.pool.query('select record from ci_runs where group_id=$1', [read.run.groupId])).rows
    expect(records).toHaveLength(read.partitions!.length)
    for (const run of integration) {
      expect(records.find(row => row.record.id === run.id)?.record)
        .toMatchObject({ plannedHostKey: run.plannedHostKey, files: run.files })
    }
    const readerResult = await f.call(f.reader, 'ci_get', { ticketId: admitted.ticketId })
    expect(readerResult.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(readerResult)).partitions).toEqual(read.partitions)
  } finally { await f.close() }
})

it('persists a second GitHub integration wave through MCP while CircleCI orgs remain credit-exhausted', async () => {
  const unitFiles = ['apps/api/src', 'apps/web/src'].flatMap((directory, index) =>
    Array.from({ length: index === 0 ? 24 : 8 }, (_, file) => `${directory}/feature-${file}.test.ts`))
  const f = await fixture({ creditsRemaining: 0, creditRefused: true,
    unitInventory: { files: unitFiles, durations: Object.fromEntries(unitFiles.map(file => [file, 50_000])), heavy: [] } })
  try {
    const listed = CiComputersOutputSchema.parse(await f.value('ci_computers_list'))
    const circle = listed.computers.filter(computer => computer.hostRef.provider === 'circleci')
    expect(circle).toHaveLength(90)
    for (const computer of circle) {
      expect(computer).toMatchObject({ ready: true, schedulingRole: 'exhausted', credits: { remaining: 0 } })
    }
    const input = { suite: 'integration', scope: 'full', gate: true, commit: 'a'.repeat(40), commandId: randomUUID() }
    expect((await f.call(f.reader, 'ci_run', input)).isError).toBe(true)
    const admitted = CiRunOutputSchema.parse(await f.value('ci_run', input))
    expect(CiRunOutputSchema.parse(await f.value('ci_run', input))).toEqual(admitted)
    await f.ci.close()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: admitted.ticketId }))
    const integration = read.partitions!.filter(run => run.suite === 'integration')
    const checks = read.partitions!.filter(run => run.suite !== 'integration')
    const clouds = integration.filter(run => run.plannedHostKey?.startsWith('github:'))
    expect(clouds.length).toBeGreaterThan(1)
    expect(clouds.length).toBeGreaterThan(new Set(clouds.map(run => run.plannedHostKey)).size)
    for (const run of clouds) expect(run.expectedDurationMs).toBeLessThanOrEqual(45 * 60_000)
    const builder = integration.find(run => run.plannedHostKey === 'builder')!
    expect(builder.files.length).toBeGreaterThan(0)
    for (const run of clouds) expect(checks.some(check => check.plannedHostKey === run.plannedHostKey)).toBe(true)
    expect(read.partitions!.some(run => run.plannedHostKey?.startsWith('circleci:'))).toBe(false)
    expect(integration.flatMap(run => run.files).sort()).toEqual([...f.files].sort())
    const hostOnlyTime = f.files.length * 120_000 / Math.floor(builder.integrationShards! / 2)
    expect(read.gate!.criticalPath.expectedDurationMs).toBeLessThan(hostOnlyTime / 2)
    const saved = (await f.pool.query('select record from ci_runs where workspace_id=$1', [f.workspaceId])).rows
    expect(saved).toHaveLength(read.partitions!.length)
    for (const run of read.partitions!) {
      expect(saved.find(row => row.record.id === run.id)?.record).toMatchObject({ files: run.files,
        plannedHostKey: run.plannedHostKey, expectedDurationMs: run.expectedDurationMs })
    }
    const readerResult = await f.call(f.reader, 'ci_get', { ticketId: admitted.ticketId })
    expect(readerResult.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(readerResult)).partitions).toEqual(read.partitions)
    const readback = CiComputersOutputSchema.parse(await f.value('ci_computers_list'))
    expect(readback.computers.filter(computer => computer.hostRef.provider === 'circleci'))
      .toEqual(circle)
  } finally { await f.close() }
})
