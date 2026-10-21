import { useEffect, useId, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { AgentHarness, ExecutionLocation, McpDetection } from '@foreman-code/contracts'
import type { ApiError } from '../../shared/api/client'
import { useMcpDetectionQuery } from '../../shared/api/query'
import { Alert, Badge, Button, Icon, type IconName, type Tone } from '../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'

const states: Record<McpDetection['state'], { label: string; hint?: string; tone: Tone; icon: IconName }> = {
  connected: { label: 'Connected', tone: 'success', icon: 'check' },
  not_detected: { label: 'Not set up', hint: 'Foreman Code MCP was not found for this workspace. Add it in Harness Settings.', tone: 'neutral', icon: 'plus' },
  misconfigured: { label: 'Needs attention', hint: 'The connection settings do not match this workspace.', tone: 'warning', icon: 'warning' },
  status_unavailable: { label: 'Setup found', hint: 'Native settings match. To verify live use, run a workflow that calls a Foreman Code MCP tool, then check its completed tool activity in Runs.', tone: 'info', icon: 'info' },
  disabled: { label: 'Turned off', hint: 'Foreman Code MCP is disabled in this provider’s configuration.', tone: 'neutral', icon: 'pause' },
  authentication_required: { label: 'Sign-in required', hint: 'The Foreman Code MCP connection needs authentication.', tone: 'warning', icon: 'lock' },
  broken: { label: 'Cannot connect', hint: 'The last connection attempt failed.', tone: 'danger', icon: 'warning' },
  check_failed: { label: 'Check failed', hint: 'The connection check could not finish.', tone: 'danger', icon: 'warning' },
}

export function McpAccessNotice({ error, retry }: { error: ApiError; retry: ReactNode }) {
  return <Alert live tone="warning" title="Connection access is unavailable" action={retry}>
    {error.message} Refresh after checking the local API connection.
  </Alert>
}

export function McpConnectionCard({ workspaceId, harness, location }: {
  workspaceId: string; harness: AgentHarness; location: ExecutionLocation
}) {
  if (harness === 'claude') return <article className="mcp-connection-card" aria-label="Claude">
    <div className="mcp-provider-heading"><h3>Claude</h3></div>
    <Alert title="Claude workspace connection checks are not available here.">This native workspace check supports Codex. Claude uses MCP servers pinned in its accepted configuration.</Alert>
    <Link className="n-button n-button--secondary n-button--sm" to="/settings/harnesses" search={{ harness: 'claude', section: 'connections' }}>Configure Claude MCP</Link>
  </article>
  return <SupportedMcpConnectionCard workspaceId={workspaceId} harness={harness} location={location} />
}

function SupportedMcpConnectionCard({ workspaceId, harness, location }: {
  workspaceId: string; harness: Exclude<AgentHarness, 'claude'>; location: ExecutionLocation
}) {
  const query = useMcpDetectionQuery(workspaceId, harness)
  const accessError = useProtectedAccessError(query)
  const headingId = useId()
  const name = 'Codex'
  const mismatched = Boolean(query.data && (query.data.runnerId !== location.runnerId
    || query.data.workingDirectory !== location.rootPath || query.data.detection.harness !== harness))
  const { refetch } = query
  // The existing query key is workspace/provider scoped. Never present cached evidence
  // from an old execution folder as a healthy connection to the new one.
  useEffect(() => {
    if (mismatched && !accessError) void refetch({ cancelRefetch: false })
  }, [mismatched, accessError, refetch])

  const result = !accessError && !mismatched ? query.data : undefined
  const paused = query.fetchStatus === 'paused'
  const stale = Boolean(result && (query.isError || paused))
  const state = result ? states[result.detection.state] : undefined
  const label = state ? `${stale ? 'Last known: ' : ''}${state.label}`
    : paused ? 'Waiting for connection' : query.isFetching ? 'Checking…' : query.isError ? 'Check failed' : mismatched ? 'Check needed' : 'Check failed'
  const hint = paused ? 'Checks resume when you’re back online.'
    : stale ? 'Couldn’t update. Showing the last check.'
      : mismatched ? query.isError ? 'Couldn’t check the new folder. Try again.'
        : query.isFetching ? 'Checking the updated workspace folder.' : 'This report doesn’t match the workspace. Check again.'
        : state?.hint ?? (!result && query.isError ? 'Couldn’t check this connection. Try again.' : undefined)
  const check = <Button size="sm" className="mcp-check-button" loading={query.isFetching} loadingLabel="Checking…"
    aria-label={`Check setup for ${name}`} leading={<Icon name="refresh" size={15} />}
    onClick={() => void refetch({ cancelRefetch: false })}>Check setup</Button>

  return <article className="mcp-connection-card" aria-labelledby={headingId}>
    <div className="mcp-provider-heading">
      <span className="mcp-provider-icon"><Icon name={harness === 'codex' ? 'terminal' : 'code'} size={22} /></span>
      <h3 id={headingId}>{name}</h3>
    </div>
    {accessError ? <McpAccessNotice error={accessError} retry={check} /> : <>
      <div className="mcp-status" role="status" aria-live="polite" aria-atomic="true">
        <Badge tone={stale ? 'warning' : state?.tone ?? (query.isError ? 'danger' : 'neutral')}>
          <Icon name={stale ? 'history' : state?.icon ?? (query.isError ? 'warning' : 'clock')} size={14} />{label}
        </Badge>
      </div>
      {hint ? <p className="mcp-hint">{hint}</p> : null}
      <div className="mcp-card-actions">
        {result ? <span className="mcp-checked"><Icon name="clock" size={13} />
          <time dateTime={result.detection.checkedAt} title={new Date(result.detection.checkedAt).toLocaleString()}>
            Checked {new Date(result.detection.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </time></span> : <span />}
        {check}
      </div>
      {result || query.error ? <details className="mcp-connection-details">
        <summary><Icon name="info" size={15} /><span>Details</span><span className="n-sr-only"> for {name}</span><Icon name="down" size={15} /></summary>
        <div className="mcp-details-content">
          {query.error ? <p className="mcp-diagnostic">{query.error.message}</p> : null}
          {result?.detection.detail ? <p className="mcp-diagnostic">{result.detection.detail}</p> : null}
          {result ? <>
            <dl className="mcp-facts">
              <div><dt>Runner</dt><dd>{result.runnerId}</dd></div>
              <div><dt>Folder</dt><dd><code>{result.workingDirectory}</code></dd></div>
              <div><dt>Version</dt><dd>{result.providerVersion}</dd></div>
              <div><dt>Checked</dt><dd><time dateTime={result.detection.checkedAt}>{new Date(result.detection.checkedAt).toLocaleString()}</time></dd></div>
            </dl>
            {result.nativeFilters.enabledTools?.length ? <div className="mcp-tool-filters"><h4>Allowed tools</h4><ul>
              {result.nativeFilters.enabledTools.map((tool) => <li key={tool}><code>{tool}</code></li>)}
            </ul></div> : null}
            {result.nativeFilters.disabledTools?.length ? <div className="mcp-tool-filters"><h4>Blocked tools</h4><ul>
              {result.nativeFilters.disabledTools.map((tool) => <li key={tool}><code>{tool}</code></li>)}
            </ul></div> : null}
            {result.nativeFilters.diagnostics?.length ? <div className="mcp-tool-filters"><h4>Diagnostics</h4><ul>
              {result.nativeFilters.diagnostics.map((detail, index) => <li key={`${index}:${detail}`}>{detail}</li>)}
            </ul></div> : null}
          </> : null}
        </div>
      </details> : null}
    </>}
  </article>
}
