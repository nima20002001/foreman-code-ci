import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunRecordSchema, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { HostCiService, type CiCommits, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, management_audit, management_command_receipts')
})

async function fixture(gate: boolean, failure: 'observed' | 'persisted', stopConfirmed = true) {
  const pool = database.pool
  const workspaceId = randomUUID()
  const groupId = randomUUID()
  const at = new Date().toISOString()
  const computers: HostCiComputer[] = [
    { key: 'builder', label: 'Build executor', priority: 60, hostRef: { kind: 'main', mainId: 'host' } },
    { key: 'paired', label: 'Paired executor', priority: 50,
      hostRef: { kind: 'device', mainId: 'host', deviceId: 'worker' } },
    { key: 'cloud', label: 'Cloud executor', priority: 30,
      hostRef: { kind: 'cloud', mainId: 'host', provider: 'github', slot: 0 } },
  ]
  const insert = async (changes: Partial<CiRunRecord>, computer?: HostCiComputer) => {
    const record = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId, groupId, gate,
      suite: 'integration', part: null, partition: null, scope: 'full',
      files: ['apps/api/test/feature.integration.test.ts'], repository: 'example/project', commit: 'a'.repeat(40),
      state: 'queued', step: null, exitCode: null, message: null, queuedAt: at, startedAt: null, finishedAt: null,
      computer: computer ? { hostRef: computer.hostRef, label: computer.label } : null,
      plannedHostKey: computer?.key ?? computers[0]!.key, integrationShards: 1,
      initiator: { principalId: 'operator', executionId: null }, ...changes })
    await pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`,
    [record.id, workspaceId, record.groupId, record.state, computer?.key ?? null, JSON.stringify(record)])
    return record
  }
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Gate cancellation workspace' })])
  const failed = await insert({ suite: 'lint', state: failure === 'persisted' ? 'failed' : 'running',
    step: 'lint', startedAt: at, ...(failure === 'persisted' ? { finishedAt: at, exitCode: 1 } : {}) }, computers[2])
  const running = await insert({ state: 'running', step: 'integration', startedAt: at }, computers[0])
  const starting = await insert({ state: 'starting', step: 'dispatch', dispatchedAt: at }, computers[1])
  const queued = await insert({})
  const passed = await insert({ state: 'passed', startedAt: at, finishedAt: at, exitCode: 0 })
  const next = await insert({ groupId: randomUUID(), gate: true, commit: 'b'.repeat(40),
    queuedAt: new Date(Date.now() + 1000).toISOString() })
  const executions = new Map<string, CiHostRun>()
  for (const record of [failed, running, starting]) {
    const state = record.id === failed.id ? 'failed' : 'running'
    executions.set(record.id, { runId: record.id, state: record.id === starting.id ? 'starting' : state,
      step: record.step, startedAt: at, finishedAt: record.id === failed.id ? at : null,
      exitCode: record.id === failed.id ? 1 : null, message: null, logBytes: 0, collection: 'unsupported' })
  }
  const control = { stopConfirmed }
  const canceled: string[] = []
  const started: string[] = []
  const commands = new PostgresCommandCoordinator(pool)
  const ci = new HostCiService(pool, commands, new RunCiAuthority(pool), {} as CiCommits, {
    computers: async () => computers,
    request: async (_computer, request) => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 4, memoryBytes: 8 * 2 ** 30, slotsTotal: 1, slotsUsed: 0, runs: [...executions.values()] }
      if (request.operation === 'start') {
        started.push(request.runId)
        const run: CiHostRun = { runId: request.runId, state: 'running', step: request.suite,
          startedAt: at, finishedAt: null, exitCode: null, message: null, logBytes: 0 }
        executions.set(request.runId, run)
        return { operation: 'start', run }
      }
      const run = executions.get(request.runId)
      if (!run) throw new Error('Unknown fixture execution')
      if (request.operation === 'cancel') {
        canceled.push(request.runId)
        const reply: CiHostRun = control.stopConfirmed
          ? { ...run, state: 'canceled', finishedAt: at } : run
        executions.set(request.runId, reply)
        return { operation: 'cancel', run: reply }
      }
      return { operation: 'read', run, text: '', nextOffset: 0 }
    },
  })
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { ci, commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  for (const granted of [true, false]) {
    const issued = await access.issue({ name: 'CI reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: granted ? [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [workspaceId] } }] : [] })
    const client = new Client({ name: 'gate-cancellation-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
  }
  const call = (client: Client, ticketId: string) => client.callTool({ name: 'ci_get',
    arguments: { workspaceId, ticketId, logTail: false } })
  const read = async (ticketId: string) => {
    const result = await call(clients[0]!, ticketId)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return CiGetOutputSchema.parse(decodeMcpToolResult(result))
  }
  return { ci, failed, running, starting, queued, passed, next, canceled, started, control, read,
    denied: () => call(clients[1]!, failed.id),
    settle: async () => { await ci.dispatch(); await ci.drain() },
    close: async () => {
      await ci.close()
      await Promise.all(clients.map(client => client.close()))
      await app.close()
    } }
}

it.each(['observed', 'persisted'] as const)(
  'cancels unfinished siblings of an %s gate failure and releases the next gate executor through MCP', async failure => {
    const f = await fixture(true, failure)
    try {
      expect((await f.denied()).isError).toBe(true)
      await f.settle()
      const read = await f.read(f.failed.id)
      expect(read.group?.state).toBe('failed')
      expect(read.run).toMatchObject({ state: 'failed', exitCode: 1 })
      for (const sibling of [f.running, f.starting, f.queued]) {
        expect(read.partitions!.find(run => run.id === sibling.id)).toMatchObject({ state: 'canceled' })
        const stored = (await database.pool.query('select state,host_key,record from ci_runs where id=$1',
          [sibling.id])).rows[0]
        expect(stored).toMatchObject({ state: 'canceled', host_key: null, record: { state: 'canceled' } })
      }
      expect(read.partitions!.find(run => run.id === f.passed.id)).toEqual(f.passed)
      expect(new Set(f.canceled)).toEqual(new Set([f.running.id, f.starting.id]))
      expect(f.started).not.toContain(f.queued.id)
      // Cancellation frees both builder executors; multi-builder rebalancing may start the next gate on either.
      const next = (await f.read(f.next.id)).run
      expect(next).toMatchObject({ state: 'running' })
      expect(['main', 'device']).toContain(next.computer?.hostRef.kind)
      expect(f.started).toContain(f.next.id)
    } finally { await f.close() }
  },
)

it('keeps non-gate siblings running and queued after a part fails', async () => {
  const f = await fixture(false, 'observed')
  try {
    await f.settle()
    const read = await f.read(f.failed.id)
    expect(read.run.state).toBe('failed')
    expect(read.partitions!.find(run => run.id === f.running.id)?.state).toBe('running')
    expect(read.partitions!.find(run => run.id === f.starting.id)?.state).toBe('starting')
    expect(read.partitions!.find(run => run.id === f.queued.id)?.state).toBe('queued')
    expect(f.canceled).toEqual([])
  } finally { await f.close() }
})

it('retains an exclusive executor until cancellation is confirmed and retries failed-gate cleanup', async () => {
  const f = await fixture(true, 'persisted', false)
  try {
    await f.settle()
    expect((await f.read(f.running.id)).run).toMatchObject({ state: 'running' })
    expect((await database.pool.query('select host_key from ci_runs where id=$1', [f.running.id])).rows[0])
      .toEqual({ host_key: 'builder' })
    expect((await f.read(f.queued.id)).run.state).toBe('canceled')
    expect((await f.read(f.next.id)).run.state).toBe('queued')
    expect(f.canceled).toContain(f.running.id)
    f.control.stopConfirmed = true
    await f.settle()
    expect((await f.read(f.running.id)).run.state).toBe('canceled')
    expect((await f.read(f.next.id)).run.state).toBe('running')
  } finally { await f.close() }
})
