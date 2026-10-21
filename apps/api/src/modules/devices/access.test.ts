import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { pairingProof, PostgresDeviceAccessService } from './access.js'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'

describe('device-only authentication', () => {
  it('rejects wrong audience tokens without attempting owner-cookie fallback', async () => {
    const queries: unknown[] = []
    const pool = { query: async (...args: unknown[]) => { queries.push(args); return { rows: [] } } } as unknown as pg.Pool
    const service = new PostgresDeviceAccessService(pool, randomUUID())
    await expect(service.authenticateDevice('owner-cookie', 'connect')).rejects.toMatchObject({ code: 'unauthorized' })
    expect(queries).toHaveLength(1)
  })
  it('distinguishes persisted revocation from a transient authentication rejection', async () => {
    const mainId = randomUUID()
    const principal = { audience: 'graphql-worker' as const, mainId, deviceId: randomUUID(),
      workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      expiresAt: '2099-01-01T00:00:00Z' }
    const pool = { query: async () => ({ rows: [{ record: { status: 'revoked' } }] }) } as unknown as pg.Pool
    const service = new PostgresDeviceAccessService(pool, mainId)
    await expect(service.revalidateDevice(principal, 'heartbeat')).rejects.toMatchObject({ code: 'revoked' })
  })
  it('rejects wrong main and forged fingerprints before DB grant access', async () => {
    const service = new PostgresDeviceAccessService({} as pg.Pool, randomUUID())
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const input = { mainId: randomUUID(), workerInstallationId: randomUUID(), publicKey, requestId: randomUUID(), grant: 'x'.repeat(43) }
    const signature = sign(null, Buffer.from(pairingProof(input)), keys.privateKey).toString('base64url')
    await expect(service.pair({ ...input, signature })).rejects.toMatchObject({ code: 'wrong_main' })
    await expect(service.createPairingGrant({} as never, { publicKey, workerInstallationId: randomUUID(),
      expectedFingerprint: publicKeyFingerprint(publicKey).replace(/^./, 'z'), scopes: ['connect'], commandId: 'pair-test' })).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
