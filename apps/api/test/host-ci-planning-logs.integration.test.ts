import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiLogsOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiHostRun, type CiHostReply } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { HostCiRunner, type HostCiPorts } from '../src/modules/ci-host/runner.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

async function fixture(realLogs = false) {
  const root = await privateFixtureDirectory('ci-group-logs-')
  const workspaceId = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'CI fixture', repository: {
      provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main' },
      ciMirror: { provider: 'github', owner: 'fixture', name: 'site-ci' } })])
  const computers: HostCiComputer[] = Array.from({ length: 3 }, (_, slot) => ({
    key: `fixture-slot-${slot}`, label: `Executor ${slot}`, priority: 0,
    hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', slot },
    userSystemd: { supported: false, reason: 'No user manager' },
  }))
  const runs = new Map<string, CiHostRun>()
  const control = { code: 0, state: 'active', stopCode: 0 }
  const ports: HostCiPorts = { cpus: 8, memoryBytes: 16 * 2 ** 30, now: () => new Date(),
    run: async (file, args) => {
      if (file === 'systemctl' && args.includes('stop')) {
        if (!control.stopCode) control.state = 'inactive'
        return { code: control.stopCode, stdout: '', stderr: '' }
      }
      if (file === 'systemctl' && args.includes('show')) {
        const stdout = args.filter(argument => argument.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=${control.state}`).join('\n\n')
        return { code: control.code, stdout, stderr: '' }
      }
      return { code: control.code, stdout: control.state, stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports, {})
  let dispatchGate: Promise<void> | undefined
  const endpoint: HostCiEndpoint = {
    computers: async () => { await dispatchGate; return computers },
    request: async (_computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 8, memoryBytes: 16 * 2 ** 30, slotsTotal: 1, slotsUsed: 0, runs: [] }
      if (request.operation === 'start') {
        const run: CiHostRun = { runId: request.runId, state: 'running', step: 'integration',
          startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, message: null, logBytes: 0 }
        runs.set(run.runId, run)
        return { operation: 'start', run }
      }
      if (request.operation === 'read' && realLogs) return runner.handle(request)
      if (request.operation === 'cancel' && realLogs) return runner.handle(request)
      const run = runs.get(request.runId)!
      if (request.operation === 'cancel') {
        run.state = 'canceled'
        return { operation: 'cancel', run }
      }
      return { operation: 'read', run, text: '', nextOffset: request.afterOffset }
    },
  }
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), {
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    resolve: async () => 'a'.repeat(40),
  }, endpoint)
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[]) => {
    const issued = await access.issue({ name: 'CI fixture caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000), grants: [{ actions, scope: { workspaceIds: [workspaceId] } }] })
    const client = new Client({ name: 'ci-fixture', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return client
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS, 'jobs:cancel'])
  const call = (client: Client, name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: { workspaceId, ...args } })
  const settleDispatch = async () => {
    const result = await call(operator, 'ci_computers_list', {})
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    await ci.dispatch()
  }
  const value = async (name: string, args: Record<string, unknown>) => {
    const result = await call(operator, name, args)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const start = async (waitForDispatch = true) => {
    const result = CiRunOutputSchema.parse(await value('ci_run', { commandId: randomUUID(), suite: 'integration',
      commit: 'a'.repeat(40), scope: 'affected', partitions: 3, files: ['apps/api/test/one.integration.test.ts',
        'apps/api/test/two.integration.test.ts', 'apps/api/test/three.integration.test.ts'] }))
    if (waitForDispatch) {
      await settleDispatch()
      await expect.poll(async () => CiGetOutputSchema.parse(await value('ci_get', { ticketId: result.ticketId }))
        .partitions!.filter(run => run.state === 'running').length)
        .toBe(Math.min(computers.length, result.partitions!.length))
    }
    return result
  }
  const stored = async (groupId: string) => (await database.pool.query<{ record: unknown }>(
    'select record from ci_runs where group_id=$1', [groupId])).rows.map(row => CiRunRecordSchema.parse(row.record))
  const close = async () => {
    await ci.close()
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await rm(root, { recursive: true, force: true })
  }
  const pauseDispatch = () => {
    let release!: () => void
    dispatchGate = new Promise<void>(resolve => { release = resolve })
    return release
  }
  return { root, workspaceId, computers, ci, start, value, stored, close, connect, call, control, pauseDispatch,
    settleDispatch }
}

it('admits selected-file CI with a pinned commit and persists the selection through MCP readback', async () => {
  const f = await fixture()
  try {
    const caller = await f.connect(CI_RUN_ACTIONS)
    const files = ['apps/api/test/one.integration.test.ts', 'apps/api/test/two.integration.test.ts',
      'apps/api/test/three.integration.test.ts'].sort()
    const unpinned = await f.call(caller, 'ci_run', {
      commandId: randomUUID(), suite: 'integration', scope: 'affected', partitions: 3, files,
    })
    expect(unpinned.isError).toBe(true)
    const started = await f.start()
    await f.ci.close()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    expect(read.partitions).toHaveLength(3)
    for (const run of read.partitions!) {
      expect(run).toMatchObject({ commit: 'a'.repeat(40), scope: 'affected', files })
    }
    expect(await f.stored(read.run.groupId)).toEqual(expect.arrayContaining(read.partitions!))
  } finally { await f.close() }
})

it('cancels a queued ticket through MCP before pending computer discovery completes', async () => {
  const f = await fixture()
  const release = f.pauseDispatch()
  try {
    const started = await f.start(false)
    const before = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    expect(before.run).toMatchObject({ state: 'queued', computer: null })
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_cancel', { ticketId: started.ticketId })).isError).toBe(true)
    const canceled = await f.value('ci_cancel', { ticketId: started.ticketId })
    expect(canceled).toMatchObject({ run: { id: started.ticketId, state: 'canceled', computer: null } })
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    expect(read.run.state).toBe('canceled')
    expect(read.partitions!.filter(run => run.id !== started.ticketId).every(run => run.state === 'queued'))
      .toBe(true)
    expect(await f.stored(read.run.groupId)).toEqual(expect.arrayContaining(read.partitions!))
    release()
    await f.settleDispatch()
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId })).run.state)
      .toBe('canceled')
  } finally { release(); await f.close() }
})

it('plans all admitted slices after an early sibling cancellation and keeps the plan on readback', async () => {
  const f = await fixture()
  const release = f.pauseDispatch()
  try {
    const started = await f.start(false)
    const canceled = started.partitions![0]!.ticketId
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_cancel', { ticketId: canceled })).isError).toBe(true)
    await f.value('ci_cancel', { ticketId: canceled })
    release()
    await f.settleDispatch()
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: canceled }))
      .partitions!.filter(run => run.id !== canceled).map(run => run.state)).toEqual(['running', 'running'])
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: canceled }))
    expect(read.partitions!.filter(run => run.id !== canceled).map(run => run.state)).toEqual(['running', 'running'])
    expect(read.run.state).toBe('canceled')
    expect(read.partitions!.every(run => run.partition?.weights?.length === 3)).toBe(true)
    expect(await f.stored(read.run.groupId)).toEqual(expect.arrayContaining(read.partitions!))
    const plan = read.partitions!.map(run => run.partition)
    await f.ci.dispatch()
    expect(CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: canceled })).partitions!.map(run => run.partition))
      .toEqual(plan)
  } finally { release(); await f.close() }
})

it('plans a group split by the fifty-row placement page behind unavailable systemd work', async () => {
  const f = await fixture()
  const release = f.pauseDispatch()
  try {
    const started = await f.start(false)
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    for (let index = 0; index < 49; index++) {
      const run = { ...read.run, id: randomUUID(), groupId: randomUUID(), scope: 'full', files: [], partition: null,
        queuedAt: '2026-01-01T00:00:00.000Z' }
      await database.pool.query('insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,$4,$5::jsonb)',
        [run.id, f.workspaceId, run.groupId, 'queued', JSON.stringify(run)])
    }
    release()
    await f.settleDispatch()
    await expect.poll(async () => {
      const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
      return read.partitions!.some(run => run.state === 'running')
        && read.partitions!.every(run => run.partition?.weights?.length === 3)
    }).toBe(true)
    const after = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    expect(after.partitions!.some(run => run.state === 'running')).toBe(true)
    expect(after.partitions!.every(run => run.partition?.weights?.length === 3)).toBe(true)
    expect(await f.stored(after.run.groupId)).toEqual(expect.arrayContaining(after.partitions!))
  } finally { release(); await f.close() }
})

it('caps aggregate group log bytes even when the budget is smaller than the part count', async () => {
  const f = await fixture(true)
  try {
    const started = await f.start()
    await f.ci.dispatch()
    await f.ci.close()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    for (const run of read.partitions!) {
      const directory = join(f.root, 'runs', run.id)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId: run.id, repository: run.repository,
        commit: run.commit, suite: run.suite, partition: run.partition, state: 'passed', exitCode: 0,
        startedAt: run.startedAt, finishedAt: new Date().toISOString(), message: null, cleaned: true }))
      await writeFile(join(directory, 'log'), 'populated log content')
    }
    const denied = await f.connect(['workflows:read'])
    expect((await f.call(denied, 'ci_logs_read', { ticketId: started.ticketId, group: true, maxBytes: 1 })).isError)
      .toBe(true)
    for (const maxBytes of [1, 2, 3, 5, 8]) {
      const logs = CiLogsOutputSchema.parse(await f.value('ci_logs_read', {
        ticketId: started.ticketId, group: true, afterOffset: 0, maxBytes }))
      expect(logs.parts).toHaveLength(3)
      expect(logs.maxBytes).toBe(maxBytes)
      expect(logs.parts!.reduce((total, part) => total + part.maxBytes, 0)).toBe(maxBytes)
      expect(logs.parts!.reduce((total, part) => total + Buffer.byteLength(part.text), 0)).toBeLessThanOrEqual(maxBytes)
      expect(logs.parts!.every(part => part.nextOffset === Buffer.byteLength(part.text))).toBe(true)
    }
    for (const run of read.partitions!) await writeFile(join(f.root, 'runs', run.id, 'log'), 'é中🙂tail')
    const tail = CiLogsOutputSchema.parse(await f.value('ci_logs_read', { ticketId: started.ticketId, maxBytes: 6 }))
    expect(tail.text).toBe('tail')
    const group = CiLogsOutputSchema.parse(await f.value('ci_logs_read', {
      ticketId: started.ticketId, group: true, afterOffset: 0, maxBytes: 13 }))
    expect(group.parts!.every(part => !part.text.includes('\uFFFD'))).toBe(true)
    expect(group.parts!.reduce((total, part) => total + Buffer.byteLength(part.text), 0)).toBeLessThanOrEqual(13)
    expect(await f.stored(read.run.groupId)).toEqual(expect.arrayContaining(read.partitions!))
  } finally { await f.close() }
})

it('retains persisted host capacity through failed cancellation and unavailable status until closure is confirmed', async () => {
  const f = await fixture(true)
  try {
    f.computers.splice(1)
    const started = await f.start()
    const read = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: started.ticketId }))
    const active = read.partitions!.find(run => run.state === 'running')!
    const directory = join(f.root, 'runs', active.id)
    await mkdir(join(directory, 'src'), { recursive: true })
    await writeFile(join(directory, 'src', 'input.txt'), 'live CI input')
    await writeFile(join(directory, 'meta.json'), JSON.stringify({ runId: active.id, repository: active.repository,
      commit: active.commit, suite: active.suite, partition: active.partition, state: 'running', exitCode: null,
      startedAt: active.startedAt, finishedAt: null, message: null, cleaned: false }))
    f.control.stopCode = 1
    f.control.code = 1
    f.control.state = ''
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied, 'ci_cancel', { ticketId: active.id })).isError).toBe(true)
    const jobsOnly = await f.connect(['jobs:cancel'])
    const deniedCancellation = await f.call(jobsOnly, 'ci_cancel', { ticketId: active.id })
    expect(deniedCancellation.isError).toBe(true)
    expect(decodeMcpToolResult(deniedCancellation)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    const unchanged = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: active.id }))
    expect(unchanged.run).toMatchObject({ state: 'running', finishedAt: null })
    expect(unchanged.run.cancellation).toBeUndefined()
    expect(await f.stored(unchanged.run.groupId)).toEqual(expect.arrayContaining(unchanged.partitions!))
    const cancellation = await f.call(await f.connect(CI_RUN_ACTIONS), 'ci_cancel', { ticketId: active.id })
    expect(cancellation.isError).toBe(true)
    expect(decodeMcpToolResult(cancellation)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
    await f.ci.dispatch()
    await f.ci.drain()
    const pending = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: active.id }))
    expect(pending.run).toMatchObject({ state: 'running', finishedAt: null,
      cancellation: { reason: 'direct', source: 'mcp' } })
    expect(pending.partitions!.filter(run => run.id !== active.id).every(run => run.state === 'queued')).toBe(true)
    const occupied = (await database.pool.query<{ host_key: string | null }>(
      'select host_key from ci_runs where id=$1', [active.id])).rows[0]!
    expect(occupied.host_key).toBe(f.computers[0]!.key)
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(directory, 'src', 'input.txt'), 'utf8')).toBe('live CI input')
    f.control.stopCode = 0
    f.control.code = 0
    await f.ci.dispatch()
    await f.ci.drain()
    await expect.poll(async () => CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: active.id }))
      .run.state).toBe('canceled')
    const cancellationRead = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: active.id }))
    expect(cancellationRead.run.state).toBe('canceled')
    expect((await database.pool.query('select host_key from ci_runs where id=$1', [active.id]))
      .rows[0].host_key).toBeNull()
    await f.ci.dispatch()
    await f.ci.close()
    const closed = CiGetOutputSchema.parse(await f.value('ci_get', { ticketId: active.id }))
    expect(closed.run.state).toBe('canceled')
    expect(closed.partitions!.some(run => run.id !== active.id && run.state === 'running')).toBe(true)
    expect(await f.stored(closed.run.groupId)).toEqual(expect.arrayContaining(closed.partitions!))
  } finally { await f.close() }
})
