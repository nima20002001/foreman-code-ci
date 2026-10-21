import { InfoHint } from '../../shared/ui/InfoHint'
import { useState } from 'react'
import { APP_MCP_SERVER_NAMES, PRODUCT_SLUG } from '@foreman-code/contracts/product'
import { ClaudeMcpServerNameSchema, ClaudeMcpServerSchema, ClaudeSupportedMcpServersSchema,
  type ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { useClaudeSetupOptions } from '../../shared/api/harnessSettings'
import { Alert, Button, TextField } from '../../shared/ui/nocturne'

/** Edits only the parent configuration draft; its revisioned save owns persistence. */
export function ClaudeMcpConfiguration({ value, onChange, appPreset = true }: {
  value: ClaudeHarnessConfiguration; onChange(value: ClaudeHarnessConfiguration): void; appPreset?: boolean;
}) {
  const setup = useClaudeSetupOptions(appPreset)
  const appConfigured = APP_MCP_SERVER_NAMES.some((server) => Object.hasOwn(value.mcpServers, server))
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string>()
  const setServer = (serverName: string, server: ClaudeHarnessConfiguration['mcpServers'][string]) =>
    onChange({ ...value, mcpServers: { ...value.mcpServers, [serverName]: server } })
  const add = () => {
    const parsedName = ClaudeMcpServerNameSchema.safeParse(name.trim())
    const parsedServer = ClaudeMcpServerSchema.safeParse({ type: 'http', url: url.trim() })
    if (!parsedName.success) { setError('Use a server name beginning with a letter, with letters, numbers, underscores or hyphens.'); return }
    if (Object.hasOwn(value.mcpServers, parsedName.data)) { setError('This server name is already configured. Remove it before replacing it.'); return }
    if (appConfigured && APP_MCP_SERVER_NAMES.some((server) => server === parsedName.data)) {
      setError('The app MCP connection is already configured under a supported name. Keep one connection for this app.')
      return
    }
    if (!parsedServer.success) { setError('Use HTTPS or a local HTTP endpoint without credentials, a query or a fragment.'); return }
    const supported = ClaudeSupportedMcpServersSchema.safeParse({ [parsedName.data]: parsedServer.data })
    if (!supported.success) { setError(supported.error.issues[0]!.message); return }
    setServer(parsedName.data, parsedServer.data)
    setName(''); setUrl(''); setError(undefined)
  }
  return <section className="harness-form-stack" aria-label="Claude MCP configuration">
    <h4>MCP connections <InfoHint label="MCP connections">Claude supports the Foreman Code app MCP connection. External MCP servers are not supported because their tool manifests cannot be verified. Save changes below to apply them to future configurations.</InfoHint></h4>
    {appPreset ? <div className="harness-section-heading"><div><strong>Foreman Code MCP</strong><InfoHint label="Foreman Code MCP">The app delivers a scoped credential at authorized execution. Adding this connection does not grant tool access or qualify Claude.</InfoHint></div>
      <Button size="sm" disabled={!setup.data?.graphqlMcp || appConfigured}
        onClick={() => { if (setup.data?.graphqlMcp) setServer(PRODUCT_SLUG, setup.data.graphqlMcp) }}>{appConfigured ? 'Foreman Code added' : 'Add Foreman Code MCP'}</Button>
    </div> : null}
    {appPreset && setup.isError ? <Alert tone="warning" title="Could not read the app MCP endpoint" action={<Button size="sm" onClick={() => void setup.refetch()}>Retry</Button>}>{setup.error.message}</Alert> : null}
    {Object.entries(value.mcpServers).map(([serverName, server]) => <div key={serverName} className="harness-policy-row">
      <div className="harness-section-heading"><strong>{serverName}</strong><Button size="sm" variant="ghost" onClick={() => {
        const next = { ...value.mcpServers }; delete next[serverName]; onChange({ ...value, mcpServers: next })
      }}>Remove {serverName}</Button></div><p><code>{server.url}</code></p>
    </div>)}
    {!Object.keys(value.mcpServers).length ? <p className="harness-muted">No MCP servers are configured.</p> : null}
    <div className="harness-two-columns"><TextField label="MCP server name" value={name} onChange={event => setName(event.target.value)} />
      <TextField label="MCP endpoint" value={url} placeholder="https://example.com/mcp" onChange={event => setUrl(event.target.value)} /></div>
    {error ? <p role="alert" className="n-field-error">{error}</p> : null}
    <Button size="sm" disabled={!name.trim() || !url.trim()} onClick={add}>Add HTTP MCP server</Button>
  </section>
}
