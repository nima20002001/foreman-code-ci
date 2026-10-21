import { computerDisplayName } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useSelectedMainQuery, useRegisteredComputersQuery } from '../shared/api/computerSettings'
import { useComputerMaintenance } from '../shared/api/computerMaintenance'
import { sessionGeneration } from '../shared/api/sessionBoundary'

export const browserAuthBoundary = () => String(sessionGeneration())
export function useBrowserComputers() {
  const main = useSelectedMainQuery(), registrations = useRegisteredComputersQuery(main.data?.mainId)
  const mainId = main.data?.mainId
  const targets: DeviceProvisioningTarget[] = mainId ? [
    { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null },
    ...(registrations.data?.devices.filter(device => device.status === 'paired').map(device => ({
      hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId }, applicationInstallationId: device.workerInstallationId,
      keyRevision: device.keyRevision, authorizationRevision: device.authorizationRevision })) ?? []),
  ] : []
  const maintenance = useComputerMaintenance(targets)
  const computers = targets.map((target, index) => ({
    id: target.hostRef.kind === 'main' ? target.hostRef.mainId : target.hostRef.deviceId,
    name: computerDisplayName(target.hostRef), online: target.hostRef.kind === 'main' || maintenance[index]?.data?.status != null,
    runtimeReady: maintenance[index]?.data?.status?.browserRuntime?.ready === true, lastSeenAt: null,
  }))
  return { mainId, targets, computers, error: main.error ?? registrations.error ?? maintenance.find(query => query.error)?.error }
}
