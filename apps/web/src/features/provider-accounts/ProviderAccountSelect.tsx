import { InfoHint } from '../../shared/ui/InfoHint'
import type { AccountProvider } from '@foreman-code/contracts/provider-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { Button, Select } from '../../shared/ui/nocturne'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { useProviderAccounts, useProviderAccountScope } from './providerAccountsQueries'
import { useProviderAccountAccess } from './providerAccountAccess'

export function ProviderAccountSelect({ provider, value, onChange, disabled = false, target, hostRef }: {
  provider: AccountProvider; value?: string; onChange(value: string | undefined): void
  disabled?: boolean; target?: DeviceProvisioningTarget | undefined; hostRef?: DeviceProvisioningTarget['hostRef'] | undefined
}) {
  const scope = useProviderAccountScope({ provider, ...(target ? { target } : {}), ...(hostRef ? { hostRef } : {}) })
  const access = useProviderAccountAccess(scope.target)
  const query = useProviderAccounts(access.target?.canRead === true, scope)
  const denied = useBlockingReadError(query)
  const accounts = !denied && access.target?.canRead === true ? query.data?.accounts.filter(account => !account.removedAt) ?? [] : []
  const defaultAccount = accounts.find(account => account.isDefault)
  const capability = access.target?.providers.find(item => item.provider === provider)
  const available = access.target?.connected && capability?.qualified && access.target.canRead
  const defaultUnavailable = Boolean(defaultAccount && (defaultAccount.observation?.readiness !== 'ready'
    || defaultAccount.observation.generation !== scope.generation))
  const options = [
    { value: '', label: defaultAccount ? `Provider default · ${defaultAccount.name}${defaultUnavailable ? ' · unavailable' : ''}`
      : 'Provider default', disabled: defaultUnavailable },
    ...accounts.map(account => ({ value: account.id,
      label: `${account.name} · ${account.status.replaceAll('-', ' ')} · ${account.observation?.readiness ?? 'unknown'}`,
      disabled: !available || !account.binding || account.observation?.readiness !== 'ready'
        || account.observation.generation !== scope.generation })),
  ]
  if (value && !accounts.some(account => account.id === value)) {
    options.push({ value, label: 'Saved account · unavailable', disabled: true })
  }
  const unavailable = access.discovery.isSuccess && !available
  return <div className="provider-account-select">
    <Select label="Account" value={value ?? ''} options={options}
      disabled={disabled || !available || !query.isSuccess || access.discovery.isError || Boolean(denied)}
      labelHint={<InfoHint label="Account">Choose an account on the selected computer. Manage accounts in Settings &gt; Harnesses.</InfoHint>}
      onChange={event => onChange(event.target.value || undefined)} />
    {access.discovery.isPending || !unavailable && query.isPending ? <small role="status">Loading accounts…</small> : null}
    {query.isError || access.discovery.isError ? <div role="alert">Account details could not be refreshed. Your selection is kept.
      <Button size="sm" variant="ghost" onClick={() => { void access.discovery.refetch(); void query.refetch() }}>Retry accounts</Button>
    </div> : null}
    {unavailable ? <p role="alert">Accounts are unavailable on the selected computer. Your saved selection is kept.</p> : null}
  </div>
}
