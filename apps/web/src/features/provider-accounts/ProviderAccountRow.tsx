import { InfoHint } from '../../shared/ui/InfoHint'
import { useRef, useState } from 'react'
import type { ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Button, Dialog } from '../../shared/ui/nocturne'
import { useProviderAccountAccess } from './providerAccountAccess'
import { useProviderAccountWrite, type ProviderAccountScope } from './providerAccountsQueries'
import type { ProviderAccountAction, ProviderAccountDefaultInput } from './providerAccountsClient'

const statusLabels: Record<ProviderAccount['status'], string> = {
  'signed-in': 'Signed in', 'signed-out': 'Signed out', 'login-pending': 'Sign-in pending', unavailable: 'Unavailable',
}
const readinessLabels = {
  ready: 'Ready', 'sign-in-required': 'Sign-in required', 'qualification-required': 'Profile qualification required',
  unavailable: 'Unavailable', unknown: 'Unknown',
}
export function ProviderAccountRow({ account, revision, defaultRevision, scope, onConfigure, onAuthenticate }: {
  account: ProviderAccount; revision: number; defaultRevision?: number | undefined; scope: ProviderAccountScope;
  onConfigure(): void; onAuthenticate(): void;
}) {
  const write = useProviderAccountWrite(undefined, scope)
  const access = useProviderAccountAccess(account.binding?.target ?? scope.target, account.binding)
  const capability = access.target?.providers.find(item => item.provider === account.provider)
  const [removing, setRemoving] = useState(false)
  const attempt = useRef(new CommandAttempt<Omit<ProviderAccountDefaultInput, 'commandId'>>()).current
  const original = useRef<{ action: ProviderAccountAction; input: Omit<ProviderAccountDefaultInput, 'commandId'> } | undefined>(undefined)
  async function act(action: ProviderAccountAction) {
    const draft = original.current ?? { action, input: { expectedRevision: revision,
      ...(account.binding ? { target: account.binding.target } : {}),
      ...(action === 'default' && defaultRevision !== undefined ? { expectedDefaultRevision: defaultRevision } : {}) } }
    original.current ??= draft
    try {
      await write.mutateAsync({ action: draft.action, accountId: account.id, input: attempt.input(draft.input) })
      attempt.succeeded()
      original.current = undefined
      if (action === 'remove') setRemoving(false)
    } catch (failure) {
      attempt.failed(failure)
      if (!attempt.unresolved) original.current = undefined
    }
  }
  const locked = write.isPending || attempt.unresolved
  const unavailable = !access.canManage || locked || Boolean(account.removedAt)
  useUnsavedChanges({ scope: 'surface', label: `${account.name} account action`, dirty: attempt.unresolved,
    busy: write.isPending, uncertain: attempt.unresolved, error: write.error?.message,
    save: () => original.current ? act(original.current.action) : undefined, discard: () => undefined })
  const target = account.binding?.target
  const observation = account.observation
  const identity = observation ? observation.identity : account.identity
  return <article className="provider-account-card" aria-label={`${account.name} account`}>
    <div className="provider-account-summary">
      <header><strong>{account.name}</strong>{account.isDefault ? <small>Default for new work</small> : null}</header>
      <dl>
        <div><dt>Computer</dt><dd>{target ? `${target.hostRef.kind === 'main' ? 'Main' : 'Worker'} · ${
          target.hostRef.kind === 'main' ? target.hostRef.mainId : target.hostRef.deviceId}` : 'Ownership not recorded'}</dd></div>
        <div><dt>Installation</dt><dd>{target?.applicationInstallationId ?? 'Unknown'}</dd></div>
        <div><dt>Sign-in</dt><dd>{statusLabels[observation?.status ?? account.status]}</dd></div>
        <div><dt>Identity{!observation?.subject && identity ? <InfoHint label="Identity">Display identity only; provider identity is unproved.</InfoHint> : null}
          {account.possibleDuplicateAccountIds?.length ? <InfoHint label="Account history">Accounts and their history remain separate.</InfoHint> : null}</dt><dd>{identity ?? 'Unknown'}</dd></div>
        <div><dt>Readiness</dt><dd>{observation && scope.generation !== undefined
          && observation.generation !== scope.generation ? 'Awaiting a fresh observation'
          : readinessLabels[observation?.readiness ?? 'unknown']}</dd></div>
        <div><dt>Last observed</dt><dd>{observation ? <time dateTime={observation.observedAt}>
          {new Date(observation.observedAt).toLocaleString()}</time> : 'Not observed'}</dd></div>
        <div><dt>Authentication</dt><dd>{account.authMode === 'api-key' ? 'API key' : 'Subscription'}</dd></div>
      </dl>
      {account.possibleDuplicateAccountIds?.length ? <p role="status">This may be the same provider identity as another account.</p> : null}
      {account.removedAt ? <p role="status">Removed from selection. <InfoHint label="Removed account">Saved Runs, chats and native history retain this account.</InfoHint></p> : null}
    </div>
    <div className="provider-account-actions">
      <Button size="sm" disabled={unavailable} onClick={onConfigure}>Configure</Button>
      {!account.isDefault && !account.removedAt ? <Button size="sm" disabled={unavailable}
        onClick={() => void act('default')}>Make default</Button> : null}
      {account.authMode === 'subscription' && !account.removedAt ? <Button size="sm" disabled={locked}
        onClick={onAuthenticate}>Authentication progress</Button> : null}
      <Button size="sm" variant="ghost" disabled={unavailable || !access.target?.connected || !capability?.actions.includes('status')}
        onClick={() => void act('refresh')}>Refresh status</Button>
      {!account.removedAt ? <Button size="sm" variant="ghost" disabled={unavailable}
        onClick={() => setRemoving(true)}>Remove from selection</Button> : null}
      {attempt.unresolved && !write.isPending ? <Button size="sm" disabled={!access.canManage}
        onClick={() => original.current && void act(original.current.action)}>Retry original action</Button> : null}
      {write.isPending ? <small role="status">Updating account…</small> : null}
      {write.error ? <p role="alert">{write.error.message}</p> : null}
    </div>
    {removing ? <Dialog open title={`Remove ${account.name} from selection?`} busy={write.isPending}
      description="Saved Runs, chats, local credentials and native history are preserved. This clears this account’s default without choosing a replacement."
      onOpenChange={open => { if (!open && !locked) setRemoving(false) }}
      footer={<><Button disabled={locked} onClick={() => setRemoving(false)}>Keep account</Button>
        <Button disabled={!access.canManage || write.isPending} onClick={() => void act('remove')}>
          {attempt.unresolved ? 'Retry original removal' : 'Remove account'}</Button></>}>
      {write.error ? <p role="alert">{write.error.message}</p> : null}
    </Dialog> : null}
  </article>
}
