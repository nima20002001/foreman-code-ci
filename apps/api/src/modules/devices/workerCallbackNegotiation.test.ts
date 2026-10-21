import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { mainIdentityProofMessage } from '@foreman-code/contracts/device-identity-node'
import { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { DeviceEndpoint } from './deviceEndpoint.js'
import { adaptDeviceSocket } from './deviceWire.js'

class Socket extends EventEmitter {
  bufferedAmount = 0
  peer?: Socket
  closed = false
  send(text: string) {
    queueMicrotask(() => {
      if (!this.closed && !this.peer?.closed) this.peer?.emit('message', Buffer.from(text), false)
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    this.peer?.close()
  }
}

it('authenticates Worker chat with negotiated callback admission and delivers its next request', async () => {
  const identity = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID() }
  const keys = generateKeyPairSync('ed25519')
  const mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const mainPublicKeyFingerprint = createHash('sha256')
    .update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const registration = { namespace: 'execution-v1', version: 1, maxJsonBytes: 1_048_576, maxBinaryBytes: 0 }
  const main = new DeviceEndpoint({ mainId: identity.mainId, appVersion: 'main-build',
    auth: { authenticateDevice: async () => ({ ...identity, audience: 'graphql-worker',
      expiresAt: '2099-01-01T00:00:00Z' }), revalidateDevice: async () => {} },
    signMainIdentityProof: async request => ({ request, mainApplicationVersion: 'main-build',
      mainPublicKey, mainPublicKeyFingerprint,
      signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'main-build')), keys.privateKey)
        .toString('base64url') }),
    reconcile: async () => {}, presence: () => {}, extensions: [{ ...registration, role: 'client' }],
  })
  const connections: Promise<void>[] = []
  const worker = new DeviceConnectionSupervisor({ identity, appVersion: 'worker-build', mainPublicKeyFingerprint,
    connect: async () => {
      const mainRaw = new Socket()
      const workerRaw = new Socket()
      mainRaw.peer = workerRaw
      workerRaw.peer = mainRaw
      connections.push(main.accept({ authorization: 'Bearer fixture-device' }, adaptDeviceSocket(mainRaw)))
      return adaptDeviceSocket(workerRaw)
    }, reconcile: async () => {},
    extensions: [{ ...registration, role: 'server', handle: async payload => ({ payload }) }],
  })
  try {
    worker.start()
    await vi.waitFor(() => expect(worker.status().phase).toBe('ready'))
    expect(main.capabilities(identity.deviceId)).toContainEqual(expect.objectContaining({
      namespace: 'execution-v1', callbackAdmission: true, observationAdmission: true,
    }))
    const request = { method: 'conversation.status' }
    await expect(main.request(identity.deviceId, 'execution-v1', request)).resolves.toEqual({ payload: request })
  } finally {
    await worker.stop()
    main.close()
    await Promise.all([...connections, main.join()])
  }
})
