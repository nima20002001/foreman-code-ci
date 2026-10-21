import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { CiComputersOutputSchema, CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { ComputerActivityListSchema } from '@foreman-code/contracts/computer-activity'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { claimCiSlot } from '../src/modules/ci-host/cloudSlots.js'
import { CircleStandby } from '../src/modules/ci-host/circleStandby.js'
import { CircleCreditCache } from '../src/modules/ci-host/circleCreditCache.js'
import type { HostCiComputer } from '../src/modules/ci-host/serviceTypes.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { CircleAccountsManagementService } from '../src/modules/settings/circleAccounts.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { CloudCi } from '../src/modules/ci-host/cloud.js'
import { CircleCiProvider } from '../src/modules/ci-host/cloudProviders.js'
import { CloudHttp } from '../src/modules/ci-host/cloudHttp.js'
import { CircleCreditUsage } from '../src/modules/ci-host/circleCredits.js'
import { ProductionHostCiEndpoint } from '../src/modules/ci-host/endpoint.js'
import { HostCiService, type CiCommits } from '../src/modules/ci-host/service.js'
import { ComputerActivityService } from '../src/modules/computers/activity.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import type { HostCiPorts } from '../src/modules/ci-host/runner.js'
import { CircleAccountAddInputSchema, CircleAccountRemoveInputSchema } from '@foreman-code/contracts/management'
import { expireCiRun } from '../src/modules/ci-host/deadlines.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)
beforeEach(async () => {
  await withTransaction(database.pool, client => new PostgresFoundationSettingsRepository(database.pool)
    .updateCircleAccounts({ accounts: [{ id: 'default', label: 'Primary', role: 'primary', organizations: [] }] },
      undefined, client))
})

const slot = (mainId: string, owner?: string, circleAccountId?: string): HostCiComputer => ({
  key: `${mainId}:cloud:circleci${circleAccountId ? `~${circleAccountId}` : ''}${owner ? `@${owner}` : ''}:0`,
  hostRef: { kind: 'cloud', mainId, provider: 'circleci', slot: 0,
    ...(owner ? { account: owner } : {}), ...(circleAccountId ? { circleAccountId } : {}) },
  label: 'Fixture CircleCI', priority: 30,
})
async function ticket(workspaceId: string, computer?: HostCiComputer): Promise<CiRunRecord> {
  const id = randomUUID()
  const run = CiRunRecordSchema.parse({ id, workspaceId, groupId: randomUUID(), suite: 'lint',
    commit: 'a'.repeat(40), repository: 'fixture/site', ciMirror: 'alpha/site-ci', partition: null,
    state: computer ? 'running' : 'queued', computer: computer ? { hostRef: computer.hostRef, label: computer.label } : null,
    step: null, exitCode: null, message: null, queuedAt: new Date().toISOString(),
    startedAt: computer ? new Date().toISOString() : null, finishedAt: null,
    initiator: { principalId: 'fixture-principal', executionId: null },
  })
  await database.pool.query('insert into ci_runs(id,workspace_id,group_id,state,host_key,record) values($1,$2,$3,$4,$5,$6)',
    [id, workspaceId, run.groupId, run.state, computer?.key ?? null, JSON.stringify(run)])
  return run
}
async function workspace() {
  const id = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2)', [id, JSON.stringify({ id,
    name: 'Fixture workspace', repository: { provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main' },
  })])
  return id
}
const request = (run: CiRunRecord) => ({ operation: 'start' as const, runId: run.id, workspaceId: run.workspaceId,
  repository: run.repository, ciMirror: run.ciMirror!, commit: run.commit, suite: run.suite, scope: run.scope })

async function accountService() {
  const access = new PostgresAccessService(database.pool)
  const caller = await access.issue({ name: 'Fixture Operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
  const settings = new PostgresFoundationSettingsRepository(database.pool)
  const service = new CircleAccountsManagementService(settings, new PostgresCommandCoordinator(database.pool), {
    read: async account => ({ tokenConfigured: false, ready: false, reasons: ['Setup needed.'],
      orgs: account.organizations.map(owner => ({ account: owner, circleAccountId: account.id, ready: false,
        running: 0, schedulingRole: 'standby', schedulingReason: 'Setup needed.', credits: null })) }),
  })
  await service.add(caller.principal, 'mcp', CircleAccountAddInputSchema.parse({ account: {
    id: 'spare', label: 'Spare', role: 'standby', organizations: ['eta', 'theta', 'iota'],
  } }))
  return { service, caller }
}

it.each([false, true])('counts legacy and explicit primary aliases as the same physical org slot, legacy first: %s', async legacyFirst => {
  const workspaceId = await workspace()
  const mainId = randomUUID()
  const legacy = slot(mainId)
  const named = slot(mainId, 'alpha')
  const occupied = await ticket(workspaceId, legacyFirst ? legacy : named)
  const queued = await ticket(workspaceId)
  expect(await claimCiSlot(database.pool, queued, legacyFirst ? named : legacy, request(queued))).toBe('busy')
  const rows = (await database.pool.query('select host_key,record from ci_runs where id=$1', [occupied.id])).rows
  expect(rows[0]).toMatchObject({ host_key: occupied.computer ? (legacyFirst ? legacy.key : named.key) : null,
    record: occupied })
})

it('keeps an old unnamed slot reserved when its database record predates the saved mirror field', async () => {
  const workspaceId = await workspace()
  const mainId = randomUUID()
  const occupied = await ticket(workspaceId, slot(mainId))
  const old = { ...occupied }
  delete old.ciMirror
  await database.pool.query('update ci_runs set record=$2 where id=$1', [occupied.id, JSON.stringify(old)])
  const queued = await ticket(workspaceId)
  expect(await claimCiSlot(database.pool, queued, slot(mainId, 'alpha'), request(queued))).toBe('busy')
})

it('serializes concurrent alias claims and preserves the chosen login in saved records after reconstruction', async () => {
  const workspaceId = await workspace()
  const mainId = randomUUID()
  const first = await ticket(workspaceId)
  const second = await ticket(workspaceId)
  const results = await Promise.all([
    claimCiSlot(database.pool, first, slot(mainId), request(first)),
    claimCiSlot(database.pool, second, slot(mainId, 'alpha'), request(second)),
  ])
  expect(results.filter(result => result === 'busy')).toHaveLength(1)
  expect(results.filter(result => result && result !== 'busy')).toHaveLength(1)
  const reserve = await ticket(workspaceId)
  const reserveSlot = slot(mainId, 'delta', 'reserve')
  await withTransaction(database.pool, client => new PostgresFoundationSettingsRepository(database.pool)
    .updateCircleAccounts({ accounts: [
      { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
      { id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] },
    ] }, undefined, client))
  expect(await claimCiSlot(database.pool, reserve, reserveSlot, request(reserve)))
    .toMatchObject({ computer: { hostRef: reserveSlot.hostRef } })
  const saved = (await database.pool.query('select host_key,record from ci_runs where id=$1', [reserve.id])).rows[0]!
  expect(saved.host_key).toBe(reserveSlot.key)
  expect(CiRunRecordSchema.parse(saved.record).computer?.hostRef).toEqual(reserveSlot.hostRef)
})

it('shares provider-refusal and confirmed recovery policy across month boundaries and new-start checks', async () => {
  let now = Date.parse('2026-10-31T23:59:59Z')
  const remaining = 20_000
  const cache = new CircleCreditCache()
  const selector = new CircleStandby(async () => [
    { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async (owner?: string) => now >= Date.parse('2026-11-01T00:00:00Z') ? { credits: null }
    : { credits: { total: 400_000, used: 400_000 - (owner === 'alpha' ? remaining : 400_000),
      remaining: owner === 'alpha' ? remaining : 400_000, asOf: new Date(now).toISOString() } } }, cache, () => now)
  await selector.recordCreditRefusal('alpha')
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(false)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(true)
  now = Date.parse('2026-10-31T23:59:59Z') + 5 * 60_000
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(false)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(true)
  expect(await selector.admitStart('alpha', 'default', 'site-ci', 'probe')).toBe(true)
  await selector.recordCreditAcceptance('alpha', 'default', 'probe')
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(false)
  now = Date.parse('2026-10-31T23:59:59Z')
  await selector.recordCreditRefusal('alpha')
  await selector.roles('site-ci')
  now += 1000
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(false)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(true)
})

it('cannot claim a stale standby row after its registration has been removed', async () => {
  const { service, caller } = await accountService()
  await service.remove(caller.principal, 'mcp', CircleAccountRemoveInputSchema.parse({ id: 'spare' }))
  const queued = await ticket(await workspace())
  expect(await claimCiSlot(database.pool, queued, slot(randomUUID(), 'eta', 'spare'), request(queued))).toBeNull()
  expect((await database.pool.query('select record from ci_runs where id=$1', [queued.id])).rows[0]!.record.state).toBe('queued')
})

it('keeps registration while a deadline failure still retains its executor', async () => {
  const { service, caller } = await accountService()
  const assigned = await ticket(await workspace(), slot(randomUUID(), 'eta', 'spare'))
  const expired = expireCiRun(assigned, new Date(Date.now() + 4 * 60 * 60_000))!
  expect(expired.deadlineExceeded?.executor).toBe('retained')
  await database.pool.query('update ci_runs set state=$2,record=$3 where id=$1',
    [assigned.id, expired.state, JSON.stringify(expired)])
  await expect(service.remove(caller.principal, 'mcp', CircleAccountRemoveInputSchema.parse({ id: 'spare' })))
    .rejects.toMatchObject({ code: 'CIRCLE_ACCOUNT_IN_USE' })
})

it('serializes removal and claims so either removal is refused or the stale claim cannot assign work', async () => {
  const settings = new PostgresFoundationSettingsRepository(database.pool)
  const workspaceId = await workspace()
  const queued = await ticket(workspaceId)
  await withTransaction(database.pool, async client => {
    await settings.updateCircleAccounts({ accounts: [
      { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
      { id: 'spare', label: 'Spare', role: 'standby', organizations: ['eta', 'theta', 'iota'] },
    ] }, undefined, client)
  })
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const locked = new Promise<void>(resolve => { entered = resolve })
  const removal = withTransaction(database.pool, async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['circle-accounts'])
    entered()
    await held
    await settings.updateCircleAccounts({ accounts: [
      { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
    ] }, undefined, client)
  })
  await locked
  const claim = claimCiSlot(database.pool, queued, slot(randomUUID(), 'eta', 'spare'), request(queued))
  release()
  await removal
  expect(await claim).toBeNull()
})

it('reads persisted account assignments and credits through authenticated MCP after recreating the CI service', async () => {
  const mainId = randomUUID()
  const workspaceId = await workspace()
  const pool = database.pool
  const ports: HostCiPorts = { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async () => ({ code: 0, stdout: '{}', stderr: '' }) }
  const http = (id: string) => new CloudHttp(ports, 'circleci', { circleAccountId: id,
    circleToken: async () => 'fixture-token', fetch: async (input, init) => {
      const path = new URL(String(input)).pathname
      const owner = id === 'default' ? 'alpha' : 'delta'
      if (path.endsWith('collaborations')) return Response.json([{ id: `org-${owner}`, name: owner }])
      if (init?.method === 'POST') return Response.json({ usage_export_job_id: 'job' })
      if (path.endsWith('/job')) return Response.json({ state: 'completed', download_urls: ['https://signed.example/usage'] })
      return new Response(`COMPUTE_CREDITS\n${id === 'default' ? 380000 : 25000}\n`)
    } })
  const usagePath = join(database.directory, 'circle-usage.json')
  let now = Date.now()
  const credits = new CircleCreditUsage(http, {
    allowance: async () => ({ defaultMonthlyCredits: 400_000, accounts: {} }), primaryOwner: async () => null,
  }, { cache: new CircleCreditCache(usagePath) })
  await Promise.all([credits.reading('alpha'), credits.reading('delta', 'reserve')])
  await vi.waitFor(async () => {
    expect((await credits.reading('alpha')).credits?.remaining).toBe(20_000)
    expect((await credits.reading('delta', 'reserve')).credits?.remaining).toBe(375_000)
  })
  const clouds = ['default', 'reserve'].map(id => new CloudCi(mainId,
    new CircleCiProvider(ports, { circleToken: async () => null }, {
      owner: id === 'default' ? 'alpha' : 'delta', circleAccountId: id,
      role: id === 'default' ? 'primary' : 'standby', mirrorNames: new Set(['site-ci']),
    }), async () => 'alpha/site-ci', join(database.directory, 'clouds', id)))
  const createSelector = () => new CircleStandby(async () => clouds.map(cloud => ({
    owner: cloud.provider.account!.owner, circleAccountId: cloud.provider.circleAccountId!,
    role: cloud.provider.account!.role!, mirrorNames: cloud.provider.account!.mirrorNames, ready: true,
  })), credits, new CircleCreditCache(usagePath), () => now)
  let selector = createSelector()
  await selector.recordCreditRefusal('alpha')
  for (const cloud of clouds) cloud.setCircleStandby(selector)
  const commands = new PostgresCommandCoordinator(pool)
  const endpoint = new ProductionHostCiEndpoint(pool, mainId, () => undefined,
    { handle: async () => { throw new Error('Unexpected local execution.') } }, clouds)
  const create = () => new HostCiService(pool, commands, new RunCiAuthority(pool), {} as CiCommits, endpoint,
    undefined, { circleCredits: credits, circleStandby: selector })
  const access = new PostgresAccessService(pool)
  const caller = await access.issue({ name: 'Fixture Reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: [...CI_GET_ACTIONS, 'settings:read'], scope: {} }] })
  const denied = await access.issue({ name: 'Fixture Denied', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [] })
  const settings = new PostgresFoundationSettingsRepository(pool)
  await withTransaction(pool, client => settings.updateCircleAccounts({ accounts: [
    { id: 'default', label: 'Primary', role: 'primary', organizations: ['alpha', 'beta', 'gamma'] },
    { id: 'reserve', label: 'Reserve', role: 'standby', organizations: ['delta', 'epsilon', 'zeta'] },
  ] }, undefined, client))
  const run = await ticket(workspaceId)
  const computer = slot(mainId, 'delta', 'reserve')
  expect(await claimCiSlot(pool, run, computer, request(run))).toMatchObject({ state: 'starting' })
  const services = { ci: create(), commands,
    computerActivity: new ComputerActivityService(pool, mainId, () => null, commands, clouds, credits) }
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: services as unknown as OperatorServices } })
  const call = async (name: string, token = caller.token) => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name,
        arguments: name === 'ci_computers_list' ? { workspaceId } : {} } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return (data ? JSON.parse(data.slice(6)) : response.json()).result
  }
  try {
    expect((await call('ci_computers_list', denied.token)).isError).toBe(true)
    expect((await call('computer_activity_list', denied.token)).isError).toBe(true)
    await services.ci.close()
    now += 5 * 60_000
    selector = createSelector()
    for (const cloud of clouds) cloud.setCircleStandby(selector)
    services.ci = create()
    const listed = CiComputersOutputSchema.parse(decodeMcpToolResult(await call('ci_computers_list')))
    expect(listed.computers.find(value => value.hostRef.circleAccountId === 'reserve')).toMatchObject({
      schedulingRole: 'active', credits: { remaining: 375_000 } })
    expect(listed.computers.find(value => value.hostRef.account === 'alpha')).toMatchObject({
      schedulingRole: 'exhausted', creditProbeAvailable: true, credits: { remaining: 20_000 } })
    const activity = ComputerActivityListSchema.parse(decodeMcpToolResult(await call('computer_activity_list')))
    expect(activity.cloud).toMatchObject([
      { account: 'alpha', schedulingRole: 'exhausted', running: 0, credits: { remaining: 20_000 } },
      { account: 'delta', circleAccountId: 'reserve', schedulingRole: 'active', running: 1, credits: { remaining: 375_000 } },
    ])
    const saved = (await pool.query('select host_key,record from ci_runs where id=$1', [run.id])).rows[0]!
    expect(saved.host_key).toBe(computer.key)
    expect(CiRunRecordSchema.parse(saved.record).computer?.hostRef).toEqual(computer.hostRef)
  } finally { await services.ci.close(); await app.close() }
})
