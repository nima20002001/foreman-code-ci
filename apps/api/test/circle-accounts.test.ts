import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CircleAccountsUpdateResultSchema, ManagedCircleAccountsSchema,
  type CircleAccount, type ManagementGrant } from '@foreman-code/contracts/management'
import { afterEach, expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CircleAccountDirectory } from '../src/modules/ci-host/circleAccounts.js'
import { CircleAccountFleetStatus } from '../src/modules/ci-host/circleAccountStatus.js'
import { CircleCiAccounts } from '../src/modules/ci-host/circleCiAccounts.js'
import { circleOrganizations } from '../src/modules/ci-host/circleOrganizations.js'
import { CircleStandby, circleOrgKey } from '../src/modules/ci-host/circleStandby.js'
import { CloudCi } from '../src/modules/ci-host/cloud.js'
import { CircleCiProvider } from '../src/modules/ci-host/cloudProviders.js'
import type { HostCiPorts } from '../src/modules/ci-host/runner.js'
import { CircleAccountsManagementService } from '../src/modules/settings/circleAccounts.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { deferred } from './helpers/deferred.js'
import type { CircleAccountStatusReader } from '../src/modules/ci-host/circleAccounts.js'
import { claimCiSlot } from '../src/modules/ci-host/cloudSlots.js'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { migratedDatabase } from './helpers/migratedDatabase.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
const reserve: CircleAccount = { id: 'reserve', label: 'Reserve', role: 'standby',
  organizations: ['fixture-delta', 'fixture-echo', 'fixture-foxtrot'] }
const primary: CircleAccount = { id: 'default', label: 'Primary', role: 'primary',
  organizations: ['fixture-alpha', 'fixture-bravo', 'fixture-charlie'] }
const canary = 'fixture-profile-credential-canary'
async function fixture() {
  const db = await migratedDatabase()
  cleanups.push(() => db.close())
  const access = new PostgresAccessService(db.pool)
  const changes: string[] = []
  const credentials = join(db.directory, 'config')
  async function profile() {
    const directory = join(credentials, 'foreman-code', 'circleci-accounts', 'reserve', 'circleci')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(join(directory, 'config.yml'), `host: https://circleci.com\ntoken: ${canary}\n`, { mode: 0o600 })
  }
  async function app(status?: CircleAccountStatusReader) {
    const repository = new PostgresFoundationSettingsRepository(db.pool)
    const commands = new PostgresCommandCoordinator(db.pool)
    const directory = new CircleAccountDirectory({ run: vi.fn(), now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30 },
      { list: async () => (await repository.getCircleAccounts()).value.accounts },
      { configRoot: credentials, environment: { CIRCLE_TOKEN: 'fixture-primary' } })
    const circleAccounts = new CircleAccountsManagementService(repository, commands, status ?? directory, async id => {
      expect((await repository.getCircleAccounts()).revision).toBeGreaterThan(0)
      directory.invalidate(id)
      changes.push(id)
    })
    const services = { commands, circleAccounts } as unknown as OperatorServices
    const instance = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services } })
    const address = await instance.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    cleanups.push(async () => {
      await Promise.all(clients.map(client => client.close()))
      await instance.close()
    })
    async function connect(token: string) {
      const client = new Client({ name: 'circle-accounts-fixture', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    return { instance, connect, circleAccounts }
  }
  async function issue(actions: ManagementGrant['actions'], scope: ManagementGrant['scope'] = {}) {
    return access.issue({ name: 'Fixture caller', audience: 'operator', grants: actions.length ? [{ actions, scope }] : [] })
  }
  return { db, app, issue, profile, changes }
}
async function list(client: Client) {
  return ManagedCircleAccountsSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'circle_accounts_list', arguments: {} })))
}
async function add(client: Client, account = reserve, extra: Record<string, unknown> = {}) {
  return CircleAccountsUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'circle_account_add', arguments: { account, ...extra },
  })))
}

it('reads discovered primary status and renames the account through MCP and HTTP without changing bindings', async () => {
  const f = await fixture()
  const repository = new PostgresFoundationSettingsRepository(f.db.pool)
  const registry = { list: async () => (await repository.getCircleAccounts()).value.accounts }
  const owners = ['fixture-alpha', 'fixture-bravo', 'fixture-charlie']
  let authenticated = true
  const ports: HostCiPorts = { now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
    run: async (file, args) => {
      if (file === 'gh') return { code: 0, stdout: owners.join('\n'), stderr: '' }
      if (file === 'circleci' && args[0] === 'auth' && !authenticated) {
        return { code: 1, stdout: '', stderr: 'Not logged in' }
      }
      if (file === 'circleci' && ['auth', 'project'].includes(args[0]!)) {
        return { code: 0, stdout: '{}', stderr: '' }
      }
      throw new Error(`Unexpected fixture command: ${file} ${args[0]}`)
    } }
  const directory = new CircleAccountDirectory(ports, registry, {
    configRoot: join(f.db.directory, 'primary-config'), environment: { CIRCLE_TOKEN: 'fixture-primary' },
  })
  const context = async (id: string) => {
    const selected = await directory.context(id)
    if (!selected) throw new Error('Missing fixture login')
    return selected
  }
  const clouds: CloudCi[] = []
  const discovery = new CircleCiAccounts(ports, async () => ['fixture-alpha/site-ci'], async account => {
    const selected = await context(account.circleAccountId ?? 'default')
    clouds.push(new CloudCi('fixture-main', new CircleCiProvider(selected.ports, { http: selected.http }, account),
      async () => 'fixture-alpha/site-ci', join(f.db.directory, account.owner)))
  }, { registry, context, explicitPrimary: true })
  await discovery.refresh()
  await Promise.all(clouds.map(cloud => cloud.ready()))
  const credits = { total: 400_000, used: 10_000, remaining: 390_000, asOf: new Date().toISOString() }
  const standby = new CircleStandby(() => circleOrganizations(clouds), { reading: async () => ({ credits }) })
  const app = await f.app(new CircleAccountFleetStatus(f.db.pool, 'fixture-main', directory, clouds, standby))
  const owner = await f.issue(['settings:read', 'settings:update'])
  const client = await app.connect(owner.token)
  await f.db.pool.query("insert into workspaces(id,record) values('fixture-workspace','{}'::jsonb)")
  for (let slot = 0; slot < 2; slot++) {
    const id = randomUUID()
    await f.db.pool.query('insert into ci_runs(id,workspace_id,group_id,state,host_key,record) values($1,$2,$3,$4,$5,$6)',
      [id, 'fixture-workspace', randomUUID(), 'running', `fixture-main:cloud:circleci@fixture-alpha:${slot}`, '{}'])
  }
  const read = async () => {
    const mcp = await list(client)
    const http = await app.instance.inject({ url: '/api/management/settings/circle-accounts',
      headers: { authorization: `Bearer ${owner.token}` } })
    expect(http.statusCode).toBe(200)
    expect(http.json()).toEqual(mcp)
    return mcp.value.accounts[0]!
  }
  const account = await read()
  const { id, role, organizations } = account
  const renameReply = await client.callTool({ name: 'circle_account_add', arguments: {
    account: { id, role, organizations, label: 'Renamed through MCP' },
  } })
  const renameResult = decodeMcpToolResult(renameReply)
  expect(renameReply.isError, JSON.stringify(renameResult)).not.toBe(true)
  const renamed = CircleAccountsUpdateResultSchema.parse(renameResult)
  expect(renamed.value.value.accounts[0]).toMatchObject({ label: 'Renamed through MCP', organizations: [] })
  expect(account).toMatchObject({ id: 'default', role: 'primary', organizations: [],
    tokenConfigured: true, ready: true, reasons: [] })
  expect(account.orgs.map(org => org.account)).toEqual(owners)
  const roles = await standby.roles()
  for (const org of account.orgs) {
    expect(org).toMatchObject({ ready: true, credits, running: org.account === 'fixture-alpha' ? 2 : 0,
      schedulingRole: roles.get(circleOrgKey(org.account, 'default'))!.schedulingRole })
  }

  clouds[2]!.provider.account!.registered = false
  const retired = await read()
  expect(retired.organizations).toEqual([])
  expect(retired.orgs.map(org => org.account)).toEqual(owners.slice(0, 2))
  const updated = await app.instance.inject({ method: 'POST', url: '/api/management/settings/circle-accounts',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { account: {
      id: retired.id, role: retired.role, organizations: retired.organizations, label: 'Renamed through HTTP',
    } } })
  expect(updated.statusCode).toBe(200)
  expect(updated.json().value.value.accounts[0]).toMatchObject({ label: 'Renamed through HTTP', organizations: [] })
  expect((await read()).label).toBe('Renamed through HTTP')
  authenticated = false
  for (const cloud of clouds) cloud.invalidateReadiness()
  const loggedOut = await read()
  expect(loggedOut.ready).toBe(false)
  expect(loggedOut.orgs.every(org => !org.ready)).toBe(true)
  expect(loggedOut.reasons.length).toBeGreaterThan(0)
  expect(loggedOut.reasons.join(' ')).not.toContain('Authentication has not been checked.')
  expect(await clouds[0]!.handle({ operation: 'status' })).toMatchObject({ ready: false })
  expect((await repository.getCircleAccounts()).value.accounts[0]).toMatchObject({
    label: 'Renamed through HTTP', organizations: [],
  })

  const denied = await f.issue([])
  expect((await (await app.connect(denied.token)).callTool({ name: 'circle_accounts_list', arguments: {} })).isError)
    .toBe(true)
  expect((await app.instance.inject({ url: '/api/management/settings/circle-accounts',
    headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
})

it('registers only metadata with MCP and HTTP parity, persisted restart readback and safe credential status', async () => {
  const f = await fixture()
  const owner = await f.issue(['settings:read', 'settings:update', 'capabilities:read'])
  const first = await f.app()
  const client = await first.connect(owner.token)
  expect((await list(client)).revision).toBe(0)
  await add(client, primary)
  const input = { commandId: randomUUID(), expectedRevision: 1 }
  const saved = await add(client, reserve, input)
  expect(saved).toMatchObject({ replayed: false, value: { revision: 2, value: { accounts: [
    expect.objectContaining({ id: 'default', role: 'primary' }),
    expect.objectContaining({ id: 'reserve', role: 'standby', tokenConfigured: false, ready: false }),
  ] } } })
  expect(await add(client, reserve, input)).toEqual({ ...saved, replayed: true })
  expect(f.changes).toEqual(['default', 'reserve'])
  const http = await first.instance.inject({ url: '/api/management/settings/circle-accounts',
    headers: { authorization: `Bearer ${owner.token}` } })
  expect(http.statusCode).toBe(200)
  expect(http.json()).toEqual(saved.value)
  const stale = await client.callTool({ name: 'circle_account_add', arguments: {
    account: { ...reserve, label: 'Changed' }, expectedRevision: 1, commandId: randomUUID(),
  } })
  expect(stale.isError).toBe(true)
  expect(JSON.stringify(stale)).toContain('REVISION_CONFLICT')
  await f.profile()
  const restarted = await f.app()
  const persisted = await list(await restarted.connect(owner.token))
  expect(persisted).toMatchObject({ revision: 2, value: { accounts: [
    expect.objectContaining({ id: 'default' }),
    expect.objectContaining({ id: 'reserve', tokenConfigured: true }),
  ] } })
  const capabilities = decodeMcpToolResult(await client.callTool({ name: 'operator_get_capabilities', arguments: {} }))
  expect(JSON.stringify(capabilities)).toContain('circle_account_add')
  expect(JSON.stringify(capabilities)).toContain('Local human setup')
  const removed = await restarted.instance.inject({ method: 'DELETE', url: '/api/management/settings/circle-accounts',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { id: 'reserve' } })
  expect(removed.statusCode).toBe(200)
  expect((await list(await first.connect(owner.token))).value.accounts.map(account => account.id)).toEqual(['default'])
  const httpAdded = await restarted.instance.inject({ method: 'POST', url: '/api/management/settings/circle-accounts',
    headers: { authorization: `Bearer ${owner.token}` }, payload: { account: reserve } })
  expect(httpAdded.statusCode).toBe(200)
  const rows = await Promise.all([
    f.db.pool.query('select record from application_settings'),
    f.db.pool.query('select record from application_setting_versions'),
    f.db.pool.query('select result from management_command_receipts'),
    f.db.pool.query('select action, details from management_audit'),
  ])
  expect(rows[2]!.rows.length).toBeGreaterThan(0)
  expect(rows[3]!.rows.map(row => row.action)).toContain('circle.account.add')
  const serialized = JSON.stringify([persisted, removed.json(), httpAdded.json(), capabilities, rows.map(row => row.rows)])
  expect(serialized).not.toContain(canary)
  expect(serialized).not.toContain(f.db.directory)
})
it('denies ungranted and workspace-scoped callers, rejects duplicate orgs and protects the reserved identity', async () => {
  const f = await fixture()
  const app = await f.app()
  const owner = await f.issue(['settings:read', 'settings:update'])
  const writer = await app.connect(owner.token)
  await add(writer, primary)
  for (const [actions, scope] of [
    [['settings:read'], {}], [[], {}],
    [['settings:read', 'settings:update'], { workspaceIds: ['fixture-workspace'] }],
  ] as [ManagementGrant['actions'], ManagementGrant['scope']][]) {
    const caller = await f.issue(actions, scope)
    const client = await app.connect(caller.token)
    expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('circle_account_add')
    expect((await client.callTool({ name: 'circle_account_add', arguments: { account: reserve } })).isError).toBe(true)
    const denied = await app.instance.inject({ method: 'POST', url: '/api/management/settings/circle-accounts',
      headers: { authorization: `Bearer ${caller.token}` }, payload: { account: reserve } })
    expect(denied.statusCode).toBe(403)
    if (actions.length === 0 || Object.keys(scope).length) {
      expect((await client.callTool({ name: 'circle_accounts_list', arguments: {} })).isError).toBe(true)
    }
  }
  const duplicate = await writer.callTool({ name: 'circle_account_add', arguments: {
    account: { ...reserve, organizations: ['FIXTURE-ALPHA', 'fixture-echo', 'fixture-foxtrot'] },
  } })
  expect(duplicate.isError).toBe(true)
  expect((await list(writer)).revision).toBe(1)
  expect((await writer.callTool({ name: 'circle_account_remove', arguments: { id: 'default' } })).isError).toBe(true)
  expect((await writer.callTool({ name: 'circle_account_add', arguments: { account: reserve, token: canary } })).isError).toBe(true)
  await add(writer)
  expect((await writer.callTool({ name: 'circle_account_add', arguments: {
    account: { ...reserve, id: 'another', organizations: ['fixture-golf', 'fixture-hotel', 'fixture-india'] },
  } })).isError).toBe(true)
})
it('blocks removal for assigned and collecting current, smoke, retry and history references until settlement', async () => {
  const f = await fixture()
  const app = await f.app()
  const owner = await f.issue(['settings:read', 'settings:update'])
  const client = await app.connect(owner.token)
  await add(client)
  await f.db.pool.query("insert into workspaces(id,record) values('fixture-workspace','{}'::jsonb)")
  const hostRef = { kind: 'cloud', provider: 'circleci', mainId: 'fixture-main', circleAccountId: 'reserve',
    account: 'fixture-delta', slot: 0 }
  const runId = randomUUID()
  const references = [
    { computer: { hostRef } }, { smokeComputer: hostRef }, { setupRetry: { failedComputer: hostRef } },
    { executionHistory: [{ runId, hostRef }] }, { dispatchHostKey: 'fixture-main:cloud:circleci~reserve@fixture-delta:0' },
  ]
  for (const reference of references) {
    const ticketId = randomUUID()
    await f.db.pool.query('insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$1,$3,$4::jsonb)',
      [ticketId, 'fixture-workspace', 'running', JSON.stringify({ ...reference, collection: 'pending' })])
    const blocked = await client.callTool({ name: 'circle_account_remove', arguments: { id: 'reserve' } })
    expect(blocked.isError).toBe(true)
    expect(JSON.stringify(blocked)).toContain('CIRCLE_ACCOUNT_IN_USE')
    await f.db.pool.query("update ci_runs set state='passed' where id=$1", [ticketId])
    expect((await client.callTool({ name: 'circle_account_remove', arguments: { id: 'reserve' } })).isError).toBe(true)
    await f.db.pool.query("update ci_runs set record=jsonb_set(record,'{collection}','\"complete\"'::jsonb) where id=$1", [ticketId])
  }
  const removed = await client.callTool({ name: 'circle_account_remove', arguments: { id: 'reserve' } })
  expect(removed.isError).not.toBe(true)
  expect((await list(client)).value.accounts).toHaveLength(1)
  const history = await f.db.pool.query('select state, record from ci_runs')
  expect(history.rows).toHaveLength(references.length)
  expect(history.rows.every(row => row.state === 'passed' && row.record.collection === 'complete')).toBe(true)
})

it.each(['add', 'remove'] as const)('releases the account registry lock before enriching %s status', async operation => {
  const f = await fixture()
  const owner = await f.issue(['settings:read', 'settings:update'])
  const normal = await f.app()
  await add(await normal.connect(owner.token))
  const entered = deferred()
  const release = deferred()
  const blocked = await f.app({ read: async () => {
    entered.resolve()
    await release.promise
    return { tokenConfigured: false, ready: false, reasons: [], orgs: [] }
  } })
  const client = await blocked.connect(owner.token)
  const mutation = client.callTool({ name: operation === 'add' ? 'circle_account_add' : 'circle_account_remove',
    arguments: operation === 'add' ? { account: { ...reserve, label: 'Renamed' } } : { id: 'reserve' },
  })
  let claim: ReturnType<typeof claimCiSlot> | undefined
  try {
    await entered.promise
    await f.db.pool.query("insert into workspaces(id,record) values('fixture-workspace','{}'::jsonb)")
    const run = CiRunRecordSchema.parse({ id: randomUUID(), workspaceId: 'fixture-workspace', groupId: randomUUID(),
      suite: 'lint', commit: 'a'.repeat(40), repository: 'fixture/source', ciMirror: 'fixture-delta/ci-mirror',
      partition: null, state: 'queued', computer: null, step: null, exitCode: null, message: null,
      queuedAt: new Date().toISOString(), startedAt: null, finishedAt: null,
      initiator: { principalId: owner.principal.id, executionId: null },
    })
    await f.db.pool.query('insert into ci_runs(id,workspace_id,group_id,state,record) values($1,$2,$3,$4,$5)',
      [run.id, run.workspaceId, run.groupId, run.state, JSON.stringify(run)])
    const hostRef = { kind: 'cloud' as const, mainId: 'fixture-main', provider: 'circleci' as const,
      circleAccountId: 'reserve', account: 'fixture-delta', slot: 0 }
    let settled = false
    claim = claimCiSlot(f.db.pool, run, { key: 'fixture-main:cloud:circleci~reserve@fixture-delta:0',
      label: 'Fixture standby', priority: 1, hostRef }, { operation: 'start', runId: run.id,
      repository: run.repository, ciMirror: run.ciMirror, commit: run.commit, suite: run.suite, scope: run.scope,
    }).then(result => { settled = true; return result })
    await expect.poll(() => settled).toBe(true)
    if (operation === 'add') expect(await claim).toMatchObject({ computer: { hostRef } })
    else expect(await claim).toBeNull()
  } finally {
    release.resolve()
    expect((await mutation).isError).not.toBe(true)
    await claim
  }
})

it('refreshes mutation replay status while receipts retain only committed registration metadata', async () => {
  const f = await fixture()
  const owner = await f.issue(['settings:read', 'settings:update'])
  const app = await f.app()
  const client = await app.connect(owner.token)
  const commandId = randomUUID()
  const saved = await add(client, reserve, { commandId })
  const receipts = await f.db.pool.query('select result from management_command_receipts where command_id=$1', [commandId])
  expect(receipts.rows[0].result.value.accounts).toContainEqual(reserve)
  expect(receipts.rows[0].result.value.accounts[0]).not.toHaveProperty('tokenConfigured')
  await f.profile()
  const restarted = await f.app()
  const replay = await add(await restarted.connect(owner.token), reserve, { commandId })
  expect(replay).toMatchObject({ replayed: true, value: { revision: saved.value.revision,
    versionId: saved.value.versionId, value: { accounts: [expect.any(Object),
      expect.objectContaining({ id: 'reserve', tokenConfigured: true })] } } })
})
