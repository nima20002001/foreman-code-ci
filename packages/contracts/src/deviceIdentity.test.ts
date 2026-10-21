import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { authorizeDevice, revokeDevice, type DevicePrincipal, type DeviceRegistration } from './deviceIdentity.js'
import { loadOrCreateWorkerIdentity, mainIdentityProofMessage, verifyMainIdentityProof, publicKeyFingerprint, loadWorkerPairing, persistWorkerPairing, updateWorkerEndpoint } from './deviceIdentityNode.js'

describe('device authority and durable local identity', () => {
  it('fences revoked, wrong-main, expired and stale authorization revisions', () => {
    const registration: DeviceRegistration = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }
    const principal: DevicePrincipal = { audience: 'graphql-worker', ...registration, expiresAt: new Date(10_000).toISOString() }
    expect(authorizeDevice(registration, principal, 'connect', 0)).toBe(true)
    expect(authorizeDevice(registration, principal, 'heartbeat', 0)).toBe(false)
    expect(authorizeDevice(registration, { ...principal, mainId: randomUUID() }, 'connect', 0)).toBe(false)
    expect(authorizeDevice(registration, principal, 'connect', 10_000)).toBe(false)
    const revoked = revokeDevice(registration)
    expect(revoked.authorizationRevision).toBe(2)
    expect(revokeDevice(revoked)).toBe(revoked)
    expect(authorizeDevice(revoked, principal, 'connect', 0)).toBe(false)
  })
  it('atomically converges concurrent starts, persists restart identity and refuses corrupt identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'device-identity-'))
    try {
      const identities = await Promise.all(Array.from({ length: 12 }, () => loadOrCreateWorkerIdentity(directory)))
      expect(new Set(identities.map(identity => identity.workerInstallationId)).size).toBe(1)
      expect(() => publicKeyFingerprint(identities[0]!.privateKey)).toThrow('never private key material')
      expect((await loadOrCreateWorkerIdentity(directory)).workerInstallationId).toBe(identities[0]!.workerInstallationId)
      const stored = await readFile(join(directory, 'identity.json'), 'utf8')
      await writeFile(join(directory, 'identity.json'), '')
      await expect(loadOrCreateWorkerIdentity(directory)).rejects.toThrow()
      expect(await readFile(join(directory, 'identity.json'), 'utf8')).toBe('')
      await writeFile(join(directory, 'identity.json'), stored.replace('"keyRevision":1', '"keyRevision":0'))
      await expect(loadOrCreateWorkerIdentity(directory)).rejects.toThrow('corrupt')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('recovers identical pairing writes and keeps authority pinned across endpoint edits', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'device-pairing-'))
    try {
      const identity = await loadOrCreateWorkerIdentity(directory)
      const configuration = { formatVersion: 1 as const, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: identity.workerInstallationId,
        keyRevision: 1, authorizationRevision: 1, endpoint: 'wss://main.example/device', mainPublicKeyFingerprint: 'a'.repeat(64),
        credential: 'b'.repeat(64), expiresAt: '2099-01-01T00:00:00Z' }
      await persistWorkerPairing(directory, configuration)
      await persistWorkerPairing(directory, configuration)
      await expect(persistWorkerPairing(directory, { ...configuration, mainId: randomUUID() })).rejects.toThrow('explicit unpairing')
      await expect(persistWorkerPairing(directory, { ...configuration, mainId: randomUUID(),
        authorizationRevision: 3 })).rejects.toThrow('explicit unpairing')
      await expect(persistWorkerPairing(directory, { ...configuration, mainPublicKeyFingerprint: 'c'.repeat(64),
        authorizationRevision: 3 })).rejects.toThrow('explicit unpairing')
      expect(await loadWorkerPairing(directory)).toEqual(configuration)
      await updateWorkerEndpoint(directory, 'wss://other-endpoint.example/device')
      const recovered = await loadWorkerPairing(directory)
      expect(recovered.mainId).toBe(configuration.mainId)
      expect(recovered.mainPublicKeyFingerprint).toBe(configuration.mainPublicKeyFingerprint)
      expect(recovered.endpoint).toBe('wss://other-endpoint.example/device')
      await rm(join(directory, 'identity.json'))
      await expect(loadOrCreateWorkerIdentity(directory)).rejects.toThrow('explicit recovery')
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('binds negotiated channel descriptors into the selected main proof', async () => {
    const keys = generateKeyPairSync('ed25519'), mainPublicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const request = { audience: 'graphql-worker-main-v1' as const, mainId: randomUUID(), nonce: randomBytes(32).toString('base64url'),
      workerInstallationId: randomUUID(), protocolVersion: 1, workerApplicationVersion: 'worker', negotiationHash: 'a'.repeat(64) }
    const mainPublicKeyFingerprint = publicKeyFingerprint(mainPublicKey)
    const proof = { request, mainApplicationVersion: 'main', mainPublicKey, mainPublicKeyFingerprint,
      signature: sign(null, Buffer.from(mainIdentityProofMessage(request, 'main')), keys.privateKey).toString('base64url') }
    expect(await verifyMainIdentityProof(proof, request, mainPublicKeyFingerprint)).toBe(true)
    expect(await verifyMainIdentityProof(proof, { ...request, negotiationHash: 'b'.repeat(64) }, mainPublicKeyFingerprint)).toBe(false)
    const withoutNegotiation = { audience: request.audience, mainId: request.mainId, nonce: request.nonce,
      workerInstallationId: request.workerInstallationId, protocolVersion: request.protocolVersion, workerApplicationVersion: request.workerApplicationVersion }
    expect(await verifyMainIdentityProof(proof, withoutNegotiation, mainPublicKeyFingerprint)).toBe(false)
    const legacyProof = { ...proof, request: withoutNegotiation,
      signature: sign(null, Buffer.from(mainIdentityProofMessage(withoutNegotiation, 'main')), keys.privateKey).toString('base64url') }
    expect(await verifyMainIdentityProof(legacyProof, withoutNegotiation, mainPublicKeyFingerprint)).toBe(true)
  })

})
