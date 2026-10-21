import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog } from '../../shared/ui/nocturne'
import { BrowserSessionSchema } from '@foreman-code/contracts/browser-sessions'
import { BrowserTransfers } from '../agent-browser/BrowserTransfers'
import { validateBrowserRead } from '../agent-browser/queries'
import { browserAccessDenied, browserErrorMessage } from '../agent-browser/errors'
import type { BrowserUiPort } from '../agent-browser/types'
import type { BrowserFilesPort } from '../agent-browser/transferTypes'

/** Retained downloads use session history reads only; opening this dialog never starts capture. */
export function BrowserProfileDownloads({ authBoundary, profileId, computerId, profileName, port, files, onClose }: {
  authBoundary: string; profileId: string; computerId: string; profileName: string
  port: BrowserUiPort; files: BrowserFilesPort; onClose(): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: ['browser-downloads', authBoundary, profileId, computerId], retry: false, enabled: !denied,
    queryFn: async ({ signal }) => {
      const values = (await port.listSetupSessions(profileId, computerId, signal)).map(value => BrowserSessionSchema.parse(value))
      if (values.some(value => value.subject || value.setupForProfileId !== profileId || value.computerId !== computerId)) {
        throw new Error('Downloads do not match this profile and computer.')
      }
      return values
    } })
  const read = useQuery({ queryKey: ['browser-downloads', authBoundary, profileId, computerId, selected], enabled: selected !== null && !denied,
    retry: false, queryFn: async ({ signal }) => {
      const value = validateBrowserRead(await port.readSession(selected!, signal))
      if (value.session.id !== selected || value.session.subject || value.session.setupForProfileId !== profileId
        || value.session.computerId !== computerId) throw new Error('The downloads session changed.')
      return value
    } })
  const error = sessions.error ?? read.error
  useEffect(() => {
    if (browserAccessDenied(error)) { setDenied(true); queryClient.removeQueries({ queryKey: ['browser-downloads', authBoundary] }) }
  }, [error, queryClient, authBoundary])
  return <Dialog open title={`Downloads · ${profileName}`} onOpenChange={open => { if (!open) onClose() }}>
    {denied || browserAccessDenied(error) ? <p role="alert">Browser file access is unavailable. Restore access and reopen this profile.</p> : <>
    {sessions.isPending ? <p role="status">Loading browser history…</p> : null}
    {error ? <p role="alert">{browserErrorMessage(error)} <Button onClick={() => {
      void (selected ? read.refetch() : sessions.refetch())
    }}>Retry downloads</Button></p> : null}
    {sessions.data?.length === 0 ? <p>No setup browser history for this profile on this computer.</p> : null}
    <div className="browser-profile-actions">{sessions.data?.map(session => <Button key={session.id}
      aria-pressed={session.id === selected} onClick={() => setSelected(session.id)}>
      {session.id.slice(0, 8)} · {session.state}
    </Button>)}</div>
    {selected && read.isPending ? <p role="status">Loading retained files…</p> : null}
    {read.data ? <><p>Files remain after setup closes until you delete them.</p>
      {read.data.files.length ? <BrowserTransfers port={files} session={read.data.session} downloads={read.data.files}
        onDenied={() => { setDenied(true); queryClient.removeQueries({ queryKey: ['browser-downloads', authBoundary] }) }}
        onChanged={() => { void read.refetch() }} /> : <p>No retained downloads for this session.</p>}</> : null}
    </>}
  </Dialog>
}
