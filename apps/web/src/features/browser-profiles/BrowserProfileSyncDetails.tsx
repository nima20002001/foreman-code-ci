import { Button } from '../../shared/ui/nocturne'
import { browserAccessDenied, browserErrorMessage } from '../agent-browser/errors'
import { useBrowserProfileSync } from './queries'
import type { BrowserProfilesPort } from './types'

export function BrowserProfileSyncDetails({ port, authBoundary, jobId, computerNames, profileNames }: {
  port: BrowserProfilesPort; authBoundary: string; jobId: string
  computerNames: ReadonlyMap<string, string>; profileNames: ReadonlyMap<string, string>
}) {
  const query = useBrowserProfileSync(port, authBoundary, jobId, true)
  if (browserAccessDenied(query.error)) return <p role="alert">Browser access is unavailable.</p>
  return <section className="browser-profile-sync" aria-label="Profile sync progress">
    <h3>Profile sync</h3>
    {query.isPending ? <p role="status">Loading profile sync…</p> : null}
    {query.error ? <p role="alert">{browserErrorMessage(query.error)}</p> : null}
    {query.data ? <>
      <p role="status">{query.data.state === 'completed' && !query.data.targets.some(target => target.state !== 'excluded')
        ? 'No other computers to update.' : `Sync ${query.data.state}`}</p>
      <ul>{query.data.profiles.map(source => <li key={source.profileId}>
        {profileNames.get(source.profileId) ?? 'Unavailable profile'} · Source on {computerNames.get(source.sourceComputerId) ?? 'Unavailable computer'} · {source.state}
        {source.reason ? ` · ${source.reason}` : ''}
      </li>)}</ul>
      <ul>{query.data.targets.map(target => <li key={`${target.profileId}:${target.computerId}`}>
        {profileNames.get(target.profileId) ?? 'Unavailable profile'} · {computerNames.get(target.computerId) ?? 'Unavailable computer'} · {target.state}
        {target.exclusion ? ` (${target.exclusion.replaceAll('_', ' ')})` : ''}{target.reason ? ` · ${target.reason}` : ''}
      </li>)}</ul>
      <small>Applying a source snapshot does not verify website sign-ins on another computer.</small>
    </> : null}
    <Button size="sm" variant="ghost" disabled={query.isFetching} onClick={() => { void query.refetch() }}>Refresh progress</Button>
  </section>
}
