import { InfoHint } from '../../shared/ui/InfoHint'
import { useState } from 'react'
import type { AccountProvider } from '@foreman-code/contracts/provider-accounts'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { Alert, Button, ErrorState, LoadingState, Select } from '../../shared/ui/nocturne'
import { ProviderAccountEditor } from './ProviderAccountEditor'
import { ProviderAccountRow } from './ProviderAccountRow'
import { ProviderAccountAuthentication } from './ProviderAccountAuthentication'
import { useProviderAccountAccess } from './providerAccountAccess'
import { providerAccountsKey, useProviderAccounts, useProviderAccountScope, useProviderAccountDetails } from './providerAccountsQueries'
import './providerAccounts.css'

export type ProviderAccountNavigation = {
  accountId: string; operationId?: string; provider: AccountProvider; target?: DeviceProvisioningTarget
}
export function ProviderAccountsSettings({ provider, selection, onSelect, target, onTargetChange }: {
  provider?: AccountProvider; selection?: ProviderAccountNavigation | undefined;
  onSelect?: ((selection: ProviderAccountNavigation | undefined) => void) | undefined;
  target?: DeviceProvisioningTarget | undefined;
  onTargetChange?: ((target: DeviceProvisioningTarget) => void) | undefined;
}) {
  const requestedTarget = target ?? selection?.target
  const scope = useProviderAccountScope({ ...(provider ? { provider } : {}), includeRemoved: true,
    ...(requestedTarget ? { target: requestedTarget } : {}) })
  const access = useProviderAccountAccess(scope.target)
  const readable = Boolean(access.target?.canRead)
  const query = useProviderAccounts(readable, scope)
  const denied = useProtectedAccessError(query)
  const scopeKey = JSON.stringify(providerAccountsKey({ ...scope, generation: 0 }))
  const [editing, setEditing] = useState<{ scopeKey: string; provider: AccountProvider; accountId?: string }>()
  const [authentication, setAuthentication] = useState<{ scopeKey: string; accountId: string;
    provider: AccountProvider; operationId?: string; open: boolean }>()
  const edit = editing?.scopeKey === scopeKey ? editing : undefined
  const auth = authentication?.scopeKey === scopeKey ? authentication : undefined
  const selected = selection && (!provider || selection.provider === provider) ? selection : undefined
  const authAccountId = selected?.accountId ?? auth?.accountId
  const authOperationId = selected?.operationId ?? auth?.operationId
  const accounts = denied ? [] : query.data?.accounts ?? []
  const account = accounts.find(item => item.id === edit?.accountId)
  const editAccess = useProviderAccountAccess(scope.target, account?.binding)
  const listedAuthAccount = accounts.find(item => item.id === authAccountId)
  const authDetail = useProviderAccountDetails(query.isSuccess && !denied && !listedAuthAccount ? authAccountId : undefined, scope)
  const authDetailDenied = useProtectedAccessError(authDetail)
  const authAccount = listedAuthAccount ?? (!authDetail.isError && !authDetailDenied ? authDetail.data : undefined)
  const providers = provider ? [provider] : ['codex', 'claude'] as const
  const targetChoices = access.discovery.data?.targets.map(item => ({ value: JSON.stringify(item.target),
    label: `${item.label} · ${item.target.applicationInstallationId}${item.connected ? '' : ' · offline'}`,
    disabled: !item.canRead })) ?? []
  const selectedTarget = scope.target ? JSON.stringify(scope.target) : ''
  if (scope.target && !access.discovery.data?.targets.some(item => sameDeviceProvisioningTarget(item.target, scope.target!))) {
    targetChoices.push({ value: selectedTarget, label: 'Saved computer · unavailable', disabled: true })
  }
  return <section className="provider-accounts-settings" aria-label={provider
    ? `${provider === 'codex' ? 'Codex' : 'Claude'} accounts` : 'Provider accounts'}>
    <header className="provider-accounts-heading"><h3>Accounts <InfoHint label="Accounts">Add one to keep its sign-in separate.</InfoHint></h3></header>
    {onTargetChange ? <Select label={`${provider === 'claude' ? 'Claude' : 'Codex'} account computer`}
      value={selectedTarget} options={targetChoices} disabled={access.discovery.isPending}
      onChange={event => {
        const selected = access.discovery.data?.targets.find(item => JSON.stringify(item.target) === event.target.value)
        if (selected) onTargetChange(selected.target)
      }} /> : null}
    {scope.target ? <p className="provider-account-note">{access.target?.label ?? 'Saved computer'} · {
      scope.target.hostRef.kind === 'main' ? scope.target.hostRef.mainId : scope.target.hostRef.deviceId}
      {' · Installation '}{scope.target.applicationInstallationId}</p> : null}
    {denied || query.isError && !query.data || access.discovery.isError || access.discovery.isSuccess && !readable ?
      <ErrorState title="Accounts are unavailable"
      description={denied?.message ?? query.error?.message ?? access.discovery.error?.message
        ?? 'The selected computer is unavailable. Choose an accessible computer or refresh its connection.'}
      onRetry={() => { void access.discovery.refetch(); void query.refetch() }} /> : !query.data ?
      <LoadingState label="Loading accounts…" rows={1} /> : <>
      {query.isError ? <Alert live tone="danger" title={query.error.message}
        action={<Button onClick={() => void query.refetch()}>Retry accounts</Button>} /> : null}
      {providers.map(item => {
        const capability = access.target?.providers.find(value => value.provider === item)
        const canAdd = access.canManage && access.target?.connected && capability?.qualified
          && (capability.actions.includes('create') || capability.actions.includes('register'))
        return <section key={item} aria-label={provider ? undefined : `${item === 'codex' ? 'Codex' : 'Claude'} accounts`}>
        <div className="provider-accounts-heading">
          {!provider ? <h4>{item === 'codex' ? 'Codex' : 'Claude'}</h4> : null}
          <Button size="sm" disabled={!canAdd || Boolean(edit)}
            onClick={() => setEditing({ scopeKey, provider: item })}>Add {item === 'codex' ? 'Codex' : 'Claude'} account</Button>
        </div>
        <div className="provider-accounts-rows">{accounts.filter(value => value.provider === item).map(value =>
          <ProviderAccountRow key={`${scopeKey}:${value.id}:${value.binding?.bindingRevision ?? 0}`}
            account={value} revision={query.data!.revision} scope={scope}
            defaultRevision={query.data!.defaults?.find(current => current.provider === item)?.revision}
            onConfigure={() => setEditing({ scopeKey, provider: item, accountId: value.id })}
            onAuthenticate={() => {
              setAuthentication({ scopeKey, provider: item, accountId: value.id,
                ...(auth?.accountId === value.id && auth.operationId ? { operationId: auth.operationId } : {}), open: true })
              onSelect?.({ provider: item, accountId: value.id, ...(scope.target ? { target: scope.target } : {}),
                ...(auth?.accountId === value.id && auth.operationId ? { operationId: auth.operationId } : {}) })
            }} />)}</div>
        {!accounts.some(value => value.provider === item) ? <p>No accounts added.</p> : null}
        {capability?.reason ? <p>{capability.reason}</p> : null}
      </section>})}
    </>}
    {edit && !denied && query.data ? <ProviderAccountEditor key={`${scopeKey}:${edit.accountId ?? edit.provider}`}
      provider={edit.provider} accountId={edit.accountId} {...(account ? { account } : {})} scope={scope} revision={query.data.revision}
      canManage={editAccess.canManage} onClose={() => setEditing(undefined)} /> : null}
    {selected && !authAccount && !authDetail.isPending ? <ErrorState title="Saved authentication account is unavailable"
      description="The operation link is retained. Restore account access to recheck its original progress."
      onRetry={() => void authDetail.refetch()} /> : null}
    {authAccount && query.data && !denied ? <ProviderAccountAuthentication
      key={`${scopeKey}:${authAccount.id}`} account={authAccount} revision={query.data.revision}
      open={onSelect ? Boolean(selected) : Boolean(auth?.open)} canManage={true}
      {...(authOperationId ? { operationId: authOperationId } : {})}
      onOperation={operationId => {
        setAuthentication({ scopeKey, provider: authAccount.provider, accountId: authAccount.id, operationId, open: true })
        onSelect?.({ provider: authAccount.provider, accountId: authAccount.id, operationId,
          ...(scope.target ? { target: scope.target } : {}) })
      }}
      onClose={() => {
        setAuthentication({ scopeKey, provider: authAccount.provider, accountId: authAccount.id,
          ...(authOperationId ? { operationId: authOperationId } : {}), open: false })
        onSelect?.(undefined)
      }} /> : null}
  </section>
}
