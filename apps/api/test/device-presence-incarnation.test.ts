import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import type { DevicePresence } from '@foreman-code/contracts/device-connection'
import { expect, it, vi } from 'vitest'
import { DeviceConnectionSupervisor } from '../src/modules/devices/connectionSupervisor.js'
import { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { adaptDeviceSocket } from '../src/modules/devices/deviceWire.js'
import { signMainIdentityProof } from '../src/modules/devices/mainIdentity.js'
import { ProductionDevicePresence } from '../src/modules/devices/productionPresence.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer!: Socket
  closed = false
  send(text: string) { this.peer.emit('message', text, false) }
  close() {
    if (this.closed) return
    this.closed = true; this.emit('close'); this.peer.close()
  }
}

it('accepts a restarted supervisor on the same boot and fences every replaced authenticated epoch', async () => {
  const identity = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainIdentity = { mainId: identity.mainId, publicKey, publicKeyFingerprint: publicKeyFingerprint(publicKey),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() }
  const presence = new ProductionDevicePresence(identity.mainId), observations: DevicePresence[] = []
  const endpoint = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'test-main',
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker', expiresAt: '2099-01-01T00:00:00Z' }),
      revalidateDevice: async () => {} },
    signMainIdentityProof: async (request) => signMainIdentityProof(mainIdentity, request, 'test-main'),
    reconcile: async () => {}, heartbeatMs: 10_000,
    presence: (view) => { observations.push(structuredClone(view)); presence.publish(view) },
  })
  const supervisor = () => new DeviceConnectionSupervisor({ identity, appVersion: 'test-worker',
    mainPublicKeyFingerprint: mainIdentity.publicKeyFingerprint, reconcile: async () => {}, heartbeatMs: 10_000,
    connect: async () => {
      const main = new Socket(), worker = new Socket(); main.peer = worker; worker.peer = main
      const workerSocket = adaptDeviceSocket(worker)
      void endpoint.accept({ authorization: 'Bearer test-device' }, adaptDeviceSocket(main))
      return workerSocket
    },
  })
  const first = supervisor(), restarted = supervisor()
  const ready = async (worker: DeviceConnectionSupervisor, generation: number) => {
    worker.start()
    await vi.waitFor(() => {
      expect(worker.status()).toMatchObject({ phase: 'ready', generation })
      expect(endpoint.currentBinding(identity.deviceId)).toMatchObject({ connectionGeneration: generation })
      expect(observations.at(-1)).toMatchObject({ phase: 'ready', binding: { connectionGeneration: generation } })
    })
    return structuredClone(observations.at(-1)!)
  }
  try {
    const epoch1 = await ready(first, 1)
    await first.stop(); await endpoint.join()
    const epoch2 = await ready(first, 2)
    await first.stop(); await endpoint.join()
    expect(presence.get(identity.deviceId)).toMatchObject({ phase: 'offline', binding: epoch2.binding })

    const epoch3 = await ready(restarted, 1)
    expect(epoch3.binding.bootId).toBe(epoch2.binding.bootId)
    expect(new Set([epoch1, epoch2, epoch3].map((view) => view.binding.connectionEpoch)).size).toBe(3)
    expect(presence.get(identity.deviceId)).toEqual(epoch3)
    for (const old of [epoch1, epoch2]) {
      presence.publish({ ...old, phase: 'offline' })
      presence.publish(old)
      presence.publish({ ...old, binding: { ...old.binding, connectionGeneration: 99 } })
      expect(presence.get(identity.deviceId)).toEqual(epoch3)
    }
    await restarted.stop(); await endpoint.join()
    expect(presence.get(identity.deviceId)).toMatchObject({ phase: 'offline', binding: epoch3.binding })
  } finally {
    await first.stop(); await restarted.stop(); endpoint.close(); await endpoint.join(); presence.close()
  }
})

it.each(['authorizationRevision', 'keyRevision'] as const)('retains the %s fence when accepting fresh epochs', (revision) => {
  const presence = new ProductionDevicePresence('main')
  const current: DevicePresence = { binding: { mainId: 'main', deviceId: 'device', workerInstallationId: 'installation',
    bootId: 'boot', keyRevision: 2, authorizationRevision: 2, connectionEpoch: 'current', connectionGeneration: 2 },
  phase: 'ready', dispatch: false, transfer: false, appVersion: 'test', protocolVersion: 1, lastSeenAt: '2026-10-02T00:00:00Z' }
  presence.publish(current)
  presence.publish({ ...current, binding: { ...current.binding, connectionEpoch: 'rejected', connectionGeneration: 1, [revision]: 1 } })
  expect(presence.get('device')).toEqual(current)
  const fresh = { ...current, binding: { ...current.binding, connectionEpoch: 'fresh', connectionGeneration: 1 } }
  presence.publish(fresh)
  expect(presence.get('device')).toEqual(fresh)
})
