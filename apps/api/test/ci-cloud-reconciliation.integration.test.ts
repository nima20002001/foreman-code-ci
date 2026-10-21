import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { RunCiAuthority, CI_GET_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { cloudCiLookupFixture } from './helpers/cloudCiLookupFixture.js'
import { ciReadWhen } from './helpers/ciReadWhen.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it.each(['starting', 'running'] as const)('retains transient CircleCI ownership and persists automatic requeue through authenticated MCP from %s', async state => {
  const f = await cloudCiLookupFixture(state)
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId, JSON.stringify({
    id: workspaceId, name: 'CI recovery', repository: { provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main' },
  })])
  const computer: HostCiComputer = { key: 'fixture:circleci', label: 'CircleCI', priority: 1,
    hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot: 0 } }
  const record = CiRunRecordSchema.parse({ id: f.run.runId, groupId: randomUUID(), workspaceId,
    repository: f.run.repository, commit: f.run.commit, suite: 'integration', part: null, partition: null,
    state, scope: 'full', files: [], computer: { hostRef: computer.hostRef, label: computer.label },
    queuedAt: f.run.startedAt, startedAt: f.run.startedAt, finishedAt: null, exitCode: null,
    step: state === 'starting' ? 'dispatch' : 'integration', message: null,
    initiator: { principalId: 'fixture-operator', executionId: null } })
  await pool.query('insert into ci_runs(id,workspace_id,group_id,state,host_key,record) values($1,$2,$3,$4,$5,$6::jsonb)',
    [record.id, workspaceId, record.groupId, state, computer.key, JSON.stringify(record)])
  const commands = new PostgresCommandCoordinator(pool)
  const create = () => new HostCiService(pool, commands, new RunCiAuthority(pool), {
    resolve: async () => f.run.commit,
    capabilities: async () => ({ parts: false, integrationPartitions: false, affected: false }),
  }, { computers: async () => [computer], request: async (_computer, request) => f.reopen().handle(request) })
  const ci = create()
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[]) => {
    const issued = await access.issue({ name: 'CI recovery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
    const client = new Client({ name: 'ci-recovery-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  try {
    f.advance(120_000)
    f.control.error = 'permission denied'
    const reader = await connect(CI_GET_ACTIONS)
    const denied = await connect(['workspaces:read'])
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(4_001)
      const restarted = create()
      await restarted.dispatch()
      await restarted.close()
    }
    const result = await reader.callTool({ name: 'ci_get', arguments: { workspaceId, ticketId: record.id } })
    expect(result.isError).not.toBe(true)
    expect(CiGetOutputSchema.parse(decodeMcpToolResult(result)).run).toMatchObject({ state, finishedAt: null,
      computer: { hostRef: computer.hostRef }, message: expect.stringContaining('Retrying lookup'),
      observation: { status: 'available', consecutiveFailures: 0, lastError: null } })
    expect((await denied.callTool({ name: 'ci_get', arguments: { workspaceId, ticketId: record.id } })).isError).toBe(true)
    expect((await pool.query('select host_key,record from ci_runs where id=$1', [record.id])).rows[0])
      .toMatchObject({ host_key: computer.key, record: { state, message: expect.stringContaining('permission denied'),
        observation: { status: 'available', consecutiveFailures: 0, lastError: null } } })
    const reads = f.control.reads
    expect(f.control.canceled).toEqual([])
    f.advance(75_000)
    await ci.dispatch()
    await ci.drain()
    const pending = CiGetOutputSchema.parse(decodeMcpToolResult(await reader.callTool({ name: 'ci_get',
      arguments: { workspaceId, ticketId: record.id } })))
    expect(pending.run).toMatchObject({ id: record.id, state, finishedAt: null,
      computer: { hostRef: computer.hostRef }, message: expect.stringContaining('Cancellation could not be confirmed') })
    expect((await pool.query('select host_key,record from ci_runs where id=$1', [record.id])).rows[0])
      .toMatchObject({ host_key: computer.key, record: { state, finishedAt: null } })
    expect(f.control.canceled).toEqual(['pipeline-1'])
    f.control.error = ''
    f.control.outcome = 'canceled'
    f.advance(4_001)
    await ci.dispatch()
    const recovered = await ciReadWhen(pool, async () => CiGetOutputSchema.parse(decodeMcpToolResult(
      await reader.callTool({ name: 'ci_get', arguments: { workspaceId, ticketId: record.id } }),
    )), output => output.run.state === 'queued')
    const requeued = { state: 'queued', computer: null, startedAt: null, finishedAt: null, exitCode: null,
      unstartedProviders: ['circleci'],
      messageHistory: expect.arrayContaining([expect.stringContaining('queued for another computer')]) }
    expect(recovered.run).toMatchObject(requeued)
    expect((await pool.query('select host_key,record from ci_runs where id=$1', [record.id])).rows[0])
      .toMatchObject({ host_key: null, record: requeued })
    expect(f.control.reads).toBeGreaterThan(reads)
    expect(f.control.canceled).toEqual(['pipeline-1'])
    const restarted = create()
    try {
      await restarted.dispatch()
      const readback = await reader.callTool({ name: 'ci_get', arguments: { workspaceId, ticketId: record.id } })
      expect(readback.isError).not.toBe(true)
      expect(CiGetOutputSchema.parse(decodeMcpToolResult(readback)).run).toMatchObject(requeued)
      expect(f.control.canceled).toEqual(['pipeline-1'])
    } finally { await restarted.close() }
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await ci.close()
    await app.close()
    await f.close()
  }
})
