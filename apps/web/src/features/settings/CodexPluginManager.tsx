import { InfoHint } from '../../shared/ui/InfoHint'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Alert, Button, Dialog, Icon, LoadingState, StatusBadge, TextField } from '../../shared/ui/nocturne'
import { useChangeCodexPlugin, useCodexPlugin, useCodexPlugins } from '../../shared/api/harnessSettings'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import './codexPlugins.css'

export function CodexPluginManager({ accessUnavailable = false }: { accessUnavailable?: boolean }) {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  const view = search.pluginView ?? 'installed'
  const query = search.pluginQuery ?? ''
  const offset = search.pluginOffset ?? 0
  const selectedId = search.pluginId
  // The URL remains authoritative; only request admission is debounced.
  const [settledQuery, setSettledQuery] = useState(query)
  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const list = useCodexPlugins({ view, query, offset, limit: 24 }, settledQuery === query && !accessUnavailable)
  const detail = useCodexPlugin(accessUnavailable ? undefined : selectedId)
  const change = useChangeCodexPlugin()
  const listDenied = useAccessFailureLatch(list)
  const detailDenied = useAccessFailureLatch(detail)
  const denied = accessUnavailable || listDenied || detailDenied
  const catalog = denied ? undefined : list.data
  const reviewed = denied ? undefined : detail.data
  const plugin = reviewed?.plugin
  const lastTrigger = useRef<HTMLButtonElement>(null)
  const lastPluginId = useRef<string | undefined>(undefined)
  const wasOpen = useRef(false)
  const searchField = useRef<HTMLInputElement>(null)
  const handledResult = useRef<unknown>(undefined)
  const [feedback, setFeedback] = useState<string>()
  const move = useCallback((fields: Partial<typeof search>) => void navigate({ search: { ...search, ...fields }, replace: true }), [navigate, search])
  useEffect(() => {
    if (catalog && offset > 0 && offset >= catalog.total) move({ pluginOffset: Math.max(0, Math.floor((catalog.total - 1) / 24) * 24) })
  }, [catalog, offset, move])
  useEffect(() => {
    if (selectedId) { wasOpen.current = true; return }
    if (!wasOpen.current || !lastPluginId.current) return
    wasOpen.current = false
    const card = lastTrigger.current?.isConnected ? lastTrigger.current
      : [...document.querySelectorAll<HTMLButtonElement>('.codex-plugin-card')].find((item) => item.dataset.pluginId === lastPluginId.current)
    ;(card ?? searchField.current)?.focus()
  }, [selectedId])
  useEffect(() => {
    const result = change.reconciliation.submittedAt > change.submittedAt ? change.reconciliation.data : change.data
    if (!result || result.status === 'uncertain' || handledResult.current === result) return
    handledResult.current = result
    setFeedback(result.message)
    if (result.status !== 'applied') return
    if (result.action === 'remove') move({ pluginId: undefined })
    else move({ pluginView: 'installed', pluginQuery: undefined, pluginOffset: 0 })
  }, [change.data, change.submittedAt, change.reconciliation.data, change.reconciliation.submittedAt, move])
  const refresh = async () => {
    if (accessUnavailable) return
    // A successful list read is not a receipt or native process reconciliation.
    await Promise.allSettled([list.refresh(), change.operations.refetch()])
    if (selectedId) await detail.refetch()
  }
  const snapshotReady = Boolean(reviewed && catalog && list.isSuccess && detail.isSuccess
    && !list.isFetching && !detail.isFetching && settledQuery === query
    && reviewed.plugin.pluginId === selectedId && reviewed.revision === catalog.revision)
  const busy = change.busy || Boolean(change.operation) || !change.operations.isSuccess || change.operations.isFetching
  const act = (action: 'install' | 'remove') => {
    if (!snapshotReady || !reviewed || busy || reviewed.plugin.unavailableReason || reviewed.plugin.verification === 'unverified') return
    if (action === 'install' && catalog?.catalogStatus !== 'complete') return
    setFeedback(undefined)
    change.start({ pluginId: reviewed.plugin.pluginId, action, expectedRevision: reviewed.revision, artifactIdentity: reviewed.artifactIdentity })
  }
  const pending = change.operation
  const rejection = !denied && change.isError && !pending ? <Alert tone="danger" live
    title="Plugin change was not accepted"
    action={<Button size="sm" disabled={list.isFetching || detail.isFetching}
      onClick={() => void refresh()}>Refresh list and details</Button>}>{change.error.message}</Alert> : null
  const recovery = !denied && pending ? <Alert tone="warning" live title="Plugin change needs reconciliation">
    <p>{pending.result?.message ?? pending.error ?? 'The install or removal may have completed. Keep the original request until its outcome is known.'}</p>
    {pending.result?.nativeFailure ? <p>Native result: {pending.result.nativeFailure}</p> : null}
    {pending.error && pending.result ? <p>{pending.error}</p> : null}
    {pending.phase !== 'sending' ? <>
      {!pending.requestedBy && pending.input && pending.phase === 'retry'
        ? <Button size="sm" disabled={change.busy} onClick={change.retry}>Retry original request</Button> : null}
      <span><Button size="sm" disabled={change.busy} onClick={() => change.reconcile()}>Reconcile original request</Button>
        <InfoHint label="Reconcile">Refresh only reads the list. Reconcile checks this request without repeating the native write.</InfoHint></span>
      {pending.result?.observedRevision ? <Button size="sm" disabled={change.busy || list.isFetching || catalog?.revision !== pending.result.observedRevision} onClick={() => change.reconcile(true)}>Keep current state and close request</Button> : null}
    </> : <p role="status">Checking the original request…</p>}
  </Alert> : null
  const label = (item: NonNullable<typeof plugin>) => item.verification === 'unverified' ? 'Needs verification'
    : item.installed ? item.enabled ? 'Installed' : 'Disabled' : item.unavailableReason ? 'Unavailable' : 'Available'
  return <section className="codex-plugins" aria-label="Codex plugins">
    <div className="codex-plugins-controls">
      <div className="codex-plugins-tabs" role="group" aria-label="Plugin catalog view">
        <Button size="sm" variant={view === 'installed' ? 'primary' : 'ghost'} aria-pressed={view === 'installed'} onClick={() => move({ pluginView: 'installed', pluginOffset: 0 })}>Installed</Button>
        <Button size="sm" variant={view === 'available' ? 'primary' : 'ghost'} aria-pressed={view === 'available'} onClick={() => move({ pluginView: 'available', pluginOffset: 0 })}>Discover</Button>
      </div>
      <Button size="sm" disabled={accessUnavailable || list.isFetching || detail.isFetching || change.busy} onClick={() => void refresh()}>Refresh</Button>
    </div>
    <TextField ref={searchField} label="Search plugins" type="search" maxLength={100} value={query} placeholder="Name or marketplace" onChange={(event) => move({ pluginQuery: event.target.value || undefined, pluginOffset: 0 })} />
    {!selectedId ? recovery : null}
    {!selectedId ? rejection : null}
    {!denied && change.operations.isError ? <Alert tone="warning" title="Plugin changes are unavailable">Unresolved requests could not be checked. Refresh before making another change.</Alert> : null}
    {feedback && !selectedId && !denied ? <p role="status" className="harness-success">{feedback}</p> : null}
    {list.isPending ? <LoadingState label="Loading Codex plugins…" rows={3} /> : null}
    {list.isError ? <Alert tone="danger" title="Codex plugins could not be loaded"
      action={<Button size="sm" disabled={accessUnavailable} onClick={() => {
        if (!accessUnavailable) void list.refetch()
      }}>Retry</Button>}>{list.error.message}</Alert> : null}
    {denied && !selectedId ? <Alert tone="danger" title="Plugin access unavailable">Protected plugin information is hidden until access is restored.</Alert> : null}
    {catalog ? <>
      {catalog.catalogStatus === 'partial' ? <Alert tone="warning" title="Catalog incomplete">Some sources could not be checked. Missing discovery entries do not prove a plugin was removed.</Alert> : null}
      {view === 'installed' && catalog.inventoryStatus === 'unknown' ? <p className="harness-muted">Codex does not expose a complete installed inventory here. Unlisted local records need verification; absence from this list is not proof of removal.</p> : null}
      <p className="harness-muted" role="status">{catalog.total} {view === 'installed' ? 'installation' : 'discovery'} {catalog.total === 1 ? 'record' : 'records'}{query ? ` matching “${query}”` : ''}</p>
      {catalog.items.length ? <ul className={`codex-plugin-grid${view === 'available' ? ' codex-plugin-grid--available' : ''}`}>{catalog.items.map((item) => <li key={item.pluginId}>
        <button type="button" className={`codex-plugin-card${view === 'available' ? ' codex-plugin-card--available' : ''}`} data-plugin-id={item.pluginId} aria-label={`View ${item.name} plugin, ${label(item).toLowerCase()}`}
          onClick={(event) => { lastTrigger.current = event.currentTarget; lastPluginId.current = item.pluginId; move({ pluginId: item.pluginId }) }}>
          <span className="codex-plugin-identity"><strong>{item.name}</strong>{view === 'installed' ? <small>{item.marketplaceName}</small> : null}</span>
          {view === 'installed' ? <span className="codex-plugin-state">{label(item)}</span> : null}
        </button>
      </li>)}</ul> : <p className="harness-empty">{query ? 'No records match this search.' : 'No plugin records were returned by the inspected sources.'}</p>}
      {catalog.total > 24 ? <div className="codex-plugins-pages">
        <Button size="sm" disabled={offset === 0 || list.isFetching} onClick={() => move({ pluginOffset: Math.max(0, offset - 24) })}>Previous</Button>
        <span className="harness-muted">{catalog.total ? `${offset + 1}–${Math.min(offset + 24, catalog.total)} of ${catalog.total}` : '0 results'}</span>
        <Button size="sm" disabled={catalog.nextOffset === null || list.isFetching} onClick={() => move({ pluginOffset: catalog.nextOffset ?? offset })}>Next</Button>
      </div> : null}
    </> : null}
    <Dialog open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) move({ pluginId: undefined }) }} title={plugin ? `${plugin.name} plugin` : 'Plugin details'} size="md"
      closeOnOutsideClick busy={change.busy}
      footer={<>
        <Button disabled={accessUnavailable || list.isFetching || detail.isFetching || change.busy}
          onClick={() => void refresh()}>Refresh plugin</Button>
        {plugin && !plugin.installed && plugin.installPolicy === 'AVAILABLE' ? <Button variant="primary" disabled={busy || !snapshotReady || Boolean(plugin.unavailableReason) || catalog?.catalogStatus !== 'complete'} onClick={() => act('install')}>Install plugin</Button> : null}
        {plugin?.installed && plugin.verification !== 'unverified' && plugin.installPolicy !== 'INSTALLED_BY_DEFAULT' ? <Button variant="danger" leading={<Icon name="trash" size={16} />}
          disabled={busy || !snapshotReady || Boolean(plugin.unavailableReason)} onClick={() => act('remove')}>Remove plugin</Button> : null}
        {plugin?.installed && plugin.verification !== 'unverified' && plugin.installPolicy !== 'INSTALLED_BY_DEFAULT' ? <InfoHint label="Remove plugin">Removing a plugin removes its bundled capabilities. Separately configured MCP connections remain in MCP connections.</InfoHint> : null}
        <Button disabled={change.busy} onClick={() => move({ pluginId: undefined })}>Close</Button>
      </>}>
      {!denied && detail.isPending ? <p role="status">Loading plugin details…</p> : null}
      {detail.isError ? <Alert tone="danger" title="Plugin details could not be loaded"
        action={<Button size="sm" disabled={accessUnavailable} onClick={() => {
          if (!accessUnavailable) void detail.refetch()
        }}>Retry</Button>}>{detail.error.message}</Alert> : null}
      {denied ? <Alert tone="danger" live title="Plugin access unavailable">Protected plugin information is hidden until access is restored.</Alert> : null}
      {recovery}
      {rejection}
      {feedback && !denied ? <p role="status" className="harness-success">{feedback}</p> : null}
      {plugin ? <div className="codex-plugin-detail">
        <StatusBadge tone={plugin.verification === 'unverified' ? 'warning' : plugin.installed ? plugin.enabled ? 'success' : 'warning' : 'neutral'} label={label(plugin)} />
        <dl className="harness-change-details">
          <div><dt>Marketplace</dt><dd>{plugin.marketplaceName}</dd></div>
          <div><dt>Version</dt><dd>{plugin.version ?? 'Not verified'}</dd></div>
          <div><dt>Sign-in</dt><dd>{plugin.authPolicy === 'ON_INSTALL' ? 'May be required during installation' : 'May be required when used'}</dd></div>
        </dl>
        {plugin.unavailableReason ? <Alert tone="warning" title="Native verification required">{plugin.unavailableReason}</Alert> : null}
        {!plugin.installed && catalog?.catalogStatus === 'partial' ? <Alert tone="warning"
          title="Installation unavailable">The catalog is incomplete. Refresh the catalog before installing this plugin.</Alert> : null}
        {!snapshotReady ? <p role="status">Refresh the list and details together before making a change. <Button size="sm" disabled={list.isFetching || detail.isFetching} onClick={() => void refresh()}>Refresh list and details</Button></p> : null}
        {reviewed?.contents.status === 'known' ? <div className="codex-plugin-includes">
          <div><strong>Skills</strong><span>{reviewed.contents.skills.length ? reviewed.contents.skills.join(', ') : 'None included'}</span></div>
          <div><strong>MCP servers</strong><span>{reviewed.contents.mcpServers.length ? reviewed.contents.mcpServers.join(', ') : 'None included'}</span></div>
          <div><strong>Apps</strong><span>{reviewed.contents.apps.length ? reviewed.contents.apps.join(', ') : 'None included'}</span></div>
          <div><strong>Hooks</strong><span>{reviewed.contents.hooks.length ? reviewed.contents.hooks.join(', ') : 'None included'}</span></div>
        </div> : plugin.installed ? <Alert tone="warning" title="Bundle contents unavailable">Verified bundle contents are unavailable. <InfoHint label="Bundle contents">This can mean missing, unreadable, oversized, or unsupported files, not an empty bundle.</InfoHint></Alert>
          : <p className="harness-muted">Bundle contents <InfoHint label="Bundle contents">Bundle contents can be checked after installation.</InfoHint></p>}
        {plugin.installed && plugin.installPolicy === 'INSTALLED_BY_DEFAULT' ? <p className="harness-muted">Codex installed this plugin by default; it cannot be removed here.</p> : null}
      </div> : null}
    </Dialog>
  </section>
}
