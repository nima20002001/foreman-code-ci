import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ProviderAccountBinding, ProviderAccountObservation } from '@foreman-code/contracts/provider-accounts'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { readLiveManagementPrincipal } from '../src/modules/access/liveManagementPrincipal.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { ProviderAccountWorkerCarrier } from '../src/modules/provider-accounts/workerCarrier.js'
import { createProviderAccountWorkerExtension } from '../src/modules/provider-accounts/workerOperations.js'

it('uses one advertised authenticated account channel and rejects revoked or reinstalled targets without credential transport', async () => {
  const db = await migratedDatabase()
  try {
    const connection: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(),
      workerInstallationId: randomUUID(), bootId: randomUUID(), connectionEpoch: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
    const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'codex',
      bindingRevision: 1, profileRef: 'owning-worker-profile', subject: null,
      target: { hostRef: { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId },
        applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 } }
    const account = { id: binding.accountId, provider: 'codex' as const, authMode: 'subscription' as const,
      name: 'Worker slot', status: 'signed-in' as const, identity: null, revision: 1, isDefault: false, binding }
    const observation: ProviderAccountObservation = { bindingRevision: 1, generation: 1, sequence: 1,
      observedAt: '2026-01-01T00:00:00.000Z', status: 'signed-in', readiness: 'unknown', identity: null, subject: null }
    const access = new PostgresAccessService(db.pool)
    const owner = await access.issue({ name: 'Worker account caller', audience: 'operator', expiresAt: new Date('2099-01-01'),
      grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {
        mainIds: [connection.mainId], deviceIds: [connection.deviceId],
        applicationInstallationIds: [connection.workerInstallationId], providerAccountIds: [binding.accountId],
      } }] })
    const reader = await access.issue({ name: 'Denied account caller', audience: 'operator', expiresAt: new Date('2099-01-01'),
      grants: [{ actions: ['settings:read'], scope: {} }] })
    const resource = { mainId: connection.mainId, deviceId: connection.deviceId,
      applicationInstallationId: connection.workerInstallationId, providerAccountId: binding.accountId }
    let current = connection
    let supported = true
    let calls = 0
    let revokeAfterNative = false
    const extension = createProviderAccountWorkerExtension({ current: () => current,
      resolve: async requested => {
        expect(requested).toEqual(binding)
        return { account, homePath: '/worker/native-profile', userHome: '/worker/context' }
      },
      authorize: async () => requireAuthorization(await readLiveManagementPrincipal(db.pool, owner.principal.id),
        'provider_accounts:read', resource),
      native: { status: async () => ({ status: 'signed-in', identity: null }),
        login: async () => {}, logout: async () => {}, cancelLogin: async () => {}, close: async () => {},
        observeAccount: async () => {
          calls += 1
          if (revokeAfterNative) await db.pool.query('update management_principals set revoked_at=now() where id=$1',
            [owner.principal.id])
          return observation
        } },
    })
    const endpoint = { captureRequest: (deviceId: string, namespace: string) => supported
      && deviceId === current.deviceId && namespace === extension.namespace ? {
        binding: current,
        request: async (payload: unknown) => extension.handle!(payload, {
          binding: connection, signal: new AbortController().signal,
        }),
      } : undefined }
    const carrier = new ProviderAccountWorkerCarrier(() => endpoint, async (principal, target, request) => {
      const action = request.kind === 'status' || request.kind === 'models' || request.kind === 'observe'
        ? 'provider_accounts:read' : 'provider_accounts:manage'
      let id: string | undefined
      if ('binding' in request) id = request.binding.accountId
      else if ('operation' in request) id = request.operation.binding.accountId
      else if (request.kind === 'provision') id = request.account.id
      requireAuthorization(await readLiveManagementPrincipal(db.pool, principal.id), action, {
        mainId: target.hostRef.mainId,
        ...(target.hostRef.kind === 'device' ? { deviceId: target.hostRef.deviceId } : {}),
        applicationInstallationId: target.applicationInstallationId,
        ...(id ? { providerAccountId: id } : {}),
      })
    })
    const request = { kind: 'status' as const, binding }
    const result = await carrier.request(await access.authenticate(owner.token), binding.target, request)
    expect(result).toEqual(observation)
    expect(JSON.stringify(result)).not.toContain('/worker')
    await expect(carrier.request(await access.authenticate(reader.token), binding.target, request))
      .rejects.toMatchObject({ status: 403 })
    expect(calls).toBe(1)
    supported = false
    await expect(carrier.request(owner.principal, binding.target, request))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_WORKER_UNAVAILABLE' })
    supported = true
    current = { ...connection, workerInstallationId: randomUUID(), connectionGeneration: 2, bootId: randomUUID() }
    await expect(carrier.request(owner.principal, binding.target, request))
      .rejects.toMatchObject({ status: 403 })
    expect(calls).toBe(1)
    current = connection
    revokeAfterNative = true
    await expect(carrier.request(owner.principal, binding.target, request)).rejects.toMatchObject({ status: 403 })
    expect(calls).toBe(2)
  } finally { await db.close() }
}, 30_000)
