import type pg from 'pg'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { DomainError } from '../errors.js'

export async function assertComputerTarget(sql: pg.PoolClient, mainId: string,
  target: DeviceProvisioningTarget): Promise<void> {
  if (target.hostRef.mainId !== mainId) {
    throw new DomainError('COMPUTER_NOT_FOUND', 'This computer belongs to another Main.', 404)
  }
  if (target.hostRef.kind === 'main') {
    if (target.applicationInstallationId !== mainId) {
      throw new DomainError('COMPUTER_NOT_FOUND', 'Main installation changed.', 404)
    }
    return
  }
  const row = (await sql.query<{ record: unknown }>(`select record from device_registrations
    where main_id=$1 and record->>'deviceId'=$2 and record->>'status'='paired' limit 1`,
  [mainId, target.hostRef.deviceId])).rows[0]
  const registration = row && DeviceRegistrationSchema.parse(row.record)
  const matches = registration && sameDeviceProvisioningTarget(target, {
    hostRef: target.hostRef,
    applicationInstallationId: registration.workerInstallationId,
    keyRevision: registration.keyRevision,
    authorizationRevision: registration.authorizationRevision,
  })
  if (!matches) {
    throw new DomainError('COMPUTER_NOT_FOUND', 'This computer is not currently paired with that installation.', 404)
  }
}
