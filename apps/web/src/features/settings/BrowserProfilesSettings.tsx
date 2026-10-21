import type { BrowserProfilesSettingsSearch } from '@foreman-code/contracts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { computerDisplayName } from '@foreman-code/contracts/computer-activity'
import { useSelectedMainQuery, useRegisteredComputersQuery } from '../../shared/api/computerSettings'
import { useCollaborationUISlots } from '../../shared/ui/collaborationSlots'
import { Alert, Button, Select } from '../../shared/ui/nocturne'

/** D owns the destination/filter; B owns and mounts the profile manager body. */
export function BrowserProfilesSettings({ search, onSearch }: {
  search: BrowserProfilesSettingsSearch; onSearch(search: BrowserProfilesSettingsSearch): void
}) {
  const slots = useCollaborationUISlots(), main = useSelectedMainQuery()
  const current = main.isSuccess ? main.data : undefined
  const registrations = useRegisteredComputersQuery(current?.mainId)
  const devices = registrations.data?.devices.filter(device => device.status === 'paired') ?? []
  const device = devices.find(item => item.deviceId === search.deviceId)
  const mismatch = !!search.mainId && !!current && search.mainId !== current.mainId
  const unknownDevice = search.computer === 'device' && registrations.isSuccess && !device
  const target: DeviceProvisioningTarget | undefined = current && !mismatch ? search.computer === 'main'
    ? { hostRef: { kind: 'main', mainId: current.mainId }, applicationInstallationId: current.mainId, keyRevision: null, authorizationRevision: null }
    : search.computer === 'device' && device ? { hostRef: { kind: 'device', mainId: current.mainId, deviceId: device.deviceId },
      applicationInstallationId: device.workerInstallationId, keyRevision: device.keyRevision, authorizationRevision: device.authorizationRevision } : undefined : undefined
  return <section className="settings-editor-page" aria-label="Browser profiles">
    <h1>Browser profiles</h1><p>Manage browser sign-in profiles on their computer.</p>
    {main.isError || registrations.isError ? <Alert tone="warning" title="Computers could not be read.">
      <Button onClick={() => { void main.refetch(); void registrations.refetch() }}>Retry computers</Button></Alert> : null}
    {!current ? <p role="status">Loading Main PC…</p> : <Select label="Computer" value={search.computer === 'device' ? `device:${search.deviceId}` : search.computer ?? 'all'}
      options={[{ value: 'all', label: 'All computers' }, { value: 'main', label: 'Main PC' },
        ...(unknownDevice ? [{ value: `device:${search.deviceId}`, label: 'Selected computer unavailable' }] : []),
        ...devices.map(item => ({ value: `device:${item.deviceId}`, label: computerDisplayName({ kind: 'device', deviceId: item.deviceId }) }))]}
      onChange={event => onSearch({ mainId: current.mainId, ...(event.target.value === 'main' ? { computer: 'main' as const }
        : event.target.value.startsWith('device:') ? { computer: 'device' as const, deviceId: event.target.value.slice(7) } : {}) })} />}
    {mismatch || unknownDevice ? <Alert tone="warning" title="The selected computer is unavailable. Choose a computer to continue." />
      : current && !main.isError && !registrations.isError && (search.computer !== 'device' || target)
        ? slots?.browserProfiles?.({ mainId: current.mainId, ...(target ? { computer: target } : {}) })
          ?? <p role="status">Browser profile management is not available yet.</p> : null}
  </section>
}
