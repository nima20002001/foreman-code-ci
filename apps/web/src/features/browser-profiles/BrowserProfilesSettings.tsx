import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '../../shared/ui/nocturne'
import { browserAccessDenied, browserErrorMessage, browserRequestUncertain } from '../agent-browser/errors'
import type { BrowserSession, BrowserUiPort } from '../agent-browser/types'
import type { BrowserFilesPort } from '../agent-browser/transferTypes'
import { BrowserProfileDownloads } from './BrowserProfileDownloads'
import { BrowserProfileComputerRows } from './BrowserProfileComputerRows'
import { BrowserProfileForm } from './BrowserProfileForm'
import { BrowserProfileSyncDetails } from './BrowserProfileSyncDetails'
import { browserProfilesKey, useBrowserProfiles } from './queries'
import type { BrowserComputerLabel, BrowserProfile, BrowserProfilesPort } from './types'
import './browserProfiles.css'

type ProfileAction = { commandId: string; run(commandId: string): Promise<void> }

export interface BrowserProfilesSettingsProps {
  visible: boolean
  authBoundary: string
  computers: readonly BrowserComputerLabel[]
  currentComputerId: string
  port: BrowserProfilesPort
  sessionPort: BrowserUiPort
  files: BrowserFilesPort
  onOpenSetup(session: BrowserSession): void
  /** Shell retains a cleanup notice/End setup action when this page has already retired. */
  onSetupCleanupPending(session: BrowserSession, message: string): void
}

export function BrowserProfilesSettings(props: BrowserProfilesSettingsProps) {
  if (!props.visible) return null
  return <VisibleBrowserProfiles key={props.authBoundary} {...props} />
}

function VisibleBrowserProfiles({ authBoundary, computers, currentComputerId, port, sessionPort, files, onOpenSetup, onSetupCleanupPending }: BrowserProfilesSettingsProps) {
  const queryClient = useQueryClient()
  const [denied, setDenied] = useState(false)
  const catalog = useBrowserProfiles(port, authBoundary, !denied)
  const [editor, setEditor] = useState<{ profile: BrowserProfile | null; computerId: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<{ profile: BrowserProfile; computerId: string } | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    if (browserAccessDenied(catalog.error)) {
      setDenied(true); queryClient.removeQueries({ queryKey: browserProfilesKey(authBoundary) })
    }
  }, [catalog.error, authBoundary, queryClient])
  const mutation = useMutation({ mutationFn: (action: ProfileAction) => action.run(action.commandId), retry: false,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: browserProfilesKey(authBoundary) }) },
    onError: error => {
      if (active.current && browserAccessDenied(error)) { setDenied(true); queryClient.removeQueries({ queryKey: browserProfilesKey(authBoundary) }) }
    } })
  const unresolved = mutation.isError && browserRequestUncertain(mutation.error)
  const busy = mutation.isPending || unresolved
  const act = (run: ProfileAction['run']) => { if (!busy) { setNotice(null); mutation.mutate({ commandId: crypto.randomUUID(), run }) } }
  const retry = () => { if (mutation.variables && !mutation.isPending) mutation.mutate(mutation.variables) }
  const sync = (profileIds?: readonly string[]) => act(async commandId => {
    const receipt = await port.sync(profileIds, commandId)
    if (!active.current) return
    // Policy saves never enter this branch. Only an admitted sync receipt can show Queued.
    setJobId(receipt.id)
    setNotice(`Sync ${receipt.state}`)
  })
  const computerNames = new Map(computers.map(computer => [computer.id, computer.name]))
  const profileNames = new Map(catalog.data?.profiles.map(profile => [profile.id, profile.name]) ?? [])
  const accessDenied = denied || browserAccessDenied(catalog.error)
  return <section className="browser-profiles-settings" aria-label="Browser profiles">
    <header><h2>Browser profiles</h2>
      <p>Keep website sign-ins in managed profiles. Agents sharing a profile share its sign-ins and sign-outs.</p></header>
    {accessDenied ? <p role="alert">Browser access is unavailable. Restore access and reopen this page.</p> : <>
      <div className="browser-profile-actions">
        <Button disabled={busy || !catalog.data} onClick={() => setEditor({ profile: null, computerId: currentComputerId })}>Add profile</Button>
        <Button disabled={busy || !catalog.data?.profiles.length} onClick={() => sync()}>Sync profiles to all computers</Button>
      </div>
      {catalog.isPending ? <p role="status">Loading browser profiles…</p> : null}
      {catalog.error ? <p role="alert">{browserErrorMessage(catalog.error)} <Button size="sm" onClick={() => { void catalog.refetch() }}>Retry</Button></p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {mutation.error && !editor ? <div role="alert"><p>{browserErrorMessage(mutation.error)} No new operation is confirmed.</p>
        <Button disabled={mutation.isPending} onClick={retry}>Check original request</Button></div> : null}
      {catalog.data?.profiles.length === 0 ? <p>No browser profiles yet. Add one to keep website sign-ins for your agents.</p> : null}
      {catalog.data ? <div className="browser-profile-computers">{computers.map(computer => <section key={computer.id}
        aria-label={`Browser profiles on ${computer.name}`} className="browser-profile-computer">
        <header><h3>{computer.name}</h3><p>{computer.online ? 'Online' : 'Offline'}
          {!computer.online && computer.lastSeenAt ? <> · Last seen <time dateTime={computer.lastSeenAt}>{computer.lastSeenAt}</time></> : null}
          {computer.runtimeReady ? ' · Browser ready' : ' · Browser setup needed'}</p></header>
        <Button size="sm" disabled={busy} onClick={() => setEditor({ profile: null, computerId: computer.id })}>Add profile here</Button>
        <BrowserProfileComputerRows profiles={catalog.data!.profiles} replicas={catalog.data!.replicas}
          presentReplicas={catalog.data!.presentReplicas}
          pendingReplicas={catalog.data!.pendingReplicas}
          computer={computer} computerNames={computerNames} disabled={busy}
          onOpen={profile => act(async commandId => {
            const session = await port.openSetup(profile.id, computer.id, commandId)
            if (active.current) { onOpenSetup(session); return }
            try {
              const state = await port.closeSetup(session, `retired:${commandId}`)
              if (state === 'pending') onSetupCleanupPending(session, 'Setup browser may still be open. End setup to confirm cleanup.')
            } catch (error) {
              onSetupCleanupPending(session, `Setup browser may still be open. ${browserErrorMessage(error)}`)
            }
          })}
          onEdit={profile => setEditor({ profile, computerId: computer.id })}
          onRemove={profile => act(async commandId => {
            const state = await port.remove(profile.id, computer.id, commandId)
            if (!active.current) return
            setNotice(state === 'removed' ? `Removed ${profile.name} from ${computer.name}. Other copies remain; a later explicit sync may add it again.`
              : `Removal queued on ${computer.name}. Waiting for owned browser work to close.`)
          })}
          onPolicy={(profile, replica) => act(async commandId => {
            const saved = await port.setLocalOverride(profile.id, computer.id, !replica.localOverride, commandId)
            if (!active.current) return
            setNotice(saved.localOverride ? 'Local sign-in is excluded from source updates.' : 'Source updates enabled — sync to apply')
          })}
          onDownloads={profile => setDownloads({ profile, computerId: computer.id })}
          onSync={profile => sync([profile.id])} />
      </section>)}</div> : null}
      {jobId ? <BrowserProfileSyncDetails port={port} authBoundary={authBoundary} jobId={jobId}
        computerNames={computerNames} profileNames={profileNames} /> : null}
      {downloads ? <BrowserProfileDownloads key={`${downloads.profile.id}:${downloads.computerId}`} authBoundary={authBoundary}
        profileId={downloads.profile.id} profileName={downloads.profile.name} computerId={downloads.computerId}
        port={sessionPort} files={files} onClose={() => setDownloads(null)} /> : null}
      {editor ? <BrowserProfileForm key={editor.profile?.id ?? editor.computerId} {...editor} computers={computers}
        profiles={catalog.data?.profiles ?? []}
        pending={mutation.isPending} unresolved={unresolved} error={mutation.error ? browserErrorMessage(mutation.error) : null}
        onRetry={retry} onClose={() => { setEditor(null); mutation.reset() }}
        onAddExisting={(profileId, computerId) => act(async commandId => {
          const receipt = await port.addExisting(profileId, computerId, commandId)
          if (!active.current) return
          setEditor(null)
          setNotice(receipt.state === 'ready' ? 'Profile added on this computer.' : receipt.state === 'first_snapshot_pending'
            ? 'Waiting for the first source snapshot. The profile will appear here after it is received and applied.'
            : 'Adding profile on this computer. Waiting for the computer to confirm it is ready.')
        })}
        onSave={(name, computerId, distribution) => act(async commandId => {
          if (editor.profile) await port.update(editor.profile.id, { name, sourceComputerId: computerId, distribution }, commandId)
          else await port.create(name, computerId, distribution, commandId)
          if (!active.current) return
          setEditor(null); setNotice('Profile saved. Open its browser to sign in.')
        })} /> : null}
    </>}
  </section>
}
