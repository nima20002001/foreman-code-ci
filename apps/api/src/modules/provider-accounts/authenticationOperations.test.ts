import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl, ownedTestPath } from '../../../test/helpers/testResources.js'
import { applyApplicationMigrations } from '../../infrastructure/migrations.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { LocalProviderCredentials } from './localCredentials.js'
import { ProviderAccountsRepository } from './repository.js'
import { ProviderAccountsService, type ProviderAccountOperationNativePort } from './service.js'
import type { ProviderAccountNativeAuthenticationObservation,
  ProviderAccountObservation } from '@foreman-code/contracts/provider-accounts'

const schema = `account_operations_${randomUUID().replaceAll('-', '')}`
let admin: pg.Pool
let pool: pg.Pool
const roots: string[] = []
beforeAll(async () => {
  const connectionString = ownedTestDatabaseUrl()
  admin = new pg.Pool({ connectionString })
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, max: 6, options: `-c search_path=${schema}` })
  await applyApplicationMigrations(pool)
}, 30_000)
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
afterAll(async () => { await pool?.end(); await dropFixtureSchema(admin, schema); await admin.end() })
const command = (expectedRevision: number) => ({ commandId: randomUUID(), expectedRevision })

async function fixture() {
  const access = new PostgresAccessService(pool)
  const owner = await access.issue({ name: 'Account operator', audience: 'operator', expiresAt: new Date('2099-01-01'),
    grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }] })
  const root = ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `operation-${randomUUID()}`))
  roots.push(root)
  const credentials = new LocalProviderCredentials(root)
  let state: ProviderAccountNativeAuthenticationObservation['state'] = 'awaiting-human'
  let closed = false
  const observed: NonNullable<ProviderAccountOperationNativePort['observeAuthentication']> = async input => ({
    operationId: input.operation.id, binding: input.operation.binding, generation: input.operation.generation,
    sequence: input.operation.nativeSequence + 1, state, nativeClosed: closed,
  })
  const native: ProviderAccountOperationNativePort = {
    status: vi.fn<ProviderAccountOperationNativePort['status']>(async () => ({ status: 'signed-out', identity: null })),
    login: vi.fn(async () => {}), logout: vi.fn(async () => {}), cancelLogin: vi.fn(async () => {}),
    close: vi.fn(async () => {}), prepareAuthentication: vi.fn(observed), observeAuthentication: vi.fn(observed),
    cancelAuthentication: vi.fn(observed),
  }
  const createService = () => new ProviderAccountsService(pool, new ProviderAccountsRepository(pool,
    () => credentials.hostId()), credentials, native, new PostgresCommandCoordinator(pool))
  const service = createService()
  const account = (await service.create(owner.principal, 'http', { ...command(0), provider: 'codex',
    authMode: 'subscription', name: 'First' })).value.accounts[0]!
  return { owner, account, service, createService, native, setState(value: typeof state, nativeClosed = false) {
    state = value; closed = nativeClosed
  } }
}

it('retains the original command after lost acknowledgement and excludes a second same-slot operation', async () => {
  const f = await fixture()
  const input = { ...command(1), intent: 'sign-in' }
  const first = await f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, input)
  const replay = await f.createService().prepareAuthentication(f.owner.principal, 'mcp', f.account.id, input)
  expect(replay).toMatchObject({ replayed: true, value: { id: first.value.id, inputHash: first.value.inputHash } })
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
  await expect(f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id,
    { ...command(2), intent: 'sign-in' })).rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_PENDING' })
  await expect(f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id,
    { ...input, intent: 'sign-out' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
})

it.each([false, true])(
  'commits reservations before a native wait and permits a separate slot to progress (observations: %s)',
  async observations => {
  const f = await fixture()
  if (observations) {
    f.native.observeAccount = vi.fn(async (): Promise<ProviderAccountObservation> => ({
      bindingRevision: 1, generation: 1, sequence: 1,
      observedAt: new Date().toISOString(), status: 'signed-out', identity: null, subject: null,
      readiness: 'sign-in-required' }))
  }
  let release!: () => void
  let entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const observe = f.native.observeAuthentication!
  f.native.prepareAuthentication = vi.fn(async input => {
    if (input.account.id === f.account.id) { entered(); await blocked }
    return observe(input)
  })
  const first = f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, { ...command(1), intent: 'sign-in' })
  try {
    await started
    const other = (await f.service.create(f.owner.principal, 'http', { ...command(2), provider: 'codex',
      authMode: 'subscription', name: 'Second' })).value.accounts[1]!
    const second = await f.service.prepareAuthentication(f.owner.principal, 'mcp', other.id, { ...command(3), intent: 'sign-in' })
    expect(second.value.binding.accountId).toBe(other.id)
    expect((await f.createService().get(f.owner.principal, { accountId: f.account.id })).status).toBe('login-pending')
    expect(f.native.status).not.toHaveBeenCalled()
    if (f.native.observeAccount) expect(f.native.observeAccount).not.toHaveBeenCalled()
  } finally { release() }
  const prepared = (await first).value
  expect(prepared.binding.accountId).toBe(f.account.id)
  f.setState('canceled', true)
  await f.service.cancelAuthentication(f.owner.principal, 'http', {
    ...command(prepared.revision), operationId: prepared.id,
  })
  expect((await f.createService().get(f.owner.principal, { accountId: f.account.id })).status).toBe('signed-out')
})

it('keeps an uncertain native dispatch reserved across service restart without retrying login', async () => {
  const f = await fixture()
  f.native.prepareAuthentication = vi.fn(async () => { throw new DomainError('ACK_LOST', 'Unknown native outcome.', 409) })
  const input = { ...command(1), intent: 'sign-in' }
  const first = await f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, input)
  expect(first.value.state).toBe('outcome-unknown')
  f.setState('outcome-unknown')
  const replay = await f.createService().prepareAuthentication(f.owner.principal, 'http', f.account.id, input)
  expect(replay.value.id).toBe(first.value.id)
  expect(replay.value.nativeClosed).toBe(false)
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
})

it('distinguishes cancel intent from closure and rejects stale or wrong-generation observations', async () => {
  const f = await fixture()
  const prepared = await f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, { ...command(1), intent: 'sign-in' })
  f.setState('outcome-unknown')
  const canceled = await f.service.cancelAuthentication(f.owner.principal, 'mcp', {
    ...command(prepared.value.revision), operationId: prepared.value.id,
  })
  expect(canceled.value).toMatchObject({ cancelRequested: true, nativeClosed: false, state: 'outcome-unknown' })
  f.setState('completed', true)
  const settled = await f.createService().authenticationStatus(f.owner.principal, { operationId: prepared.value.id })
  expect(settled).toMatchObject({ id: prepared.value.id, state: 'canceled', nativeClosed: true })
  expect((await f.service.get(f.owner.principal, { accountId: f.account.id })).isDefault).toBe(true)
  const fresh = await f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, { ...command(2), intent: 'sign-in' })
  f.native.observeAuthentication = async input => ({ operationId: input.operation.id, binding: input.operation.binding,
    generation: input.operation.generation + 1, sequence: input.operation.nativeSequence + 1,
    state: 'completed', nativeClosed: true })
  // Re-open an uncertain slot for the stale-result check using a distinct fresh account.
  const other = (await f.service.create(f.owner.principal, 'http', { ...command(3), provider: 'codex',
    authMode: 'subscription', name: 'Stale result' })).value.accounts.at(-1)!
  f.setState('awaiting-human')
  const operation = await f.service.prepareAuthentication(f.owner.principal, 'http', other.id, { ...command(4), intent: 'sign-in' })
  await expect(f.service.authenticationStatus(f.owner.principal, { operationId: operation.value.id }))
    .rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_STALE' })
  expect(fresh.value.binding.accountId).toBe(f.account.id)
})

it('keeps sign-in available for an hour across restart without dispatching another login', async () => {
  const f = await fixture()
  const prepared = await f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id,
    { ...command(1), intent: 'sign-in' })
  expect(Date.parse(prepared.value.expiresAt) - Date.parse(prepared.value.createdAt)).toBe(60 * 60_000)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(prepared.value.createdAt) + 30 * 60_000)
  const status = await f.createService().authenticationStatus(f.owner.principal, { operationId: prepared.value.id })
  expect(status).toMatchObject({ id: prepared.value.id, state: 'awaiting-human',
    expiresAt: prepared.value.expiresAt, nativeClosed: false })
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
})

it('retains expiry after late completion and does not implicitly start another operation', async () => {
  const f = await fixture()
  const prepared = await f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, { ...command(1), intent: 'sign-in' })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse(prepared.value.expiresAt) + 1)
  const expired = await f.service.authenticationStatus(f.owner.principal, { operationId: prepared.value.id })
  expect(expired).toMatchObject({ state: 'expired', nativeClosed: false })
  f.setState('completed', true)
  expect(await f.service.authenticationStatus(f.owner.principal, { operationId: prepared.value.id }))
    .toMatchObject({ state: 'expired', nativeClosed: true })
  expect(f.native.prepareAuthentication).toHaveBeenCalledTimes(1)
})

it('reauthorizes a native completion after its issuing grant was revoked and audits the denial', async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const observe = f.native.observeAuthentication!
  f.native.prepareAuthentication = async input => { entered(); await gate; return observe(input) }
  const pending = f.service.prepareAuthentication(f.owner.principal, 'http', f.account.id, { ...command(1), intent: 'sign-in' })
    .catch(error => error)
  try {
    await started
    await pool.query('update management_principals set revoked_at=now() where id=$1', [f.owner.principal.id])
  } finally { release() }
  expect(await pending).toMatchObject({ status: 403 })
  const audits = await pool.query<{ action: string; outcome: string }>(
    'select action,outcome from management_audit where principal_id=$1', [f.owner.principal.id])
  expect(audits.rows).toContainEqual({ action: 'provider.account.auth.publish', outcome: 'denied' })
  expect(f.native.prepareAuthentication).toBeDefined()
})
