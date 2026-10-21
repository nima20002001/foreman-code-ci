import type { SqlQuery } from '../../infrastructure/transaction.js'
import { createHash, hkdfSync, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { BrowserPairingAuthority, BrowserInstallationBinding } from '../browser-profiles/keys.js'
import { DomainError } from '../errors.js'

export function browserConnectionBinding(binding: DeviceSessionBinding): BrowserInstallationBinding {
  return { computerId: binding.deviceId, installationId: binding.workerInstallationId,
    connectionId: commandInputHash(binding) }
}
export function browserWrappingKey(secret: Uint8Array, binding: BrowserInstallationBinding) {
  return new Uint8Array(hkdfSync('sha256', secret, Buffer.from(binding.connectionId),
    Buffer.from(`browser-profile:${binding.computerId}:${binding.installationId}`), 32))
}
export class MainBrowserPairing implements BrowserPairingAuthority {
  private readonly connectionId = randomUUID()
  constructor(private readonly pool: pg.Pool, readonly mainId: () => string,
    private readonly connection: (deviceId: string) => DeviceSessionBinding | null) {}
  async current(computerId: string, sql: SqlQuery = this.pool): Promise<BrowserInstallationBinding> {
    if (computerId === this.mainId()) return { computerId, installationId: computerId, connectionId: this.connectionId }
    const row = (await sql.query<{ record: unknown }>('select record from device_registrations where id=$1 and main_id=$2',
      [computerId, this.mainId()])).rows[0]
    if (!row) throw new DomainError('BROWSER_COMPUTER_NOT_FOUND', 'The selected browser computer is not registered.', 404)
    const registration = DeviceRegistrationSchema.parse(row.record)
    if (registration.status !== 'paired') throw new DomainError('BROWSER_PAIRING_CHANGED', 'This computer is no longer paired.', 403)
    const binding = this.connection(computerId)
    if (!binding) return { computerId, installationId: registration.workerInstallationId, connectionId: `offline:${registration.authorizationRevision}` }
    if (binding.workerInstallationId !== registration.workerInstallationId || binding.keyRevision !== registration.keyRevision
      || binding.authorizationRevision !== registration.authorizationRevision) throw new DomainError('BROWSER_PAIRING_CHANGED',
      'The browser computer connection belongs to an older installation.', 403)
    return browserConnectionBinding(binding)
  }
  async assertCurrent(binding: BrowserInstallationBinding) {
    const current = await this.current(binding.computerId)
    if (current.installationId !== binding.installationId || current.connectionId !== binding.connectionId) {
      throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser computer connection changed.', 409)
    }
  }
  async assertInstallation(computerId: string, installationId: string) {
    if ((await this.current(computerId)).installationId !== installationId) throw new DomainError('BROWSER_PAIRING_CHANGED',
      'The browser operation belongs to another computer installation.', 409)
  }
  async wrappingKey(binding: BrowserInstallationBinding): Promise<Uint8Array> {
    await this.assertCurrent(binding)
    let secret: Buffer
    if (binding.computerId === this.mainId()) {
      const row = (await this.pool.query<{ private_key: string }>(
        "select record->>'privateKey' as private_key from device_main_identity where main_id=$1", [this.mainId()])).rows[0]
      if (!row?.private_key) throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'Main browser key authority is unavailable.', 503)
      secret = createHash('sha256').update(row.private_key).digest()
    } else {
      const row = (await this.pool.query<{ credential_hash: string }>(
        'select credential_hash from device_registrations where id=$1', [binding.computerId])).rows[0]
      if (!row?.credential_hash) throw new DomainError('BROWSER_KEY_UNAVAILABLE', 'The paired browser key is unavailable.', 403)
      secret = Buffer.from(row.credential_hash, 'hex')
    }
    return browserWrappingKey(secret, binding)
  }
}
