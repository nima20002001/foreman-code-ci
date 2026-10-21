import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { publicKeyFingerprint, verifyMainIdentityProof } from '@foreman-code/contracts/device-identity-node'
import { signMainIdentityProof } from './mainIdentity.js'

describe('selected main application proof', () => {
  it('binds fresh nonce, installation, revisions, boot, generations, epochs and versions to pinned app key', async () => {
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const identity = { mainId: randomUUID(), publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyFingerprint: publicKeyFingerprint(publicKey) }
    const request = { audience: 'graphql-worker-main-v1' as const, mainId: identity.mainId, nonce: randomBytes(32).toString('base64url'),
      workerInstallationId: randomUUID(), deviceId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 2,
      connectionGeneration: 3, connectionEpoch: randomUUID(), mainConnectionEpoch: randomUUID(), protocolVersion: 1, workerApplicationVersion: 'test-worker', negotiationHash: 'a'.repeat(64) }
    const proof = signMainIdentityProof(identity, request, 'test-main')
    expect(await verifyMainIdentityProof(proof, request, identity.publicKeyFingerprint)).toBe(true)
    for (const changed of [{ nonce: randomBytes(32).toString('base64url') }, { workerInstallationId: randomUUID() }, { authorizationRevision: 3 },
      { negotiationHash: 'b'.repeat(64) }, { connectionGeneration: 4 }, { mainConnectionEpoch: randomUUID() }, { protocolVersion: 2 }, { workerApplicationVersion: 'other' }]) {
      expect(await verifyMainIdentityProof(proof, { ...request, ...changed }, identity.publicKeyFingerprint)).toBe(false)
    }
    expect(await verifyMainIdentityProof({ ...proof, mainApplicationVersion: 'forged' }, request, identity.publicKeyFingerprint)).toBe(false)
    expect(await verifyMainIdentityProof(proof, request, 'a'.repeat(64))).toBe(false)
  })
})
