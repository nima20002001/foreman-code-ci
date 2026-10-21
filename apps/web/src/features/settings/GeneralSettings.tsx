import { useComputerActivity, computerKey } from '../../shared/api/computerActivity'
import { Alert, Button, LoadingState, Select } from '../../shared/ui/nocturne'
import { ComputerSyncPanel } from '../computers/ComputerSync'
import { useSyncedTheme } from '../theme/useSyncedTheme'
import { ThemeSchema } from '@foreman-code/contracts/management'
import { ChatRetentionSettings } from '../retention-settings'
import './settingsExperience.css'

export function GeneralSettings() {
  const { settings, update, changeTheme, denied, uncertain, refresh, retry } = useSyncedTheme()
  const computers = useComputerActivity()
  return <section className="settings-editor-page" aria-label="General settings">
    <header className="settings-experience-heading"><h1>General</h1></header>
    <h2>Appearance</h2>
    {settings.isPending && <LoadingState label="Reading general settings…" />}
    {settings.isError && <Alert tone="warning" title={settings.error.message} />}
    {settings.data && !denied && <Select label="Theme" value={settings.data.value.theme}
      options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }]}
      disabled={settings.isError || update.isPending || update.isError}
      onChange={event => changeTheme(ThemeSchema.parse(event.target.value))} />}
    {update.isPending && <p role="status">Saving theme on Main…</p>}
    {update.isError && <Alert tone="warning" title={update.error.message}>
      {uncertain && <Button size="sm" disabled={denied} onClick={retry}>Retry theme save</Button>}
    </Alert>}
    <Button size="sm" disabled={settings.isFetching || update.isPending} onClick={() => void refresh()}>
      Refresh general settings
    </Button>
    <div className="settings-editor-content"><ChatRetentionSettings /></div>
    <h2>File sync by computer</h2>
    {computers.isPending && <LoadingState label="Reading computers…" />}
    {computers.isError && <Alert tone="warning" title={computers.error.message}>
      <Button onClick={() => void computers.refetch()}>Refresh computers</Button>
    </Alert>}
    {computers.data && !computers.isError && <>
      {!computers.data.activityComplete && <p role="status">Some computer status is unavailable.</p>}
      {computers.data.truncated && <p role="status">Only the first computers are shown.</p>}
      {computers.data.computers.map(computer => <section className="computer-sync-folder"
        aria-label={`Sync on ${computer.name}`} key={JSON.stringify(computer.target)}>
        <h3>{computer.name}</h3>
        <p>{computer.online ? 'Online' : 'Offline'}</p>
        <h4>Workspace files</h4>
        <ComputerSyncPanel key={computerKey(computer.target)} target={computer.target} />
      </section>)}
    </>}
  </section>
}
