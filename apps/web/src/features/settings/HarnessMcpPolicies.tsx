import { InfoHint } from '../../shared/ui/InfoHint'
import { useState } from 'react'
import { withAdvancedDefaults, type CodexMcpToolPolicy, type CodexAdvancedConfiguration } from '@foreman-code/contracts'
import { Button, Checkbox, Select } from '../../shared/ui/nocturne'
import { useNativeMcpServers } from '../../shared/api/harnessSettings'
import type { HarnessEditor } from './harnessEditor'
import { HarnessTokenList } from './HarnessTokenList'

export function HarnessMcpPolicies({ editor, onChange }: { editor: HarnessEditor; onChange(value: HarnessEditor): void }) {
  const value = withAdvancedDefaults(editor.configuration)
  const servers = useNativeMcpServers(value.harness, value.harness !== 'claude')
  const [expanded, setExpanded] = useState<string>()
  if (value.harness === 'opencode') return null
  if (value.harness === 'claude') return <section className="harness-form-stack" aria-label="Claude tool policy">
    <HarnessTokenList label="Enabled Claude tools" labelHint={<InfoHint label="Enabled Claude tools">Enable exact tool names deliberately. MCP tools use mcp__server__tool. Adding a connection does not enable its tools. Native qualification must observe every enabled tool before execution.</InfoHint>} values={value.tools} onChange={(tools) => onChange({ ...editor, configuration: {
      ...value, tools, permissionRules: tools.map(tool => value.permissionRules.find(rule => rule.tool === tool) ?? { tool, effect: 'ask' as const }),
    } })} />
    <h4>Tool permissions <InfoHint label="Tool permissions">These permissions belong to the saved configuration. App grants and the selected sandbox are checked separately.</InfoHint></h4>
    {value.tools.map(tool => <Select key={tool} label={`${tool} approval`} value={value.permissionRules.find(rule => rule.tool === tool)?.effect ?? ''}
      options={[{ value: '', label: 'Native default' }, { value: 'ask', label: 'Ask through app routing' }, { value: 'allow', label: 'Allow' }, { value: 'deny', label: 'Deny' }]}
      onChange={event => onChange({ ...editor, configuration: { ...value, permissionRules: [
        ...value.permissionRules.filter(rule => rule.tool !== tool), ...(event.target.value ? [{ tool, effect: event.target.value as 'ask' | 'allow' | 'deny' }] : []),
      ] } })} />)}
  </section>
  const policies = value.advanced!.mcpServers
  const names = [...new Set([...Object.keys(policies), ...(servers.data?.servers.map((server) => server.name) ?? [])])].sort()
  const setPolicy = (name: string, enabled?: boolean) => {
    if (value.harness === 'codex') {
      const next = { ...value.advanced!.mcpServers }
      if (enabled === undefined) delete next[name]
      else next[name] = { ...next[name], enabled, required: enabled ? next[name]?.required ?? false : false }
      onChange({ ...editor, configuration: { ...value, advanced: { ...value.advanced!, mcpServers: next } }, mcpText: JSON.stringify(next, null, 2) })
    }
  }
  const updateCodex = (name: string, updates: Partial<CodexAdvancedConfiguration['mcpServers'][string]>) => {
    if (value.harness !== 'codex') return
    const current = value.advanced!.mcpServers[name] ?? { enabled: true, required: false }
    const next = { ...value.advanced!.mcpServers, [name]: { ...current, ...updates } }
    onChange({ ...editor, configuration: { ...value, advanced: { ...value.advanced!, mcpServers: next } }, mcpText: JSON.stringify(next, null, 2) })
  }
  return <section className="harness-mcp-policies" aria-label="Pinned MCP policy requirements"><div className="harness-section-heading"><h4>Pinned tool requirements <InfoHint label="MCP server policies">Session admission checks these against native configuration; this does not rewrite connection settings.</InfoHint></h4>
    <Button size="sm" onClick={() => void servers.refetch()} disabled={servers.isFetching}>Refresh servers</Button></div>
    {servers.isPending ? <p role="status">Discovering configured servers…</p> : null}
    {servers.isError ? <p className="harness-muted">{servers.error.message}</p> : null}
    {!names.length && !servers.isPending ? <p className="harness-muted">No server overrides. <InfoHint label="Server overrides">Native configuration is inherited.</InfoHint></p> : null}
    {names.map((name) => {
      const server = servers.data?.servers.find((item) => item.name === name)
      const policy = value.harness === 'codex' ? value.advanced!.mcpServers[name] : undefined
      const hasOverride = Object.hasOwn(policies, name)
      const enabled = policy?.enabled
      return <div key={name} className="harness-policy-row"><div className="harness-section-heading"><strong>{name}</strong>
        <Select label={`Access for ${name}`} value={hasOverride ? enabled ? 'enabled' : 'disabled' : 'inherit'}
          options={[{ value: 'inherit', label: 'Inherit' }, { value: 'enabled', label: 'Enabled' }, { value: 'disabled', label: 'Disabled' }]}
          disabled={server?.protected} onChange={(event) => setPolicy(name, event.target.value === 'inherit' ? undefined : event.target.value === 'enabled')} />
        {hasOverride ? <Button size="sm" onClick={() => setPolicy(name)}>Clear override</Button> : null}
      </div>
      {server?.protected ? <small className="harness-muted">App-managed</small> : null}
      {value.harness === 'codex' && policy && !server?.protected ? <>
        <Button variant="ghost" size="sm" aria-expanded={expanded === name} onClick={() => setExpanded(expanded === name ? undefined : name)}>Tool permissions</Button>
        {expanded === name ? <div className="harness-form-stack">
          <Checkbox label="Required for this session" checked={policy.required} disabled={!policy.enabled} onChange={(event) => updateCodex(name, { required: event.target.checked })} />
          <Select label="Tool approval" value={policy.defaultToolsApprovalMode ?? ''} options={[{ value: '', label: 'Native default' }, ...['auto', 'prompt', 'writes', 'approve'].map((mode) => ({ value: mode, label: mode }))]}
            onChange={(event) => updateCodex(name, { defaultToolsApprovalMode: (event.target.value || undefined) as typeof policy.defaultToolsApprovalMode })} />
          <div className="harness-inline-actions"><Checkbox label="Require a tool allowlist" checked={policy.enabledTools !== undefined}
            onChange={(event) => updateCodex(name, { enabledTools: event.target.checked ? [] : undefined })} />
            <InfoHint label="Require a tool allowlist">An empty allowlist permits no tools.</InfoHint></div>
          {policy.enabledTools !== undefined ? <HarnessTokenList label="Allowed tools" values={policy.enabledTools} onChange={(enabledTools) => updateCodex(name, { enabledTools })} /> : null}
          <HarnessTokenList label="Blocked tools" values={policy.disabledTools ?? []} onChange={(disabledTools) => updateCodex(name, { disabledTools })} />
          <HarnessTokenList label="Per-tool rules" values={Object.keys(policy.tools ?? {})} onChange={(names) => updateCodex(name, {
            tools: Object.fromEntries(names.map((tool) => [tool, policy.tools?.[tool] ?? {}])),
          })} />
          {Object.entries(policy.tools ?? {}).map(([tool, rule]) => <div className="harness-two-columns" key={tool}>
            <Checkbox label={tool} checked={rule.enabled !== false} onChange={(event) => updateCodex(name, { tools: { ...policy.tools, [tool]: { ...rule, enabled: event.target.checked } } })} />
            <Select label={`${tool} approval`} value={rule.approvalMode ?? ''} options={[{ value: '', label: 'Server default' }, ...['auto', 'prompt', 'writes', 'approve'].map((mode) => ({ value: mode, label: mode }))]}
              onChange={(event) => updateCodex(name, { tools: { ...policy.tools, [tool]: { ...rule, approvalMode: (event.target.value || undefined) as CodexMcpToolPolicy['approvalMode'] } } })} />
          </div>)}
        </div> : null}
      </> : null}</div>
    })}
  </section>
}
