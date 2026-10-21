import { create } from 'zustand'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { ComputerCards } from '../computers/ComputerCards'
import { useRegisteredComputersQuery, useSelectedMainQuery } from '../../shared/api/computerSettings'
import { Alert, Button, LoadingState } from '../../shared/ui/nocturne'
import { ComputerRevokeButton } from './ComputerRevokeButton'
import { ComputerPairingForm } from './ComputerPairingForm'
import { ConnectionSetupStatus } from './DeviceSetupGuide'
import { CircleCiSummaryCard } from './CircleCiSummaryCard'
import './computerSettings.css'
import { Link } from '@tanstack/react-router'

/** Which main's Add computer panel is open, keyed by session generation and main so a new session or main starts closed. */
const useAddPanel = create<{ scope?: string; toggle(scope: string): void }>(set => ({
  toggle: scope => set(state => ({ scope: state.scope === scope ? undefined : scope })),
}))

/** Summary cards only. The Operator changes computer settings through MCP; pairing and revocation stay human actions. */
export function ComputerSettings({ deviceId, onSelectComputer }: { deviceId?: string; onSelectComputer?(deviceId: string): void }) {
  const main = useSelectedMainQuery()
  const currentMain = main.isSuccess ? main.data : undefined
  const computers = useRegisteredComputersQuery(currentMain?.mainId)
  const devices = computers.isSuccess ? computers.data.devices : []
  const registration = devices.find(value => value.deviceId === deviceId)
  const addScope = useAddPanel(state => state.scope)
  const toggleAdd = useAddPanel(state => state.toggle)
  const adding = currentMain !== undefined && addScope === `${sessionGeneration()}:${currentMain.mainId}`
  const readFailure = main.isError ? <><Alert tone="danger" title="Main PC could not be read." />
    <Button onClick={() => void main.refetch()}>Retry Main PC</Button></>
    : computers.isError ? <><Alert tone="danger" title="Computers could not be read." />
      <Button onClick={() => void computers.refetch()}>Retry computers</Button></> : null
  const loading = !currentMain ? <LoadingState label="Loading Main PC…" /> : computers.isPending ? <LoadingState label="Loading computers…" /> : null
  return <section className="settings-editor-page computers-page" aria-label={deviceId ? 'Computer details' : 'Computers'}>
    <header className="computers-header"><div className="settings-experience-heading"><h1>{deviceId ? 'Computer details' : 'Computers'}</h1></div>
      {currentMain && !deviceId ? <Button variant="primary" aria-expanded={adding} aria-controls="computer-add-panel" onClick={() => toggleAdd(`${sessionGeneration()}:${currentMain.mainId}`)}>{adding ? 'Close' : 'Add computer'}</Button> : null}</header>
    {currentMain && !deviceId ? <div id="computer-add-panel" className="computers-panel" hidden={!adding}><ComputerPairingForm key={currentMain.mainId} mainId={currentMain.mainId} /></div> : null}
    {readFailure ?? loading ?? (deviceId
      ? registration ? <>
        <ComputerCards mainId={currentMain!.mainId} devices={devices} only={registration.deviceId} />
        {registration.status !== 'revoked' ? <ConnectionSetupStatus registration={registration} /> : null}
        <section className="computer-action-card" aria-label="Remove this computer">
          <h2>Remove this computer</h2>
          <ComputerRevokeButton key={`${registration.mainId}:${registration.deviceId}`} registration={registration} />
        </section>
      </> : <Alert tone="warning" title="This device is not registered with the selected main." />
      : <ComputerCards mainId={currentMain!.mainId} devices={devices} onSelectComputer={onSelectComputer} />)}
    {!deviceId && !readFailure && !loading && currentMain
      ? <Link to="/settings/browser-profiles" search={{ mainId: currentMain.mainId }}>Browser profiles</Link> : null}
    {!deviceId && <CircleCiSummaryCard />}
  </section>
}
