import { InfoHint } from '../../shared/ui/InfoHint'
import { UnsavedChangesContext, useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useContext, useEffect, useRef, useState } from 'react'
import {
  HarnessMcpChangeSchema, type HarnessMcpChange, type HarnessMcpList, type HarnessMcpPlan, type HarnessMcpManagedPreset, type HarnessMcpReconcileInput,
} from '@foreman-code/contracts/management'
import { Alert, Button, Checkbox, Dialog, Icon, Select, StatusBadge, Textarea, TextField } from '../../shared/ui/nocturne'
import {
  useNativeMcpServers, useNativeMcpPlans, useRequestNativeMcpChange, useDecideNativeMcpChange, useApplyManagedMcpChange, useHarnessSessionEpoch, useReconcileNativeMcpChange,
} from '../../shared/api/harnessSettings'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { APP_MCP_SERVER_NAMES } from '@foreman-code/contracts/product'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'

type Harness = 'codex'
type Presets = HarnessMcpList['presets']
/** Retired per-role app entries; installing the graphql preset removes them. */
const LEGACY_APP_SERVERS = ['graphql-app', 'graphql-operator']
function needsAttention(name: string, presets: Presets): boolean {
  return (APP_MCP_SERVER_NAMES.some((server) => server === name) && ['mismatch', 'legacy'].includes(presets?.graphql ?? ''))
    || (LEGACY_APP_SERVERS.includes(name) && presets?.graphql !== undefined)
    || (name === 'linear' && presets?.linear === 'mismatch')
}
const words = { add: 'Add', remove: 'Remove', enable: 'Update' }
function ChangeDetails({ change }: { change: HarnessMcpChange }) {
  return <dl className="harness-change-details"><div><dt>Server</dt><dd>{change.name}</dd></div>
    <div><dt>Change</dt><dd>{change.kind === 'enable' ? change.enabled ? 'Enable' : 'Disable' : words[change.kind]}</dd></div>
    {change.kind === 'add' ? change.connection.transport === 'remote' ? <>
      <div><dt>Endpoint</dt><dd>{change.connection.url}</dd></div>
      <div><dt>Authentication</dt><dd>{change.connection.bearerTokenEnvironmentVariable ? `Bearer token from ${change.connection.bearerTokenEnvironmentVariable}` : 'Native authentication'}</dd></div>
    </> : <>
      <div><dt>Executable</dt><dd>{change.connection.executable}</dd></div>
      <div><dt>Arguments</dt><dd>{change.connection.arguments.length ? <ol>{change.connection.arguments.map((argument, index) => <li key={index}><code>{argument || '(empty argument)'}</code></li>)}</ol> : 'None'}</dd></div>
      <div><dt>Environment references</dt><dd>{change.connection.environmentVariables.join(', ') || 'None added'}</dd></div>
    </> : null}
  </dl>
}
function ConnectionForm({ busy, disabled, onReview }: {
  busy: boolean; disabled: boolean; onReview(change: HarnessMcpChange): void
}) {
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'remote' | 'stdio'>('remote')
  const [url, setUrl] = useState('')
  const [variable, setVariable] = useState('')
  const [executable, setExecutable] = useState('')
  const [argumentsText, setArgumentsText] = useState('')
  const [environment, setEnvironment] = useState('')
  const [error, setError] = useState<string>()
  const review = () => {
    const candidate = HarnessMcpChangeSchema.safeParse({ kind: 'add', name: name.trim(), connection: transport === 'remote'
      ? { transport, url: url.trim(), ...(variable.trim() ? { bearerTokenEnvironmentVariable: variable.trim() } : {}) }
      : { transport, executable: executable.trim(), arguments: argumentsText === '' ? [] : argumentsText.split('\n'),
        environmentVariables: environment.split(/[,\s]+/).filter(Boolean) } })
    if (!candidate.success) { setError(candidate.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(' ')); return }
    setError(undefined)
    onReview(candidate.data)
  }
  useUnsavedChanges({ scope: 'surface', label: 'new MCP connection',
    dirty: Boolean(name || url || variable || executable || argumentsText || environment || transport !== 'remote'),
    busy, saveDisabled: true, error: 'Keep editing and use Review connection to review this change before applying it.',
    save: review, discard: () => {
      setName(''); setUrl(''); setVariable(''); setExecutable(''); setArgumentsText(''); setEnvironment(''); setTransport('remote'); setError(undefined)
    },
  })
  return <div className="harness-form-stack">
    <TextField label="Server name" value={name} maxLength={80} autoComplete="off" onChange={(event) => setName(event.target.value)} />
    <Select label="Connection" value={transport} options={[{ value: 'remote', label: 'Remote · URL' }, { value: 'stdio', label: 'Local · installed program' }]}
      onChange={(event) => setTransport(event.target.value as typeof transport)} />
    {transport === 'remote' ? <>
      <TextField label="Server URL" type="url" placeholder="https://example.com/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />
      <TextField label="Token environment variable (optional)" placeholder="MY_SERVICE_TOKEN" autoComplete="off" spellCheck={false} value={variable}
        labelHint={<InfoHint label="Token environment variable">Enter the variable name, not the token.</InfoHint>} onChange={(event) => setVariable(event.target.value)} />
    </> : <>
      <TextField label="Installed executable" value={executable} placeholder="/absolute/path/to/mcp-server" autoComplete="off" onChange={(event) => setExecutable(event.target.value)} />
      <Textarea label="Arguments · one per line" rows={3} value={argumentsText} spellCheck={false} onChange={(event) => setArgumentsText(event.target.value)} />
      <TextField label="Environment variable names (optional)" value={environment} autoComplete="off" placeholder="SERVICE_TOKEN, SERVICE_ACCOUNT" onChange={(event) => setEnvironment(event.target.value)} />
    </>}
    {error ? <Alert tone="danger" live title={error} /> : null}
    <Button variant="primary" disabled={busy || disabled} onClick={review}>Review connection</Button>
  </div>
}

type NativeMcpManagerProps = { harness: Harness; accessUnavailable?: boolean }

function useNativeMcpManager({ harness, accessUnavailable = false }: NativeMcpManagerProps) {
  const guard = useContext(UnsavedChangesContext)
  const servers = useNativeMcpServers(harness, !accessUnavailable)
  const accessError = useProtectedAccessError(servers)
  const blocked = accessUnavailable || Boolean(accessError)
  const serverData = blocked ? undefined : servers.data
  const plans = useNativeMcpPlans(harness, !blocked)
  const request = useRequestNativeMcpChange()
  const decision = useDecideNativeMcpChange()
  const managed = useApplyManagedMcpChange(harness, plans.data?.items)
  const reconciliation = useReconcileNativeMcpChange()
  const reconciliationAttempts = useRef(new Map<string, CommandAttempt<Omit<HarnessMcpReconcileInput, 'commandId'>>>())
  const [reconcileInputs, setReconcileInputs] = useState<Record<string, HarnessMcpReconcileInput>>({})
  const [observedAcceptance, setObservedAcceptance] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [active, setActive] = useState<string>()
  const [detailsName, setDetailsName] = useState<string>()
  const [created, setCreated] = useState<HarnessMcpPlan>()
  const [feedback, setFeedback] = useState<string>()
  // A failed HTTP response may hide a committed plan. Reuse the same receipt ID on retry.
  const command = useRef<{ signature: string; id: string } | undefined>(undefined)
  const allPlans = blocked ? [] : [...(plans.data?.items ?? [])]
  const managedPlan = managed.operation?.plan
  const selected = blocked ? undefined : allPlans.find((plan) => plan.id === active)
    ?? (decision.data?.id === active ? decision.data : undefined)
    ?? (created?.id === active ? created : managedPlan?.id === active ? managedPlan : undefined)
  const reconcileInput = selected ? reconcileInputs[selected.id] : undefined
  const acceptObservedState = selected ? observedAcceptance[selected.id] ?? false : false
  const inspection = useNativeMcpServers(selected?.harness ?? harness, Boolean(active) && !blocked)
  const expired = Boolean(selected && Date.parse(selected.expiresAt) <= Date.now())
  const requestChange = (change: HarnessMcpChange) => {
    if (!serverData || servers.isError || request.isPending) return
    const signature = JSON.stringify([harness, serverData.revision, change])
    if (command.current?.signature !== signature) command.current = { signature, id: crypto.randomUUID() }
    setFeedback(undefined)
    decision.reset()
    request.mutate({ harness, commandId: command.current.id, expectedRevision: serverData.revision, change }, {
      onSuccess: (result) => { setCreated(result.value); setActive(result.value.id); setAdding(false) },
    })
  }
  const decide = (approve: boolean) => {
    if (!selected || selected.status !== 'pending') return
    decision.mutate({ planId: selected.id, approve }, { onSuccess: (result) => {
      setCreated(result)
      if (result.status === 'applied') { setFeedback('Connection settings saved.'); setActive(undefined) }
      if (result.status === 'rejected') setActive(undefined)
    } })
  }
  const manage = (preset: HarnessMcpManagedPreset, change: { installed: boolean } | { enabled: boolean }) => {
    if (!serverData || servers.isError || managed.isPending || managed.operation) return
    setFeedback(undefined)
    managed.start({ preset, ...change, expectedRevision: serverData.revision })
  }
  const reconcile = () => {
    if (!selected || !inspection.data || reconciliation.isPending) return
    const attempt = reconciliationAttempts.current.get(selected.id) ?? new CommandAttempt<Omit<HarnessMcpReconcileInput, 'commandId'>>()
    reconciliationAttempts.current.set(selected.id, attempt)
    const clearInput = () => setReconcileInputs((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== selected.id)))
    const input = reconcileInput ?? attempt.input({
      planId: selected.id, expectedRevision: inspection.data.revision, acceptObservedState })
    if (input.planId !== selected.id) return
    setReconcileInputs((current) => ({ ...current, [selected.id]: input }))
    reconciliation.mutate(input, { onSuccess: (result) => {
      attempt.succeeded(); clearInput()
      setObservedAcceptance((current) => ({ ...current, [selected.id]: false }))
      setCreated(result.value); setActive(undefined)
      setFeedback(result.value.status === 'applied' ? 'The intended settings were confirmed. No native write was repeated.'
        : 'The current settings were recorded. The original write will not be repeated.')
    }, onError: (error) => {
      attempt.failed(error)
      if (!attempt.unresolved) clearInput()
    } })
  }
  const presets = serverData?.presets
  const details = serverData?.servers.find((server) => server.name === detailsName)
  const detailsPreset: HarnessMcpManagedPreset | undefined = details && APP_MCP_SERVER_NAMES.some((name) => name === details.name) && ['installed', 'disabled'].includes(presets?.graphql ?? '') ? 'graphql'
    : details?.name === 'linear' && ['installed', 'disabled'].includes(presets?.linear ?? '') ? 'linear' : undefined
  const detailsRemovable = Boolean(details && (detailsPreset || details.editable))
  const outstanding = allPlans.filter((plan) => ['submitting', 'uncertain'].includes(plan.status)
    || (plan.harness === harness && plan.status === 'pending'))
  const managedBusy = managed.isPending || Boolean(managed.operation)
    || outstanding.some((plan) => plan.status === 'submitting' || plan.status === 'uncertain')
  const detailsBusy = managedBusy || request.isPending || decision.isPending || servers.isFetching || servers.isError
  useEffect(() => {
    if (managed.data?.status === 'applied' && managed.data.change.kind === 'remove' && managed.data.change.name === detailsName) setDetailsName(undefined)
    if (managed.operation && managed.operation.phase !== 'sending' && detailsName) setDetailsName(undefined)
  }, [managed.data, managed.operation, detailsName])
  return {
    guard, servers, blocked, serverData, plans, request, decision, managed, reconciliation,
    setObservedAcceptance, adding, setAdding, active, setActive, detailsName, setDetailsName, feedback,
    selected, reconcileInput, acceptObservedState, inspection, expired, requestChange, decide, manage,
    reconcile, presets, details, detailsPreset, detailsRemovable, outstanding, managedBusy, detailsBusy,
  }
}

function NativeMcpManager({ harness, accessUnavailable = false }: NativeMcpManagerProps) {
  const {
    guard, servers, blocked, serverData, plans, request, decision, managed, reconciliation,
    setObservedAcceptance, adding, setAdding, active, setActive, detailsName, setDetailsName, feedback,
    selected, reconcileInput, acceptObservedState, inspection, expired, requestChange, decide, manage,
    reconcile, presets, details, detailsPreset, detailsRemovable, outstanding, managedBusy, detailsBusy,
  } = useNativeMcpManager({
    harness, accessUnavailable,
  })
  return <section className="harness-mcp-manager" aria-label={`${harness} MCP connections`}>
    <div className="harness-section-heading"><div><h4>MCP servers <InfoHint label="Connections">New sessions will use them.</InfoHint></h4></div>
      <div className="harness-inline-actions"><Button size="sm" disabled={servers.isFetching} onClick={() => void servers.refetch()}>Refresh</Button>
        <Button size="sm" variant="primary" disabled={!serverData || servers.isError} onClick={() => { request.reset(); setAdding(true) }}>Add server</Button></div></div>
    {blocked ? <Alert tone="warning" title="Connection access is unavailable">Your connection draft is kept. Restore access before reviewing it.</Alert> : null}
    {servers.isPending ? <p role="status">Reading configured servers…</p> : null}
    {servers.isError ? <Alert tone="danger" title={servers.error.message} /> : null}
    {request.isError ? <Alert live tone="danger" title={request.error.message} /> : null}
    {managed.operation ? <Alert live tone="warning" title={managed.operation.phase === 'sending' ? 'Applying original MCP change' : 'MCP change needs attention'}>
      {managed.operation.error ?? (managed.operation.phase === 'sending' ? 'Waiting for the native result.' : 'Review the accepted request before making another change.')}
      {managed.operation.phase === 'retry' ? <Button size="sm" disabled={blocked || servers.isError}
        onClick={managed.retry}>Retry original change</Button> : null}
      {managed.operation.plan ? <Button size="sm" disabled={blocked}
        onClick={() => { decision.reset(); setActive(managed.operation!.plan!.id) }}>Review original change</Button> : null}
    </Alert> : managed.isError ? <Alert live tone="danger" title="MCP change was not accepted">{managed.error.message}</Alert> : null}
    {managed.data?.status === 'applied' ? <p role="status" className="harness-success">Connection settings saved.</p> : null}
    {feedback ? <p role="status" className="harness-success">{feedback}</p> : null}
    {presets ? <div className="harness-preset-actions" aria-label="Suggested MCP servers">
      {(['graphql', 'linear'] as const).map((preset) => {
        const status = presets[preset]
        if (status === 'installed' || status === 'disabled') return null
        const label = preset === 'graphql' ? 'Foreman Code MCP' : 'Linear MCP'
        const actionable = status === 'missing' || status === 'legacy'
          || (status === 'mismatch' && (preset !== 'linear' || !serverData?.servers.find((server) => server.name === 'linear')?.protected))
        let helpLabel = label
        let helpText: string | undefined
        let warning: string | undefined
        if (status === 'missing') helpText = preset === 'graphql'
          ? 'App tools for Operator chat and workflow agents, with automatic instance routing. Each agent’s role decides which tools it can call.'
          : 'Read-only Linear connection; sign in with the harness after adding.'
        else if (status === 'legacy') {
          helpLabel = `Upgrade to ${label}`
          helpText = 'Replaces the separate graphql-app and graphql-operator connections with one connection for every role.'
        } else if (status === 'inherited') warning = 'Configured outside this user profile. Edit it at its source.'
        else if (preset === 'graphql') {
          helpLabel = `Repair ${label}`
          helpText = 'Repair the connection while keeping its tool, approval, and disabled policies.'
        } else warning = 'This is not the verified read-only preset. Conversion changes its endpoint; native sign-in remains separate.'
        return <div key={preset} className="harness-preset-row"><div><strong>{label}
          {helpText ? <InfoHint label={helpLabel}>{helpText}</InfoHint> : null}</strong>
          {warning ? <small>{warning}</small> : null}</div>
          {actionable ? <Button size="sm" disabled={managedBusy || servers.isFetching || servers.isError} loading={managed.isPending && managed.variables?.preset === preset}
            onClick={() => manage(preset, { installed: true })}>{status === 'legacy' ? `Upgrade to ${label}` : status === 'mismatch' ? preset === 'linear' ? `Convert to read-only` : `Repair ${label}` : `Add ${label}`}</Button> : <StatusBadge tone="warning" label={status === 'inherited' ? 'Inherited' : 'Needs attention'} />}
        </div>
      })}
    </div> : null}
    {serverData?.servers.length === 0 ? <div className="harness-empty">No servers configured. Add a connection to give this harness more tools.</div> : null}
    <ul className="harness-server-list">{serverData?.servers.map((server) => {
      const status = !server.enabled ? 'Disabled'
        : server.origin === 'inherited' ? 'Inherited'
          : needsAttention(server.name, presets) ? 'Needs attention' : 'Enabled'
      return <li key={server.name}>
        <button type="button" className="harness-server-open" aria-label={`View details for ${server.name}, ${status}`} onClick={() => setDetailsName(server.name)}>
          <span className="harness-server-symbol" aria-hidden="true">{server.transport === 'remote' ? '↗' : '⌘'}</span>
          <span className="harness-server-name"><strong>{server.name}</strong></span>
          <span className="harness-server-status" data-status={status === 'Enabled' ? 'enabled' : status === 'Disabled' ? 'disabled' : 'attention'} aria-hidden="true" />
        </button>
      </li>
    })}</ul>
    {outstanding.length ? <section className="harness-pending-plans" aria-label="MCP change requests"><h4>Change requests</h4>
      {outstanding.map((plan) => {
        const operation = managed.operation
        const kind = operation && ('enabled' in operation.input ? 'enable' : operation.input.installed ? 'add' : 'remove')
        const applying = operation?.phase === 'sending' && plan.harness === harness && plan.managedPreset === operation.input.preset
          && plan.change.kind === kind
        return <div key={plan.id} className="harness-plan-row"><span>{plan.harness === harness ? '' : `${plan.harness} · `}{words[plan.change.kind]} <strong>{plan.change.name}</strong><small>{applying ? 'Awaiting native confirmation' : plan.status === 'pending' && Date.parse(plan.expiresAt) <= Date.now() ? 'Expired' : plan.status}</small></span>
          {applying ? <span role="status">Applying…</span> : <Button size="sm" onClick={() => { decision.reset(); setActive(plan.id) }}>Review</Button>}</div>
      })}
    </section> : null}
    {plans.isError ? <p className="harness-muted" role="status">Change requests: {plans.error.message}</p> : null}
    <Dialog open={adding} onOpenChange={(open) => { if (open) setAdding(true); else void (async () => { if (!guard || await guard.surfaces()) setAdding(false) })() }} title={`Add ${'Codex'} MCP server`} size="md" busy={request.isPending}>
      {adding ? <ConnectionForm busy={request.isPending} disabled={blocked || servers.isError} onReview={requestChange} /> : null}
      {request.isError ? <Alert tone="danger" title={request.error.message} /> : null}
    </Dialog>
    <Dialog open={Boolean(active)} onOpenChange={(open) => { if (!open) setActive(undefined) }} title="Review MCP change" size="md" busy={decision.isPending || reconciliation.isPending}
      footer={selected?.status === 'pending' ? <><Button disabled={decision.isPending} onClick={() => decide(false)}>Reject</Button>
        <Button variant={selected.change.kind === 'remove' ? 'danger' : 'primary'} disabled={decision.isPending || expired} onClick={() => decide(true)}>{decision.isPending ? 'Applying…' : 'Approve and apply'}</Button></>
        : selected && ['submitting', 'uncertain'].includes(selected.status) ? <>
          <Button disabled={inspection.isFetching || reconciliation.isPending} onClick={() => void inspection.refetch()}>Refresh inspection</Button>
          <Button variant="primary" disabled={!inspection.data || inspection.isError || inspection.isFetching || reconciliation.isPending} onClick={reconcile}>
            {reconciliation.isPending ? 'Reconciling…' : 'Reconcile without rewriting'}</Button>
          <InfoHint label="Reconcile">Reconciliation closes the old request without sending its native write again. It first checks the current configuration and any owned writer process.</InfoHint>
        </> : <Button onClick={() => setActive(undefined)}>Close</Button>}>
      {selected ? <div className="harness-form-stack"><p>Codex · native user configuration</p><ChangeDetails change={selected.change} />
        <p className="harness-access-warning">A server may run programs or send data to its endpoint. Only approve a connection you trust.</p>
        <span className="harness-muted">Requested by {selected.requestedBy}</span>
        {selected.status !== 'pending' || expired ? <Alert tone={selected.status === 'applied' ? 'success' : 'warning'} title={expired && selected.status === 'pending' ? 'Request expired. Reject it before preparing a new request.' : `Change ${selected.status}`}>
          {selected.error ?? (selected.status === 'uncertain' ? 'The write may have completed. Reconcile it without rewriting; Refresh alone does not settle this request.' : null)}</Alert> : null}
        {selected && ['submitting', 'uncertain'].includes(selected.status) ? <>
          <Checkbox label="Keep the current native configuration even if the original result cannot be proven" checked={acceptObservedState}
            disabled={Boolean(reconcileInput) || reconciliation.isPending} onChange={(event) => setObservedAcceptance((current) => ({ ...current, [selected.id]: event.target.checked }))} />
          {inspection.isError ? <Alert tone="danger" title={inspection.error.message} /> : null}
          {reconciliation.isError ? <Alert tone="danger" live title={reconciliation.error.message} /> : null}
        </> : null}
        {decision.isError ? <Alert tone="danger" live title={decision.error.message} /> : null}
      </div> : <p role="status">Loading request…</p>}
    </Dialog>
    <Dialog open={Boolean(detailsName)} onOpenChange={(open) => { if (!open) setDetailsName(undefined) }}
      title={details ? `${details.name} MCP details` : 'MCP server unavailable'} size="md" closeOnOutsideClick busy={managed.isPending}
      footer={<>
        {details && (detailsPreset || details.editable) ? <Button disabled={detailsBusy} onClick={() => {
          if (detailsPreset) manage(detailsPreset, { enabled: !details.enabled })
          else { setDetailsName(undefined); requestChange({ kind: 'enable', name: details.name, enabled: !details.enabled }) }
        }}>{details.enabled ? 'Disable' : 'Enable'}</Button> : null}
        {details ? <Button variant="danger" leading={<Icon name="trash" size={16} />} disabled={!detailsRemovable || detailsBusy} onClick={() => {
          if (detailsPreset) manage(detailsPreset, { installed: false })
          else { setDetailsName(undefined); requestChange({ kind: 'remove', name: details.name }) }
        }}>Remove server</Button> : null}
        <Button disabled={managed.isPending} onClick={() => setDetailsName(undefined)}>Close</Button>
      </>}>
      {details ? <div className="harness-form-stack">
        {details.name === 'graphql' && detailsPreset === 'graphql' ? <div className="harness-inline-actions">
          <Button size="sm" disabled={detailsBusy} onClick={() => manage('graphql', { installed: true })}>Rename to Foreman Code MCP</Button>
          <InfoHint label="Rename to Foreman Code MCP">This supported connection can keep its native name. Renaming it preserves its policies and removes the old entry.</InfoHint>
        </div> : null}
        <div className="harness-inline-actions"><StatusBadge tone={!details.enabled ? 'danger' : details.origin === 'inherited' || needsAttention(details.name, presets) ? 'warning' : 'success'}
          label={!details.enabled ? 'Disabled' : details.origin === 'inherited' ? 'Inherited' : needsAttention(details.name, presets) ? 'Needs attention' : 'Enabled'} />
        <InfoHint label="Enabled">Enabled means the native configuration permits startup; a live tool call is needed to verify the connection.</InfoHint></div>
        <dl className="harness-change-details">
          <div><dt>Harness</dt><dd>{'Codex'}</dd></div>
          <div><dt>Native name</dt><dd><code>{details.name}</code></dd></div>
          <div><dt>Connection</dt><dd>{details.transport === 'remote' ? 'Remote MCP' : details.transport === 'stdio' ? 'Local program' : 'Native connection'}</dd></div>
          <div><dt>{details.transport === 'remote' ? 'Host' : 'Program'}{details.transport === 'remote' && !details.endpoint ? <InfoHint label="Host">Only the host is shown here. Native URLs can contain private credentials; inspect their configuration source for the full address.</InfoHint> : null}</dt><dd>{details.label}</dd></div>
          {details.endpoint ? <div><dt>Endpoint</dt><dd><code>{details.endpoint}</code></dd></div> : null}
          <div><dt>Configuration</dt><dd>{details.origin === 'inherited' ? 'Inherited from another configuration source' : details.protected ? 'App-managed user configuration' : 'Native user configuration'}</dd></div>
        </dl>
        {LEGACY_APP_SERVERS.includes(details.name) ? <p className="harness-muted">
          This retired connection is replaced by <code>foreman-code</code>, which serves Operator chat and workflow agents. Use Upgrade to Foreman Code MCP to remove it.
        </p> : !detailsRemovable ? <p className="harness-muted">{details.protected ? 'This app-managed connection is protected here. Change it in its owning app settings.' : 'This connection comes from another configuration source. Enable, disable, or remove it there.'}</p> : null}
        {details.name === 'linear' && detailsPreset === 'linear' ? <p className="harness-muted">
          Sign in with <code>{'codex mcp login linear'}</code>. <InfoHint label="Remove Linear connection">Removing this connection keeps the harness’s saved sign-in.</InfoHint>
        </p> : null}
      </div> : <p role="status">This server is no longer in the native list. Refresh to see current connections.</p>}
    </Dialog>
  </section>
}

export function HarnessMcpManager({ harness, accessUnavailable }: { harness: Harness; accessUnavailable?: boolean }) {
  const epoch = useHarnessSessionEpoch()
  return <NativeMcpManager key={`${harness}:${epoch}`} harness={harness} accessUnavailable={accessUnavailable} />
}
