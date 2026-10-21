import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import type pg from 'pg'
import { MainIdentityProofRequestSchema, MainSignedIdentityProofSchema, MainEnrollmentProofRequestSchema, MainSignedEnrollmentProofSchema, type MainIdentityProofRequest, type MainSignedIdentityProof, type MainEnrollmentProofRequest, type MainSignedEnrollmentProof } from '@foreman-code/contracts/device-identity'
import { mainIdentityProofMessage, mainEnrollmentProofMessage, publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { DeviceAccessError } from './access.js'

export const mainDeviceIdentityMigration = { version: 282102, sql: 'create table device_main_identity (main_id uuid primary key, record jsonb not null);' } as const

export interface MainDeviceIdentity {
  mainId: string
  publicKey: string
  privateKey: string
  publicKeyFingerprint: string
}
/** Main's existing installation UUID remains the authority. One app-authentication key survives restarts. */
export async function loadOrCreateMainDeviceIdentity(pool: Pick<pg.Pool, 'query'>, mainId: string): Promise<MainDeviceIdentity> {
  const installation = await pool.query<{ id: string }>('select id from application_installation where singleton=true')
  if (installation.rows[0]?.id !== mainId) throw new DeviceAccessError('wrong_main')
  const existing = await pool.query<{ record: MainDeviceIdentity }>('select record from device_main_identity where main_id=$1', [mainId])
  let identity = existing.rows[0]?.record
  if (!identity) {
    const keys = generateKeyPairSync('ed25519'), publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const candidate: MainDeviceIdentity = { mainId, publicKey, privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyFingerprint: publicKeyFingerprint(publicKey) }
    const persisted = await pool.query<{ record: MainDeviceIdentity }>(`insert into device_main_identity(main_id,record) values($1,$2)
      on conflict(main_id) do update set main_id=excluded.main_id returning record`, [mainId, candidate])
    identity = persisted.rows[0]?.record
  }
  if (!identity || identity.mainId !== mainId || publicKeyFingerprint(identity.publicKey) !== identity.publicKeyFingerprint
    || publicKeyFingerprint(createPublicKey(identity.privateKey).export({ type: 'spki', format: 'pem' }).toString()) !== identity.publicKeyFingerprint) {
    throw new Error('Main device-authentication identity is corrupt; explicit recovery is required.')
  }
  return identity
}
export function signMainIdentityProof(identity: MainDeviceIdentity, input: MainIdentityProofRequest, mainApplicationVersion: string): MainSignedIdentityProof {
  const request = MainIdentityProofRequestSchema.parse(input)
  if (request.mainId !== identity.mainId) throw new DeviceAccessError('wrong_main')
  return MainSignedIdentityProofSchema.parse({ request, mainApplicationVersion, mainPublicKey: identity.publicKey,
    mainPublicKeyFingerprint: identity.publicKeyFingerprint,
    signature: sign(null, Buffer.from(mainIdentityProofMessage(request, mainApplicationVersion)), identity.privateKey).toString('base64url') })
}
export function signMainEnrollmentProof(identity: MainDeviceIdentity, input: MainEnrollmentProofRequest, mainApplicationVersion: string): MainSignedEnrollmentProof {
  const request = MainEnrollmentProofRequestSchema.parse(input)
  if (request.mainId !== identity.mainId) throw new DeviceAccessError('wrong_main')
  return MainSignedEnrollmentProofSchema.parse({ request, mainApplicationVersion, mainPublicKey: identity.publicKey,
    mainPublicKeyFingerprint: identity.publicKeyFingerprint,
    signature: sign(null, Buffer.from(mainEnrollmentProofMessage(request, mainApplicationVersion)), identity.privateKey).toString('base64url') })
}
