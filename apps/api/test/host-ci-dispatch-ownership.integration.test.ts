import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiComputersOutputSchema, CiGetOutputSchema, CiRunOutputSchema,
  type CiHostRequest, type CiHostReply, type CiHostRun } from '@foreman-code/contracts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { HostCiRunner, type HostCiPorts } from '../src/modules/ci-host/runner.js'
import { buildComputerIntegrationShards } from '../src/modules/ci-host/capacity.js'
import { workspaceMirrors } from '../src/modules/ci-host/cloud.js'
import { DomainError } from '../src/modules/errors.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { cloudCiLookupFixture } from './helpers/cloudCiLookupFixture.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await database.pool.query('truncate ci_runs, ci_file_durations, management_command_receipts, management_audit')
})

/** Dispatch passes hand observations and follow-up passes to background work; settle waits for all of it. */
async function settle(service: HostCiService) {
  await service.dispatch()
  await service.drain()
}

/** The host accepts the start but the reply is lost, and its status stays unreachable so no observation can discover the run. */
function loseStartReply(f: { control: { onStart: (...args: never[]) => Promise<void>; onStatus: (...args: never[]) => Promise<void> } }, message: string) {
  f.control.onStart = async () => {
    f.control.onStatus = async () => { throw new Error('Status unavailable') }
    throw new Error(message)
  }
}

/** The partition plan a dispatch pass persists after throughput planning: one patch per sibling with its weights. */
function isPartitionPlan(values: unknown) {
  if (!Array.isArray(values) || typeof values[0] !== 'string' || !values[0].startsWith('[')) return false
  try {
    const plan = JSON.parse(values[0]) as unknown
    return Array.isArray(plan) && (plan as { patch?: { partition?: { weights?: unknown } } }[])
      .some(item => item.patch?.partition?.weights !== undefined)
  } catch {
    return false
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(executor?: HostCiEndpoint) {
  const pool = database.pool
  const workspaceId = randomUUID()
  const repository = { provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main' }
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'CI workspace', repository,
      ciMirror: { provider: 'github', owner: 'octo', name: 'site-ci' } })])
  const computers: HostCiComputer[] = [0, 1].map(index => ({
    key: `executor:${index}`, hostRef: { kind: 'device', mainId: 'test-main', deviceId: `executor-${index}` },
    label: `Executor ${index}`, priority: 10 - index,
  }))
  const remote = new Map<string, CiHostRun>()
  const starts: { computer: HostCiComputer; request: Extract<CiHostRequest, { operation: 'start' }> }[] = []
  const control: {
    available: boolean
    onStart(computer: HostCiComputer, request: CiHostRequest): Promise<void>
    onStatus(computer: HostCiComputer): Promise<void>
    /** Runs before the service persists a throughput-planned partition plan. */
    onPlan(): Promise<void>
    hideRuns: boolean
    onCancel(): Promise<void>
  } = {
    available: false,
    onStart: async () => {},
    onStatus: async () => {},
    onPlan: async () => {},
    onCancel: async () => {},
    hideRuns: false,
  }
  const endpoint: HostCiEndpoint = {
    computers: async () => control.available ? computers : [],
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') {
        await control.onStatus(computer)
        const runs = [...remote.entries()]
          .filter(([key]) => key.startsWith(`${computer.key}:`))
          .map(([, run]) => run)
        return { operation: 'status', ready: true, reasons: [], cpuCount: 8, memoryBytes: 8 * 2 ** 30,
          slotsUsed: runs.filter(run => ['starting', 'running'].includes(run.state)).length,
          slotsTotal: 1, runs: control.hideRuns ? [] : runs }
      }
      const key = `${computer.key}:${request.runId}`
      if (request.operation === 'start') {
        if (!remote.has(key)) {
          remote.set(key, { runId: request.runId, state: 'running', step: request.suite, exitCode: null,
            startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null })
          starts.push({ computer, request })
        }
        await control.onStart(computer, request)
        return { operation: 'start', run: remote.get(key)! }
      }
      const run = remote.get(key)
      if (!run) throw new DomainError('CI_RUN_UNKNOWN', 'Unknown CI run.', 404)
      if (request.operation === 'cancel') {
        await control.onCancel()
        const canceled = { ...run, state: 'canceled' as const, finishedAt: new Date().toISOString(), message: 'Canceled.' }
        remote.set(key, canceled)
        return { operation: 'cancel', run: canceled }
      }
      return { operation: 'read', run, text: '', nextOffset: 0 }
    },
  }
  const commands = new PostgresCommandCoordinator(pool)
  const commits = {
    resolve: async (_repository: string, _branch: string, commit: string | undefined) => commit ?? 'a'.repeat(40),
    capabilities: async () => ({ parts: false, integrationPartitions: true, affected: true }),
  }
  // The service's own pool lets a test hold a dispatch pass just before it persists a partition plan.
  const servicePool = new Proxy(pool, { get(target, property) {
    if (property === 'query') {
      return async (...args: unknown[]) => {
        if (isPartitionPlan(args[1])) await control.onPlan()
        return (target.query as (...input: unknown[]) => Promise<unknown>).apply(target, args)
      }
    }
    const member: unknown = Reflect.get(target, property, target)
    return typeof member === 'function' ? member.bind(target) : member
  } })
  const createService = () => {
    const service = new HostCiService(servicePool, commands, new RunCiAuthority(pool), commits, executor ?? endpoint)
    vi.spyOn(service, 'start').mockImplementation(() => {})
    return service
  }
  const ci = createService()
  const access = new PostgresAccessService(pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (actions: ManagementAction[], workspaceIds = [workspaceId]) => {
    const issued = await access.issue({ name: 'CI caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions, scope: { workspaceIds } }] })
    const client = new Client({ name: 'ci-ownership-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { requestInit: { headers: { authorization: `Bearer ${issued.token}` } } }))
    return { client, token: issued.token, principalId: (await access.authenticate(issued.token)).id }
  }
  const operator = await connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
  const call = (client: Client, name: string, input: Record<string, unknown>) =>
    client.callTool({ name, arguments: { workspaceId, ...input } })
  const value = async (name: string, input: Record<string, unknown>, client = operator.client) => {
    const result = await call(client, name, input)
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    return decodeMcpToolResult(result)
  }
  const enqueue = async (input: Record<string, unknown> = {}) => {
    const result = CiRunOutputSchema.parse(await value('ci_run', { suite: 'install', commandId: randomUUID(), ...input }))
    await settle(ci)
    return result
  }
  const read = async (ticketId: string) => CiGetOutputSchema.parse(await value('ci_get', { ticketId })).run
  const observeWhenDue = async (service: HostCiService, ticketId: string) => {
    const nextAttemptAt = (await read(ticketId)).observation?.nextAttemptAt
    if (!nextAttemptAt) return settle(service)
    const retryAt = Date.parse(nextAttemptAt)
    expect(retryAt - Date.now()).toBeLessThanOrEqual(1000)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Math.max(Date.now(), retryAt))
    try {
      await settle(service)
    } finally {
      clock.mockRestore()
    }
  }
  const close = async () => {
    await ci.close()
    await Promise.all(clients.map(client => client.close()))
    await app.close()
  }
  return { pool, app, workspaceId, repository, operator, connect, call, value, enqueue, read, ci,
    createService, control, remote, starts, computers, endpoint, observeWhenDue, close }
}

function failingCloud(f: Awaited<ReturnType<typeof fixture>>, provider: 'github' | 'circleci') {
  const computer: HostCiComputer = { key: `cloud:${provider}`, label: 'Cloud executor', priority: 10,
    hostRef: { kind: 'cloud', mainId: 'test-main', provider, slot: 0 } }
  f.computers.splice(0, 2, computer)
  const request = f.endpoint.request.bind(f.endpoint)
  let attempts = 0
  f.endpoint.request = async (target, input) => {
    if (target.hostRef.kind === 'cloud' && input.operation === 'start') {
      attempts++
      throw new DomainError('CI_CLOUD_FAILED', 'Selected integration files are absent from the commit.', 502)
    }
    return request(target, input)
  }
  return { computer, attempts: () => attempts }
}

it('dispatches on startup while old cloud recovery is blocked and exposes persisted MCP readback', async () => {
  const f = await fixture()
  const cloud = await cloudCiLookupFixture('running')
  const computer = cloud.cloud.computers()[0]!
  f.computers.splice(0, 2, computer)
  const computers = f.endpoint.computers.bind(f.endpoint)
  f.endpoint.computers = async () => {
    const available = await computers()
    if (available.length) await cloud.cloud.handle({ operation: 'status' })
    return available
  }
  const request = f.endpoint.request.bind(f.endpoint)
  f.endpoint.request = (target, input) => input.operation === 'status'
    ? cloud.cloud.handle(input) : request(target, input)
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const status = vi.spyOn(cloud.cloud.provider, 'status').mockImplementation(async () => {
    await blocked
    return { done: false, steps: [] }
  })
  cloud.advance(55 * 60_000)
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    // This is the production startup entry point, with no manual dispatcher pass or timer tick.
    HostCiService.prototype.start.call(f.ci, 60_000)
    await expect.poll(() => f.starts.length, { timeout: 1000 }).toBe(1)
    await settle(f.ci)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'running', dispatchAttempts: 1,
      computer: { hostRef: computer.hostRef } })
    const denied = await f.connect(['workspaces:read'])
    expect((await f.call(denied.client, 'ci_get', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect((await f.pool.query('select host_key,record from ci_runs where id=$1', [ticket.ticketId])).rows[0])
      .toMatchObject({ host_key: computer.key, record: { state: 'running', dispatchAttempts: 1 } })
    await expect.poll(() => status.mock.calls.length).toBe(1)
  } finally {
    release()
    await cloud.cloud.reconcile()
    await f.close()
    await cloud.close()
  }
})

it.each(['github', 'circleci'] as const)(
  'cancels an accepted %s dispatch with a lost reply without replaying start through MCP', async provider => {
    const f = await fixture()
    const computer: HostCiComputer = { key: `cloud:${provider}`, label: 'Cloud executor', priority: 10,
      hostRef: { kind: 'cloud', mainId: 'test-main', provider, slot: 0 } }
    f.computers.splice(0, 2, computer)
    let calls = 0
    // The provider is unreachable after accepting the start, so no observation can discover the run.
    let providerReachable = true
    const request = f.endpoint.request.bind(f.endpoint)
    f.endpoint.request = async (target, input) => {
      if (!providerReachable && input.operation === 'read') {
        throw new DomainError('CI_CLOUD_FAILED', 'The provider is unreachable.', 502)
      }
      return request(target, input)
    }
    f.control.onStart = async () => {
      calls++
      providerReachable = false
      throw new DomainError('CI_CLOUD_FAILED', 'The start reply was lost.', 502)
    }
    try {
      const ticket = await f.enqueue()
      f.control.available = true
      await settle(f.ci)
      expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', startedAt: null })
      providerReachable = true
      await f.value('ci_cancel', { ticketId: ticket.ticketId })
      expect(calls).toBe(1)
      expect((await f.read(ticket.ticketId)).state).toBe('canceled')
      expect(f.remote.get(`${computer.key}:${ticket.ticketId}`)?.state).toBe('canceled')
      expect((await f.pool.query('select host_key from ci_runs where id=$1', [ticket.ticketId])).rows)
        .toEqual([{ host_key: null }])
    } finally { await f.close() }
  })

it.each(['github', 'circleci'] as const)(
  'retries an unstarted %s ticket twice across Main restarts and frees its slot through MCP', async provider => {
    const f = await fixture()
    const cloud = failingCloud(f, provider)
    const restarted: HostCiService[] = []
    try {
      const ticket = await f.enqueue()
      f.control.available = true
      await settle(f.ci)
      expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', startedAt: null })
      expect(cloud.attempts()).toBe(1)
      await settle(f.ci)
      expect(cloud.attempts()).toBe(1)
      for (let attempt = 0; attempt < 3; attempt++) {
        const at = new Date(Date.now() - 75_100).toISOString()
        await f.pool.query(`update ci_runs set record=jsonb_set(record,'{dispatchedAt}',to_jsonb($2::text))
          where id=$1`, [ticket.ticketId, at])
        const service = f.createService()
        restarted.push(service)
        await settle(service)
      }
      expect(cloud.attempts()).toBe(3)
      expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'queued', computer: null,
        startedAt: null, unstartedProviders: [provider] })
      const stored = (await f.pool.query('select state,host_key from ci_runs where id=$1', [ticket.ticketId])).rows[0]
      expect(stored).toEqual({ state: 'queued', host_key: null })
      const replacement: HostCiComputer = { key: 'replacement', label: 'Replacement executor', priority: 0,
        hostRef: { kind: 'device', mainId: 'test-main', deviceId: 'replacement' } }
      f.computers.push(replacement)
      await settle(restarted.at(-1)!)
      const running = await f.read(ticket.ticketId)
      expect(running).toMatchObject({ id: ticket.ticketId, state: 'running',
        computer: { hostRef: replacement.hostRef }, executionRunId: expect.any(String) })
      expect(running.executionRunId).not.toBe(ticket.ticketId)
      expect(f.starts[0]!.request.runId).toBe(running.executionRunId)
      expect((await f.pool.query('select record from ci_runs where id=$1', [ticket.ticketId])).rows[0].record)
        .toEqual(running)
    } finally {
      await Promise.all(restarted.map(service => service.close()))
      await f.close()
    }
  })

it.each(['github', 'circleci'] as const)(
  'cancels an unstarted %s ticket through MCP without resolving its selected files again', async provider => {
    const f = await fixture()
    const cloud = failingCloud(f, provider)
    const failingRequest = f.endpoint.request.bind(f.endpoint)
    try {
      const ticket = await f.enqueue()
      f.control.available = true
      await settle(f.ci)
      expect(cloud.attempts()).toBe(1)
      const reader = await f.connect(CI_GET_ACTIONS)
      expect((await f.call(reader.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
      expect((await f.read(ticket.ticketId)).state).toBe('starting')
      await f.value('ci_cancel', { ticketId: ticket.ticketId })
      await f.value('ci_cancel', { ticketId: ticket.ticketId })
      expect(cloud.attempts()).toBe(1)
      expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'canceled', startedAt: null,
        finishedAt: expect.any(String) })
      expect((await f.pool.query('select state,host_key from ci_runs where id=$1', [ticket.ticketId])).rows)
        .toEqual([{ state: 'canceled', host_key: null }])
      expect((await f.pool.query("select details from management_audit where action='ci.cancel' and target_key=$1",
        [`ci:${ticket.ticketId}`])).rows).toHaveLength(1)
      f.endpoint.request = async (target, input) => {
        if (input.operation === 'status') return failingRequest(target, input)
        if (input.operation !== 'start') throw new Error('Expected a replacement start')
        return { operation: 'start', run: { runId: input.runId, state: 'running', step: input.suite,
          startedAt: new Date().toISOString(), finishedAt: null, exitCode: null, logBytes: 0, message: null } }
      }
      const next = await f.enqueue({ commandId: randomUUID() })
      expect((await f.read(next.ticketId)).state).toBe('running')
    } finally { await f.close() }
  })

it('audits queued and running MCP cancellation once with the caller and request identity', async () => {
  const f = await fixture()
  try {
    const queued = await f.enqueue()
    const running = await f.enqueue()
    f.control.available = true
    await settle(f.ci)
    const extra = await f.enqueue()
    const denied = await f.connect(['jobs:cancel'], [randomUUID()])
    expect((await f.call(denied.client, 'ci_cancel', { ticketId: extra.ticketId })).isError).toBe(true)
    for (const ticketId of [extra.ticketId, running.ticketId, queued.ticketId]) {
      await f.value('ci_cancel', { ticketId })
      await f.value('ci_cancel', { ticketId })
      expect((await f.read(ticketId)).state).toBe('canceled')
      const rows = (await f.pool.query<{ principal_id: string; source: string; details: Record<string, unknown> }>(
        "select principal_id,source,details from management_audit where action='ci.cancel' and target_key=$1",
        [`ci:${ticketId}`])).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ principal_id: f.operator.principalId, source: 'mcp',
        details: { ticketId, reason: 'direct', commandId: expect.any(String) } })
    }
    const denial = (await f.pool.query("select principal_id,outcome from management_audit where action='ci_cancel'" )).rows
    expect(denial).toContainEqual({ principal_id: denied.principalId, outcome: 'denied' })
  } finally { await f.close() }
})

it('keeps provider facts stable while successful observation time advances', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    await settle(f.ci)
    const key = `${f.starts[0]!.computer.key}:${ticket.ticketId}`
    f.remote.set(key, { ...f.remote.get(key)!, message: 'Observation A' })
    await settle(f.ci)
    f.remote.set(key, { ...f.remote.get(key)!, message: 'Observation B' })
    await settle(f.ci)
    const before = (await f.pool.query('select record from ci_runs where id=$1', [ticket.ticketId])).rows[0]
    await settle(f.ci)
    await settle(f.ci)
    const after = (await f.pool.query('select record from ci_runs where id=$1', [ticket.ticketId])).rows[0]
    expect(after.record).toEqual({ ...before.record, observation: {
      ...before.record.observation, lastSuccessAt: expect.any(String) } })
    expect(Date.parse(after.record.observation.lastSuccessAt))
      .toBeGreaterThanOrEqual(Date.parse(before.record.observation.lastSuccessAt))
    expect((await f.read(ticket.ticketId)).message).toContain('Observation B')
  } finally { await f.close() }
})

it('retains one executor after an accepted start loses its reply and reconciles after restart', async () => {
  const f = await fixture()
  let restarted: HostCiService | undefined
  try {
    const ticket = await f.enqueue()
    loseStartReply(f, 'Start reply lost')
    f.control.available = true
    await settle(f.ci)
    expect(f.starts).toHaveLength(1)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', computer: {
      hostRef: f.starts[0]!.computer.hostRef } })
    f.control.onStart = async () => {}
    f.control.onStatus = async () => {}
    restarted = f.createService()
    await settle(restarted)
    expect(f.starts).toHaveLength(1)
    const recovered = await f.read(ticket.ticketId)
    const accepted = f.starts[0]!
    expect(recovered).toMatchObject({ state: 'running', computer: {
      hostRef: accepted.computer.hostRef },
      startedAt: f.remote.get(`${accepted.computer.key}:${ticket.ticketId}`)!.startedAt })
    await f.observeWhenDue(restarted, ticket.ticketId)
    expect(await f.read(ticket.ticketId)).toEqual({ ...recovered, observation: {
      status: 'available', consecutiveFailures: 0, lastError: null,
      nextAttemptAt: null, lastSuccessAt: expect.any(String) } })
    expect(f.starts).toHaveLength(1)
  } finally {
    await restarted?.close()
    await f.close()
  }
})

it('discovers an accepted run when its start acknowledgement was lost', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    loseStartReply(f, 'Start reply lost')
    f.control.available = true
    await settle(f.ci)
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    f.control.onStatus = async () => {}
    const computers = await f.value('ci_computers_list', {})
    expect(computers).toMatchObject({ computers: expect.arrayContaining([
      expect.objectContaining({ hostRef: f.starts[0]!.computer.hostRef, running: [ticket.ticketId] }),
    ]) })
    expect((await f.read(ticket.ticketId)).state).toBe('running')
    expect(f.starts).toHaveLength(1)
  } finally { await f.close() }
})

it('preserves the assignment when the database rejects settlement after an accepted start', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    await f.pool.query(`create function reject_ci_running() returns trigger language plpgsql as $$
      begin if new.state='running' then raise exception 'Settlement unavailable'; end if; return new; end $$`)
    await f.pool.query(`create trigger reject_ci_running before update on ci_runs
      for each row execute function reject_ci_running()`)
    f.control.available = true
    await settle(f.ci)
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    await f.pool.query('drop trigger reject_ci_running on ci_runs')
    await f.observeWhenDue(f.ci, ticket.ticketId)
    expect(f.starts).toHaveLength(1)
    const recovered = await f.read(ticket.ticketId)
    const accepted = f.starts[0]!
    expect(recovered).toMatchObject({ state: 'running', computer: {
      hostRef: accepted.computer.hostRef },
      startedAt: f.remote.get(`${accepted.computer.key}:${ticket.ticketId}`)!.startedAt })
    await f.observeWhenDue(f.ci, ticket.ticketId)
    expect(await f.read(ticket.ticketId)).toEqual({ ...recovered, observation: {
      status: 'available', consecutiveFailures: 0, lastError: null,
      nextAttemptAt: null, lastSuccessAt: expect.any(String) } })
    expect(f.starts).toHaveLength(1)
  } finally {
    await f.pool.query('drop trigger if exists reject_ci_running on ci_runs')
    await f.pool.query('drop function if exists reject_ci_running()')
    await f.close()
  }
})

it('claims the executor before entry and prevents competing dispatchers from choosing another executor', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  const other = f.createService()
  let dispatch: Promise<void> | undefined
  try {
    const ticket = await f.enqueue()
    let persisted: unknown
    f.control.onStart = async () => {
      if (persisted) return
      persisted = (await f.pool.query('select state,host_key,record from ci_runs where id=$1', [ticket.ticketId])).rows[0]
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    await other.dispatch()
    release.resolve()
    await dispatch
    expect(persisted).toMatchObject({ state: 'starting', host_key: f.starts[0]!.computer.key,
      record: { computer: { hostRef: f.starts[0]!.computer.hostRef } } })
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('running')
  } finally {
    release.resolve()
    await dispatch
    await other.close()
    await f.close()
  }
})

it('retries persisted cancellation on the assigned executor after transport failure and restart', async () => {
  const f = await fixture()
  let restarted: HostCiService | undefined
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    await settle(f.ci)
    f.control.onCancel = async () => { throw new Error('Cancel reply unavailable') }
    expect((await f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    f.control.onCancel = async () => {}
    restarted = f.createService()
    await settle(restarted)
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
    const rows = (await f.pool.query("select principal_id from management_audit where action='ci.cancel'")).rows
    expect(rows).toEqual([{ principal_id: f.operator.principalId }])
  } finally {
    await restarted?.close()
    await f.close()
  }
})

it('persists direct cancellation before a start reply returns and recovers cleanup after restart', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  let restarted: HostCiService | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const ticket = await f.enqueue()
    const commandId = randomUUID()
    f.control.onStart = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect((await f.read(ticket.ticketId)).cancellation).toBeUndefined()
    const cancellation = await Promise.race([
      f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId, commandId }),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new Error('Cancellation waited for the start reply')), 5_000)
      }),
    ])
    clearTimeout(deadline)
    expect(cancellation.isError).toBe(true)
    expect(decodeMcpToolResult(cancellation)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
    const pending = await f.read(ticket.ticketId)
    expect(pending).toMatchObject({ state: 'starting', cancellation: {
      principalId: f.operator.principalId, source: 'mcp', commandId, reason: 'direct',
    } })
    expect(f.starts).toHaveLength(1)
    // A follow-up pass may already retry the cleanup once the start returns; the executor stays unreachable until the restart.
    f.control.onCancel = async () => { throw new Error('Cancel reply unavailable') }
    release.resolve()
    await dispatch
    expect((await f.read(ticket.ticketId)).cancellation).toEqual(pending.cancellation)
    f.control.onStart = async () => {}
    f.control.onCancel = async () => {}
    restarted = f.createService()
    await settle(restarted)
    const canceled = await f.read(ticket.ticketId)
    expect(canceled.state).toBe('canceled')
    expect(canceled.cancellation).toBeUndefined()
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
    const audits = (await f.pool.query<{ principal_id: string; source: string; details: unknown }>(
      "select principal_id,source,details from management_audit where action='ci.cancel' and target_key=$1",
      [`ci:${ticket.ticketId}`])).rows
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ principal_id: f.operator.principalId, source: 'mcp',
      details: { commandId, ticketId: ticket.ticketId, reason: 'direct' } })
  } finally {
    clearTimeout(deadline)
    release.resolve()
    await dispatch
    await restarted?.close()
    await f.close()
  }
})

it('retains cleanup when cancellation arrives while the accepted start reply is still in flight', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  try {
    const ticket = await f.enqueue()
    f.control.onStart = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    expect((await f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    release.resolve()
    await dispatch
    f.control.onStart = async () => {}
    await settle(f.ci)
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
  } finally {
    release.resolve()
    await dispatch
    await f.close()
  }
})

it.each([2, 3])('preserves direct cancellation during throughput planning with %i partitions', async partitions => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  try {
    // Throughput planning ends by persisting the slice plan; hold the pass there.
    f.control.onPlan = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    const tickets = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', partitions, scope: 'full', commandId: randomUUID(),
    }))
    expect(tickets.partitions).toHaveLength(partitions)
    dispatch = f.ci.dispatch()
    await entered.promise
    const ticketId = tickets.ticketId
    expect((await f.read(ticketId)).partition?.weights).toBeUndefined()
    expect(f.starts).toEqual([])
    await f.value('ci_cancel', { ticketId })
    expect((await f.read(ticketId)).state).toBe('canceled')
    release.resolve()
    await dispatch
    await settle(f.ci)
    expect((await f.read(ticketId)).state).toBe('canceled')
    expect(f.starts.some(start => start.request.runId === ticketId)).toBe(false)
    expect(f.starts.length).toBeGreaterThan(0)
  } finally {
    release.resolve()
    await dispatch
    await f.close()
  }
})

it.each([
  { partitions: 2, hostIndexes: [0] },
  { partitions: 3, hostIndexes: [0, 1] },
  { partitions: 4, hostIndexes: [0, 1] },
])('persists one plan for $partitions canceled siblings', async ({ partitions, hostIndexes }) => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  try {
    // Throughput planning ends by persisting the slice plan; hold the pass there.
    f.control.onPlan = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    const ready = CiComputersOutputSchema.parse(await f.value('ci_computers_list', {}))
    expect(ready.computers).toHaveLength(2)
    expect(ready.computers.every(computer => computer.ready)).toBe(true)
    const tickets = CiRunOutputSchema.parse(await f.value('ci_run', {
      suite: 'integration', partitions, scope: 'full', commandId: randomUUID(),
    }))
    expect(tickets.partitions).toHaveLength(partitions)
    dispatch = f.ci.dispatch()
    await entered.promise
    const canceled = []
    for (const { ticketId } of tickets.partitions!) {
      await f.value('ci_cancel', { ticketId })
      canceled.push(await f.read(ticketId))
    }
    release.resolve()
    await dispatch
    const saved = (await f.pool.query<{ record: Record<string, unknown>; revision: string }>(
      'select record,xmin::text as revision from ci_runs where group_id=$1', [canceled[0]!.groupId])).rows
    expect(saved).toHaveLength(partitions)
    expect(new Set(saved.map(row => row.revision)).size).toBe(1)
    const planned = await Promise.all(canceled.map(run => f.read(run.id)))
    const shards = buildComputerIntegrationShards({ cpuCount: 8, memoryBytes: 8 * 2 ** 30 })
    for (const [index, run] of planned.entries()) {
      expect(run).toMatchObject(canceled[index]!)
      expect(run).toMatchObject({ state: 'canceled', partition: { index, count: partitions } })
      expect(run.partition?.weights).toEqual(Array.from({ length: partitions }, () => shards))
      expect(run.partition?.weights).toHaveLength(partitions)
      expect(run.partition).toMatchObject({ weights: planned[0]!.partition!.weights, hostIndexes })
    }
    await settle(f.ci)
    expect(await Promise.all(canceled.map(run => f.read(run.id)))).toEqual(planned)
    expect(f.starts).toEqual([])
  } finally {
    release.resolve()
    await dispatch
    await f.close()
  }
})

it('pins each workspace mirror at admission and never borrows a duplicate repository workspace mirror', async () => {
  const f = await fixture()
  try {
    const workspaceIds = [f.workspaceId, randomUUID(), randomUUID()]
    const mirrors = ['site-ci-first', 'site-ci-second', null]
    for (const [index, workspaceId] of workspaceIds.entries()) {
      const record = { id: workspaceId, name: `Workspace ${index}`, repository: f.repository,
        ...(mirrors[index] ? { ciMirror: { provider: 'github', owner: 'octo', name: mirrors[index] } } : {}) }
      await f.pool.query(`insert into workspaces(id,record) values($1,$2::jsonb)
        on conflict(id) do update set record=excluded.record`, [workspaceId, JSON.stringify(record)])
    }
    const caller = await f.connect([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS], workspaceIds)
    const resolve = workspaceMirrors(f.pool)
    for (const [index, workspaceId] of workspaceIds.entries()) {
      expect(await resolve(workspaceId)).toBe(mirrors[index] ? `octo/${mirrors[index]}` : null)
      const ticket = CiRunOutputSchema.parse(await f.value('ci_run', {
        workspaceId, suite: 'install', commandId: randomUUID(),
      }, caller.client))
      await settle(f.ci)
      await f.pool.query("update workspaces set record=record-'ciMirror' where id=$1", [workspaceId])
      f.control.available = true
      await settle(f.ci)
      const start = f.starts.find(item => item.request.runId === ticket.ticketId)!
      expect(start.request).toMatchObject({ workspaceId, ciMirror: mirrors[index] ? `octo/${mirrors[index]}` : null })
      await f.value('ci_cancel', { workspaceId, ticketId: ticket.ticketId }, caller.client)
      f.control.available = false
    }
  } finally { await f.close() }
})


it('retains an overdue unknown start, denies read-only cancellation and cleans the original executor after restart', async () => {
  const f = await fixture()
  let restarted: HostCiService | undefined
  let now: ReturnType<typeof vi.spyOn> | undefined
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    loseStartReply(f, 'Accepted start reply lost')
    await settle(f.ci)
    const accepted = f.starts[0]!
    now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001)
    restarted = f.createService()
    for (let attempt = 0; attempt < 4; attempt++) await settle(restarted)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', finishedAt: null,
      computer: { hostRef: accepted.computer.hostRef }, dispatchRequest: { runId: ticket.ticketId } })
    const stored = (await f.pool.query('select host_key,record from ci_runs where id=$1', [ticket.ticketId])).rows[0]
    expect(stored).toMatchObject({ host_key: accepted.computer.key, record: { state: 'starting' } })
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    f.control.onCancel = async () => { throw new Error('Cancel transport unavailable') }
    expect((await f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', cancellation: {
      principalId: f.operator.principalId, source: 'mcp', reason: 'direct' } })
    f.control.onCancel = async () => {}
    await settle(restarted)
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
    expect(f.starts).toHaveLength(1)
  } finally {
    now?.mockRestore()
    await restarted?.close()
    await f.close()
  }
})

it('bounds retries for an accepted but unlisted start without failing it or releasing capacity', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    f.control.hideRuns = true
    f.control.onStart = async () => { throw new Error('Accepted start reply lost') }
    for (let attempt = 0; attempt < 5; attempt++) await settle(f.ci)
    const assigned = f.starts[0]!.computer
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', finishedAt: null,
      computer: { hostRef: assigned.hostRef }, dispatchRequest: { runId: ticket.ticketId },
      message: expect.stringContaining('cancellation is required') })
    expect((await f.pool.query('select host_key from ci_runs where id=$1', [ticket.ticketId])).rows[0])
      .toEqual({ host_key: assigned.key })
    await f.value('ci_cancel', { ticketId: ticket.ticketId })
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect(f.starts).toHaveLength(1)
    expect([...f.remote.values()].every(run => run.state === 'canceled')).toBe(true)
  } finally { await f.close() }
})

it('attributes HTTP cancellation to HTTP and audits each transition once alongside MCP', async () => {
  const f = await fixture()
  try {
    const reader = await f.connect(CI_GET_ACTIONS)
    for (const running of [false, true]) {
      f.control.available = running
      const ticket = await f.enqueue()
      const url = `/api/management/workspaces/${f.workspaceId}/ci/${ticket.ticketId}`
      const denied = await f.app.inject({ method: 'DELETE', url, headers: { authorization: `Bearer ${reader.token}` } })
      expect(denied.statusCode).toBe(403)
      expect((await f.read(ticket.ticketId)).state).toBe(running ? 'running' : 'queued')
      for (let replay = 0; replay < 2; replay++) {
        const response = await f.app.inject({ method: 'DELETE', url,
          headers: { authorization: `Bearer ${f.operator.token}` } })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toMatchObject({ run: { state: 'canceled' } })
      }
      const rows = (await f.pool.query('select principal_id,source from management_audit where action=$1 and target_key=$2',
        ['ci.cancel', `ci:${ticket.ticketId}`])).rows
      expect(rows).toEqual([{ principal_id: f.operator.principalId, source: 'http' }])
    }
  } finally { await f.close() }
})

it('keeps overdue Host fetch cancellation pending until preparation closes and prevents late native entry', async () => {
  const root = await privateFixtureDirectory('ci-preparation-cancel-')
  const entered = deferred()
  const release = deferred()
  let launches = 0
  let ticketId: string | undefined
  let preparationSignal: AbortSignal | undefined
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 8 * 2 ** 30, now: () => new Date(),
    run: async (file, args, options) => {
      if (file === 'git' && args.includes('rev-list')) return { code: 1, stdout: '', stderr: 'Commit not fetched' }
      if (file === 'git' && args.includes('fetch')) {
        preparationSignal = options?.signal
        entered.resolve()
        await release.promise
      }
      if (file === 'git' && args.includes('worktree') && args.includes('add')) {
        const source = args.at(-2)!
        await mkdir(source, { recursive: true })
        await writeFile(join(source, 'package.json'), '{}')
      }
      if (file === 'systemd-run' && args.includes(`--unit=foreman-ci-${ticketId}`)) launches++
      const states = file === 'systemctl' && args.includes('show')
        ? args.filter(arg => arg.endsWith('.service')).map(unit =>
          `Id=${unit}\nLoadState=loaded\nActiveState=inactive\n`).join('\n') : ''
      return { code: 0, stdout: states, stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports, {})
  const computer: HostCiComputer = { key: 'fixture:builder', label: 'Builder', priority: 1,
    hostRef: { kind: 'main', mainId: 'fixture-main' } }
  let available = false
  let statusUnavailable = false
  let start: Promise<CiHostReply> | undefined
  let original: Extract<CiHostRequest, { operation: 'start' }> | undefined
  const executor: HostCiEndpoint = { computers: async () => available ? [computer] : [],
    request: async (_computer, request) => {
      if (request.operation === 'status' && statusUnavailable) throw new Error('Status unavailable')
      if (request.operation === 'start' && !request.warmup) {
        original = request
        start ??= runner.handle(request)
        await entered.promise
        throw new Error('Start acknowledgement lost')
      }
      const reply = await runner.handle(request)
      // This scenario controls the assigned ticket's fetch rather than background warmup preparation.
      return reply.operation === 'status' ? { ...reply, prewarmSupported: false } : reply
    } }
  const f = await fixture(executor)
  let restarted: HostCiService | undefined
  let restoreClock: (() => void) | undefined
  try {
    const ticket = await f.enqueue()
    ticketId = ticket.ticketId
    available = true
    await settle(f.ci)
    statusUnavailable = true
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001)
    restoreClock = () => clock.mockRestore()
    await settle(f.ci)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting',
      computer: { hostRef: computer.hostRef }, dispatchRequest: { runId: ticket.ticketId } })
    expect(preparationSignal).toBeInstanceOf(AbortSignal)
    const reader = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(reader.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    const pending = await f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })
    expect(pending.isError).toBe(true)
    expect(decodeMcpToolResult(pending)).toMatchObject({ error: { code: 'CI_CANCEL_PENDING' } })
    expect(preparationSignal!.aborted).toBe(true)
    expect(await f.read(ticket.ticketId)).toMatchObject({ state: 'starting', cancellation: {
      principalId: f.operator.principalId, source: 'mcp' } })
    expect(launches).toBe(0)
    expect(original?.runId).toBe(ticket.ticketId)
    release.resolve()
    await expect(start).resolves.toMatchObject({ run: { state: 'canceled' } })
    restarted = f.createService()
    await settle(restarted)
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect((await f.pool.query('select state,host_key from ci_runs where id=$1', [ticket.ticketId])).rows[0])
      .toEqual({ state: 'canceled', host_key: null })
    const recovered = new HostCiRunner(root, ports, {})
    await expect(recovered.handle(original)).resolves.toMatchObject({ run: { state: 'canceled' } })
    expect(launches).toBe(0)
  } finally {
    restoreClock?.()
    release.resolve()
    await start
    await restarted?.close()
    await f.close()
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
  }
})


it('preserves a running ticket without optional message metadata during an unchanged MCP refresh', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    f.control.available = true
    await settle(f.ci)
    const stored = async () => (await f.pool.query(
      'select record from ci_runs where id=$1', [ticket.ticketId])).rows[0]
    const running = await f.read(ticket.ticketId)
    expect(running.state).toBe('running')
    const withoutMessages = { ...running }
    delete withoutMessages.providerMessage
    delete withoutMessages.messageHistory
    await f.pool.query('update ci_runs set record=$2::jsonb where id=$1',
      [ticket.ticketId, JSON.stringify(withoutMessages)])
    const before = await stored()
    expect(await f.read(ticket.ticketId)).toEqual(withoutMessages)

    await settle(f.ci)
    await settle(f.ci)

    const refreshed = { ...before.record, observation: {
      status: 'available', consecutiveFailures: 0, lastError: null,
      nextAttemptAt: null, lastSuccessAt: expect.any(String),
    } }
    expect(await f.read(ticket.ticketId)).toEqual(refreshed)
    const after = await stored()
    expect(after.record).toEqual(refreshed)
    const denied = await f.connect(['jobs:cancel'], [randomUUID()])
    expect((await f.call(denied.client, 'ci_get', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect(await stored()).toEqual(after)
  } finally { await f.close() }
})


it('cancels a queued ticket through MCP before a blocked capacity read finishes', async () => {
  const f = await fixture()
  const entered = deferred()
  const release = deferred()
  let dispatch: Promise<void> | undefined
  let cancellation: ReturnType<typeof f.call> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const ticket = await f.enqueue()
    f.control.onStatus = async () => {
      entered.resolve()
      await release.promise
    }
    f.control.available = true
    dispatch = f.ci.dispatch()
    await entered.promise
    const denied = await f.connect(CI_GET_ACTIONS)
    expect((await f.call(denied.client, 'ci_cancel', { ticketId: ticket.ticketId })).isError).toBe(true)
    expect((await f.read(ticket.ticketId)).state).toBe('queued')
    cancellation = f.call(f.operator.client, 'ci_cancel', { ticketId: ticket.ticketId })
    const result = await Promise.race([
      cancellation,
      new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 1000) }),
    ])
    expect(result, 'Cancellation must finish while capacity discovery is blocked').toBeDefined()
    expect(result!.isError, JSON.stringify(result!.content)).not.toBe(true)
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect(f.starts).toEqual([])
    release.resolve()
    await dispatch
    expect((await f.read(ticket.ticketId)).state).toBe('canceled')
    expect(f.starts).toEqual([])
    const audit = (await f.pool.query(
      "select principal_id from management_audit where action='ci.cancel' and target_key=$1",
      [`ci:${ticket.ticketId}`])).rows
    expect(audit).toEqual([{ principal_id: f.operator.principalId }])
  } finally {
    clearTimeout(timeout)
    release.resolve()
    await dispatch
    await cancellation
    await f.close()
  }
})

it('recovers an accepted completed start after settlement fails without starting another execution', async () => {
  const f = await fixture()
  try {
    const ticket = await f.enqueue()
    f.control.onStart = async (computer, request) => {
      if (request.operation !== 'start') throw new Error('Expected a start request')
      const key = `${computer.key}:${request.runId}`
      f.remote.set(key, { ...f.remote.get(key)!, state: 'passed', step: null,
        exitCode: 0, finishedAt: new Date().toISOString() })
    }
    await f.pool.query(`create function reject_ci_finished() returns trigger language plpgsql as $$
      begin if new.state='passed' then raise exception 'Settlement unavailable'; end if; return new; end $$`)
    await f.pool.query(`create trigger reject_ci_finished before update on ci_runs
      for each row execute function reject_ci_finished()`)
    f.control.available = true
    await settle(f.ci)
    expect(f.starts).toHaveLength(1)
    expect((await f.read(ticket.ticketId)).state).toBe('starting')
    await f.pool.query('drop trigger reject_ci_finished on ci_runs')
    await f.observeWhenDue(f.ci, ticket.ticketId)
    const recovered = await f.read(ticket.ticketId)
    expect(recovered).toMatchObject({ state: 'passed', exitCode: 0,
      computer: { hostRef: f.starts[0]!.computer.hostRef } })
    await settle(f.ci)
    expect((await f.read(ticket.ticketId)).state).toBe('passed')
    expect(f.starts).toHaveLength(1)
  } finally {
    await f.pool.query('drop trigger if exists reject_ci_finished on ci_runs')
    await f.pool.query('drop function if exists reject_ci_finished()')
    await f.close()
  }
}, 60_000)
