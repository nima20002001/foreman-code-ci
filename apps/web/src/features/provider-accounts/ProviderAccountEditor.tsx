import { InfoHint } from '../../shared/ui/InfoHint'
import { useRef, useState } from 'react'
import {
  ProviderAccountApiKeyInputSchema, type AccountProvider, type ProviderAccount,
  type ProviderAccountAuthMode, type ProviderAccountCommandInput,
  type ProviderAccountCreateInput, type ProviderAccountRenameInput,
  ProviderAccountCreateInputSchema, ProviderAccountRenameInputSchema, ProviderAccountRegisterInputSchema,
} from '@foreman-code/contracts/provider-accounts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button, Dialog, Select, TextField } from '../../shared/ui/nocturne'
import { type ProviderAccountScope, useProviderAccountWrite } from './providerAccountsQueries'
import { useProviderAccountProfiles } from './providerAccountDiscovery'
import { useProviderAccountAccess } from './providerAccountAccess'
import type { ProviderAccountRegisterInput } from './providerAccountsClient'

export function ProviderAccountEditor({ provider, account, revision, onClose, scope = {}, canManage = true, accountId = account?.id }: {
  provider: AccountProvider; account?: ProviderAccount; revision: number; onClose(): void; scope?: ProviderAccountScope; canManage?: boolean; accountId?: string | undefined
}) {
  const [name, setName] = useState(account?.name ?? '')
  const [savedName, setSavedName] = useState(account?.name ?? '')
  const [authMode, setAuthMode] = useState<ProviderAccountAuthMode>(account?.authMode ?? 'subscription')
  const [setup, setSetup] = useState('fresh')
  const [profileRef, setProfileRef] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [validation, setValidation] = useState<string>()
  const keyField = useRef<HTMLInputElement>(null)
  const write = useProviderAccountWrite(() => keyField.current?.value ?? '', scope)
  const access = useProviderAccountAccess(scope.target, account?.binding)
  const capability = access.target?.providers.find(item => item.provider === provider)
  const canCreate = capability?.qualified && capability.actions.includes('create') && access.target?.connected
  const canRegister = capability?.qualified && capability.actions.includes('register') && access.target?.connected
  const profiles = useProviderAccountProfiles({ ...scope, provider }, !accountId && Boolean(canRegister))
  const choices = !profiles.isError ? profiles.data?.profiles.filter(item => item.authMode === 'subscription') ?? [] : []
  const profile = choices.find(item => item.profileRef === profileRef)
  const existingProfile = setup === 'existing-profile'
  type NameInput = Omit<ProviderAccountCreateInput, 'commandId'> | Omit<ProviderAccountRenameInput, 'commandId'>
    | Omit<ProviderAccountRegisterInput, 'commandId'>
  const nameAttempt = useRef(new CommandAttempt<NameInput>()).current
  const nameInput = useRef<NameInput | undefined>(undefined)
  const keyAttempt = useRef(new CommandAttempt<Omit<ProviderAccountCommandInput, 'commandId'>>()).current
  const keyInput = useRef<Omit<ProviderAccountCommandInput, 'commandId'> | undefined>(undefined)
  const uncertain = nameAttempt.unresolved || keyAttempt.unresolved
  const missingAccount = Boolean(accountId && !account)
  const locked = !canManage || !access.canManage || missingAccount || write.isPending || uncertain
  const dirty = name !== savedName || apiKey !== ''
    || (!accountId && (authMode !== 'subscription' || existingProfile || Boolean(profileRef)))
  const error = validation ?? write.error?.message

  async function saveName() {
    if (!name.trim()) {
      setValidation('Enter an account name.')
      return
    }
    const commonInput = { name: name.trim(), expectedRevision: revision,
      ...(scope.target ? { target: scope.target } : {}) }
    if (!accountId && !nameAttempt.unresolved && (existingProfile ? !profile || !canRegister : !canCreate)) {
      setValidation('Choose a currently qualified profile or a supported fresh account.')
      return
    }
    let draft: NameInput = { ...commonInput, provider, authMode }
    if (accountId) draft = { ...commonInput, ...(account ? { expectedLabelRevision: account.revision } : {}) }
    else if (existingProfile && profile) draft = { ...commonInput, provider: profile.provider, authMode: profile.authMode,
      profileRef: profile.profileRef, qualificationId: profile.qualificationId }
    const input = nameAttempt.input(nameInput.current ?? draft)
    nameInput.current ??= draft
    try {
      if (accountId) await write.mutateAsync({ action: 'rename', accountId, input: ProviderAccountRenameInputSchema.parse(input) })
      else if (existingProfile) await write.mutateAsync({ action: 'register', input: ProviderAccountRegisterInputSchema.parse(input) })
      else await write.mutateAsync({ action: 'create', input: ProviderAccountCreateInputSchema.parse(input) })
      nameAttempt.succeeded()
      nameInput.current = undefined
      setSavedName(name)
      if (!accountId) onClose()
    } catch (failure) {
      nameAttempt.failed(failure)
      if (!nameAttempt.unresolved) nameInput.current = undefined
    }
  }
  async function saveKey() {
    if (!accountId || scope.target?.hostRef.kind !== 'main') return
    const draft = keyInput.current ?? { expectedRevision: revision, ...(scope.target ? { target: scope.target } : {}) }
    const valid = ProviderAccountApiKeyInputSchema.safeParse({ ...draft, commandId: 'validate-key', apiKey })
    if (!valid.success) { setValidation('Enter a valid API key (at least 20 characters, without spaces).'); return }
    const input = keyAttempt.input(draft)
    keyInput.current ??= draft
    try {
      await write.mutateAsync({ action: 'api-key', accountId, input })
      keyAttempt.succeeded()
      keyInput.current = undefined
      if (keyField.current) keyField.current.value = ''
      setApiKey('')
    } catch (failure) {
      keyAttempt.failed(failure)
      if (!keyAttempt.unresolved) keyInput.current = undefined
    }
  }
  const save = () => keyAttempt.unresolved || (apiKey && !nameAttempt.unresolved && name === savedName)
    ? saveKey() : saveName()
  const leave = useUnsavedChanges({ scope: 'surface', label: 'provider account', dirty, busy: write.isPending,
    uncertain, error, save, discard: () => { setApiKey(''); onClose() },
  })
  function close() {
    if (!write.isPending && !uncertain) void leave(onClose)
  }
  const configureTitle = accountId ? `Configure ${account?.name ?? 'saved account'}` : undefined
  return <Dialog open title={configureTitle ?? `Add ${provider === 'codex' ? 'Codex' : 'Claude'} account`}
    headerLeading={accountId ? <InfoHint label="Account settings">Changes apply to this account on its owning computer.</InfoHint> : undefined}
    busy={write.isPending} onOpenChange={open => { if (!open) close() }} size="sm"
    footer={<>
      <Button disabled={write.isPending || uncertain} onClick={close}>Cancel</Button>
      <Button variant="primary" disabled={!canManage || !access.canManage || write.isPending || keyAttempt.unresolved
        || (!accountId && !nameAttempt.unresolved && (existingProfile ? !profile || !canRegister : !canCreate))
        || (missingAccount && !nameAttempt.unresolved) || (!name.trim())
        || (Boolean(accountId) && name === savedName && !nameAttempt.unresolved)}
        onClick={() => void saveName()}>{nameAttempt.unresolved ? 'Retry original save' : accountId ? 'Save name' : 'Add account'}</Button>
    </>}>
    <div className="provider-account-form">
      <TextField label="Account name" value={name} maxLength={100} disabled={locked}
        onChange={event => { setName(event.target.value); setValidation(undefined) }} />
      {!accountId ? <Select label="Account setup" labelHint={<InfoHint label="Account setup">Add a fresh isolated account on the selected computer. Adding it does not sign in or qualify its profile.</InfoHint>} value={setup} disabled={locked}
        options={[{ value: 'fresh', label: 'Fresh isolated account', disabled: !canCreate },
          { value: 'existing-profile', label: 'Existing qualified profile', disabled: !canRegister }]}
        onChange={event => { setSetup(event.target.value); setValidation(undefined) }} /> : null}
      {!accountId && existingProfile ? <>
        <Select label="Qualified profile" value={profileRef} disabled={locked || profiles.isPending}
          options={[{ value: '', label: 'Choose a qualified profile', disabled: true },
            ...choices.map(item => ({ value: item.profileRef, label: item.label })),
            ...(profileRef && !profile ? [{ value: profileRef, label: 'Selected profile · unavailable', disabled: true }] : [])]}
          onChange={event => { setProfileRef(event.target.value); setValidation(undefined) }} />
        {profiles.isPending ? <p role="status">Loading qualified profiles…</p> : null}
        {profiles.isError ? <Alert tone="danger" title={profiles.error.message}
          action={<Button onClick={() => void profiles.refetch()}>Retry profiles</Button>} /> : null}
        {profiles.isSuccess && !choices.length ? <p>No qualified subscription profiles are available on this computer.</p> : null}
      </> : <Select label="Authentication" value={authMode} disabled={Boolean(accountId) || locked}
        options={provider === 'codex' || scope.target?.hostRef.kind !== 'main' ? [{ value: 'subscription', label:
          provider === 'codex' ? 'ChatGPT subscription login' : 'Claude subscription login' },
          ...(account?.authMode === 'api-key' ? [{ value: 'api-key', label: 'Saved API key · unavailable here', disabled: true }] : [])] : [
          { value: 'subscription', label: 'Claude subscription login' }, { value: 'api-key', label: 'API key · separate billing' },
        ]} labelHint={accountId ? <InfoHint label="Authentication">Authentication is chosen when the account is added.</InfoHint> : undefined}
        onChange={event => setAuthMode(event.target.value as ProviderAccountAuthMode)} />}
      {account && authMode === 'api-key' && scope.target?.hostRef.kind === 'main' ? <>
        <TextField ref={keyField} label="New API key" type="password" value={apiKey} autoComplete="off" spellCheck={false}
          disabled={locked} maxLength={4096} labelHint={<InfoHint label="New API key">Write-only. The saved key is never shown or returned.</InfoHint>}
          onChange={event => { setApiKey(event.target.value); setValidation(undefined) }} />
        <Button disabled={!canManage || !access.canManage || write.isPending || nameAttempt.unresolved || !apiKey.trim()}
          onClick={() => void saveKey()}>{keyAttempt.unresolved ? 'Retry original key save' : 'Save API key'}</Button>
      </> : null}
      {missingAccount ? <p role="alert">The saved account is unavailable. Your input is kept; restore account access before saving.</p> : null}
      {!accountId && !existingProfile && authMode === 'api-key' ? <p>Add the account, then configure its API key.</p> : null}
      {account?.authMode === 'subscription' ? <p>Use Authentication progress on the account row to prepare or recheck provider sign-in.</p> : null}
      {uncertain && !write.isPending ? <Alert tone="warning" title="The previous save is unconfirmed. Retry it before editing or leaving." /> : null}
      {error ? <Alert live tone="danger" title={error} /> : null}
    </div>
  </Dialog>
}
