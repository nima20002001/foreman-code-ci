import { useCallback, useEffect } from 'react'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Alert, Button, LoadingState, StatusBadge, TextField } from '../../shared/ui/nocturne'
import { useClaudePlugins } from '../../shared/api/claudePlugins'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { askOperator } from '../operator-chat/operatorChatStore'
import './codexPlugins.css'

function stateLabel(enabled: boolean): string {
  return enabled ? 'Enabled' : 'Disabled'
}

export function ClaudePluginSummary({ onClose, accessUnavailable = false }: {
  onClose(): void; accessUnavailable?: boolean
}) {
  const search = useSearch({ from: '/settings/harnesses' })
  const navigate = useNavigate({ from: '/settings/harnesses' })
  const view = search.pluginView ?? 'installed'
  const query = search.pluginQuery ?? ''
  const offset = search.pluginOffset ?? 0
  const list = useClaudePlugins({ view, query, offset, limit: 24 }, !accessUnavailable)
  const listDenied = useAccessFailureLatch(list)
  const denied = accessUnavailable || listDenied
  const catalog = denied ? undefined : list.data
  const move = useCallback((fields: Partial<typeof search>) =>
    void navigate({ search: { ...search, ...fields }, replace: true }), [navigate, search])
  useEffect(() => {
    if (catalog && offset > 0 && offset >= catalog.total) {
      move({ pluginOffset: Math.max(0, Math.floor((catalog.total - 1) / 24) * 24) })
    }
  }, [catalog, offset, move])
  const ask = (content: string) => {
    onClose()
    askOperator(content, { send: false })
  }
  return <section className="codex-plugins" aria-label="Claude plugins">
    <div className="codex-plugins-controls">
      <div className="codex-plugins-tabs" role="group" aria-label="Plugin catalog view">
        <Button size="sm" aria-pressed={view === 'installed'} variant={view === 'installed' ? 'primary' : 'ghost'}
          onClick={() => move({ pluginView: 'installed', pluginOffset: 0 })}>Installed</Button>
        <Button size="sm" aria-pressed={view === 'available'} variant={view === 'available' ? 'primary' : 'ghost'}
          onClick={() => move({ pluginView: 'available', pluginOffset: 0 })}>Discover</Button>
      </div>
      <Button size="sm" disabled={accessUnavailable || list.isFetching} onClick={() => {
        if (!accessUnavailable) void list.refresh()
      }}>Refresh</Button>
    </div>
    <TextField label="Search plugins" type="search" maxLength={100} value={query} placeholder="Name or marketplace"
      onChange={event => move({ pluginQuery: event.target.value || undefined, pluginOffset: 0 })} />
    {list.isPending ? <LoadingState label="Loading Claude plugins…" rows={3} /> : null}
    {list.isError ? <Alert tone="danger" title="Claude plugins could not be loaded"
      action={<Button size="sm" disabled={accessUnavailable} onClick={() => {
        if (!accessUnavailable) void list.refetch()
      }}>Retry</Button>}>{list.error.message}</Alert> : null}
    {denied ? <Alert tone="danger" live title="Plugin access unavailable">Protected plugin information is hidden until access is restored.</Alert> : null}
    {catalog ? <>
      <Button size="sm" onClick={() => ask('Add a Claude Code plugin marketplace: ')}>
        Add marketplace with Operator
      </Button>
      <p className="harness-muted" role="status">{catalog.total} {view === 'installed' ? 'installed' : 'available'} plugins</p>
      {catalog.items.length ? <ul className="codex-plugin-grid">{catalog.items.map(plugin => <li key={plugin.pluginId}>
        <button type="button" className="codex-plugin-card" aria-label={`Ask Operator to ${plugin.installed ? 'manage' : 'install'} ${plugin.name}`}
          onClick={() => ask(`${plugin.installed ? 'Manage' : 'Install'} the Claude Code plugin ${plugin.pluginId}. `)}>
          <span className="codex-plugin-identity"><strong>{plugin.name}</strong><small>{plugin.marketplaceName}</small></span>
          <StatusBadge label={plugin.installed ? stateLabel(plugin.enabled) : 'Available'}
            tone={plugin.installed && plugin.enabled ? 'success' : 'neutral'} />
        </button>
      </li>)}</ul> : <p className="harness-empty">{query ? 'No plugins match this search.' : 'No plugins found.'}</p>}
      {catalog.total > 24 ? <div className="codex-plugins-pages">
        <Button size="sm" disabled={offset === 0 || list.isFetching}
          onClick={() => move({ pluginOffset: Math.max(0, offset - 24) })}>Previous</Button>
        <span>{offset + 1}–{Math.min(offset + 24, catalog.total)} of {catalog.total}</span>
        <Button size="sm" disabled={catalog.nextOffset === null || list.isFetching}
          onClick={() => move({ pluginOffset: catalog.nextOffset ?? offset })}>Next</Button>
      </div> : null}
    </> : null}
  </section>
}
