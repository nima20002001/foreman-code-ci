import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { createHostHarnessProfileCheckExtension } from './profileChannel.js'

it('discovers a native catalog only on its owning Worker installation and current channel', async () => {
  const hostRef = { kind: 'device' as const, mainId: randomUUID(), deviceId: randomUUID() }
  const binding = { mainId: hostRef.mainId, deviceId: hostRef.deviceId, workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: 'connection', connectionGeneration: 1,
    keyRevision: 1, authorizationRevision: 1 }
  const options = { harness: 'claude' as const, providerVersion: 'fixture', authenticated: true,
    models: [{ id: 'worker-model', reasoningEfforts: ['high'], variants: [], serviceTiers: [] }],
    nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString() }
  const discoverOptions = vi.fn(async () => options)
  const extension = createHostHarnessProfileCheckExtension({ hostRef,
    applicationInstallationId: binding.workerInstallationId,
    qualifierForBinding: () => { throw new Error('Catalog discovery must not qualify a profile') }, discoverOptions })
  const input = { operation: 'options', harness: 'claude', target: { hostRef,
    applicationInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 } }
  const context = { binding, signal: new AbortController().signal }
  await expect(extension.handle(input, context)).resolves.toEqual({ payload: options })
  for (const target of [{ ...input.target, applicationInstallationId: randomUUID() },
    { ...input.target, authorizationRevision: 2 },
    { ...input.target, hostRef: { ...hostRef, deviceId: randomUUID() } }]) {
    await expect(extension.handle({ ...input, target }, context)).rejects.toThrow()
  }
  expect(discoverOptions).toHaveBeenCalledTimes(1)
})
