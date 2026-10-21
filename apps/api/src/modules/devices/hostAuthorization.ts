import type { GraphSqlClient } from '../run-graph/connection.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DeviceRegistrationSchema, type CanonicalMachineReference, type DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { DeviceAccessError } from './accessError.js'
import { authorizationReadSnapshot } from '../access/authorizationReadSnapshot.js'

/** Identity only: the caller checks its domain grants first and retains this command transaction's locks.
 * Returns current key/auth revisions for the caller's pin checks; null denotes the original main. */
export async function assertDeviceHostInstallation(client: GraphSqlClient,
  host: CanonicalMachineReference, applicationInstallationId: string): Promise<DeviceRegistration | null> {
  const snapshot = await authorizationReadSnapshot(client)
  const mainId = snapshot ? snapshot.main_id : (await client.query<{ id: string }>(
    'select id from application_installation where singleton=true for share')).rows[0]?.id
  if (mainId !== host.mainId) throw new DeviceAccessError('wrong_main')
  if (host.kind === 'main') {
    if (applicationInstallationId !== host.mainId) throw new DeviceAccessError('unauthorized')
    return null
  }
  const selected = snapshot?.placement.hostRef
  const sameDevice = selected?.kind === 'device' && selected.mainId === host.mainId && selected.deviceId === host.deviceId
  const device = snapshot && sameDevice ? snapshot.device : (await client.query<{ record: unknown }>(
    'select record from device_registrations where id=$1 and main_id=$2 for share', [host.deviceId, host.mainId])).rows[0]?.record
  if (!device) throw new DeviceAccessError('unauthorized')
  const registration = DeviceRegistrationSchema.parse(device)
  if (registration.status !== 'paired') throw new DeviceAccessError(registration.status === 'revoked' ? 'revoked' : 'unauthorized')
  if (registration.mainId !== host.mainId || registration.deviceId !== host.deviceId
    || registration.workerInstallationId !== applicationInstallationId) throw new DeviceAccessError('unauthorized')
  return registration
}

/** Use the command's transaction so revocation cannot race a host-scoped settings mutation. */
export async function authorizeDeviceHost(client: GraphSqlClient, principal: ManagementPrincipal,
  action: 'harnesses:read' | 'harnesses:update', host: CanonicalMachineReference, applicationInstallationId: string): Promise<void> {
  requireAuthorization(await readLiveManagementPrincipal(client, principal.id), action)
  await assertDeviceHostInstallation(client, host, applicationInstallationId)
}
