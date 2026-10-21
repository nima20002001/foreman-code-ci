import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useComputerSync } from '../../shared/api/computerSync'
import { Alert, Button, LoadingState, Switch } from '../../shared/ui/nocturne'

export function ComputerSyncPanel({ target }: { target: DeviceProvisioningTarget }) {
  const state = useComputerSync(target)
  return <ComputerSyncContent state={state} />
}

function ComputerSyncContent({ state }: { state: ReturnType<typeof useComputerSync> }) {
  const { status, update, change, retry, uncertain, refresh } = state
  return <>
      {status.isPending && <LoadingState label="Reading sync status…" />}
      {status.isError && <Alert tone="danger" title={status.error.message} />}
      {status.data?.message && <Alert tone="warning" title={status.data.message} />}
      <Button size="sm" disabled={status.isFetching || update.isPending} onClick={() => void refresh()}>Refresh sync status</Button>
      {update.isError && <Alert tone="danger" title={update.error.message}>
        {uncertain && <Button size="sm" disabled={update.isPending} onClick={retry}>Retry sync save</Button>}
      </Alert>}
      {status.data?.folders.map(folder => <section key={folder.workspaceId} className="computer-sync-folder"
        aria-label={`Shared files for ${folder.name}`}>
        <Switch label={`Sync ${folder.name}`} checked={folder.enabled}
          disabled={update.isPending || update.isError || status.isError}
          onChange={event => change(folder.workspaceId, event.target.checked, folder.revision)} />
        {!folder.participating && <p>Sync starts when an Agent from this workspace runs on this computer.</p>}
        {folder.status && <>
          <p>{folder.status.connected ? 'Connected' : 'Disconnected'} · {folder.status.state}</p>
          <code className="computer-sync-path">{folder.status.path}</code>
          {folder.status.message && <Alert tone="danger" title={folder.status.message} />}
          {folder.status.conflicts.length > 0 && <div><p>Conflicting copies need your review:</p>
            <ul>{folder.status.conflicts.map(file => <li key={file}>{file}</li>)}</ul></div>}
        </>}
      </section>)}
      {status.data && !status.data.folders.length && <p>Create a workspace to share files.</p>}
  </>
}
