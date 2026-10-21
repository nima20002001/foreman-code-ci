import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog, Select, TextField } from '../../shared/ui/nocturne'
import { BrowserSessionPanel } from '../agent-browser/AgentBrowserPanel'
import { browserAccessDenied, browserErrorMessage, browserRequestUncertain } from '../agent-browser/errors'
import type { BrowserFilesPort } from '../agent-browser/transferTypes'
import { validateBrowserRead } from '../agent-browser/queries'
import type { BrowserSession, BrowserUiPort } from '../agent-browser/types'
import type { BrowserProfilesPort } from './types'

export interface BrowserSetupDialogProps {
  authBoundary: string; session: BrowserSession; profileName: string; computerName: string
  port: BrowserUiPort; files: BrowserFilesPort; profiles: BrowserProfilesPort; onClosed(): void; onCleanupError(message: string): void
}

export function BrowserSetupDialog(props: BrowserSetupDialogProps) {
  if (!props.session.setupForProfileId || props.session.subject) throw new Error('Profile setup needs a setup browser session.')
  return <SetupBrowser key={`${props.authBoundary}:${props.session.id}:${props.session.browserGeneration}`} {...props} />
}

function SetupBrowser(props: BrowserSetupDialogProps) {
  const queryClient = useQueryClient()
  const key = ['browser-setup', props.authBoundary, props.session.id, props.session.browserGeneration] as const
  const [viewerId] = useState(() => crypto.randomUUID())
  const [closeId] = useState(() => crypto.randomUUID())
  const [tabId, setTabId] = useState<string | null>(null)
  const [connection, setConnection] = useState(0)
  const [denied, setDenied] = useState(false)
  const active = useRef(true)
  const mounted = useRef(false)
  const lifetime = useRef(0)
  const [cleanupError, setCleanupError] = useState<string | null>(null)
  const recoveryCommand = useRef<string | null>(null)
  const read = useQuery({ queryKey: key, enabled: !denied, retry: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const result = validateBrowserRead(await props.port.readSession(props.session.id, signal))
      if (result.session.id !== props.session.id || result.session.setupForProfileId !== props.session.setupForProfileId
        || result.session.subject || result.session.browserGeneration !== props.session.browserGeneration) {
        throw new Error('The setup browser changed. Reopen this profile to continue.')
      }
      return result
    }, refetchInterval: query => query.state.data && !['closed', 'failed'].includes(query.state.data.session.state) ? 1500 : false,
    refetchIntervalInBackground: false })
  useEffect(() => {
    if (browserAccessDenied(read.error)) {
      setDenied(true); queryClient.removeQueries({ queryKey: ['browser-setup', props.authBoundary, props.session.id] })
    }
  }, [read.error, queryClient, props.authBoundary, props.session.id])
  const recovery = useMutation({ mutationFn: async (commandId: string) => {
    const result = validateBrowserRead(await props.port.reconnect(props.session, commandId))
    if (result.session.id !== props.session.id || result.session.browserGeneration !== props.session.browserGeneration
      || result.session.setupForProfileId !== props.session.setupForProfileId || result.session.subject) {
      throw new Error('The setup browser changed. Reopen the selected profile.')
    }
    return result
  }, retry: false, onSuccess: result => {
    if (!mounted.current) return
    recoveryCommand.current = null; queryClient.setQueryData(key, result); setConnection(value => value + 1)
  }, onError: error => {
    if (!mounted.current) return
    if (!browserRequestUncertain(error)) recoveryCommand.current = null
    if (browserAccessDenied(error)) { setDenied(true); queryClient.removeQueries({ queryKey: key }) }
  } })
  const reconnect = () => {
    if (recovery.isPending) return
    recoveryCommand.current ??= crypto.randomUUID(); recovery.mutate(recoveryCommand.current)
  }
  const close = useMutation({ mutationFn: () => props.port.closeSession(props.session, closeId), retry: false,
    onSuccess: result => {
      if (result === 'pending') {
        if (mounted.current) setCleanupError('Setup browser may still be open. Check End setup again.')
        else props.onCleanupError('Setup browser may still be open. Check End setup again.')
      } else { active.current = false; if (mounted.current) props.onClosed() }
    } })
  const callbacks = useRef(props)
  callbacks.current = props
  useEffect(() => {
    lifetime.current += 1
    mounted.current = true
    return () => {
      mounted.current = false
      const ending = ++lifetime.current
      queueMicrotask(() => {
        if (lifetime.current !== ending || !active.current) return
        const current = callbacks.current
        void current.port.closeSession(current.session, closeId).then(result => {
          if (result === 'pending') current.onCleanupError('Setup browser may still be open. Reconnect view or End setup from this profile.')
        }).catch(error => current.onCleanupError(browserErrorMessage(error)))
      })
    }
  }, [closeId])
  const tab = read.data?.tabs.find(item => item.tabId === (tabId ?? read.data.session.selectedTabId))
  const accessDenied = denied || browserAccessDenied(read.error)
  return <Dialog open size="xl" title={`Set up ${props.profileName} · ${props.computerName}`} busy={close.isPending}
    onOpenChange={open => { if (!open) close.mutate() }} closeLabel="Close setup browser"
    footer={<div className="browser-profile-actions"><Button disabled={close.isPending} onClick={() => close.mutate()}>
      {close.isPending ? 'Closing setup browser…' : close.data === 'pending' || close.isError ? 'End setup' : 'Done'}</Button></div>}>
    {accessDenied ? <p role="alert">Browser access is unavailable.</p>
      : read.isPending ? <p role="status">Loading setup browser…</p>
        : read.error ? <p role="alert">{browserErrorMessage(read.error)}</p>
          : read.data && tab ? <BrowserSessionPanel key={`${tab.tabId}:${connection}`} port={props.port} files={props.files} initial={read.data}
            tab={tab} viewerId={viewerId} readOnly={false} computerName={props.computerName} setup
            onRead={result => queryClient.setQueryData(key, result)} onSelectTab={setTabId} keepControlOnTabChange={() => true}
            onRefresh={() => { if (mounted.current) void read.refetch() }}
            onCleanupError={message => { if (active.current) props.onCleanupError(message) }}
            onDenied={() => { setDenied(true); queryClient.removeQueries({ queryKey: key }) }}
            onReconnect={reconnect} /> : <p>No setup browser tab is available.</p>}
    {read.data && !accessDenied ? <OriginConfirmation profileId={props.session.profileId} computerId={props.session.computerId}
      profiles={props.profiles} /> : null}
    {cleanupError || close.error ? <p role="alert">{cleanupError ?? browserErrorMessage(close.error)}</p> : null}
    {recovery.error && !accessDenied ? <p role="alert">{browserErrorMessage(recovery.error)}
      <Button disabled={recovery.isPending} onClick={reconnect}>Check original reconnect</Button></p> : null}
  </Dialog>
}

function OriginConfirmation({ profileId, computerId, profiles }: { profileId: string; computerId: string; profiles: BrowserProfilesPort }) {
  const [origin, setOrigin] = useState('')
  const [state, setState] = useState<'signed_in' | 'sign_in_required'>('signed_in')
  const confirmation = useMutation({ mutationFn: (request: { origin: string; state: 'signed_in' | 'sign_in_required'; commandId: string }) =>
    profiles.confirmLogin(profileId, computerId, request.origin, request.state, request.commandId), retry: false })
  const uncertain = confirmation.isError && browserRequestUncertain(confirmation.error)
  return <form className="browser-profile-form" onSubmit={event => {
    event.preventDefault()
    if (!uncertain && !confirmation.isPending) confirmation.mutate({ origin, state, commandId: crypto.randomUUID() })
  }}>
    <TextField label="Website origin to confirm" value={origin} type="url" placeholder="https://example.com" required
      onChange={event => setOrigin(event.currentTarget.value)} />
    <Select label="What you observed on this computer" value={state}
      options={[{ value: 'signed_in', label: 'I am signed in' }, { value: 'sign_in_required', label: 'Sign-in is required' }]}
      onChange={event => setState(event.currentTarget.value === 'signed_in' ? 'signed_in' : 'sign_in_required')} />
    <Button type="submit" disabled={confirmation.isPending || uncertain}>Record sign-in check</Button>
    {confirmation.isSuccess ? <p role="status">Sign-in observation saved for this website on this computer.</p> : null}
    {confirmation.error ? <p role="alert">{browserErrorMessage(confirmation.error)}</p> : null}
    {uncertain ? <Button disabled={confirmation.isPending} onClick={() => {
      if (confirmation.variables) confirmation.mutate(confirmation.variables)
    }}>Check original sign-in observation</Button> : null}
  </form>
}
