import { Button } from '../../shared/ui/nocturne'
import type { BrowserComputerLabel, BrowserProfile, BrowserProfileReplica, BrowserProfileCatalog } from './types'

function replicaTransferLabel(replica: BrowserProfileReplica | undefined): string {
  if (!replica) return 'Not added here'
  if (replica.localOverride) return 'Local sign-in · excluded from source updates'
  const labels: Record<BrowserProfileReplica['transfer'], string> = {
    missing: 'Not added here', update_available: 'Source updates enabled — sync to apply', queued: 'Queued',
    applying: 'Applying source snapshot', up_to_date: 'Source snapshot applied', failed: 'Update failed',
    offline: 'Computer offline', local_only: 'Local only',
  }
  return labels[replica.transfer]
}

export function BrowserProfileComputerRows({ profiles, replicas, presentReplicas, pendingReplicas, computer, computerNames, disabled,
  onOpen, onEdit, onRemove, onPolicy, onSync, onDownloads }: {
  profiles: readonly BrowserProfile[]; replicas: readonly BrowserProfileReplica[]; computer: BrowserComputerLabel
  presentReplicas: readonly { profileId: string; computerId: string }[]
  pendingReplicas: BrowserProfileCatalog['pendingReplicas']
  computerNames: ReadonlyMap<string, string>; disabled: boolean
  onOpen(profile: BrowserProfile): void; onEdit(profile: BrowserProfile): void; onRemove(profile: BrowserProfile): void
  onPolicy(profile: BrowserProfile, replica: BrowserProfileReplica): void; onSync(profile: BrowserProfile): void
  onDownloads(profile: BrowserProfile): void
}) {
  return <ul className="browser-profile-rows" aria-label={`Browser profiles on ${computer.name}`}>
    {profiles.map(profile => {
      const replica = replicas.find(value => value.profileId === profile.id && value.computerId === computer.id)
      const source = profile.sourceComputerId === computer.id
      const present = presentReplicas.some(copy => copy.profileId === profile.id && copy.computerId === computer.id)
      const pending = pendingReplicas.find(copy => copy.profileId === profile.id && copy.computerId === computer.id)
      return <li key={profile.id}>
        <h4>{profile.name}</h4>
        <p>{source ? 'Source on this computer' : `Source: ${computerNames.get(profile.sourceComputerId) ?? 'Unavailable computer'}`}
          {profile.distribution === 'local_only' ? ' · Local-only profile' : ''}</p>
        <p>{pending ? pending.operation === 'remove' ? 'Removal queued — waiting for browser/computer'
          : pending.operation === 'create' ? 'Adding profile — waiting for computer' : 'Waiting to apply source snapshot'
          : !present ? 'Not added here' : source && replica?.transfer === 'missing'
          ? profile.publishedRevision === 0 ? 'No source snapshot published yet' : 'Source snapshot needs publication'
          : profile.distribution === 'shared' && !source && replica && !replica.localOverride && replica.transfer === 'local_only'
            ? 'Source updates enabled — sync to apply'
          : replicaTransferLabel(replica)}</p>
        {replica?.reason ? <p>{replica.reason}</p> : null}
        <LoginEvidence replica={replica} />
        <div className="browser-profile-actions">
          <Button size="sm" disabled={disabled || !computer.online || !computer.runtimeReady || !present || pending?.operation === 'remove'}
            onClick={() => onOpen(profile)}>Open browser</Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onEdit(profile)}>Edit profile</Button>
          {!source && replica && profile.distribution === 'shared' ? <Button size="sm" variant="ghost" disabled={disabled}
            onClick={() => onPolicy(profile, replica)}>{replica.localOverride ? 'Use source updates' : 'Keep local sign-in'}</Button> : null}
          {profile.distribution === 'shared' ? <Button size="sm" variant="ghost" disabled={disabled}
            onClick={() => onSync(profile)}>Sync profile</Button> : null}
          {present ? <Button size="sm" variant="ghost" disabled={disabled || pending?.operation === 'remove'}
            onClick={() => onRemove(profile)}>Remove from this computer</Button> : null}
          <Button size="sm" variant="ghost" onClick={() => onDownloads(profile)}>Downloads</Button>
        </div>
        {!source && profile.distribution === 'shared' && !replica?.localOverride ? <small>
          Opening the browser does not change sync policy. Choose Keep local sign-in to exclude this computer from source updates.
        </small> : null}
      </li>
    })}
  </ul>
}

function LoginEvidence({ replica }: { replica: BrowserProfileReplica | undefined }) {
  if (!replica?.loginEvidence.length) return <p>Website sign-in: not checked on this computer.</p>
  const labels = { not_checked: 'Not checked', signed_in: 'Signed in when checked', sign_in_required: 'Sign-in required', unknown: 'Could not verify sign-in' }
  return <ul className="browser-login-evidence" aria-label="Website sign-in checks">{replica.loginEvidence.map(evidence =>
    <li key={evidence.origin}>{evidence.origin} · {labels[evidence.state]}
      {evidence.checkedAt ? <> · <time dateTime={evidence.checkedAt}>{evidence.checkedAt}</time></> : null}
      {evidence.evidence === 'user_confirmed' ? ' · Confirmed by you' : null}
      {evidence.reason ? <small>{evidence.reason}</small> : null}
    </li>)}</ul>
}
