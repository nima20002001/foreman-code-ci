import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { transferContextForBinding, type AcceptedTransferAuthority } from '../byte-transfer/carrier.js'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { ConnectionProbeSchema, TrustedEndpointSchema, probeTrustedConnection, discoverTrustedConnectionHost, type HostDiscovery, type ConnectionProbe } from './trustedConnectionProbe.js'

import { TrustedConnectionConfigureSchema, TrustedConnectionConsentSchema, TrustedConnectionReadSchema, TrustedConnectionCheckSchema, type TrustedConnectionConfigure, type TrustedConnectionConsent, type TrustedConnectionRead, type TrustedConnectionCheck } from '@foreman-code/contracts/trusted-device-connection'
export { TrustedConnectionConfigureSchema, TrustedConnectionConsentSchema, TrustedConnectionReadSchema, TrustedConnectionCheckSchema } from '@foreman-code/contracts/trusted-device-connection'
export type { TrustedConnectionConfigure, TrustedConnectionConsent, TrustedConnectionRead, TrustedConnectionCheck } from '@foreman-code/contracts/trusted-device-connection'
const OPERATION = 'device.trusted-connection.configure'
// Read historical receipts without exposing retired metadata or rewriting saved facts.
const StoredConsentSchema = TrustedConnectionConsentSchema.strip()
export interface TrustedConnectionSetupPorts {
  probe?: typeof probeTrustedConnection
}
export interface AcceptedTrustedConnectionTransfer {
  accepted: AcceptedTransferAuthority
  binding: Readonly<DeviceSessionBinding>
  /** Actual current Main client capture for rsync-stage-v1, not incoming-only namespace lookup. */
  current(): Readonly<DeviceSessionBinding> | undefined
}
function blocked(read: TrustedConnectionRead): TrustedConnectionCheck['state'] | null {
  if (read.registration.status === 'revoked') return 'revoked'
  if (read.registration.status !== 'paired') return 'pairing-required'
  if (!read.consent) return 'consent-required'
  if (!read.consent.allowOwnerCommands) return 'consent-revoked'
  if (read.consent.mainId !== read.registration.mainId || read.consent.deviceId !== read.registration.deviceId
    || read.consent.workerInstallationId !== read.registration.workerInstallationId || read.consent.keyRevision !== read.registration.keyRevision
    || read.consent.authorizationRevision !== read.registration.authorizationRevision || read.consent.publicKeyFingerprint !== read.registration.publicKeyFingerprint) return 'identity-changed'
  return null
}
/** Consent and diagnostic readiness only. Does not dispatch commands, install software,
 * enable SSH/Tailscale, modify known_hosts, or confer agent execution authority. */
export class PostgresTrustedConnectionSetup {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string, private readonly ports: TrustedConnectionSetupPorts = {}) {}
  private async transaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, operation)
  }
  private async readLocked(client: pg.PoolClient, principal: ManagementPrincipal, deviceId: string, write = false): Promise<TrustedConnectionRead> {
    requireAuthorization(principal, write ? 'settings:update' : 'settings:read')
    requireAuthorization(await readLiveManagementPrincipal(client, principal.id), write ? 'settings:update' : 'settings:read')
    if (write) await client.query('select pg_advisory_xact_lock(hashtext($1))', [`trusted-connection:${this.mainId}:${deviceId}`])
    return this.readRecord(client, deviceId)
  }
  private async readRecord(client: pg.PoolClient, deviceId: string): Promise<TrustedConnectionRead> {
    const row = (await client.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2 for share', [deviceId, this.mainId])).rows[0]
    if (!row) throw new DomainError('DEVICE_NOT_FOUND', 'The device is not registered on this Main.', 404)
    const registration = DeviceRegistrationSchema.parse(row.record)
    const latest = (await client.query<{ result: unknown }>(`select result from management_command_receipts where operation=$1 and target_key=$2 order by (result->>'revision')::bigint desc limit 1`, [OPERATION, `${this.mainId}:${deviceId}`])).rows[0]
    return TrustedConnectionReadSchema.parse({ registration, consent: latest ? StoredConsentSchema.parse(latest.result) : null })
  }
  async discover(principal: ManagementPrincipal): Promise<HostDiscovery> {
    const authorize = () => this.transaction(async client => {
      requireAuthorization(principal, 'settings:read')
      requireAuthorization(await readLiveManagementPrincipal(client, principal.id), 'settings:read')
    })
    await authorize()
    const facts = await discoverTrustedConnectionHost()
    await authorize()
    return facts
  }
  async read(principal: ManagementPrincipal, rawDeviceId: string): Promise<TrustedConnectionRead> {
    const deviceId = z.uuid().parse(rawDeviceId)
    return this.transaction(client => this.readLocked(client, principal, deviceId))
  }
  async configure(principal: ManagementPrincipal, raw: TrustedConnectionConfigure, source: 'http' | 'mcp' = 'http'): Promise<TrustedConnectionConsent> {
    const input = TrustedConnectionConfigureSchema.parse(raw)
    requireAuthorization(principal, 'settings:update')
    const result = await new PostgresCommandCoordinator(this.pool).execute({ principal, source, operation: OPERATION,
      commandId: input.commandId, targetKey: `${this.mainId}:${input.deviceId}`, payload: input,
      authorize: async client => { await this.readLocked(client, principal, input.deviceId, true) },
      perform: async client => {
        const current = await this.readLocked(client, principal, input.deviceId, true)
        if ((current.consent?.revision ?? 0) !== input.expectedRevision || current.registration.authorizationRevision !== input.expectedAuthorizationRevision) {
          throw new DomainError('DEVICE_CONNECTION_CONFLICT', 'The device or consent revision changed. Read it before changing the connection again.', 409)
        }
        if (current.registration.status !== 'paired') throw new DomainError('DEVICE_CONNECTION_NOT_PAIRED', 'Pair this device before configuring remote commands.', 409)
        const { mainId, deviceId, workerInstallationId, keyRevision, authorizationRevision, publicKeyFingerprint } = current.registration
        return TrustedConnectionConsentSchema.parse({ mainId, deviceId, workerInstallationId, keyRevision, authorizationRevision, publicKeyFingerprint,
          revision: input.expectedRevision + 1, endpoint: input.endpoint, hostKeyFingerprint: input.hostKeyFingerprint,
          allowOwnerCommands: input.allowOwnerCommands,
          privilege: 'selected-os-user', automaticSudo: false, grantsAgentPermissions: false })
      } })
    return StoredConsentSchema.parse(result.value)
  }
  async inspect(principal: ManagementPrincipal, deviceId: string, rawEndpoint: z.infer<typeof TrustedEndpointSchema>): Promise<ConnectionProbe> {
    const endpoint = TrustedEndpointSchema.parse(rawEndpoint)
    const before = await this.read(principal, deviceId)
    if (before.registration.status !== 'paired') throw new DomainError('DEVICE_CONNECTION_NOT_PAIRED', 'Pair this device before testing its connection.', 409)
    const probe = ConnectionProbeSchema.parse(await (this.ports.probe ?? probeTrustedConnection)(endpoint))
    const after = await this.read(principal, deviceId)
    if (after.registration.status !== 'paired' || !isDeepStrictEqual(after.registration, before.registration)) {
      throw new DomainError('DEVICE_CONNECTION_CONFLICT', 'The paired identity changed during the connection test.', 409)
    }
    return probe
  }
  /** Server-internal accepted-transfer capability only. Does not lend settings grants,
   * expose a new management route or authorize bytes independently of the original domain. */
  private async authorizeAcceptedTransfer(intent: TransferIntent, authority: AcceptedTrustedConnectionTransfer,
    signal: AbortSignal): Promise<void> {
    const binding = DeviceSessionBindingSchema.parse(authority.binding)
    signal.throwIfAborted()
    const current = authority.current()
    if (!current || !isDeepStrictEqual(current, binding)) throw new DomainError('DEVICE_TRANSFER_CONNECTION_CHANGED', 'The actual authenticated transfer connection changed.', 409)
    const original = TransferIntentSchema.parse(await authority.accepted.intent(intent.transferId, binding))
    if (!isDeepStrictEqual(original, intent) || intent.mainId !== this.mainId
      || ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'].some(key => intent[key as keyof TransferIntent] !== binding[key as keyof DeviceSessionBinding])) {
      throw new DomainError('DEVICE_TRANSFER_INTENT_CHANGED', 'The original accepted transfer identity does not match this device.', 409)
    }
    await authority.accepted.authorize(intent, transferContextForBinding(binding), 'start')
    signal.throwIfAborted()
    if (!isDeepStrictEqual(authority.current(), binding)) throw new DomainError('DEVICE_TRANSFER_CONNECTION_CHANGED', 'The authenticated connection changed during original transfer authorization.', 409)
    if (Date.parse(intent.expiresAt) <= Date.now()) throw new DomainError('DEVICE_TRANSFER_EXPIRED', 'The original accepted transfer expired.', 409)
  }
  async readAcceptedTransfer(raw: TransferIntent, authority: AcceptedTrustedConnectionTransfer,
    signal: AbortSignal): Promise<TrustedConnectionRead> {
    const intent = TransferIntentSchema.parse(raw)
    await this.authorizeAcceptedTransfer(intent, authority, signal)
    const current = await this.transaction(client => this.readRecord(client, intent.deviceId))
    await this.authorizeAcceptedTransfer(intent, authority, signal)
    return current
  }
  async checkAcceptedTransfer(raw: TransferIntent, authority: AcceptedTrustedConnectionTransfer, signal: AbortSignal): Promise<TrustedConnectionCheck> {
    const intent = TransferIntentSchema.parse(raw), binding = DeviceSessionBindingSchema.parse(authority.binding)
    const authorize = () => this.authorizeAcceptedTransfer(intent, authority, signal)
    await authorize()
    const before = await this.transaction(client => this.readRecord(client, intent.deviceId)), initial = blocked(before)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(authority.current(), binding)) throw new DomainError('DEVICE_TRANSFER_CONNECTION_CHANGED', 'The authenticated capture changed during the setup read.', 409)
    if (before.registration.mainId !== binding.mainId || before.registration.deviceId !== binding.deviceId || before.registration.workerInstallationId !== binding.workerInstallationId
      || before.registration.keyRevision !== binding.keyRevision || before.registration.authorizationRevision !== binding.authorizationRevision) throw new DomainError('DEVICE_TRANSFER_IDENTITY_CHANGED', 'The registered identity changed before the setup probe.', 409)
    if (initial) return TrustedConnectionCheckSchema.parse({ ...before, state: initial, probe: null, checkedAt: new Date().toISOString() })
    const probe = ConnectionProbeSchema.parse(await (this.ports.probe ?? probeTrustedConnection)(before.consent!.endpoint))
    await authorize()
    const after = await this.transaction(client => this.readRecord(client, intent.deviceId))
    if (after.registration.mainId !== binding.mainId || after.registration.deviceId !== binding.deviceId
      || after.registration.workerInstallationId !== binding.workerInstallationId || after.registration.keyRevision !== binding.keyRevision
      || after.registration.authorizationRevision !== binding.authorizationRevision) throw new DomainError('DEVICE_TRANSFER_IDENTITY_CHANGED', 'The current registered identity differs from the accepted transfer.', 409)
    const fence = blocked(after), changed = !isDeepStrictEqual(after.consent, before.consent)
    const state = fence ?? (changed ? 'consent-required' : probe.state !== 'connected' ? probe.state
      : probe.hostKeyFingerprint !== after.consent!.hostKeyFingerprint ? 'host-key-mismatch'
      : probe.osUser !== after.consent!.endpoint.osUser ? 'permission-denied'
      : !probe.sshVersion || !probe.rsyncVersion || after.consent!.endpoint.transport === 'tailscale' && !probe.tailscaleVersion ? 'tools-missing' : 'ready')
    signal.throwIfAborted()
    if (!isDeepStrictEqual(authority.current(), binding) || Date.parse(intent.expiresAt) <= Date.now()) throw new DomainError('DEVICE_TRANSFER_CONNECTION_CHANGED', 'Accepted transfer authority changed during final setup read.', 409)
    return TrustedConnectionCheckSchema.parse({ ...after, state, probe: fence || changed ? null : probe, checkedAt: new Date().toISOString() })
  }
  async check(principal: ManagementPrincipal, deviceId: string): Promise<TrustedConnectionCheck> {
    const before = await this.read(principal, deviceId)
    const initial = blocked(before)
    if (initial) return TrustedConnectionCheckSchema.parse({ ...before, state: initial, probe: null, checkedAt: new Date().toISOString() })
    const consent = before.consent!
    // No SQL locks across network waits; revalidate everything after the probe.
    const probe = ConnectionProbeSchema.parse(await (this.ports.probe ?? probeTrustedConnection)(consent.endpoint))
    const after = await this.read(principal, deviceId)
    const fence = blocked(after)
    const changed = after.consent?.revision !== consent.revision
    const state = fence ?? (changed ? 'consent-required' : probe.state !== 'connected' ? probe.state
      : probe.hostKeyFingerprint !== consent.hostKeyFingerprint ? 'host-key-mismatch'
      : probe.osUser !== consent.endpoint.osUser ? 'permission-denied'
      : !probe.sshVersion || !probe.rsyncVersion || consent.endpoint.transport === 'tailscale' && !probe.tailscaleVersion ? 'tools-missing' : 'ready')
    return TrustedConnectionCheckSchema.parse({ ...after, state, probe: fence || changed ? null : probe, checkedAt: new Date().toISOString() })
  }
}
