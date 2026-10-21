import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ProviderAccount, ProviderAccountAuthenticationOperation,
  ProviderAccountBinding, ProviderAccountObservation } from '@foreman-code/contracts/provider-accounts'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { createRemoteAccountServices } from './remoteServices.js'
import type { ProviderAccountsService } from './service.js'
import { ProviderAccountWorkerCarrier } from './workerCarrier.js'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    connectionGeneration: 1 }
  const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
    applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'codex',
    profileRef: 'qualified-profile', target, bindingRevision: 1, subject: null }
  const observation: ProviderAccountObservation = { bindingRevision: 1, generation: 1_800_000_000_000,
    sequence: 1, observedAt: '2026-01-01T00:00:00.000Z', status: 'signed-in', identity: null,
    subject: null, readiness: 'ready' }
  const operation: ProviderAccountAuthenticationOperation = { id: randomUUID(), commandId: randomUUID(),
    inputHash: `sha256:${'a'.repeat(64)}`, binding, intent: 'sign-in', state: 'reserved', revision: 1,
    generation: observation.generation, nativeSequence: 0, cancelRequested: false, nativeClosed: false,
    createdAt: observation.observedAt, updatedAt: observation.observedAt,
    expiresAt: '2099-01-01T00:00:00.000Z', humanActionRequired: true }
  const request = vi.fn(async () => ({ payload: observation as unknown }))
  let current = connection
  const endpoint = { captureRequest: () => ({ binding: current, request }),
    currentBinding: () => current, capabilities: () => [] }
  const authorize = vi.fn(async () => undefined)
  const carrier = new ProviderAccountWorkerCarrier(() => endpoint, authorize)
  return { connection, target, binding, observation, operation, request, endpoint, carrier, authorize,
    principal: {} as ManagementPrincipal,
    reconnect() { current = { ...connection, connectionEpoch: randomUUID(), connectionGeneration: 2 } } }
}

it.each(['status', 'models', 'prepare'] as const)(
  'accepts a persisted account generation independently of the connection counter for %s', async kind => {
    const f = fixture()
    let payload: unknown = f.observation
    if (kind === 'models') payload = { binding: f.binding, generation: f.observation.generation,
      observedAt: f.observation.observedAt, models: [] }
    if (kind === 'prepare') payload = { binding: f.binding, generation: f.operation.generation,
      operationId: f.operation.id, sequence: 1, state: 'awaiting-human', nativeClosed: false }
    f.request.mockResolvedValue({ payload })
    const request = kind === 'prepare' ? { kind, operation: f.operation } : { kind, binding: f.binding }
    await expect(f.carrier.request(f.principal, f.target, request)).resolves.toEqual(payload)
    expect(f.authorize).toHaveBeenCalledTimes(2)
  })

it.each(['status', 'models', 'prepare'] as const)('rejects a late %s result after the channel changes', async kind => {
  const f = fixture()
  f.request.mockImplementation(async () => {
    f.reconnect()
    return { payload: f.observation }
  })
  const request = kind === 'prepare' ? { kind, operation: f.operation } : { kind, binding: f.binding }
  await expect(f.carrier.request(f.principal, f.target, request)).rejects.toMatchObject({
    code: 'PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT',
  })
})

it('rejects a sign-in result from another account generation', async () => {
  const f = fixture()
  f.request.mockResolvedValue({ payload: { binding: f.binding, generation: f.operation.generation + 1,
    operationId: f.operation.id, sequence: 1, state: 'awaiting-human', nativeClosed: false } })
  await expect(f.carrier.request(f.principal, f.target, { kind: 'prepare', operation: f.operation }))
    .rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_STALE' })
})

function resolverFixture() {
  const f = fixture()
  const account: ProviderAccount = { id: f.binding.accountId, provider: 'codex', name: 'Worker account',
    authMode: 'subscription', revision: 1, isDefault: false, status: 'unavailable', identity: null,
    binding: f.binding }
  const snapshot = [{ record: { accounts: [account] }, revision: '1' }]
  const device = [{ record: { mainId: f.connection.mainId, deviceId: f.connection.deviceId,
    workerInstallationId: f.connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    publicKeyFingerprint: 'a'.repeat(64),
    status: 'paired', scopes: ['connect', 'heartbeat'] } }]
  // SQL port results for the initial read and the transaction that persists the observation.
  const rows: unknown[][] = [snapshot, [], [{ id: f.connection.mainId }], device, [],
    [], [{ id: f.connection.mainId }], device, [], snapshot, [], snapshot, [], [], []]
  const query = vi.fn(async () => {
    const next = rows.shift()
    if (!next) throw new Error('Unexpected database request')
    return { rows: structuredClone(next), rowCount: next.length }
  })
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const services = createRemoteAccountServices({ pool, commands: {} as PostgresCommandCoordinator,
    local: {} as ProviderAccountsService, endpoint: () => f.endpoint })
  return { ...f, services }
}

it('resolves an accepted Worker account using its persisted generation through Main', async () => {
  const f = resolverFixture()
  await expect(f.services.resolve(f.binding)).resolves.toMatchObject({ accountId: f.binding.accountId,
    observation: f.observation })
})

it('rejects account resolution if the authenticated channel changes during readback', async () => {
  const f = resolverFixture()
  f.request.mockImplementation(async () => {
    f.reconnect()
    return { payload: f.observation }
  })
  await expect(f.services.resolve(f.binding)).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_TARGET_CONFLICT' })
})
