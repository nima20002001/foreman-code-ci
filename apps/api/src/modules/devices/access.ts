import { DeviceSetupApproveInputSchema,DeviceSetupOptionsSchema,encodeWorkerEnrollmentCode,type DeviceSetupApproveInput,type DeviceSetupOptions } from '@foreman-code/contracts/device-setup'
import { withTransaction } from '../../infrastructure/transaction.js'
import { verifiedWorkerIdentityRequest } from '@foreman-code/contracts/device-setup-node'
import { createHash, createHmac, randomBytes, randomUUID, verify } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { authorizeDevice, DevicePairingRequestSchema, DeviceRegistrationSchema, revokeDevice, type DevicePrincipal, type DeviceRegistration, type DeviceScope, type DevicePairingRequest, MainDeviceIdentityPublicSchema, type MainDeviceIdentityPublic } from '@foreman-code/contracts/device-identity'
import { pairingProof, publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { commandInputHash, PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { initializePairedBuildComputer } from '../settings/buildComputers.js'
import { DeviceAccessError } from './accessError.js'

export { DeviceAccessError }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export type PairDeviceInput = DevicePairingRequest
export { pairingProof } from '@foreman-code/contracts/device-identity-node'
interface DeviceRow { record: DeviceRegistration; public_key: string; credential_expires_at: Date }
export class PostgresDeviceAccessService {
  constructor(private readonly pool: pg.Pool, readonly mainId: string, private readonly onRevoked?: (deviceId: string, authorizationRevision: number) => void,private readonly setupOptions:()=>DeviceSetupOptions=()=>({endpoint:null,available:false,reason:'listener-unconfigured'})) {}
  private pairingAttempts = { window: 0, count: 0 }
  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, operation)
  }
  private async management(client: pg.PoolClient, principal: ManagementPrincipal, write: boolean): Promise<void> {
    requireAuthorization(await readLiveManagementPrincipal(client, principal.id), write ? 'settings:update' : 'settings:read')
  }
  async readMainIdentity(principal: ManagementPrincipal): Promise<MainDeviceIdentityPublic> {
    return this.transaction(async client => {
      await this.management(client, principal, false)
      const result = await client.query<{ mainPublicKey: string; mainPublicKeyFingerprint: string }>(
        `select record->>'publicKey' as "mainPublicKey", record->>'publicKeyFingerprint' as "mainPublicKeyFingerprint" from device_main_identity where main_id=$1`, [this.mainId])
      if (!result.rows[0]) throw new DomainError('DEVICE_MAIN_IDENTITY_UNAVAILABLE', 'Main device authentication has not been initialized.', 503)
      return MainDeviceIdentityPublicSchema.parse({ mainId: this.mainId, ...result.rows[0] })
    })
  }
  async readSetupOptions(principal:ManagementPrincipal):Promise<DeviceSetupOptions> {
    return this.transaction(async client=>{await this.management(client,principal,false);return DeviceSetupOptionsSchema.parse(this.setupOptions())})
  }
  async createSetupCode(principal:ManagementPrincipal,raw:DeviceSetupApproveInput,source:'http'|'mcp'='http') {
    requireAuthorization(principal,'settings:update')
    const input=DeviceSetupApproveInputSchema.parse(raw),request=verifiedWorkerIdentityRequest(input.identityRequestCode)
    const grantInput={commandId:input.commandId,workerInstallationId:request.workerInstallationId,publicKey:request.publicKey,expectedFingerprint:request.publicKeyFingerprint,scopes:input.scopes,...(input.expectedAuthorizationRevision?{expectedAuthorizationRevision:input.expectedAuthorizationRevision}:{})}
    let metadata:{registration:DeviceRegistration;expiresAt:string;requestId:string;mainFingerprint:string;tlsTrust?:DeviceSetupOptions['tlsTrust']}|undefined
    const approved=await new PostgresCommandCoordinator(this.pool).execute({principal,source,operation:'device_setup_code_create',commandId:input.commandId,targetKey:this.mainId,payload:input,dedicatedConnection:true,
      authorize:client=>this.management(client,principal,true),prepare:async()=>{
        const options=DeviceSetupOptionsSchema.parse(this.setupOptions())
        if(!options.available||options.endpoint!==input.endpoint)throw new DomainError('DEVICE_SETUP_ENDPOINT_UNAVAILABLE','The selected approved LAN device listener is unavailable or changed.',409)
        const main=await this.transaction(async client=>{
          await this.management(client,principal,true)
          const row=(await client.query<{mainPublicKey:string;mainPublicKeyFingerprint:string}>(`select record->>'publicKey' as "mainPublicKey",record->>'publicKeyFingerprint' as "mainPublicKeyFingerprint" from device_main_identity where main_id=$1`,[this.mainId])).rows[0]
          if(!row||publicKeyFingerprint(row.mainPublicKey)!==row.mainPublicKeyFingerprint)throw new DomainError('DEVICE_MAIN_IDENTITY_UNAVAILABLE','The selected Main identity is unavailable.',503)
          return row
        })
        const grant=await this.createPairingGrant(principal,grantInput,source)
        metadata={registration:grant.registration,expiresAt:grant.expiresAt,requestId:randomUUID(),mainFingerprint:main.mainPublicKeyFingerprint,...(options.tlsTrust?{tlsTrust:options.tlsTrust}:{})}
      },perform:async()=>{
        if(!metadata)throw new DomainError('DEVICE_SETUP_UNAVAILABLE','The approved enrollment receipt is missing.',503)
        return metadata // The private code/grant is not stored in the public command result or audit.
      }})
    const original=approved.value,grant=await this.createPairingGrant(principal,grantInput,source)
    if(grant.expiresAt!==original.expiresAt||grant.registration.deviceId!==original.registration.deviceId)throw new DomainError('DEVICE_SETUP_RECEIPT_CONFLICT','The original key-bound grant changed.',409)
    return {registration:original.registration,expiresAt:original.expiresAt,enrollmentCode:encodeWorkerEnrollmentCode({version:1,kind:'enrollment',workerInstallationId:request.workerInstallationId,publicKeyFingerprint:request.publicKeyFingerprint,enrollment:{mainId:this.mainId,mainPublicKeyFingerprint:original.mainFingerprint,endpoint:input.endpoint,grant:grant.grant,requestId:original.requestId},expiresAt:original.expiresAt,...(original.tlsTrust?{tlsTrust:original.tlsTrust}:{})})}
  }
  async list(principal: ManagementPrincipal): Promise<DeviceRegistration[]> {
    return this.transaction(async client => {
      await this.management(client, principal, false)
      const rows = await client.query<{ record: DeviceRegistration }>('select record from device_registrations where main_id=$1 order by created_at,id', [this.mainId])
      return rows.rows.map(row => DeviceRegistrationSchema.parse(row.record))
    })
  }
  async createPairingGrant(principal: ManagementPrincipal, input: { workerInstallationId: string; publicKey: string; expectedFingerprint: string; scopes: DeviceScope[]; commandId: string; expectedAuthorizationRevision?: number | undefined }, source: 'http' | 'mcp' = 'http'): Promise<{ registration: DeviceRegistration; grant: string; expiresAt: string }> {
    const fingerprint = publicKeyFingerprint(input.publicKey)
    if (fingerprint !== input.expectedFingerprint) throw new DeviceAccessError('unauthorized')
    let registration = DeviceRegistrationSchema.parse({ mainId: this.mainId, deviceId: randomUUID(), workerInstallationId: input.workerInstallationId,
      publicKeyFingerprint: fingerprint, keyRevision: 1, authorizationRevision: 1, status: 'pending', scopes: input.scopes })
    await this.transaction(client => this.management(client, principal, true))
    const secretResult = await this.pool.query<{ secret: string }>(`insert into device_authorization_secret(singleton,secret) values(true,$1)
      on conflict(singleton) do update set singleton=true returning secret`, [randomBytes(32).toString('hex')])
    const grant = createHmac('sha256', secretResult.rows[0]!.secret).update(JSON.stringify([principal.id, input.commandId, commandInputHash(input)])).digest('base64url')
    const result = await new PostgresCommandCoordinator(this.pool).execute({ principal, source, operation: 'device_pairing_grant_create', commandId: input.commandId,
      targetKey: this.mainId, payload: input, authorize: client => this.management(client, principal, true), perform: async client => {
        const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString()
        await client.query('select pg_advisory_xact_lock(hashtext($1))', [`device-installation:${input.workerInstallationId}`])
        const existing = await client.query<{ record: DeviceRegistration }>('select record from device_registrations where worker_installation_id=$1 for update', [input.workerInstallationId])
        if (existing.rows[0]) {
          const previous = existing.rows[0].record
          if (previous.status !== 'revoked' || previous.authorizationRevision !== input.expectedAuthorizationRevision) throw new DeviceAccessError('conflict')
          registration = { ...registration, deviceId: previous.deviceId, keyRevision: previous.keyRevision + (previous.publicKeyFingerprint === fingerprint ? 0 : 1), authorizationRevision: previous.authorizationRevision + 1 }
        }
        await client.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5) on conflict(id) do update set public_key=excluded.public_key,record=excluded.record,credential_hash=null,credential_expires_at=null', [registration.deviceId, this.mainId, registration.workerInstallationId, input.publicKey, registration])
        await client.query('insert into device_pairing_grants(id,token_hash,device_id,authorization_revision,expires_at,principal_id) values($1,$2,$3,$4,$5,$6)', [randomUUID(), digest(grant), registration.deviceId, registration.authorizationRevision, expiresAt, principal.id])
        return { registration, expiresAt }
      } })
    return { ...result.value, grant }
  }

  async pair(input: PairDeviceInput): Promise<{ registration: DeviceRegistration; credential: string; expiresAt: string }> {
    const now = Date.now()
    if (now - this.pairingAttempts.window >= 60_000) this.pairingAttempts = { window: now, count: 0 }
    if (++this.pairingAttempts.count > 30) throw new DeviceAccessError('forbidden')
    input = DevicePairingRequestSchema.parse(input)
    if (input.mainId !== this.mainId) throw new DeviceAccessError('wrong_main')
    if (!verify(null, Buffer.from(pairingProof(input)), input.publicKey, Buffer.from(input.signature, 'base64url'))) throw new DeviceAccessError('unauthorized')
    return this.transaction(async client => {
      const result = await client.query<DeviceRow & { expires_at: Date; consumed_request_id: string | null; authorization_revision: number; principal_id: string }>(
        'select d.record,d.public_key,d.credential_expires_at,g.expires_at,g.consumed_request_id,g.authorization_revision,g.principal_id from device_pairing_grants g join device_registrations d on d.id=g.device_id where g.token_hash=$1 for update of g,d', [digest(input.grant)])
      const row = result.rows[0]
      if (!row || row.record.workerInstallationId !== input.workerInstallationId || row.record.publicKeyFingerprint !== publicKeyFingerprint(input.publicKey)) throw new DeviceAccessError('unauthorized')
      if (!row.consumed_request_id) requireAuthorization(await readLiveManagementPrincipal(client, row.principal_id), 'settings:update')
      if (Number(row.authorization_revision) !== row.record.authorizationRevision) throw new DeviceAccessError('unauthorized')
      if (row.record.status === 'revoked') throw new DeviceAccessError('revoked')
      if (row.consumed_request_id && row.consumed_request_id !== input.requestId) throw new DeviceAccessError('conflict')
      if (row.consumed_request_id && row.credential_expires_at.getTime() <= Date.now()) throw new DeviceAccessError('expired')
      if (!row.consumed_request_id && row.expires_at.getTime() <= Date.now()) throw new DeviceAccessError('expired')
      const credential = digest(JSON.stringify(['graphql-worker-credential-v1', input.grant, input.requestId]))
      const registration = { ...row.record, status: 'paired' as const }
      const expiresAt = row.consumed_request_id
        ? row.credential_expires_at.toISOString()
        : new Date(Date.now() + 100 * 365 * 86400_000).toISOString()
      if (!row.consumed_request_id) {
        await client.query('update device_registrations set record=$2,credential_hash=$3,credential_expires_at=$4 where id=$1', [registration.deviceId, registration, digest(credential), expiresAt])
        await client.query('update device_pairing_grants set consumed_request_id=$2,consumed_at=now() where token_hash=$1', [digest(input.grant), input.requestId])
        const buildPreference = await initializePairedBuildComputer(client, registration, row.principal_id)
        await client.query("insert into management_audit(principal_id,source,action,target_key,outcome,details) values($1,'device','device_pair',$2,'succeeded',$3::jsonb)",
          [row.principal_id, registration.deviceId, JSON.stringify({ buildPreference })])
      }
      return { registration, credential, expiresAt }
    })
  }
  async revoke(principal: ManagementPrincipal, deviceId: string, expectedRevision: number, commandId: string, source: 'http' | 'mcp' = 'http'): Promise<DeviceRegistration> {
    const result = await new PostgresCommandCoordinator(this.pool).execute({ principal, source, operation: 'device_revoke', commandId, targetKey: deviceId, payload: { deviceId, expectedRevision },
      authorize: client => this.management(client, principal, true), perform: async client => {
      const result = await client.query<{ record: DeviceRegistration }>('select record from device_registrations where id=$1 and main_id=$2 for update', [deviceId, this.mainId])
      const row = result.rows[0]
      if (!row) throw new DeviceAccessError('unauthorized')
      if (row.record.authorizationRevision !== expectedRevision) throw new DeviceAccessError('conflict')
      const revoked = revokeDevice(row.record)
      await client.query('update device_registrations set record=$2,credential_hash=null where id=$1', [deviceId, revoked])
      return revoked
    } })
    this.onRevoked?.(deviceId, result.value.authorizationRevision)
    return result.value
  }
  async authenticateDevice(token: string, scope: DeviceScope): Promise<DevicePrincipal> {
    const result = await this.pool.query<DeviceRow>('select record,public_key,credential_expires_at from device_registrations where credential_hash=$1', [digest(token)])
    const row = result.rows[0]
    if (!row) throw new DeviceAccessError('unauthorized')
    const principal: DevicePrincipal = { audience: 'graphql-worker', mainId: row.record.mainId, deviceId: row.record.deviceId,
      workerInstallationId: row.record.workerInstallationId, keyRevision: row.record.keyRevision,
      authorizationRevision: row.record.authorizationRevision, expiresAt: row.credential_expires_at.toISOString() }
    await this.revalidateDevice(principal, scope)
    return principal
  }
  async revalidateDevice(principal: DevicePrincipal, scope: DeviceScope): Promise<void> {
    const result = await this.pool.query<{ record: DeviceRegistration }>('select record from device_registrations where id=$1 and main_id=$2', [principal.deviceId, this.mainId])
    const row = result.rows[0]
    if (row?.record.status === 'revoked') throw new DeviceAccessError('revoked')
    if (!row || !authorizeDevice(row.record, principal, scope, Date.now())) throw new DeviceAccessError('unauthorized')
  }
}
