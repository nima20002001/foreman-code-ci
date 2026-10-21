import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button, TextField } from '../../shared/ui/nocturne'
import { BrowserController } from './controller'
import { BrowserControlStatus } from './BrowserControlStatus'
import { BrowserViewer } from './BrowserViewer'
import { BrowserSessionActions } from './BrowserSessionActions'
import { BrowserPreparation, type BrowserPreparationRead } from './BrowserPreparation'
import type { BrowserFilesPort } from './transferTypes'
import { browserAccessDenied, browserErrorMessage, browserRequestUncertain } from './errors'
import { roleLabel, subjectLabel } from './identity'
import { browserSessionKey, useBrowserSession, useBrowserSessions, validateBrowserRead } from './queries'
import type { BrowserSelection, BrowserSessionRead, BrowserTabLease, BrowserUiPort } from './types'
import './agentBrowser.css'

export interface AgentBrowserPanelProps {
  visible: boolean
  selection: BrowserSelection
  port: BrowserUiPort
  files: BrowserFilesPort
  preparation?: BrowserPreparationRead
  computerName: string
  profileName: string
  readOnly: boolean
  onOpenSettings(): void
  onSelectSession(sessionId: string): void
  onSelectTab(tabId: string): void
  onCleanupError(message: string): void
}

/** D's one rail owns mounting/navigation. A hidden panel starts no reads or capture. */
export function AgentBrowserPanel(props: AgentBrowserPanelProps) {
  const current = useRef({ visible: props.visible, sessionId: props.selection.sessionId })
  current.current = { visible: props.visible, sessionId: props.selection.sessionId }
  if (!props.visible) return null
  if (!props.selection.enabled) return <section className="agent-browser-panel" aria-label="Agent browser">
    <p>Browser is off for this node.</p><Button onClick={props.onOpenSettings}>Open settings</Button>
  </section>
  return <SelectedBrowser key={`${props.selection.authBoundary}:${props.selection.visitKey}`}
    {...props} keepControlOnTabChange={() => current.current.visible && current.current.sessionId === props.selection.sessionId} />
}

function SelectedBrowser(props: AgentBrowserPanelProps & { keepControlOnTabChange(): boolean }) {
  const queryClient = useQueryClient()
  const [denied, setDenied] = useState(false)
  const selection = { ...props.selection, enabled: props.selection.enabled && !denied }
  const read = useBrowserSession(props.port, selection)
  const sessions = useBrowserSessions(props.port, selection)
  const [viewerId] = useState(() => crypto.randomUUID())
  const [connectionVisit, setConnectionVisit] = useState(0)
  const visitKey = `${props.selection.authBoundary}:${props.selection.visitKey}:${props.selection.sessionId}`
  const activeVisit = useRef<string | null>(visitKey)
  activeVisit.current = visitKey
  useEffect(() => { activeVisit.current = visitKey; return () => { activeVisit.current = null } }, [visitKey])
  const recoveryCommand = useRef<string | null>(null)
  const deny = useCallback(() => {
    setDenied(true)
    queryClient.removeQueries({ queryKey: ['browser', props.selection.authBoundary] })
  }, [queryClient, props.selection.authBoundary])
  const recovery = useMutation({ mutationFn: async (request: { session: BrowserSessionRead['session']; commandId: string; visitKey: string }) =>
    validateBrowserRead(await props.port.reconnect(request.session, request.commandId), props.selection), retry: false,
    onSuccess: (result, request) => {
      if (activeVisit.current !== request.visitKey) return
      if (result.session.id !== request.session.id || result.session.browserGeneration !== request.session.browserGeneration) {
        deny(); return
      }
      recoveryCommand.current = null
      queryClient.setQueryData(browserSessionKey(props.selection), result)
      setConnectionVisit(value => value + 1)
    }, onError: (failure, request) => {
      if (activeVisit.current !== request.visitKey) return
      if (!browserRequestUncertain(failure)) recoveryCommand.current = null
      if (browserAccessDenied(failure)) deny()
    } })
  const recover = () => {
    if (!read.data || recovery.isPending) return
    recoveryCommand.current ??= crypto.randomUUID()
    recovery.mutate({ session: read.data.session, commandId: recoveryCommand.current, visitKey })
  }
  const error = read.error ?? sessions.error
  useEffect(() => { if (browserAccessDenied(error)) deny() }, [error, deny])
  const rejected = denied || browserAccessDenied(error)
  const reconnect = async () => {
    const requestedVisit = activeVisit.current
    const result = await read.refetch()
    if (activeVisit.current !== requestedVisit) return
    if (result.isSuccess) { setDenied(false); setConnectionVisit(value => value + 1) }
    else if (browserAccessDenied(result.error)) deny()
  }
  const data = read.data
  const tab = data?.tabs.find(item => item.tabId === props.selection.tabId)
    ?? (props.selection.tabId === null ? data?.tabs.find(item => item.tabId === data.session.selectedTabId) : undefined)
  return <section className="agent-browser-panel" aria-label="Agent browser">
    <header><h3>{props.selection.subject.agent.displayName} · {props.computerName} · {props.profileName}</h3>
      <p>{roleLabel(props.selection.subject)} · {subjectLabel(props.selection.subject)}</p></header>
    {rejected ? <div role="alert"><p>Browser access is unavailable.</p>
      <Button onClick={() => { void reconnect() }}>Check access</Button></div>
      : error ? <div role="alert"><p>{browserErrorMessage(error)}</p>
        <Button onClick={() => { void (props.selection.sessionId ? reconnect() : sessions.refetch()) }}>Retry</Button></div>
        : !props.selection.sessionId ? <>
          {props.preparation ? <BrowserPreparation key={props.preparation.request.commandId} read={props.preparation}
            subject={props.selection.subject} port={props.port} historical={props.selection.historical}
            onSelectSession={props.onSelectSession} onDenied={failure => { if (browserAccessDenied(failure)) deny() }} /> : null}
          <SessionChoices {...props} sessions={sessions.data} loading={sessions.isPending} />
        </>
          : read.isPending ? <p role="status">Loading browser…</p>
            : data?.session.state === 'closed' || data?.session.state === 'failed' ? <p>No live browser remains for this selected session.</p>
              : data && tab ? <BrowserSessionPanel key={`${data.session.id}:${data.session.browserGeneration}:${tab.tabId}:${connectionVisit}`}
                {...props} initial={data} tab={tab} viewerId={viewerId} onDenied={deny}
                onRead={result => queryClient.setQueryData(browserSessionKey(props.selection), validateBrowserRead(result, props.selection))}
                onRefresh={() => { void read.refetch() }}
                onReconnect={recover} />
                : <p>{props.selection.tabId ? 'The selected tab is no longer available. Choose a tab from this session.' : 'No browser tab is available yet.'}</p>}
    {!rejected && data && !tab ? <div className="agent-browser-actions">{data.tabs.map(item =>
      <Button key={item.tabId} onClick={() => props.onSelectTab(item.tabId)}>{item.title || 'Untitled tab'}</Button>)}</div> : null}
    {recovery.isPending ? <p role="status">Reconnecting the owned browser…</p> : null}
    {recovery.error && !rejected ? <p role="alert">{browserErrorMessage(recovery.error)}
      <Button disabled={recovery.isPending} onClick={recover}>Check original reconnect</Button></p> : null}
  </section>
}

function SessionChoices({ sessions, loading, selection, onSelectSession }: {
  sessions: BrowserSessionRead['session'][] | undefined; loading: boolean; selection: BrowserSelection
  onSelectSession(sessionId: string): void
}) {
  if (loading) return <p role="status">Loading browser sessions…</p>
  if (!sessions?.length) return <p>{selection.historical ? 'No live browser remains for this historical selection.' : 'No live browser yet.'}</p>
  return <div><p>{sessions.length > 1 ? 'Choose the exact browser session to watch.' : 'Browser session for the selected agent.'}</p>
    {sessions.map(session => <Button key={session.id} onClick={() => onSelectSession(session.id)}>
      Open browser · {session.state} · {session.id.slice(0, 8)}
    </Button>)}</div>
}

export interface BrowserSessionPanelProps {
  port: BrowserUiPort; files: BrowserFilesPort; initial: BrowserSessionRead; tab: BrowserTabLease; viewerId: string; readOnly: boolean
  computerName: string; selection?: BrowserSelection; setup?: boolean
  onDenied(): void; onRead(read: BrowserSessionRead): void; onReconnect(): void; keepControlOnTabChange(): boolean
  onSelectTab(tabId: string): void; onCleanupError(message: string): void
  onRefresh(): void
}

type ViewerMutation = {
  action(epoch: number, commandId: string): Promise<BrowserSessionRead & { createdTabId?: string }>
  commandId: string; visit: number; epoch?: number; selectedTabId?: string; selectCreated?: boolean
}

export function BrowserSessionPanel(props: BrowserSessionPanelProps) {
  const [controller] = useState(() => new BrowserController(props.port, props.initial, props.tab, props.viewerId, props.onDenied))
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const surface = useRef<HTMLDivElement>(null)
  const retiringForTab = useRef(false)
  const effectVisit = useRef(0)
  const mounted = useRef(false)
  const lifecycle = useRef({ keepControlOnTabChange: props.keepControlOnTabChange, onCleanupError: props.onCleanupError })
  lifecycle.current = { keepControlOnTabChange: props.keepControlOnTabChange, onCleanupError: props.onCleanupError }
  const [url, setUrl] = useState(props.tab.url)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    effectVisit.current += 1
    mounted.current = true
    void controller.start()
    const outside = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !surface.current?.contains(event.target)) void controller.release()
    }
    const blur = () => controller.pause(new Error('Browser actions are paused. Reconnect the view before continuing.'))
    document.addEventListener('pointerdown', outside)
    window.addEventListener('blur', blur)
    return () => {
      mounted.current = false
      const retiringVisit = ++effectVisit.current
      document.removeEventListener('pointerdown', outside); window.removeEventListener('blur', blur)
      // React StrictMode replays setup immediately; only a genuinely retired mount closes the host view.
      queueMicrotask(() => {
        if (effectVisit.current !== retiringVisit) return
        const release = !retiringForTab.current || !lifecycle.current.keepControlOnTabChange()
        void controller.close(release).catch(failure => lifecycle.current.onCleanupError(browserErrorMessage(failure)))
      })
    }
  }, [controller])
  const mutation = useMutation({ mutationFn: async (request: ViewerMutation) => {
      if (request.epoch === undefined) {
        const control = await controller.acquire()
        if (control.state !== 'user' || control.controllingViewerId !== props.viewerId) throw new Error('User control is not confirmed.')
        request.epoch = control.epoch
      }
      if (!mounted.current || request.visit !== effectVisit.current) return null
      const receipt = await request.action(request.epoch, request.commandId)
      const result = validateBrowserRead(receipt, props.selection)
      if (result.session.id !== props.initial.session.id || result.session.browserGeneration !== props.initial.session.browserGeneration
        || result.session.setupForProfileId !== props.initial.session.setupForProfileId) throw new Error('The browser restarted or changed. Reconnect before continuing.')
      if (request.selectCreated) {
        if (!receipt.createdTabId || !result.tabs.some(tab => tab.tabId === receipt.createdTabId)) {
          throw new Error('The new tab is not confirmed in this browser session. Check the original action.')
        }
        request.selectedTabId = receipt.createdTabId
      }
      return result
    }, retry: false,
    onSuccess: (result, request) => {
      if (!result || !mounted.current || request.visit !== effectVisit.current) return
      props.onRead(result)
      if (request.selectedTabId && result.tabs.some(value => value.tabId === request.selectedTabId)) {
        retiringForTab.current = true; props.onSelectTab(request.selectedTabId)
      }
    }, onError: (failure, request) => {
      if (mounted.current && request.visit === effectVisit.current && browserAccessDenied(failure)) props.onDenied()
    } })
  const unresolved = mutation.isError && browserRequestUncertain(mutation.error)
  const pending = mutation.isPending || unresolved
  const mutate = (action: ViewerMutation['action'], selectedTabId?: string, selectCreated?: boolean) => {
    if (pending || props.readOnly) return
    setError(null)
    mutation.mutate({ action, commandId: crypto.randomUUID(), visit: effectVisit.current, selectedTabId, selectCreated })
  }
  return <div ref={surface} className="agent-browser-content">
    <BrowserControlStatus snapshot={snapshot} viewerId={props.viewerId} setup={props.setup ?? false} readOnly={props.readOnly}
      onAcquire={() => { void controller.acquire().catch(failure => setError(browserErrorMessage(failure))) }}
      onRelease={() => { void controller.release() }} onReconnect={() => { retiringForTab.current = true; props.onReconnect() }} />
    <div className="agent-browser-tabs" aria-label="Browser tabs">{props.initial.tabs.map(tab =>
      <Button key={tab.tabId} size="sm" variant="ghost" aria-current={tab.tabId === props.tab.tabId ? 'page' : undefined}
        disabled={pending} onClick={() => {
          if (tab.tabId === props.tab.tabId) return
          if (props.readOnly) { retiringForTab.current = true; props.onSelectTab(tab.tabId); return }
          mutate((epoch, commandId) => props.port.selectTab(props.initial.session, tab.tabId, props.viewerId, epoch, commandId), tab.tabId)
        }}>{tab.title || 'Untitled tab'}</Button>)}</div>
    {!props.readOnly ? <form className="agent-browser-address" onSubmit={event => {
      event.preventDefault()
      mutate((epoch, commandId) => props.port.navigate(props.initial.session, props.tab, props.viewerId, epoch, url, commandId))
    }}><TextField label="Website address" value={url} onChange={event => setUrl(event.currentTarget.value)} disabled={pending} />
      <Button type="submit" disabled={pending || snapshot.stale || !url.trim()}>Go</Button></form> : null}
    {error || mutation.error ? <p role="alert">{error ?? browserErrorMessage(mutation.error)}</p> : null}
    {unresolved ? <Button size="sm" disabled={mutation.isPending} onClick={() => {
      if (mutation.variables) mutation.mutate(mutation.variables)
    }}>Check original browser action</Button> : null}
    <BrowserViewer controller={controller} snapshot={snapshot} readOnly={props.readOnly}
      onLeavePage={() => surface.current?.querySelector<HTMLButtonElement>('[data-browser-control]')?.focus()} />
    <small id="browser-page-help">Click the page or choose Take control to interact. Tab moves through the website; Escape leaves page capture. Changing tabs keeps your control.</small>
    <BrowserSessionActions read={props.initial} tab={props.tab} files={props.files} disabled={pending || snapshot.stale}
      onDenied={failure => controller.pause(failure)}
      readOnly={props.readOnly} onChanged={() => { if (mounted.current) props.onRefresh() }}
      acquire={async () => {
        const control = await controller.acquire()
        if (!mounted.current || control.state !== 'user' || control.controllingViewerId !== props.viewerId) {
          throw new Error('User control is not confirmed for this upload.')
        }
        return { viewerId: props.viewerId, epoch: control.epoch }
      }} onRespond={(accept, prompt) => mutate((epoch, commandId) =>
        props.port.respondDialog(props.initial.session, props.tab, props.viewerId, epoch, accept, prompt, commandId))} />
    {!props.readOnly ? <div className="agent-browser-actions">
      <Button size="sm" disabled={pending || snapshot.stale} onClick={() => { mutate((epoch, commandId) =>
        props.port.createTab(props.initial.session, props.viewerId, epoch, commandId), undefined, true) }}>New tab</Button>
      <Button size="sm" variant="ghost" disabled={pending || snapshot.stale} onClick={() => { mutate((epoch, commandId) =>
        props.port.closeTab(props.initial.session, props.tab.tabId, props.viewerId, epoch, commandId)) }}>Close tab</Button>
      <Button size="sm" variant="ghost" disabled={pending || snapshot.stale} onClick={() => {
        const visit = effectVisit.current
        mutate(async (epoch, commandId) => {
          const control = await props.port.openLocalBrowser(props.initial.session, props.viewerId, epoch, commandId)
          if (mounted.current && visit === effectVisit.current) controller.pause(new Error(`Complete in the browser on ${props.computerName}, then reconnect and return control.`))
          return { ...props.initial, control }
        })
      }}>Continue on this computer</Button>
    </div> : null}
  </div>
}
