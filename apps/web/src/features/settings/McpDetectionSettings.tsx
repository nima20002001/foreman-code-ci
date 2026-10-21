import { useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { AgentHarness } from '@foreman-code/contracts'
import { Alert, Badge, Button, Combobox, Icon } from '../../shared/ui/nocturne'
import { useManagedWorkspacesQuery, useManagedWorkspaceQuery } from '../../shared/api/query'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { McpAccessNotice, McpConnectionCard } from './McpConnectionCard'
import './mcpConnections.css'

type Props = { workspaceId?: string; harness?: AgentHarness }

function WorkspaceEvidence({ workspaceId, harness }: Props & { workspaceId: string }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const query = useManagedWorkspaceQuery(workspaceId)
  const accessError = useProtectedAccessError(query)
  const current = query.data?.workspace.id === workspaceId ? query.data : undefined
  const retry = <Button size="sm" loading={query.isFetching} leading={<Icon name="refresh" size={16} />}
    onClick={() => void query.refetch({ cancelRefetch: false })}>Try again</Button>

  if (accessError) return <McpAccessNotice error={accessError} retry={retry} />
  if (!current) return query.isError
    ? <Alert live tone="danger" title="Couldn't load this workspace" action={retry}>{query.error.message}</Alert>
    : <p className="mcp-pending" role="status"><Icon name="clock" size={16} />
      {query.fetchStatus === 'paused' ? 'Waiting for a connection…' : 'Checking the workspace folder…'}</p>

  const location = current.executionLocation
  const status = current.locationValidation.status
  const ready = Boolean(location) && status === 'ready'
  return <div className="mcp-content" ref={contentRef} tabIndex={-1}>
    {query.isError ? <Alert tone="warning" title="Workspace details couldn't update" action={retry}>
      Showing the last saved location.
    </Alert> : null}
    {current.locationValidation.status === 'unavailable' ? <Alert tone="warning" title="Workspace folder is unavailable" action={retry}>
      {current.locationValidation.error.message}
    </Alert> : null}
    {ready && location ? <div className="mcp-connection-grid">
      {(harness ? [harness] : ['codex'] as const).map((provider) => <McpConnectionCard
        key={JSON.stringify([workspaceId, provider, location.runnerId, location.rootPath])}
        workspaceId={workspaceId} harness={provider} location={location} />)}
    </div> : status === 'restricted' ? <Alert tone="warning" title="Folder access is restricted" action={retry}>
      Ask the workspace owner for access, then try again.
    </Alert> : <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="card" onSaved={() => contentRef.current?.focus()} />}
  </div>
}

/** A picker belongs only in the global harness preview, never inside a known workspace. */
function WorkspaceSelector({ harness }: { harness?: AgentHarness }) {
  const [selected, setSelected] = useState('')
  const query = useManagedWorkspacesQuery()
  const accessError = useProtectedAccessError(query)
  const retry = <Button size="sm" loading={query.isFetching} onClick={() => void query.refetch({ cancelRefetch: false })}>Try again</Button>
  if (accessError) return <McpAccessNotice error={accessError} retry={retry} />
  if (!query.data) return query.isError
    ? <Alert live tone="danger" title="Couldn't load workspaces" action={retry}>{query.error.message}</Alert>
    : <p className="mcp-pending" role="status">{query.fetchStatus === 'paused' ? 'Waiting for a connection…' : 'Loading workspaces…'}</p>

  const choices = query.data.items.map((item) => ({
    value: item.workspace.id, label: item.workspace.name,
    description: item.locationValidation.status === 'restricted' ? 'Folder access restricted'
      : item.locationValidation.status === 'unavailable' ? 'Folder unavailable'
        : item.executionLocation ? 'Workspace folder set' : 'Needs a workspace folder',
  }))
  return <div className="mcp-content">
    {query.isError ? <Alert tone="warning" title="Workspace list couldn't update" action={retry} /> : null}
    {choices.length ? <Combobox label="Workspace" value={selected} options={choices} onValueChange={setSelected}
      placeholder="Choose a workspace…" /> : <div className="mcp-folder-notice">
      <Icon name="folder" size={22} /><div><strong>No workspaces yet</strong><p>Create a workspace to check its app connections.</p></div>
      <Link className="n-button n-button--secondary n-button--sm" to="/workspaces">Workspaces<Icon name="arrow" size={16} /></Link>
    </div>}
    {selected ? <WorkspaceEvidence key={selected} workspaceId={selected} harness={harness} /> : null}
  </div>
}

export function McpDetectionSettings(props: Props) {
  const epoch = useHarnessSessionEpoch()
  return <section className="mcp-connections" aria-label="Workspace Foreman Code MCP">
    <header className="mcp-heading">
      <div className="mcp-heading-title"><Icon name="workflow" size={20} /><h2>App connections</h2><Badge>MCP</Badge></div>
    </header>
    {props.workspaceId ? <WorkspaceEvidence key={`${props.workspaceId}:${epoch}`} {...props} workspaceId={props.workspaceId} />
      : <WorkspaceSelector key={epoch} harness={props.harness} />}
  </section>
}
