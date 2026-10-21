import { workerToolServices } from './helpers/workerMcpServices.js'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiGetOutputSchema, CiRunOutputSchema, CiRunRecordSchema,
  type CiHostReply, type CiHostRun, type CiRunRecord } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { acceptRunAuthority, currentOperatorAuthority } from '../src/modules/access/runAuthority.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAppInteractionService } from '../src/modules/interactions/app.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/wave25/credentials.js'
import { RunCiAuthority, CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { HostCiService, type HostCiComputer, type HostCiEndpoint } from '../src/modules/ci-host/service.js'
import { RunManagementService } from '../src/modules/runs/management.js'
import { createCurrentNativeProductionFactory } from '../src/modules/runs/workflowProduction.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { checkpointRuntimeFixture, insertProviderRun } from './helpers/wave25Br1003Runtime.js'

async function fixture() {
  const saved = makeCurrentWorkflowFixture(randomUUID(), 'single')
  saved.configurations = saved.configurations.map(configuration => ({ ...configuration,
    graphqlTools: ['context_get', 'ci_run', 'ci_get'] }))
  const f = await checkpointRuntimeFixture(1, 1, { fixture: saved,
    approvalNodeIds: [saved.version.entryNodeId], insertRun: false,
    onRunTerminal: async runId => { await ci.cancelStoppedRun(runId) } })
  const pool = f.db.pool
  const access = new PostgresAccessService(pool)
  const commands = new PostgresCommandCoordinator(pool)
  await pool.query(`update workspaces set record=record || $2::jsonb where id=$1`,
    [f.f.run.workspaceId, JSON.stringify({
      repository: { provider: 'github', owner: 'example', name: 'repo', defaultBranch: 'main' },
      ciMirror: { provider: 'github', owner: 'example', name: 'repo-ci' },
    })])
  await pool.query(`update management_principals set grants=grants || $2::jsonb where id=$1`,
    [f.authorizationPrincipalId, JSON.stringify([{ actions: [...CI_RUN_ACTIONS, ...CI_GET_ACTIONS],
      scope: { workspaceIds: [f.f.run.workspaceId] } }])])
  const admitRun = async (runId: string) => {
    const authority = await withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
      const root = await currentOperatorAuthority(sql, f.authorizationPrincipalId)
      return acceptRunAuthority(sql, root.principal)
    }))
    const run = WorkflowRunV3Schema.parse({ ...f.f.run, id: runId,
      authorizationPrincipalId: authority.principal.id })
    await insertProviderRun(pool, { ...f.f, run }, authority)
    return run
  }
  f.f.run = await admitRun(f.f.run.id)
  const mainId = randomUUID()
  const computers: HostCiComputer[] = [
    { key: 'laptop', hostRef: { kind: 'device', mainId, deviceId: randomUUID() }, label: 'Laptop', priority: 60 },
    { key: 'circleci', hostRef: { kind: 'cloud', mainId, provider: 'circleci', slot: 0 }, label: 'CircleCI', priority: 30 },
    { key: 'github', hostRef: { kind: 'cloud', mainId, provider: 'github', slot: 0 }, label: 'GitHub', priority: 30 },
  ]
  const remote = new Map<string, { computer: HostCiComputer; run: CiHostRun }>()
  const cancellations: string[] = []
  let failedTicket: string | undefined
  let beforeResolve: (() => Promise<void>) | undefined
  let beforeStart: (() => Promise<void>) | undefined
  const endpoint: HostCiEndpoint = {
    computers: async () => computers,
    request: async (computer, request): Promise<CiHostReply> => {
      if (request.operation === 'status') return { operation: 'status', ready: true, reasons: [],
        cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] }
      if (request.operation === 'start') {
        await beforeStart?.()
        const run: CiHostRun = { runId: request.runId,
          state: computer.key === 'github' ? 'starting' : 'running', step: 'integration', exitCode: null,
          startedAt: new Date().toISOString(), finishedAt: null, logBytes: 0, message: null }
        remote.set(request.runId, { computer, run })
        return { operation: 'start', run }
      }
      const entry = remote.get(request.runId)!
      if (request.operation === 'cancel') {
        if (failedTicket === request.runId) throw new Error('Provider temporarily unavailable')
        cancellations.push(request.runId)
        entry.run = { ...entry.run, state: 'canceled', finishedAt: new Date().toISOString(), message: 'Canceled.' }
        return { operation: 'cancel', run: entry.run }
      }
      return { operation: 'read', run: entry.run, text: '', nextOffset: 0 }
    },
  }
  const ci: HostCiService = new HostCiService(pool, commands, new RunCiAuthority(pool), {
    capabilities: async () => ({ parts: true, integrationPartitions: true, affected: true }),
    resolve: async () => {
      await beforeResolve?.()
      return 'a'.repeat(40)
    },
  }, endpoint)
  const production = createCurrentNativeProductionFactory({
    isRuntimeOpen: () => true, reportDispatchFailure: () => undefined,
  })({ primaryPool: pool, commands, runs: f.runs, workflows: f.workflows,
    locations: f.locations, engine: f.engine, nativeExecutions: f.native,
    interactions: f.service, checkpointer: f.saver })
  const runs = new RunManagementService(pool, commands, f.runs, f.engine, f.locations, production)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci, runs } as unknown as OperatorServices },
    appMcp: workerToolServices(pool, commands).appMcp(access, new PostgresAppInteractionService(pool, f.repository, commands)) })
  const scope = { workspaceIds: [f.f.run.workspaceId] }
  const writer = await access.issue({ name: 'Run Stop operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['runs:read', 'runs:stop', ...CI_GET_ACTIONS], scope }] })
  const reader = await access.issue({ name: 'Read only operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['runs:read', ...CI_GET_ACTIONS], scope }] })
  const credentials = new Wave25WorkerCredentialService(pool, access)
  await f.engine.start(f.f.run.id)
  const agentTokens = new Set<string>()
  const tokenFor = async (runId: string) => {
    const executionId = (await pool.query<{ id: string }>(
      'select id from harness_executions where run_id=$1', [runId])).rows[0]!.id
    const issued = await credentials.issueForExecution(executionId)
    const token = issued.environment.variables.GRAPHQL_MCP_TOKEN!
    agentTokens.add(token)
    return token
  }
  const agentToken = await tokenFor(f.f.run.id)
  const call = (token: string, name: string, input: Record<string, unknown>) => graphRpc(app, token, 'tools/call', {
    name, arguments: agentTokens.has(token) ? input : { workspaceId: f.f.run.workspaceId, ...input },
  })
  const value = async (token: string, name: string, input: Record<string, unknown>) => {
    const response = await call(token, name, input)
    expect(response.result?.isError, JSON.stringify(response.result)).not.toBe(true)
    return graphRpcValue(response.result)
  }
  const createTickets = async (token = agentToken, partitions = 8) => {
    const result = CiRunOutputSchema.parse(await value(token, 'ci_run', {
      suite: 'integration', scope: 'full', partitions, commandId: randomUUID(),
    }))
    await ci.dispatch()
    return (await pool.query<{ record: unknown }>('select record from ci_runs where group_id=$1 order by id',
      [(await pool.query<{ group_id: string }>('select group_id from ci_runs where id=$1', [result.ticketId]))
        .rows[0]!.group_id])).rows.map(row => CiRunRecordSchema.parse(row.record))
  }
  return { ...f, pool, ci, call, value, createTickets, tokenFor, admitRun, writer, reader, agentToken, remote, cancellations,
    fail: (ticketId?: string) => { failedTicket = ticketId },
    beforeResolve: (callback: () => Promise<void>) => { beforeResolve = callback },
    beforeStart: (callback: () => Promise<void>) => { beforeStart = callback },
    async close() {
      await ci.close()
      await app.close()
      await f.close()
    } }
}

it('Run Stop cancels all Agent CI partitions and provider runs, audits them, and preserves other and terminal tickets', async () => {
  const f = await fixture()
  try {
    const tickets = await f.createTickets()
    const active = tickets.filter(ticket => ticket.state !== 'queued')
    expect(active.map(ticket => ticket.computer!.hostRef.kind === 'cloud'
      ? ticket.computer!.hostRef.provider : 'laptop').sort()).toEqual(['circleci', 'github', 'laptop'])
    const queued = tickets.filter(ticket => ticket.state === 'queued')
    const terminal: CiRunRecord[] = []
    for (const [index, state] of (['passed', 'failed', 'canceled', 'lost'] as const).entries()) {
      const record = { ...queued[index]!, state, finishedAt: new Date().toISOString(), exitCode: state === 'passed' ? 0 : 1 }
      await f.pool.query('update ci_runs set state=$2,record=$3::jsonb where id=$1',
        [record.id, state, JSON.stringify(record)])
      terminal.push(record)
    }
    const otherRun = await f.admitRun(`run-${randomUUID()}`)
    await f.engine.start(otherRun.id)
    const otherTickets = await f.createTickets(await f.tokenFor(otherRun.id), 2)
    const input = { runId: f.f.run.id, commandId: randomUUID() }
    const before = (await f.pool.query('select record from ci_runs order by id')).rows
    const denied = await f.call(f.reader.token, 'run_stop', input)
    expect(denied.result?.isError).toBe(true)
    expect((await f.pool.query('select record from ci_runs order by id')).rows).toEqual(before)
    expect(f.cancellations).toHaveLength(0)
    expect((await f.runs.getRepeatSnapshot(input.runId)).stopRequested).toBe(false)
    expect(await f.value(f.writer.token, 'run_stop', input)).toMatchObject({ status: 'accepted', replayed: false })
    await f.ci.dispatch()
    for (const ticket of otherTickets) {
      const read = CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: ticket.id }))
      expect(['starting', 'running']).toContain(read.run.state)
      expect(read.run).toMatchObject({ id: ticket.id, groupId: ticket.groupId,
        commit: ticket.commit, initiator: ticket.initiator })
      expect(f.remote.get(ticket.id)?.run.state).toBe(read.run.state)
    }
    const canceled = [...active, queued[4]!]
    for (const ticket of canceled) {
      const read = CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: ticket.id }))
      expect(read.run).toMatchObject({ id: ticket.id, state: 'canceled' })
      expect(read.run.finishedAt).not.toBeNull()
      expect((await f.pool.query('select record,state,host_key from ci_runs where id=$1', [ticket.id])).rows[0])
        .toEqual({ record: read.run, state: 'canceled', host_key: null })
    }
    expect(f.cancellations.sort()).toEqual(active.map(ticket => ticket.id).sort())
    for (const ticket of active) {
      expect(f.remote.get(ticket.id)?.run.state).toBe('canceled')
    }
    for (const ticket of terminal) {
      expect(CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: ticket.id })).run).toEqual(ticket)
    }
    const audits = (await f.pool.query<{ principal_id: string; details: { ticketId: string; runId: string; commandId: string } }>(
      "select principal_id,details from management_audit where action='ci.cancel' order by target_key")).rows
    expect(audits).toHaveLength(canceled.length)
    expect(audits.map(row => row.details.ticketId).sort()).toEqual(canceled.map(ticket => ticket.id).sort())
    for (const audit of audits) expect(audit).toMatchObject({ principal_id: f.writer.principal.id,
      details: { runId: input.runId, commandId: input.commandId, reason: 'run_stop' } })
    expect(await f.value(f.writer.token, 'run_stop', input)).toMatchObject({ replayed: true })
    expect((await f.pool.query("select count(*)::int as count from management_audit where action='ci.cancel'"))
      .rows[0]!.count).toBe(canceled.length)
    expect(await f.runs.getRepeatSnapshot(otherRun.id)).toMatchObject({ stopRequested: false })
  } finally { await f.close() }
}, 90_000)

it('retains pending cleanup after a provider cancellation fails and retries without duplicate audit', async () => {
  const f = await fixture()
  try {
    const tickets = await f.createTickets(undefined, 5)
    const failed = tickets.find(ticket => ticket.computer?.hostRef.provider === 'github')!
    f.fail(failed.id)
    const input = { runId: f.f.run.id, commandId: randomUUID() }
    expect((await f.call(f.writer.token, 'run_stop', input)).result?.isError).toBe(true)
    expect(await f.runs.getRepeatSnapshot(input.runId)).toMatchObject({ stopRequested: true, cleanupPending: true })
    expect(CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: failed.id })).run.state)
      .toBe('starting')
    expect((await f.pool.query("select count(*)::int as count from ci_runs where state='canceled'"))
      .rows[0]!.count).toBe(tickets.length - 1)
    f.fail()
    expect(await f.value(f.writer.token, 'run_stop', input)).toMatchObject({ status: 'accepted' })
    expect(await f.runs.getRepeatSnapshot(input.runId)).toMatchObject({ cleanupPending: false })
    expect((await f.pool.query("select count(*)::int as count from ci_runs where state='canceled'"))
      .rows[0]!.count).toBe(tickets.length)
    expect((await f.pool.query("select count(*)::int as count from management_audit where action='ci.cancel'"))
      .rows[0]!.count).toBe(tickets.length)
  } finally { await f.close() }
}, 90_000)


it('keeps a failed provider cancellation readable through MCP until the same Stop command succeeds', async () => {
  const f = await fixture()
  try {
    const tickets = await f.createTickets(undefined, 5)
    const ticket = tickets.find(candidate => candidate.computer?.hostRef.provider === 'github')!
    f.fail(ticket.id)
    const input = { runId: f.f.run.id, commandId: randomUUID() }
    const denied = await f.call(f.reader.token, 'run_stop', input)
    expect(denied.result?.isError).toBe(true)
    expect(f.cancellations).toHaveLength(0)
    const pending = await f.call(f.writer.token, 'run_stop', input)
    expect(pending.result?.isError).toBe(true)
    const read = CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: ticket.id }))
    expect(read.run.cancellation).toEqual({
      principalId: f.writer.principal.id, source: 'mcp', commandId: input.commandId,
      runId: input.runId, reason: 'run_stop',
    })
    expect(read.run.state).toBe('starting')
    f.fail()
    expect(await f.value(f.writer.token, 'run_stop', input)).toMatchObject({ status: 'accepted' })
    const settled = CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: ticket.id }))
    expect(settled.run.state).toBe('canceled')
    expect(settled.run.cancellation).toBeUndefined()
    expect(await f.value(f.writer.token, 'run_stop', input)).toMatchObject({ replayed: true })
    expect(f.cancellations.filter(id => id === ticket.id)).toHaveLength(1)
  } finally { await f.close() }
}, 90_000)

it('rejects an Agent CI admission that finishes publishing after Run Stop', async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const resolving = new Promise<void>(resolve => { entered = resolve })
  f.beforeResolve(async () => { entered(); await blocked })
  const admission = f.call(f.agentToken, 'ci_run', {
    suite: 'integration', partitions: 5, commandId: randomUUID(),
  })
  try {
    await Promise.race([resolving, admission.then(response => {
      throw new Error(`CI admission ended before publishing: ${JSON.stringify(response.result)}`)
    })])
    expect(await f.value(f.writer.token, 'run_stop', {
      runId: f.f.run.id, commandId: randomUUID(),
    })).toMatchObject({ status: 'accepted' })
    release()
    expect((await admission).result?.isError).toBe(true)
    expect((await f.pool.query('select count(*)::int as count from ci_runs')).rows[0]!.count).toBe(0)
    expect(f.remote.size).toBe(0)
  } finally { release(); await admission; await f.close() }
}, 90_000)


it('drains a dispatch already starting remote work before Run Stop completes', async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const starting = new Promise<void>(resolve => { entered = resolve })
  f.beforeStart(async () => { entered(); await blocked })
  let stopping: Promise<unknown> | undefined
  try {
    const tickets = CiRunOutputSchema.parse(await f.value(f.agentToken, 'ci_run', {
      suite: 'integration', scope: 'full', partitions: 5, commandId: randomUUID(),
    }))
    await starting
    stopping = f.value(f.writer.token, 'run_stop', { runId: f.f.run.id, commandId: randomUUID() })
    await expect.poll(async () => (await f.runs.getRepeatSnapshot(f.f.run.id)).stopRequested).toBe(true)
    release()
    expect(await stopping).toMatchObject({ status: 'accepted' })
    const read = CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', {
      ticketId: tickets.ticketId,
    }))
    expect(read.partitions).toHaveLength(5)
    expect(read.partitions!.every(ticket => ticket.state === 'canceled')).toBe(true)
    expect(f.remote.size).toBe(3)
    expect([...f.remote.values()].every(entry => entry.run.state === 'canceled')).toBe(true)
  } finally {
    release()
    await stopping
    await f.close()
  }
}, 90_000)


it('cancels persisted CI assignments using the accepted Stop intent and permits denied-caller readback', async () => {
  const f = await fixture()
  try {
    const tickets = await f.createTickets(undefined, 3)
    expect(tickets.filter(ticket => ticket.computer !== null)).toHaveLength(3)
    const input = { runId: f.f.run.id, commandId: randomUUID() }
    expect((await f.call(f.reader.token, 'run_stop', input)).result?.isError).toBe(true)
    expect(f.cancellations).toEqual([])
    expect(await f.value(f.writer.token, 'run_stop', input)).toMatchObject({ status: 'accepted' })
    for (const ticket of tickets) {
      const result = CiGetOutputSchema.parse(await f.value(f.reader.token, 'ci_get', { ticketId: ticket.id }))
      expect(result.run.state).toBe('canceled')
    }
    expect(f.cancellations.sort()).toEqual(tickets.map(ticket => ticket.id).sort())
    expect(await f.runs.getRepeatSnapshot(input.runId)).toMatchObject({ cleanupPending: false })
  } finally { await f.close() }
}, 90_000)
