import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { ProviderAccountBinding, ProviderAccountObservation } from '@foreman-code/contracts/provider-accounts'
import { createProviderAccountWorkerExtension, workerProviderAccountResolver } from './workerOperations.js'

function fixture() {
  const connection: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    connectionGeneration: 1, connectionEpoch: randomUUID() }
  const binding: ProviderAccountBinding = { kind: 'slot', accountId: randomUUID(), provider: 'codex',
    profileRef: randomUUID(), bindingRevision: 1, subject: null,
    target: { hostRef: { kind: 'device', mainId: connection.mainId, deviceId: connection.deviceId },
      applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 } }
  const observation: ProviderAccountObservation = { bindingRevision: 1, generation: 1, sequence: 1,
    observedAt: '2026-01-01T00:00:00.000Z', status: 'unavailable', readiness: 'unknown', identity: null, subject: null }
  const observeAccount = vi.fn(async () => observation)
  const resolve = vi.fn(async () => ({ account: { id: binding.accountId, provider: binding.provider,
    name: 'Worker account', authMode: 'subscription' as const, revision: 1, isDefault: false,
    status: 'unavailable' as const, identity: null, binding }, homePath: '/private/local-slot', userHome: '/private/context' }))
  const authorize = vi.fn(async () => undefined)
  let current = connection
  const extension = createProviderAccountWorkerExtension({ current: () => current, resolve, authorize,
    native: { observeAccount, status: async () => ({ status: 'unavailable', identity: null }),
      login: async () => undefined, cancelLogin: async () => undefined, logout: async () => undefined,
      close: async () => undefined } })
  const identity = { ...connection }
  delete (identity as Partial<DeviceSessionBinding>).connectionEpoch
  const request = { version: 1, target: binding.target, connection: identity, request: { kind: 'status', binding } }
  const context = { binding: connection, signal: new AbortController().signal }
  return { extension, request, context, observeAccount, resolve, authorize,
    change: (value: DeviceSessionBinding) => { current = value }, connection, binding }
}

describe('qualified Worker account extension', () => {
  it('advertises a versioned narrow port and returns metadata without local paths', async () => {
    const f = fixture()
    expect(f.extension).toMatchObject({ namespace: 'provider-accounts-v1', version: 1,
      role: 'duplex', maxBinaryBytes: 0 })
    const result = await f.extension.handle!(f.request, f.context)
    expect(result.payload).toMatchObject({ status: 'unavailable', readiness: 'unknown' })
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(f.authorize).toHaveBeenCalledTimes(2)
  })

  it.each(['workerInstallationId', 'bootId', 'connectionGeneration', 'authorizationRevision'] as const)(
    'denies stale %s before native effects', async field => {
      const f = fixture()
      const stale = structuredClone(f.request)
      if (field === 'connectionGeneration' || field === 'authorizationRevision') stale.connection[field]++
      else stale.connection[field] = randomUUID()
      await expect(f.extension.handle!(stale, f.context)).rejects.toMatchObject({
        code: 'PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT',
      })
      expect(f.resolve).not.toHaveBeenCalled()
      expect(f.observeAccount).not.toHaveBeenCalled()
    })

  it('requires current authenticated authority and rejects binary or secret input', async () => {
    const f = fixture()
    f.authorize.mockRejectedValue(new Error('Permission denied'))
    await expect(f.extension.handle!(f.request, f.context)).rejects.toThrow('Permission denied')
    expect(f.observeAccount).not.toHaveBeenCalled()
    await expect(f.extension.handle!({ ...f.request, token: 'unaccepted' }, f.context)).rejects.toThrow()
    await expect(f.extension.handle!(f.request, { ...f.context, bytes: new Uint8Array([1]) }))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT' })
  })

  it('does not publish a late result after the connection changes', async () => {
    const f = fixture()
    f.observeAccount.mockImplementation(async () => {
      f.change({ ...f.connection, connectionGeneration: 2, connectionEpoch: randomUUID() })
      return { bindingRevision: 1, generation: 1, sequence: 1, observedAt: '2026-01-01T00:00:00.000Z',
        status: 'signed-in', identity: null, subject: null, readiness: 'unknown' }
    })
    await expect(f.extension.handle!(f.request, f.context)).rejects.toMatchObject({
      code: 'PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT',
    })
  })

  it('cannot adopt an old same-path slot after Worker reinstall', async () => {
    const f = fixture()
    const reinstalled = { ...f.connection, workerInstallationId: randomUUID(), bootId: randomUUID() }
    f.change(reinstalled)
    const connection = { ...reinstalled }
    delete (connection as Partial<DeviceSessionBinding>).connectionEpoch
    await expect(f.extension.handle!({ ...f.request, connection }, { ...f.context, binding: reinstalled }))
      .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT' })
    expect(f.resolve).not.toHaveBeenCalled()
  })
})


it('resolves only a locally retained accepted Worker slot without a default or path transfer', async () => {
  const f = fixture()
  const resolver = workerProviderAccountResolver({ current: () => f.connection, resolve: f.resolve })
  const binding = f.request.request.binding
  const resolved = await resolver.resolve('codex', binding.accountId, { allowDefault: false, acceptedBinding: binding })
  expect(resolved).toMatchObject({ accountId: binding.accountId, binding, homePath: '/private/local-slot' })
  await expect(resolver.resolve('codex')).rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_UNAVAILABLE' })
  await expect(resolver.resolve('codex', randomUUID(), { acceptedBinding: binding }))
    .rejects.toMatchObject({ code: 'PROVIDER_ACCOUNT_BINDING_UNAVAILABLE' })
  expect(f.resolve).toHaveBeenCalledTimes(1)
})

it('requires live Main binding readback before runtime recovery even when the original local slot still exists', async () => {
  const f = fixture()
  const validate = vi.fn(async () => { throw new Error('The original account was removed on Main') })
  const resolver = workerProviderAccountResolver({ current: () => f.connection, resolve: f.resolve, validate })
  await expect(resolver.resolve('codex', f.request.request.binding.accountId, { allowDefault: false, acceptedBinding: f.request.request.binding }))
    .rejects.toThrow('removed on Main')
  expect(validate).toHaveBeenCalledWith(f.request.request.binding)
  expect(f.resolve).not.toHaveBeenCalled()
})
