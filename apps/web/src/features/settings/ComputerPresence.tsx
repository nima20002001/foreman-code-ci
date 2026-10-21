import { InfoHint } from '../../shared/ui/InfoHint'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { HarnessHostInventoryMetadata } from '@foreman-code/contracts/harness-registry'
import { useHostHarnessRegistryQuery } from '../../shared/api/computerSettings'
import { presentationFor } from './computerPresenceModel'
import './computerSettings.css'

function yesNo(value: boolean) { return value ? 'Available' : 'Not available' }

export function ComputerPresence({ host, applicationInstallationId, metadata }: { host: CanonicalMachineReference; applicationInstallationId: string; metadata: HarnessHostInventoryMetadata | undefined }) {
  const value = presentationFor(host, applicationInstallationId, metadata)
  return <section aria-label="Worker connection">
    <h3>Worker connection{value.kind === 'main' ? <InfoHint label="Main connection">This is the selected main. It owns scheduling and has no separate worker connection.</InfoHint>
      : value.kind === 'unknown' ? <InfoHint label="Connection">Pairing alone does not mean it is connected or qualified.</InfoHint> : null}</h3>
    {value.kind === 'main' ? <p>Main</p>
      : value.kind === 'unavailable' ? <p>Connection readback is unavailable or does not match this computer.</p>
        : value.kind === 'unknown' ? <p>The server has not observed an authenticated connection from this worker.</p>
          : <dl className="computer-facts">
            <div><dt>Connection</dt><dd>{value.connection.phase === 'ready' ? 'Ready' : 'Offline'}</dd></div>
            <div><dt>Last seen</dt><dd><time dateTime={value.connection.lastSeenAt}>{value.connection.lastSeenAt}</time></dd></div>
            <div><dt>App version</dt><dd>{value.connection.appVersion}</dd></div>
            <div><dt>Protocol version</dt><dd>{value.connection.protocolVersion}</dd></div>
            <div><dt>Job dispatch</dt><dd>{yesNo(value.connection.dispatch)}</dd></div>
            <div><dt>File transfer</dt><dd>{yesNo(value.connection.transfer)}</dd></div>
            <div><dt>Connection generation</dt><dd>{value.connection.binding.connectionGeneration}</dd></div>
          </dl>}
  </section>
}
/** Read-only readback for a chosen folder target; presence never gates or substitutes the server's save/validate decision. */
export function ComputerPresenceReadback({ host, applicationInstallationId }: { host: CanonicalMachineReference; applicationInstallationId: string }) {
  const inventory = useHostHarnessRegistryQuery(host, applicationInstallationId)
  if (inventory.isPending) return <p role="status">Reading computer connection…</p>
  if (inventory.isError) return <p>Connection readback is unavailable. <InfoHint label="Computer">Browse and validation still run on the selected computer.</InfoHint></p>
  return <ComputerPresence host={host} applicationInstallationId={applicationInstallationId} metadata={inventory.data.hostMetadata} />
}
