import { useRef, type ReactNode } from 'react'
import { APP_MCP_SERVER_NAMES, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import type { HarnessDefaults } from '@foreman-code/contracts'
import { HarnessDefaultsUpdateInputSchema } from '@foreman-code/contracts/management'
import { useApplyManagedMcpChange, useClaudeSetupOptions, useHarnessSessionEpoch, useNativeMcpPlans, useNativeMcpServers } from '../../shared/api/harnessSettings'
import { useUpdateManagedHarnessDefaultsMutation } from '../../shared/api/query'
import { commandWasRejected } from '../../shared/api/commandAttempt'
import { Badge, Button } from '../../shared/ui/nocturne'

type Tone = 'success' | 'warning' | 'neutral'
type DefaultsUpdate = ReturnType<typeof HarnessDefaultsUpdateInputSchema.parse>
function Status({ label, tone, children }: { label: string; tone: Tone; children?: ReactNode }) {
  return <>
    <span className="operator-mcp-status"><span>Operator MCP</span><Badge tone={tone}>{label}</Badge></span>
    {children}
  </>
}

/** Codex keeps the Operator MCP in its native user config; one click applies the managed preset. */
function CodexOperatorMcp() {
  const servers = useNativeMcpServers('codex')
  const plans = useNativeMcpPlans('codex')
  const managed = useApplyManagedMcpChange('codex', plans.data?.items)
  const preset = servers.data?.presets?.graphql
  if (servers.isPending) return <Status label="Checking…" tone="neutral" />
  if (servers.isError || !preset) return <Status label="Unavailable" tone="warning">
    <Button size="sm" variant="ghost" onClick={() => void servers.refetch()}>Retry</Button>
  </Status>
  const operation = managed.operation
  if (operation) {
    return <Status label={operation.phase === 'sending' ? 'Installing…' : 'Needs attention'} tone="warning">
      {operation.phase === 'retry' ? <Button size="sm" onClick={managed.retry}>Retry install</Button> : null}
      {operation.phase === 'review' ? <small>Open Connections to review this change.</small> : null}
      {operation.error ? <small className="operator-mcp-error" role="alert">{operation.error}</small> : null}
    </Status>
  }
  if (managed.isError) return <Status label="Needs attention" tone="warning">
    <small className="operator-mcp-error" role="alert">{managed.error.message}</small>
    <Button size="sm" variant="ghost" onClick={() => {
      managed.reset()
      void servers.refetch()
    }}>Refresh setup</Button>
  </Status>
  const start = (change: { installed: boolean } | { enabled: boolean }) => managed.start({ preset: 'graphql', ...change, expectedRevision: servers.data.revision })
  switch (preset) {
    case 'installed': return <Status label="Installed" tone="success" />
    case 'inherited': {
      const disabled = servers.data.servers.some((server) => APP_MCP_SERVER_NAMES.some((name) => name === server.name)
        && !server.enabled)
      return <Status label={disabled ? 'Disabled' : 'Installed'} tone={disabled ? 'warning' : 'success'}>
        <small>From another Codex config layer. Change it at its source.</small>
      </Status>
    }
    case 'disabled': return <Status label="Disabled" tone="warning"><Button size="sm" onClick={() => start({ enabled: true })}>Enable</Button></Status>
    case 'legacy': case 'mismatch': return <Status label="Outdated" tone="warning"><Button size="sm" onClick={() => start({ installed: true })}>Update</Button></Status>
    default: return <Status label="Not installed" tone="neutral"><Button size="sm" variant="primary" onClick={() => start({ installed: true })}>Install</Button></Status>
  }
}

/** Claude keeps MCP servers in its saved preset; one click adds this app's endpoint to that preset. */
function ClaudeOperatorMcp({ defaults, revision }: { defaults: HarnessDefaults; revision: number }) {
  const setup = useClaudeSetupOptions()
  const save = useUpdateManagedHarnessDefaultsMutation()
  const command = useRef<DefaultsUpdate | undefined>(undefined)
  const claude = defaults.claude
  if (!claude) return <Status label="No preset" tone="neutral"><small>Save a Claude preset first</small></Status>
  if (setup.isPending) return <Status label="Checking…" tone="neutral" />
  if (setup.isError || !setup.data?.graphqlMcp) return <Status label="Unavailable" tone="warning">
    <small className="operator-mcp-error" role="alert">{setup.error?.message ?? 'The app MCP endpoint is unavailable.'}</small>
    <Button size="sm" variant="ghost" onClick={() => void setup.refetch()}>Retry setup</Button>
  </Status>
  const endpoint = setup.data.graphqlMcp
  const serverName = APP_MCP_SERVER_NAMES.find((name) => Object.hasOwn(claude.mcpServers, name))
  const server = serverName ? claude.mcpServers[serverName] : undefined
  if (server?.type === endpoint.type && server.url === endpoint.url) {
    return <Status label="Installed" tone="success" />
  }
  const pendingLabel = server ? 'Updating…' : 'Installing…'
  const savedLabel = server ? 'Outdated' : 'Not installed'
  const label = save.isPending ? pendingLabel : savedLabel
  return <Status label={label} tone={server ? 'warning' : 'neutral'}>
    <Button size="sm" variant={server ? 'secondary' : 'primary'} disabled={save.isPending} onClick={() => {
      const input = command.current ?? HarnessDefaultsUpdateInputSchema.parse({
        commandId: crypto.randomUUID(), expectedRevision: revision,
        defaults: {
          ...defaults,
          claude: { ...claude, mcpServers: { ...claude.mcpServers, [serverName ?? PRODUCT_SLUG]: endpoint } },
        },
      })
      command.current = input
      save.mutate(input, {
        onSuccess: () => { command.current = undefined },
        onError: (error) => { if (commandWasRejected(error)) command.current = undefined },
      })
    }}>{server ? 'Update' : 'Install'}</Button>
    {save.isError ? <small className="operator-mcp-error" role="alert">{save.error.message}</small> : null}
  </Status>
}

export function OperatorMcpStatus({ harness, defaults, revision }: { harness: 'codex' | 'claude'; defaults: HarnessDefaults; revision: number }) {
  const epoch = useHarnessSessionEpoch()
  return harness === 'codex' ? <CodexOperatorMcp /> : <ClaudeOperatorMcp key={epoch} defaults={defaults} revision={revision} />
}
