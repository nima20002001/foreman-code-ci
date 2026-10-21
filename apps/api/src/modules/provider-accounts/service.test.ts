import { randomUUID } from 'node:crypto'
import { lstat, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ProviderAccountUpdateResultSchema, ProviderAccountsSnapshotSchema,
  ProviderAccountPageSchema, ProviderAccountSchema, ProviderAccountAuthenticationResultSchema,
  ProviderAccountAuthenticationOperationSchema, type ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl, ownedTestPath } from '../../../test/helpers/testResources.js'
import { applyApplicationMigrations } from '../../infrastructure/migrations.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { buildApp } from '../../app.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { LocalProviderCredentials } from './localCredentials.js'
import { NativeProviderAccountCommands, type AccountCommandInvocation } from './nativeCommands.js'
import { ProviderAccountsRepository } from './repository.js'
import { ProviderAccountsService, type ProviderAccountOperationNativePort } from './service.js'
import { providerAccountEnvironment } from './environment.js'

const schema = `provider_accounts_${randomUUID().replaceAll('-', '')}`
let pool: pg.Pool
let admin: pg.Pool
const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  const connectionString = ownedTestDatabaseUrl()
  admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
}, 30_000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})
afterAll(async () => {
  await pool?.end()
  if (admin) {
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
})

async function fixture() {
  const access = new PostgresAccessService(pool)
  const owner = await access.issue({ name: 'Owner', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read',
      'provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
  const reader = await access.issue({ name: 'Reader', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'provider_accounts:read'], scope: {} }] })
  const scoped = await access.issue({ name: 'Scoped', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read', 'settings:update', 'provider_accounts:read',
      'provider_accounts:manage'], scope: { workspaceIds: ['one'] } }] })
  const root = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `accounts-${randomUUID()}`))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const credentials = new LocalProviderCredentials(root)
  const commands = new PostgresCommandCoordinator(pool)
  const statuses = new Map<string, 'signed-in' | 'signed-out' | 'login-pending'>()
  const native: ProviderAccountOperationNativePort = {
    status: vi.fn(async ({ account }) => ({ status: statuses.get(account.id) ?? 'signed-out', identity: null })),
    login: vi.fn(async ({ account }) => { statuses.set(account.id, 'login-pending') }),
    logout: vi.fn(async ({ account }) => { statuses.set(account.id, 'signed-out') }),
    cancelLogin: vi.fn(async accountId => { statuses.delete(accountId) }), close: vi.fn(async () => {}),
    prepareAuthentication: vi.fn<NonNullable<ProviderAccountOperationNativePort['prepareAuthentication']>>(async input => {
      if (input.operation.intent === 'sign-in') await native.login(input)
      else await native.logout(input)
      return { operationId: input.operation.id, binding: input.operation.binding,
        generation: input.operation.generation, sequence: input.operation.nativeSequence + 1,
        state: input.operation.intent === 'sign-in' ? 'awaiting-human' : 'completed',
        nativeClosed: input.operation.intent === 'sign-out' }
    }),
    observeAuthentication: vi.fn<NonNullable<ProviderAccountOperationNativePort['observeAuthentication']>>(async input => ({
      operationId: input.operation.id,
      binding: input.operation.binding, generation: input.operation.generation,
      sequence: input.operation.nativeSequence + 1,
      state: statuses.get(input.account.id) === 'signed-in' ? 'completed' : 'awaiting-human',
      nativeClosed: statuses.get(input.account.id) === 'signed-in' })),
    cancelAuthentication: vi.fn<NonNullable<ProviderAccountOperationNativePort['cancelAuthentication']>>(async input => ({
      operationId: input.operation.id,
      binding: input.operation.binding, generation: input.operation.generation,
      sequence: input.operation.nativeSequence + 1, state: 'canceled', nativeClosed: true })),
  }
  const createService = () => new ProviderAccountsService(pool,
    new ProviderAccountsRepository(pool, () => credentials.hostId()), credentials, native, commands)
  const service = createService()
  const app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    localHuman: { current: async () => owner.principal },
    operator: { access, services: { providerAccounts: service, commands } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => app.close())
  async function connect(token: string) {
    const client = new Client({ name: 'accounts-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    cleanups.push(() => client.close())
    return client
  }
  return { owner, reader, scoped, credentials, native, commands, service, createService, statuses, app, connect }
}

const command = (expectedRevision: number) => ({ expectedRevision, commandId: randomUUID() })
async function add(service: ProviderAccountsService, principal: ManagementPrincipal,
  provider: 'codex' | 'claude', authMode: 'subscription' | 'api-key', expectedRevision = 0) {
  return service.create(principal, 'http', { ...command(expectedRevision), provider, authMode, name: `${provider} account` })
}

it('creates and accepts an account with database target reads on a one-slot pool', async () => {
  const f = await fixture()
  const oneSlot = new pg.Pool({ connectionString: ownedTestDatabaseUrl(), max: 1,
    connectionTimeoutMillis: 1000, options: `-c search_path=${schema}` })
  cleanups.push(() => oneSlot.end())
  const mainId = await f.credentials.hostId()
  const service = new ProviderAccountsService(oneSlot,
    new ProviderAccountsRepository(oneSlot, () => f.credentials.hostId()), f.credentials, f.native,
    new PostgresCommandCoordinator(oneSlot))
  service.bindTarget(async sql => {
    const row = (await sql.query<{ id: string }>('select $1::text as id', [mainId])).rows[0]!
    return { hostRef: { kind: 'main', mainId: row.id }, applicationInstallationId: row.id,
      keyRevision: null, authorizationRevision: null }
  })
  const account = (await add(service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const configuration = { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: account.id }
  const prepared = await service.acceptedBindings.prepare(configuration)
  const conversationId = randomUUID()
  await withTransaction(oneSlot, async client => {
    expect(await service.acceptedBindings.accept(client, 'agent-conversation', conversationId,
      configuration, undefined, { prepared })).toEqual(account.binding)
  })
  expect(await service.runtimeBinding('agent-conversation', conversationId, configuration)).toEqual(account.binding)
})

it('supports the complete authenticated MCP account workflow with PostgreSQL readback after recreation', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const names = (await client.listTools()).tools.map(tool => tool.name)
  expect(names).toContain('provider_account_login')
  const input = { ...command(0), provider: 'codex', authMode: 'subscription', name: 'Personal' }
  const call = async (name: string, arguments_: Record<string, unknown>) =>
    ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({ name, arguments: arguments_ })))
  const created = await call('provider_account_create', input)
  expect(await call('provider_account_create', input)).toEqual({ ...created, replayed: true })
  const first = created.value.accounts[0]!
  const second = await call('provider_account_create', { ...command(1), provider: 'codex', authMode: 'subscription', name: 'Work' })
  const accountId = second.value.accounts[1]!.id
  await call('provider_account_rename', { ...command(2), accountId, name: 'Company' })
  await call('provider_account_default_set', { ...command(3), accountId })
  await call('provider_account_login', { ...command(4), accountId })
  expect(f.native.login).toHaveBeenCalledTimes(1)
  f.statuses.set(accountId, 'signed-in')
  await call('provider_account_refresh', { ...command(5), accountId })
  const read = ProviderAccountsSnapshotSchema.parse(decodeMcpToolResult(await client.callTool({ name: 'provider_accounts_list', arguments: {} })))
  expect(read).toMatchObject({ revision: 6, accounts: [
    { id: first.id, isDefault: false }, { id: accountId, name: 'Company', isDefault: true, status: 'signed-in' },
  ] })
  expect(await f.createService().list(f.reader.principal)).toEqual(read)
  expect((await f.createService().resolve('codex'))?.accountId).toBe(accountId)
  await call('provider_account_logout', { ...command(6), accountId })
  expect((await f.service.list(f.reader.principal)).accounts[1]?.status).toBe('signed-out')
  const audit = await pool.query<{ action: string; outcome: string }>(
    'select action,outcome from management_audit where principal_id=$1', [f.owner.principal.id])
  expect(audit.rows).toContainEqual({ action: 'provider.account.default.set', outcome: 'succeeded' })
})

it('denies guessed MCP writes and scoped reads, HTTP writes and revoked live command replay', async () => {
  const f = await fixture()
  const client = await f.connect(f.reader.token)
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('provider_account_create')
  const input = { ...command(0), provider: 'claude', authMode: 'subscription', name: 'Denied' }
  expect((await client.callTool({ name: 'provider_account_create', arguments: input })).isError).toBe(true)
  const denied = await f.app.inject({ method: 'POST', url: '/api/provider-accounts',
    headers: { authorization: `Bearer ${f.reader.token}` }, payload: input })
  expect(denied.statusCode).toBe(403)
  await expect(f.service.list(f.scoped.principal)).rejects.toMatchObject({ status: 403 })
  const accepted = { ...input, commandId: randomUUID() }
  await f.service.create(f.owner.principal, 'http', accepted)
  await pool.query('update management_principals set grants=$2::jsonb where id=$1',
    [f.owner.principal.id, JSON.stringify(f.reader.principal.grants)])
  await expect(f.service.create(f.owner.principal, 'mcp', accepted)).rejects.toMatchObject({ status: 403 })
  const deniedAudits = await pool.query<{ outcome: string }>(
    'select outcome from management_audit where principal_id=$1', [f.reader.principal.id])
  expect(deniedAudits.rows).toContainEqual({ outcome: 'denied' })
})

it('keeps API keys local and private, rejects bearer provisioning and exposes only metadata through MCP', async () => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'claude', 'api-key')
  const accountId = created.value.accounts[0]!.id
  const apiKey = `sk-test-${randomUUID()}-${randomUUID()}`
  const input = { ...command(1), apiKey }
  const denied = await f.app.inject({ method: 'POST', url: `/api/provider-accounts/${accountId}/api-key`,
    headers: { authorization: `Bearer ${f.owner.token}` }, payload: input })
  expect(denied.statusCode).toBe(403)
  const response = await f.app.inject({ method: 'POST', url: `/api/provider-accounts/${accountId}/api-key`, payload: input })
  expect(response.statusCode).toBe(200)
  expect(response.body).not.toContain(apiKey)
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(apiKey)
  const keyInfo = await lstat(join(f.credentials.paths(accountId).userHome, 'api-key'))
  expect(keyInfo.mode & 0o777).toBe(0o600)
  const client = await f.connect(f.reader.token)
  const result = await client.callTool({ name: 'provider_accounts_list', arguments: {} })
  expect(JSON.stringify(result)).not.toContain(apiKey)
  expect(ProviderAccountsSnapshotSchema.parse(decodeMcpToolResult(result)).accounts[0]?.status).toBe('signed-in')
  const persisted = await pool.query('select to_jsonb(t) as record from application_settings t union all '
    + 'select to_jsonb(t) from application_setting_versions t union all select to_jsonb(t) '
    + 'from management_command_receipts t union all select to_jsonb(t) from management_audit t')
  expect(JSON.stringify(persisted.rows)).not.toContain(apiKey)
})

it('rejects stale revisions, foreign provider selections, missing homes and unsafe symlinks without fallback', async () => {
  const f = await fixture()
  const result = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const accountId = result.value.accounts[0]!.id
  await expect(f.service.rename(f.owner.principal, 'http', accountId, { ...command(0), name: 'Stale' }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  await expect(f.service.resolve('claude', accountId)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_MISMATCH' })
  await expect(f.service.resolve('codex', randomUUID())).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_NOT_FOUND' })
  const foreignRoot = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `foreign-${randomUUID()}`))
  const foreign = new LocalProviderCredentials(foreignRoot)
  const foreignService = new ProviderAccountsService(pool, new ProviderAccountsRepository(pool, () => foreign.hostId()), foreign, f.native, f.commands)
  cleanups.push(() => rm(foreignRoot, { recursive: true, force: true }))
  await expect(foreignService.resolve('codex', accountId)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_NOT_FOUND' })
  const home = f.credentials.paths(accountId).homePath
  await rm(home, { recursive: true })
  await symlink(f.credentials.paths(accountId).userHome, home)
  await expect(f.service.resolve('codex', accountId)).rejects.toMatchObject({ code: 'ACCOUNT_HOME_UNSAFE' })
})

it('restores local key state after a confirmed database rollback', async () => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'claude', 'api-key')
  const accountId = created.value.accounts[0]!.id
  const oldKey = `sk-old-${randomUUID()}`
  await f.service.provisionApiKey(f.owner.principal, accountId, { ...command(1), apiKey: oldKey })
  const repository = new ProviderAccountsRepository(pool, () => f.credentials.hostId())
  vi.spyOn(repository, 'write').mockRejectedValue(new Error('fixture persistence failure'))
  const service = new ProviderAccountsService(pool, repository, f.credentials, f.native, f.commands)
  await expect(service.provisionApiKey(f.owner.principal, accountId,
    { ...command(2), apiKey: `sk-new-${randomUUID()}` })).rejects.toThrow('fixture persistence failure')
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(oldKey)
  expect((await f.service.list(f.reader.principal)).revision).toBe(2)
})

it.each(['save', 'logout'] as const)('serializes %s compensation before a concurrent same-revision key save', async action => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'claude', 'api-key')
  const accountId = created.value.accounts[0]!.id
  await f.service.provisionApiKey(f.owner.principal, accountId,
    { ...command(1), apiKey: `sk-original-${randomUUID()}` })
  const repository = new ProviderAccountsRepository(pool, () => f.credentials.hostId())
  const failingService = new ProviderAccountsService(pool, repository, f.credentials, f.native, f.commands)
  let releaseRestore!: () => void
  let enteredRestore!: () => void
  const restoreEntered = new Promise<void>(resolve => { enteredRestore = resolve })
  const restoreGate = new Promise<void>(resolve => { releaseRestore = resolve })
  vi.spyOn(repository, 'write').mockImplementation(async () => {
    if (action === 'logout') { enteredRestore(); await restoreGate }
    throw new Error('fixture persistence failure')
  })
  const restore = f.credentials.restore.bind(f.credentials)
  vi.spyOn(f.credentials, 'restore').mockImplementation(async backup => {
    enteredRestore()
    await restoreGate
    await restore(backup)
  })
  const mutation = action === 'logout'
    ? failingService.logout(f.owner.principal, 'http', accountId, command(2))
    : failingService.provisionApiKey(f.owner.principal, accountId,
      { ...command(2), apiKey: `sk-failing-${randomUUID()}` })
  const failed = mutation.catch(error => error)
  await restoreEntered
  const committedKey = `sk-committed-${randomUUID()}`
  vi.spyOn(f.credentials, 'saveApiKey')
  const contender = f.service.provisionApiKey(f.owner.principal, accountId,
    { ...command(2), apiKey: committedKey })
  let contenderSettled = false
  const observedContender = contender.finally(() => { contenderSettled = true })
  try {
    await new Promise<void>(resolve => setTimeout(resolve, 100))
    expect(contenderSettled).toBe(false)
    expect(f.credentials.saveApiKey).not.toHaveBeenCalled()
  } finally {
    releaseRestore()
  }
  expect(await failed).toBeInstanceOf(Error)
  if (action === 'logout') expect(f.native.logout).not.toHaveBeenCalled()
  expect((await observedContender).value.revision).toBe(3)
  expect((await f.createService().resolve('claude', accountId))?.apiKey).toBe(committedKey)
  expect((await f.service.list(f.reader.principal)).revision).toBe(3)
})

it('invokes native login/status in the selected home and sanitizes provider output', async () => {
  const mainId = randomUUID()
  const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'claude',
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null }, profileRef: 'qualified-profile', bindingRevision: 1, subject: null }
  const account = { binding, id: binding.accountId, provider: 'claude' as const, name: 'Personal', authMode: 'subscription' as const,
    isDefault: true, status: 'signed-out' as const, identity: null, revision: 1 }
  const invocations: AccountCommandInvocation[] = []
  const native = new NativeProviderAccountCommands({ selected: async input => ({ binding: input.account.binding!,
    binary: '/qualified/provider', profilePath: input.homePath, qualificationId: 'isolation-check', generation: 1,
    isolation: true, status: true, login: true, logout: true }) }, input => {
    invocations.push(input)
    return { completion: Promise.resolve({ code: 0,
      stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', token: 'must-not-escape' }) }),
    stop: async () => {} }
  })
  const input = { account, homePath: '/owned/account/home', userHome: '/owned/account' }
  expect(await native.status(input)).toEqual({ status: 'signed-in', identity: 'user@example.com', subject: null })
  const operation = { id: randomUUID(), commandId: randomUUID(), inputHash: `sha256:${'a'.repeat(64)}`,
    binding, intent: 'sign-in' as const, state: 'reserved' as const, revision: 1, generation: 1, nativeSequence: 0,
    cancelRequested: false, nativeClosed: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: '2099-01-01T00:00:00.000Z', humanActionRequired: true }
  const login = await native.dispatch({ ...input, operation }, 'login', {
    recovery: { root: '/fixture/process-registry', owner: 'fixture-operation', launchId: randomUUID() },
  })
  await login.completion
  expect(invocations[1]?.args).toEqual(['auth', 'login'])
  expect(invocations[1]?.environment.CLAUDE_CONFIG_DIR).toBe(input.homePath)
  expect(invocations[1]?.environment.HOME).toBe(process.env.HOME)
  await native.status({ ...input, account: { ...account, provider: 'codex',
    binding: { ...binding, provider: 'codex' } } })
  expect(invocations[2]?.args).toEqual(['login', 'status'])
  await native.close()
  const environment = providerAccountEnvironment('claude', input.homePath, input.userHome, {
    OPENAI_API_KEY: 'ambient', ANTHROPIC_API_KEY: 'ambient', ANTHROPIC_AUTH_TOKEN: 'ambient',
    CLAUDE_CODE_OAUTH_TOKEN: 'ambient', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'ambient', DISPLAY: ':0',
  })
  expect(Object.keys(environment).filter(key => /API_KEY|TOKEN|BEDROCK|AWS_/.test(key))).toEqual([])
  expect(environment.DISPLAY).toBe(':0')
})

it('reads paginated accounts, registers a qualified profile and removes a default through authenticated MCP and HTTP', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const first = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const accountId = first.value.accounts[0]!.id
  await add(f.service, f.owner.principal, 'codex', 'subscription', 1)
  const page = ProviderAccountPageSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_accounts_page', arguments: { provider: 'codex', limit: 1 },
  })))
  expect(page.accounts).toHaveLength(1)
  expect(page.nextCursor).not.toBeNull()
  const next = await f.service.page(f.reader.principal, { provider: 'codex', limit: 1, cursor: page.nextCursor })
  expect(next.accounts).toHaveLength(1)
  expect(next.accounts[0]!.id).not.toBe(page.accounts[0]!.id)
  const http = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${accountId}`,
    headers: { authorization: `Bearer ${f.reader.token}` } })
  const read = ProviderAccountSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_get', arguments: { accountId },
  })))
  expect(http.statusCode).toBe(200)
  expect(http.json()).toEqual(read)
  f.native.registerProfile = vi.fn(async input => ({ profileRef: input.profileRef }))
  const registered = ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_register', arguments: { ...command(2), provider: 'claude', authMode: 'subscription',
      name: 'Existing profile', profileRef: 'qualified-existing-profile', qualificationId: 'profile-check' },
  })))
  expect(registered.value.accounts.at(-1)?.binding?.profileRef).toBe('qualified-existing-profile')
  const removed = ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_remove', arguments: { ...command(3), accountId },
  })))
  expect(removed.value.accounts.find(account => account.id === accountId)).toMatchObject({ isDefault: false })
  expect(removed.value.defaults?.find(value => value.provider === 'codex')?.accountId).toBeNull()
  expect((await f.createService().get(f.reader.principal, { accountId })).removedAt).toEqual(expect.any(String))
  await expect(f.createService().resolve('codex', accountId)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_UNAVAILABLE' })
  expect((await f.service.page(f.reader.principal, { provider: 'codex' })).accounts.map(account => account.id))
    .not.toContain(accountId)
})

it('prepares, rechecks and cancels one authentication operation through MCP with HTTP persisted readback', async () => {
  const f = await fixture()
  const client = await f.connect(f.owner.token)
  const created = await add(f.service, f.owner.principal, 'claude', 'subscription')
  const accountId = created.value.accounts[0]!.id
  const input = { ...command(1), intent: 'sign-in' }
  const prepared = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_prepare', arguments: { ...input, accountId },
  })))
  expect(prepared.value.state).toBe('awaiting-human')
  const replay = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_prepare', arguments: { ...input, accountId },
  })))
  expect(replay.replayed).toBe(true)
  expect(replay.value.id).toBe(prepared.value.id)
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
  const status = ProviderAccountAuthenticationOperationSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_status', arguments: { operationId: prepared.value.id },
  })))
  const canceled = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_cancel', arguments: { ...command(status.revision), operationId: status.id },
  })))
  expect(canceled.value).toMatchObject({ id: status.id, state: 'canceled', cancelRequested: true, nativeClosed: true })
  const http = await f.app.inject({ method: 'POST', url: '/api/provider-accounts/authentication/status',
    headers: { authorization: `Bearer ${f.reader.token}` }, payload: { operationId: status.id } })
  expect(http.statusCode).toBe(200)
  expect(http.json()).toEqual(canceled.value)
  expect(await f.createService().authenticationStatus(f.reader.principal, { operationId: status.id })).toEqual(canceled.value)
  await expect(f.service.prepareAuthentication(f.owner.principal, 'mcp', accountId,
    { ...input, intent: 'sign-out' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
})

it('audits each denied HTTP and guessed MCP mutation without changing persisted state', async () => {
  const f = await fixture()
  const created = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const accountId = created.value.accounts[0]!.id
  const prepared = await f.service.prepareAuthentication(f.owner.principal, 'http', accountId,
    { ...command(1), intent: 'sign-in' })
  const client = await f.connect(f.reader.token)
  const operations = [
    { tool: 'provider_account_remove', url: `/api/provider-accounts/${accountId}/remove`,
      input: { ...command(2), accountId } },
    { tool: 'provider_account_auth_prepare', url: `/api/provider-accounts/${accountId}/authentication`,
      input: { ...command(2), accountId, intent: 'sign-in' } },
    { tool: 'provider_account_auth_cancel', url: '/api/provider-accounts/authentication/cancel',
      input: { ...command(prepared.value.revision), operationId: prepared.value.id } },
    { tool: 'provider_account_register', url: '/api/provider-accounts/register',
      input: { ...command(2), provider: 'codex', authMode: 'subscription', name: 'Denied',
        profileRef: 'qualified-profile', qualificationId: 'qualified-proof' } },
  ]
  for (const operation of operations) {
    expect((await client.callTool({ name: operation.tool, arguments: operation.input })).isError).toBe(true)
    const payload = Object.fromEntries(Object.entries(operation.input).filter(([key]) => key !== 'accountId'))
    expect((await f.app.inject({ method: 'POST', url: operation.url,
      headers: { authorization: `Bearer ${f.reader.token}` }, payload })).statusCode).toBe(403)
  }
  const audits = await pool.query<{ outcome: string; source: string }>(
    'select outcome,source from management_audit where principal_id=$1', [f.reader.principal.id])
  expect(audits.rows.filter(row => row.outcome === 'denied')).toHaveLength(operations.length * 2)
  for (const source of ['http', 'mcp']) {
    expect(audits.rows.filter(row => row.outcome === 'denied' && row.source === source)).toHaveLength(operations.length)
  }
  expect((await f.service.get(f.reader.principal, { accountId })).removedAt).toBeNull()
})

it('keeps scoped-default CAS independent from label edits and rejects another canonical installation', async () => {
  const f = await fixture()
  const first = await add(f.service, f.owner.principal, 'codex', 'subscription')
  const second = await add(f.service, f.owner.principal, 'codex', 'subscription', 1)
  const accountId = second.value.accounts[1]!.id
  const defaultRevision = second.value.defaults!.find(value => value.provider === 'codex')!.revision
  await f.service.rename(f.owner.principal, 'http', first.value.accounts[0]!.id, { ...command(2), name: 'Renamed' })
  const changed = await f.service.setDefault(f.owner.principal, 'mcp', accountId,
    { ...command(2), expectedDefaultRevision: defaultRevision })
  expect(changed.value.defaults!.find(value => value.provider === 'codex')).toMatchObject({
    accountId, revision: defaultRevision + 1,
  })
  await expect(f.service.setDefault(f.owner.principal, 'http', accountId,
    { ...command(4), expectedDefaultRevision: defaultRevision })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  const target = { ...second.value.accounts[1]!.binding!.target, applicationInstallationId: randomUUID() }
  await expect(f.service.get(f.owner.principal, { accountId, target }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
})

it('detects reliable same-scope duplicates without merging and protects a used principal from replacement', async () => {
  const f = await fixture()
  const first = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const second = (await add(f.service, f.owner.principal, 'codex', 'subscription', 1)).value.accounts[1]!
  let subject: string | null = 'qualified-provider-subject'
  let sequence = 0
  f.native.observeAccount = async input => ({ bindingRevision: input.account.binding!.bindingRevision,
    generation: 1, sequence: ++sequence, observedAt: new Date().toISOString(), status: 'signed-in',
    identity: 'display@example.test', readiness: 'ready', subject: subject ? { subject,
      provenance: 'qualified-native', qualificationId: 'native-identity-check', observedAt: new Date().toISOString() } : null })
  const observedFirst = await f.service.refresh(f.owner.principal, 'http', first.id, command(2))
  const observedSecond = await f.service.refresh(f.owner.principal, 'mcp', second.id, command(3))
  expect(observedSecond.value.accounts[1]!.possibleDuplicateAccountIds).toEqual([first.id])
  expect(observedSecond.value.accounts).toHaveLength(2)
  expect(observedSecond.value.accounts[1]!.binding!.profileRef).not.toBe(observedFirst.value.accounts[0]!.binding!.profileRef)
  const third = (await add(f.service, f.owner.principal, 'codex', 'subscription', 4)).value.accounts[2]!
  subject = null
  const emailOnly = await f.service.refresh(f.owner.principal, 'http', third.id, command(5))
  expect(emailOnly.value.accounts[2]!.binding!.subject).toBeNull()
  expect(emailOnly.value.accounts[2]!.possibleDuplicateAccountIds).toEqual([])
  await withTransaction(pool, async sql => {
    const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
    await f.service.acceptedBindings.accept(sql, 'run-node', `accepted:${randomUUID()}`,
      { ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: first.id })
  })
  subject = 'different-provider-subject'
  await expect(f.service.refresh(f.owner.principal, 'http', first.id, command(6)))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_PRINCIPAL_LOCKED' })
  await expect(f.service.prepareAuthentication(f.owner.principal, 'mcp', first.id,
    { ...command(6), intent: 'sign-in' })).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_PRINCIPAL_LOCKED' })
  expect(await f.service.get(f.reader.principal, { accountId: first.id }))
    .toMatchObject({ status: 'unavailable', observation: { subject: null, readiness: 'unavailable' } })
  subject = 'qualified-provider-subject'
  expect((await f.createService().get(f.reader.principal, { accountId: first.id })).observation!.subject!.subject)
    .toBe('qualified-provider-subject')
})

it('returns distinct account-scoped models and rejects unqualified or mismatched catalogs without fallback', async () => {
  const f = await fixture()
  const first = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const second = (await add(f.service, f.owner.principal, 'codex', 'subscription', 1)).value.accounts[1]!
  f.native.models = async input => ({ binding: input.account.binding!, generation: 1,
    observedAt: new Date().toISOString(), models: input.account.id === first.id ? [{ id: 'model-a', name: 'Model A', reasoningEfforts: [], variants: [], serviceTiers: [] }] : [] })
  const client = await f.connect(f.reader.token)
  const { ProviderAccountModelsSchema } = await import('@foreman-code/contracts/provider-accounts')
  const models = ProviderAccountModelsSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_models', arguments: { accountId: first.id },
  })))
  expect(models.models.map(model => model.id)).toEqual(['model-a'])
  const http = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${second.id}/models`,
    headers: { authorization: `Bearer ${f.reader.token}` } })
  expect(http.statusCode).toBe(200)
  expect(ProviderAccountModelsSchema.parse(http.json()).models).toEqual([])
  f.native.models = async () => ({ ...models, binding: second.binding! })
  await expect(f.service.models(f.reader.principal, { accountId: first.id }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_CONFLICT' })
})

it('enforces target restrictions at every delegation link through authenticated HTTP and MCP', async () => {
  const f = await fixture()
  const first = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const second = (await add(f.service, f.owner.principal, 'codex', 'subscription', 1)).value.accounts[1]!
  const access = new PostgresAccessService(pool)
  const parent = await access.issue({ name: 'Scoped account owner', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: { providerAccountIds: [first.id] } }] })
  const child = await access.issue({ name: 'Delegated account caller', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
  await pool.query('update management_principals set delegated_from=$2 where id=$1', [child.principal.id, parent.principal.id])
  const client = await f.connect(child.token)
  const permitted = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${first.id}`,
    headers: { authorization: `Bearer ${child.token}` } })
  expect(permitted.statusCode).toBe(200)
  expect(permitted.json().id).toBe(first.id)
  const denied = await f.app.inject({ method: 'POST', url: `/api/provider-accounts/${second.id}/remove`,
    headers: { authorization: `Bearer ${child.token}` }, payload: command(2) })
  expect(denied.statusCode).toBe(403)
  expect((await client.callTool({ name: 'provider_account_remove', arguments: { ...command(2), accountId: second.id } })).isError)
    .toBe(true)
  expect((await f.createService().get(f.reader.principal, { accountId: second.id })).removedAt).toBeNull()
  const audits = await pool.query<{ outcome: string }>(
    'select outcome from management_audit where principal_id=$1', [child.principal.id])
  expect(audits.rows.filter(row => row.outcome === 'denied')).toHaveLength(2)
})

it('does not adopt prior slot records after an application reinstall even when the native root is unchanged', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const otherMain = randomUUID()
  const recreated = f.createService()
  recreated.bindTarget(async () => ({ hostRef: { kind: 'main', mainId: otherMain },
    applicationInstallationId: otherMain, keyRevision: null, authorizationRevision: null }))
  await expect(recreated.get(f.owner.principal, { accountId: account.id }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
  await expect(recreated.resolve('codex', account.id)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
  expect((await f.createService().get(f.owner.principal, { accountId: account.id })).binding).toEqual(account.binding)
})

it('discovers qualified actions and profiles, fresh persisted observations and original operations over authenticated MCP', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const target = account.binding!.target
  let sequence = 0
  f.native.discover = async () => ({ generation: 7,
    providers: [{ provider: 'codex', qualified: true, actions: ['register', 'status', 'models', 'sign-in', 'cancel', 'human-handoff'], reason: null }],
    profiles: [{ profileRef: 'qualified-existing', qualificationId: 'storage-proof', provider: 'codex',
      authMode: 'subscription', label: 'Existing CLI profile' }] })
  f.native.observeAccount = async () => ({ bindingRevision: 1, generation: 7, sequence: ++sequence,
    observedAt: new Date().toISOString(), status: 'signed-in', identity: null, subject: null, readiness: 'unknown' })
  const client = await f.connect(f.owner.token)
  const contracts = await import('@foreman-code/contracts/provider-accounts')
  const read = async (name: string, arguments_: Record<string, unknown>) =>
    decodeMcpToolResult(await client.callTool({ name, arguments: arguments_ }))
  const targets = contracts.ProviderAccountTargetsSchema.parse(await read('provider_account_targets', {}))
  expect(targets.targets).toEqual([{ target, label: 'Main', generation: 7, connected: true,
    canRead: true, canManage: true, providers: (await f.native.discover(target)).providers }])
  const profiles = contracts.ProviderAccountProfilesSchema.parse(await read('provider_account_profiles', { target, provider: 'codex' }))
  expect(profiles.profiles[0]).toEqual({ profileRef: 'qualified-existing', qualificationId: 'storage-proof',
    provider: 'codex', authMode: 'subscription', label: 'Existing CLI profile' })
  const page = contracts.ProviderAccountPageSchema.parse(await read('provider_accounts_page', { target }))
  expect(page.target).toEqual(target)
  expect(page.accounts[0]!.observation).toMatchObject({ generation: 7, sequence: 1, status: 'signed-in', readiness: 'unknown' })
  const readback = await f.createService().get(f.reader.principal, { target, accountId: account.id })
  expect(readback.observation!.sequence).toBe(2)
  expect(readback.revision).toBe(account.revision)
  const encoded = new URLSearchParams({ target: JSON.stringify(target), includeRemoved: 'false', limit: '1' })
  const http = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/page?${encoded}`,
    headers: { authorization: `Bearer ${f.reader.token}` } })
  expect(http.statusCode).toBe(200)
  expect(contracts.ProviderAccountPageSchema.parse(http.json()).accounts[0]!.observation!.sequence).toBe(3)
  const bad = await f.app.inject({ method: 'GET', url: '/api/provider-accounts/page?target=invalid',
    headers: { authorization: `Bearer ${f.reader.token}` } })
  expect(bad.statusCode).toBe(400)
  const operation = contracts.ProviderAccountAuthenticationResultSchema.parse(await read('provider_account_auth_prepare',
    { ...command(1), accountId: account.id, target, intent: 'sign-in' })).value
  const operations = contracts.ProviderAccountAuthenticationPageSchema.parse(await read('provider_account_auth_list',
    { accountId: account.id, target, limit: 1 }))
  expect(operations.operations).toEqual([operation])
  expect((await f.createService().authenticationList(f.reader.principal, { accountId: account.id, target })).operations)
    .toEqual([operation])
  const eligibility = contracts.ProviderAccountEligibilitySchema.parse(await read('provider_account_eligibility',
    { accountId: account.id, target }))
  expect(eligibility).toMatchObject({ canManage: true, canReauthenticate: false })
  expect(f.native.login).toHaveBeenCalledTimes(1)

  const access = new PostgresAccessService(pool)
  const denied = await access.issue({ name: 'No account access', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read'], scope: {} }] })
  const deniedClient = await f.connect(denied.token)
  for (const [name, arguments_] of [
    ['provider_account_targets', {}], ['provider_account_profiles', { target }],
    ['provider_account_eligibility', { accountId: account.id, target }],
    ['provider_account_auth_list', { accountId: account.id, target }],
    ['provider_accounts_page', { target }], ['provider_account_get', { accountId: account.id, target }],
  ] as const) {
    expect((await deniedClient.callTool({ name, arguments: arguments_ })).isError).toBe(true)
  }
  expect((await f.createService().authenticationList(f.reader.principal, { accountId: account.id })).operations)
    .toEqual([operation])
})

it('returns full selected-account model metadata through HTTP/MCP and limits no-store handoff to a local human', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const model = { id: 'selected-model', name: 'Selected model', reasoningEfforts: ['low', 'high'],
    variants: ['fast'], serviceTiers: ['standard', 'priority'], releasedAt: '2026-01-01', defaultPriority: 2 }
  f.native.models = async value => ({ binding: value.account.binding!, generation: 1,
    observedAt: '2026-01-01T00:00:00.000Z', models: [model], options: { harness: 'codex', providerVersion: 'installed-release',
      authenticated: true, models: [model], nativeAgents: [], settings: [], restrictions: [], checkedAt: '2026-01-01T00:00:00.000Z' } })
  f.native.humanHandoff = async value => ({ operationId: value.operation.id, kind: 'local-browser',
    expiresAt: value.operation.expiresAt, message: 'Complete sign-in in the local provider browser.' })
  const client = await f.connect(f.owner.token)
  const contracts = await import('@foreman-code/contracts/provider-accounts')
  const models = contracts.ProviderAccountModelsSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_models', arguments: { accountId: account.id },
  })))
  expect(models.models).toEqual([model])
  expect(models.options!.models).toEqual([model])
  const encoded = new URLSearchParams({ target: JSON.stringify(account.binding!.target) })
  const http = await f.app.inject({ method: 'GET', url: `/api/provider-accounts/${account.id}/models?${encoded}`,
    headers: { authorization: `Bearer ${f.reader.token}` } })
  expect(http.statusCode).toBe(200)
  expect(contracts.ProviderAccountModelsSchema.parse(http.json())).toEqual(models)
  const operation = (await f.service.prepareAuthentication(f.owner.principal, 'http', account.id,
    { ...command(1), intent: 'sign-in' })).value
  const denied = await f.app.inject({ method: 'POST', url: '/api/provider-accounts/authentication/handoff',
    headers: { authorization: `Bearer ${f.owner.token}` }, payload: { operationId: operation.id } })
  expect(denied.statusCode).toBe(403)
  expect(denied.headers['cache-control']).toBe('no-store, private')
  const human = await f.app.inject({ method: 'POST', url: '/api/provider-accounts/authentication/handoff',
    payload: { operationId: operation.id } })
  expect(human.statusCode).toBe(200)
  expect(human.headers['cache-control']).toBe('no-store, private')
  expect(contracts.ProviderAccountHumanHandoffSchema.parse(human.json()).operationId).toBe(operation.id)
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain('provider_account_handoff')
  const persisted = await f.createService().authenticationList(f.reader.principal, { accountId: account.id })
  expect(persisted.operations).toEqual([operation])
  expect(JSON.stringify(persisted)).not.toContain('Complete sign-in')
  const access = new PostgresAccessService(pool)
  const deniedReader = await access.issue({ name: 'No model access', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['settings:read'], scope: {} }] })
  const blocked = await f.connect(deniedReader.token)
  expect((await blocked.callTool({ name: 'provider_account_models', arguments: { accountId: account.id } })).isError).toBe(true)
})

it('does not persist or publish a page observation after authority is revoked during the native read', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  let finish!: () => void
  const wait = new Promise<void>(resolve => { finish = resolve })
  f.native.observeAccount = async () => {
    entered()
    await wait
    return { bindingRevision: 1, generation: 1, sequence: 900, observedAt: new Date().toISOString(),
      status: 'signed-in', readiness: 'unknown', identity: null, subject: null }
  }
  const client = await f.connect(f.owner.token)
  const pending = client.callTool({ name: 'provider_accounts_page', arguments: {} })
  await started
  await pool.query('update management_principals set revoked_at=now() where id=$1', [f.owner.principal.id])
  finish()
  expect((await pending).isError).toBe(true)
  f.native.observeAccount = async () => ({ bindingRevision: 1, generation: 1, sequence: 1,
    observedAt: new Date().toISOString(), status: 'signed-out', readiness: 'sign-in-required', identity: null, subject: null })
  const readback = await f.createService().get(f.reader.principal, { accountId: account.id })
  expect(readback.observation!.sequence).toBe(1)
  expect(readback.status).toBe('signed-out')
})

it('allows account-only grants to discover and persist accounts through authenticated MCP without settings access', async () => {
  const f = await fixture()
  const issued = await new PostgresAccessService(pool).issue({ name: 'Account manager', audience: 'operator',
    expiresAt: new Date('2099-01-01'), grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
  const client = await f.connect(issued.token)
  const created = ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_create', arguments: { ...command(0), provider: 'codex', authMode: 'subscription', name: 'Managed slot' },
  })))
  const account = created.value.accounts[0]!
  const response = await client.callTool({ name: 'provider_account_get', arguments: { accountId: account.id } })
  expect(ProviderAccountSchema.parse(decodeMcpToolResult(response)).binding).toEqual(account.binding)
  expect((await f.createService().get(issued.principal, { accountId: account.id })).name).toBe('Managed slot')
})

it('rejects forged original authentication intent or expiry before granting Worker native authority', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const prepared = await f.service.prepareAuthentication(f.owner.principal, 'mcp', account.id,
    { ...command(1), intent: 'sign-in' })
  await f.service.assertAuthenticationEligibility(prepared.value)
  await expect(f.service.assertAuthenticationEligibility({ ...prepared.value, intent: 'sign-out' }))
    .rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_STALE' })
  await expect(f.service.assertAuthenticationEligibility({ ...prepared.value, expiresAt: '2099-01-01T00:00:00.000Z' }))
    .rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_STALE' })
  expect((await f.createService().authenticationList(f.reader.principal, { accountId: account.id })).operations)
    .toEqual([prepared.value])
  const client = await f.connect(f.owner.token)
  const canceled = ProviderAccountAuthenticationResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_auth_cancel', arguments: { ...command(prepared.value.revision), operationId: prepared.value.id },
  })))
  expect(canceled.value).toMatchObject({ state: 'canceled', nativeClosed: true })
  await expect(f.service.assertAuthenticationEligibility(prepared.value))
    .rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_CLOSED' })
  expect((await f.createService().authenticationList(f.reader.principal, { accountId: account.id })).operations)
    .toEqual([canceled.value])
  expect(f.native.login).toHaveBeenCalledTimes(1)
})

it('clears current identity on failed observations without replacing persisted subject evidence', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  const { DomainError } = await import('../errors.js')
  f.native.observeAccount = async () => ({ bindingRevision: 1, generation: 1, sequence: 1,
    observedAt: '2026-01-01T00:00:00.000Z', status: 'signed-in', identity: 'account@example.invalid',
    subject: { subject: 'native-subject', provenance: 'qualified-native', qualificationId: 'storage-proof',
      observedAt: '2026-01-01T00:00:00.000Z' }, readiness: 'unknown' })
  await f.service.get(f.reader.principal, { accountId: account.id })
  f.native.observeAccount = async () => { throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'Isolation evidence expired.', 409) }
  const client = await f.connect(f.reader.token)
  const unavailable = ProviderAccountSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_get', arguments: { accountId: account.id },
  })))
  expect(unavailable).toMatchObject({ status: 'unavailable', identity: null,
    observation: { subject: null, identity: null, readiness: 'qualification-required' } })
  delete f.native.observeAccount
  const readback = await f.createService().get(f.reader.principal, { accountId: account.id })
  expect(readback.observation!.subject!.subject).toBe('native-subject')
})

it('returns the latest persisted observation when a slower native read follows a refresh', async () => {
  const f = await fixture()
  const account = (await add(f.service, f.owner.principal, 'codex', 'subscription')).value.accounts[0]!
  let sequence = 20
  f.native.observeAccount = async () => ({ bindingRevision: 1, generation: 1, sequence,
    observedAt: '2026-01-01T00:00:00.000Z', status: 'signed-in', identity: null, subject: null, readiness: 'unknown' })
  const client = await f.connect(f.owner.token)
  const refreshed = ProviderAccountUpdateResultSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_refresh', arguments: { ...command(1), accountId: account.id },
  })))
  expect(refreshed.value.accounts[0]!.observation!.sequence).toBe(20)
  sequence = 10
  const readback = ProviderAccountSchema.parse(decodeMcpToolResult(await client.callTool({
    name: 'provider_account_get', arguments: { accountId: account.id },
  })))
  expect(readback.observation!.sequence).toBe(20)
  expect((await f.createService().get(f.reader.principal, { accountId: account.id })).observation!.sequence).toBe(20)
})

it('routes the complete authenticated MCP Worker lifecycle to its owning slot and preserves receipts across service recreation', async () => {
  const f = await fixture()
  const { createRemoteAccountServices } = await import('./remoteServices.js')
  const { createProviderAccountWorkerExtension } = await import('./workerOperations.js')
  const { ProviderAccountTargetsSchema, ProviderAccountModelsSchema, ProviderAccountAuthenticationPageSchema } =
    await import('@foreman-code/contracts/provider-accounts')
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
  await pool.query('insert into application_installation values(true,$1) on conflict(singleton) do update set id=excluded.id',
    [connection.mainId])
  const registration = { mainId: connection.mainId, deviceId: connection.deviceId,
    workerInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  await pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)',
    [connection.deviceId, connection.mainId, connection.workerInstallationId, 'fixture-public-key', JSON.stringify(registration)])
  const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
    applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const slots = new Map<string, import('@foreman-code/contracts/provider-accounts').ProviderAccount>()
  let online = true
  let current = connection
  let launches = 0
  let observationSequence = 0
  const operation = async (value: { operation: import('@foreman-code/contracts/provider-accounts').ProviderAccountAuthenticationOperation }) => ({
    operationId: value.operation.id, binding: value.operation.binding, generation: value.operation.generation,
    sequence: value.operation.nativeSequence + 1, state: 'awaiting-human' as const, nativeClosed: false,
  })
  const extension = createProviderAccountWorkerExtension({ current: () => current, authorize: async () => {},
    provision: async account => { slots.set(account.id, account); return account },
    resolve: async binding => {
      const account = slots.get(binding.accountId)
      if (!account) throw new Error('The owning Worker slot is missing')
      return { account, homePath: '/fixture/native-profile', userHome: '/fixture/native-context' }
    },
    native: { status: async () => ({ status: 'signed-out', identity: null }), login: async () => {}, logout: async () => {},
      cancelLogin: async () => {}, close: async () => {},
      discover: async () => ({ generation: current.connectionGeneration,
        providers: [{ provider: 'codex', qualified: true, actions: ['create', 'register', 'status', 'models', 'sign-in', 'cancel'], reason: null }],
        profiles: [{ profileRef: 'worker-existing-profile', qualificationId: 'worker-storage-proof', provider: 'codex',
          authMode: 'subscription', label: 'Worker profile' }] }),
      registerProfile: async value => ({ profileRef: value.profileRef }),
      observeAccount: async () => ({ bindingRevision: 1, generation: current.connectionGeneration, sequence: ++observationSequence,
        observedAt: new Date().toISOString(), status: 'signed-out', identity: null, subject: null, readiness: 'sign-in-required' }),
      models: async value => ({ binding: value.account.binding!, generation: current.connectionGeneration,
        observedAt: new Date().toISOString(), models: [{ id: 'worker-model', name: 'Worker model',
          reasoningEfforts: ['high'], variants: [], serviceTiers: ['standard'] }] }),
      prepareAuthentication: async value => { launches++; return operation(value) }, observeAuthentication: operation,
      cancelAuthentication: async value => ({ ...await operation(value), state: 'canceled', nativeClosed: true }),
    } })
  const endpoint = { captureRequest: (id: string) => online && id === current.deviceId ? { binding: current,
    request: (payload: unknown) => extension.handle!(payload, { binding: current, signal: new AbortController().signal }) } : undefined,
    currentBinding: () => current, capabilities: () => [] }
  const route = (service: ProviderAccountsService) => {
    service.bindRouting(createRemoteAccountServices({ pool, commands: f.commands, local: service, endpoint: () => endpoint }))
    return service
  }
  route(f.service)
  const client = await f.connect(f.owner.token)
  const call = async (name: string, arguments_: Record<string, unknown>) =>
    decodeMcpToolResult(await client.callTool({ name, arguments: arguments_ }))
  expect(ProviderAccountTargetsSchema.parse(await call('provider_account_targets', {})).targets)
    .toContainEqual(expect.objectContaining({ target, connected: true, canManage: true }))
  const created = ProviderAccountUpdateResultSchema.parse(await call('provider_account_create',
    { ...command(0), target, provider: 'codex', authMode: 'subscription', name: 'Remote slot' }))
  const account = created.value.accounts[0]!
  expect(slots.get(account.id)!.binding).toEqual(account.binding)
  const unsupported = await client.callTool({ name: 'provider_account_create', arguments: {
    ...command(1), target, provider: 'claude', authMode: 'api-key', name: 'Unsupported remote key',
  } })
  expect(unsupported.isError).toBe(true)
  const unchanged = ProviderAccountPageSchema.parse(await call('provider_accounts_page', { target }))
  expect(unchanged.revision).toBe(created.value.revision)
  expect(unchanged.accounts.map(value => value.id)).toEqual([account.id])
  const access = new PostgresAccessService(pool)
  const accountReader = await access.issue({ name: 'Worker slot reader', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read'], scope: { mainIds: [connection.mainId], deviceIds: [connection.deviceId],
      applicationInstallationIds: [connection.workerInstallationId], providerAccountIds: [account.id] } }] })
  const scopedClient = await f.connect(accountReader.token)
  expect(ProviderAccountSchema.parse(decodeMcpToolResult(await scopedClient.callTool({
    name: 'provider_account_get', arguments: { accountId: account.id, target },
  }))).binding).toEqual(account.binding)
  const scopedHttp = await f.app.inject({ method: 'GET',
    url: `/api/provider-accounts/${account.id}?${new URLSearchParams({ target: JSON.stringify(target) })}`,
    headers: { authorization: `Bearer ${accountReader.token}` } })
  expect(scopedHttp.statusCode).toBe(200)
  expect(ProviderAccountSchema.parse(scopedHttp.json()).id).toBe(account.id)
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
  await expect(f.service.acceptedBindings.prepare({ ...DEFAULT_HARNESS_DEFAULTS.codex, accountId: account.id }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_SIGN_IN_REQUIRED' })
  expect(ProviderAccountPageSchema.parse(await call('provider_accounts_page', { target })).target).toEqual(target)
  expect(ProviderAccountModelsSchema.parse(await call('provider_account_models', { accountId: account.id, target })).models[0]!)
    .toEqual({ id: 'worker-model', name: 'Worker model', reasoningEfforts: ['high'], variants: [], serviceTiers: ['standard'] })
  const prepared = ProviderAccountAuthenticationResultSchema.parse(await call('provider_account_auth_prepare',
    { ...command(1), target, accountId: account.id, intent: 'sign-in' }))
  const readback = route(f.createService())
  expect((await readback.authenticationList(f.reader.principal, { target, accountId: account.id })).operations)
    .toEqual([prepared.value])
  online = false
  expect(ProviderAccountAuthenticationPageSchema.parse(await call('provider_account_auth_list', { target, accountId: account.id })).operations)
    .toEqual([prepared.value])
  online = true
  current = { ...current, connectionGeneration: 2, connectionEpoch: randomUUID(), bootId: randomUUID() }
  const status = ProviderAccountAuthenticationOperationSchema.parse(await call('provider_account_auth_status',
    { target, operationId: prepared.value.id }))
  expect(status.id).toBe(prepared.value.id)
  expect(status.generation).toBe(1)
  expect(launches).toBe(1)
  const denied = await f.connect(f.reader.token)
  for (const [name, arguments_] of [
    ['provider_account_create', { ...command(2), target, provider: 'codex', authMode: 'subscription', name: 'Denied remote slot' }],
    ['provider_account_register', { ...command(2), target, provider: 'codex', authMode: 'subscription', name: 'Denied profile',
      profileRef: 'worker-existing-profile', qualificationId: 'worker-storage-proof' }],
    ['provider_account_auth_prepare', { ...command(2), accountId: account.id, target }],
    ['provider_account_auth_cancel', { ...command(status.revision), target, operationId: status.id }],
    ['provider_account_remove', { ...command(2), target, accountId: account.id }],
  ] as const) expect((await denied.callTool({ name, arguments: arguments_ })).isError).toBe(true)
  expect(launches).toBe(1)
  const excluded = await access.issue({ name: 'Other device account reader', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read'], scope: { deviceIds: [randomUUID()] } }] })
  const excludedClient = await f.connect(excluded.token)
  expect(ProviderAccountTargetsSchema.parse(decodeMcpToolResult(await excludedClient.callTool({
    name: 'provider_account_targets', arguments: {},
  }))).targets).toEqual([])
  for (const name of ['provider_accounts_page', 'provider_account_get', 'provider_account_models', 'provider_account_auth_list']) {
    const arguments_ = name === 'provider_accounts_page' ? { target } : { target, accountId: account.id }
    expect((await excludedClient.callTool({ name, arguments: arguments_ })).isError).toBe(true)
  }
  const canceled = ProviderAccountAuthenticationResultSchema.parse(await call('provider_account_auth_cancel',
    { ...command(status.revision), target, operationId: status.id }))
  expect(canceled.value).toMatchObject({ id: status.id, nativeClosed: true, state: 'canceled' })
  const registered = ProviderAccountUpdateResultSchema.parse(await call('provider_account_register', {
    ...command(2), target, provider: 'codex', authMode: 'subscription', name: 'Existing remote profile',
    profileRef: 'worker-existing-profile', qualificationId: 'worker-storage-proof',
  }))
  expect(slots.get(registered.value.accounts[1]!.id)!.binding!.profileRef).toBe('worker-existing-profile')
  const removed = ProviderAccountUpdateResultSchema.parse(await call('provider_account_remove', { ...command(3), target, accountId: account.id }))
  expect(removed.value.accounts[0]!.removedAt).not.toBeNull()
  expect((await route(f.createService()).get(f.reader.principal, { target, accountId: account.id })).removedAt)
    .toBe(removed.value.accounts[0]!.removedAt)
  current = { ...current, workerInstallationId: randomUUID(), connectionGeneration: 3 }
  expect((await client.callTool({ name: 'provider_account_models', arguments: { target, accountId: registered.value.accounts[1]!.id } })).isError)
    .toBe(true)
  expect(launches).toBe(1)
})
