import { InfoHint } from '../../shared/ui/InfoHint'
import { useEffect, useRef, useState } from 'react'
import type { ProviderAccount, ProviderAccountAuthenticationOperation } from '@foreman-code/contracts/provider-accounts'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { Alert, Button, Dialog, Select } from '../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import type { ProviderAccountPrepareInput, ProviderAccountCancelInput } from './providerAccountsClient'
import { useProviderAuthentication, useProviderAuthenticationOperations, useProviderAuthenticationWrite } from './providerAccountsQueries'
import { useProviderAccountAccess } from './providerAccountAccess'
import { ProviderAccountHumanHandoff } from './ProviderAccountHumanHandoff'

const stateLabels: Record<ProviderAccountAuthenticationOperation['state'], string> = {
  reserved: 'Preparing authentication', 'awaiting-human': 'Waiting for human sign-in',
  observing: 'Checking provider completion', completed: 'Authentication completed',
  canceled: 'Authentication canceled', expired: 'Authentication expired', failed: 'Authentication failed',
  'outcome-unknown': 'Authentication outcome unknown',
}

type Props = {
  account: ProviderAccount; revision: number; open: boolean; canManage: boolean;
  operationId?: string; onOperation(operationId: string): void; onClose(): void;
}
export function ProviderAccountAuthentication({ account, revision, open, canManage,
  operationId, onOperation, onClose }: Props) {
  const epoch = useHarnessSessionEpoch()
  const [intent, setIntent] = useState<'sign-in' | 'sign-out'>('sign-in')
  const [choosingAction, setChoosingAction] = useState(false)
  const discovery = useProviderAuthenticationOperations(account.binding)
  const access = useProviderAccountAccess(account.binding?.target, account.binding)
  const capability = access.target?.providers.find(item => item.provider === account.provider)
  const discovered = !discovery.isError ? discovery.data?.currentOperation ?? discovery.data?.operations[0] : undefined
  const selectedId = choosingAction ? undefined : operationId ?? discovered?.id
  const query = useProviderAuthentication(account.binding, selectedId)
  const write = useProviderAuthenticationWrite(account.binding)
  const denied = useProtectedAccessError(query, write.error ?? discovery.error ?? access.eligibility.error)
  const operation = denied ? undefined : query.data
  const prepareAttempt = useRef(new CommandAttempt<Omit<ProviderAccountPrepareInput, 'commandId'>>()).current
  const cancelAttempt = useRef(new CommandAttempt<Omit<ProviderAccountCancelInput, 'commandId'>>()).current
  const prepareInput = useRef<Omit<ProviderAccountPrepareInput, 'commandId'> | undefined>(undefined)
  const prepareCommand = useRef<string | undefined>(undefined)
  const cancelInput = useRef<Omit<ProviderAccountCancelInput, 'commandId'> | undefined>(undefined)
  const uncertain = prepareAttempt.unresolved || cancelAttempt.unresolved
  const busy = write.isPending
  const manage = canManage && access.canManage && !denied
  const canPrepare = manage && Boolean(account.binding) && !account.removedAt && account.authMode === 'subscription'
    && access.eligibility.data?.canReauthenticate === true && access.target?.connected && capability?.qualified
    && capability.actions.includes(intent) && discovery.isSuccess && !discovery.isFetching && !discovery.data.currentOperation

  useEffect(() => {
    if (!discovery.isSuccess || discovery.isError) return
    const records = [...discovery.data.operations,
      ...(discovery.data.currentOperation ? [discovery.data.currentOperation] : [])]
    const original = records.find(item => item.commandId === prepareCommand.current)
    if (original) {
      prepareAttempt.succeeded()
      prepareInput.current = undefined
      prepareCommand.current = undefined
      setChoosingAction(false)
      onOperation(original.id)
    } else if (!operationId && discovered && !choosingAction && open) onOperation(discovered.id)
  }, [discovery.data, discovery.isSuccess, discovery.isError, discovered, operationId,
    choosingAction, open, onOperation, prepareAttempt])

  async function prepare() {
    const draft = prepareInput.current ?? { expectedRevision: revision, intent,
      ...(account.binding ? { target: account.binding.target } : {}) }
    prepareInput.current ??= draft
    const input = prepareAttempt.input(draft)
    prepareCommand.current = input.commandId
    try {
      const result = await write.mutateAsync({ action: 'prepare', input })
      prepareAttempt.succeeded()
      prepareInput.current = undefined
      prepareCommand.current = undefined
      setChoosingAction(false)
      onOperation(result.id)
    } catch (error) {
      prepareAttempt.failed(error)
      if (!prepareAttempt.unresolved) {
        prepareInput.current = undefined
        prepareCommand.current = undefined
      }
    }
  }
  async function cancel() {
    if (!selectedId) return
    const draft = cancelInput.current ?? { operationId: selectedId, expectedRevision: revision,
      ...(account.binding ? { target: account.binding.target } : {}) }
    cancelInput.current ??= draft
    try {
      await write.mutateAsync({ action: 'cancel', input: cancelAttempt.input(draft) })
      cancelAttempt.succeeded()
      cancelInput.current = undefined
    } catch (error) {
      cancelAttempt.failed(error)
      if (!cancelAttempt.unresolved) cancelInput.current = undefined
    }
  }
  useUnsavedChanges({ scope: 'surface', label: `${account.name} authentication`, dirty: uncertain,
    busy, uncertain, error: write.error?.message, save: () => cancelAttempt.unresolved ? cancel() : prepare(),
    discard: () => undefined }, (current, next) => current.pathname !== next.pathname
      || current.search.accountId !== next.search.accountId
      || current.search.accountProvider !== next.search.accountProvider
      || JSON.stringify(current.search.accountTarget) !== JSON.stringify(next.search.accountTarget)
      || current.search.harness !== next.search.harness || current.search.section !== next.search.section)
  const waitingForHuman = operation?.humanActionRequired && !operation.cancelRequested && !operation.nativeClosed
    && ['reserved', 'awaiting-human', 'observing'].includes(operation.state) && Date.parse(operation.expiresAt) > Date.now()
  const canHandoff = manage && waitingForHuman && account.authMode === 'subscription'
    && capability?.qualified && capability.actions.includes('human-handoff')
  const records = discovery.data ? [discovery.data.currentOperation, ...discovery.data.operations]
    .filter((item): item is ProviderAccountAuthenticationOperation => item !== null)
    .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) : []
  return <Dialog open={open} title={`Authentication for ${account.name}`} busy={busy}
    headerLeading={<InfoHint label="Authentication progress">Authentication continues on the owning computer when you hide this progress.</InfoHint>}
    onOpenChange={next => { if (!next && !busy && !uncertain) onClose() }}
    footer={<Button disabled={busy || uncertain} onClick={onClose}>Hide progress</Button>}>
    <div className="provider-account-form">
      {records.length ? <Select label="Authentication operation" value={selectedId ?? ''} disabled={busy || uncertain}
        options={[...(!selectedId ? [{ value: '', label: 'New authentication action' }] : []),
          ...records.map(item => ({ value: item.id, label: `${stateLabels[item.state]} · ${item.createdAt}` })),
          ...(selectedId && !records.some(item => item.id === selectedId)
            ? [{ value: selectedId, label: 'Saved operation' }] : [])]}
        onChange={event => {
          if (!event.target.value) return
          setChoosingAction(false)
          onOperation(event.target.value)
        }} /> : null}
      {selectedId ? <>
        {query.isPending ? <p role="status">Reading authentication progress…</p> : null}
        {operation ? <>
          <p role="status">{stateLabels[operation.state]}</p>
          <p>Last checked <time dateTime={operation.updatedAt}>{new Date(operation.updatedAt).toLocaleString()}</time></p>
          {operation.cancelRequested && !operation.nativeClosed ? <Alert tone="warning"
            title="Cancel requested. The provider has not confirmed closure." /> : null}
          {operation.nativeClosed ? <p>The provider operation is closed.</p> : null}
          {waitingForHuman ?
            <p>{operation.binding.target.hostRef.kind === 'device'
              ? 'Complete sign-in in the owning Worker’s browser. Open this account’s progress on that computer.'
              : 'Complete sign-in through the installed provider on this computer.'}</p> : null}
          {open && canHandoff && operation.binding.target.hostRef.kind === 'main' ?
            <ProviderAccountHumanHandoff key={`${epoch}:${operation.id}:${operation.revision}`} operation={operation} /> : null}
          {operation.state === 'outcome-unknown' ? <p>Recheck this operation to find its result.</p> : null}
          {['expired', 'failed'].includes(operation.state) && !operation.nativeClosed ?
            <p>The provider may still be running. Recheck or cancel this operation before starting another.</p> : null}
          {operation.state === 'completed' ? <p>Refresh the account to read its sign-in and readiness.</p> : null}
          {!operation.nativeClosed ? <Button disabled={!manage || busy || prepareAttempt.unresolved}
            onClick={() => void cancel()}>{cancelAttempt.unresolved ? 'Retry original cancel' : 'Cancel authentication'}</Button> : null}
          {operation.nativeClosed ? <Button disabled={!canPrepare || busy || uncertain}
            onClick={() => setChoosingAction(true)}>Choose another authentication action</Button> : null}
        </> : null}
        <Button disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Recheck original operation</Button>
      </> : <>
        {discovery.isPending ? <p role="status">Finding saved authentication operations…</p> : null}
        <div className="provider-account-actions">
          <Button disabled={!manage || busy || uncertain || !capability?.actions.includes('sign-in')}
            aria-pressed={intent === 'sign-in'} onClick={() => setIntent('sign-in')}>Sign in</Button>
          <Button disabled={!manage || busy || uncertain || !capability?.actions.includes('sign-out')}
            aria-pressed={intent === 'sign-out'} onClick={() => setIntent('sign-out')}>Sign out</Button>
        </div>
        {!prepareAttempt.unresolved ? <Button variant="primary" disabled={!canPrepare || busy || cancelAttempt.unresolved}
          onClick={() => void prepare()}>Prepare authentication</Button> : null}
        {!canPrepare ? <p>{access.eligibility.data?.reason
          ?? 'Authentication requires manage access and qualified native support for this account.'}</p> : null}
      </>}
      {prepareAttempt.unresolved ? <Button disabled={!manage || busy || cancelAttempt.unresolved}
        onClick={() => void prepare()}>Retry original authentication</Button> : null}
      <Button disabled={discovery.isFetching || busy} onClick={() => void discovery.refetch()}>Find saved operations</Button>
      {uncertain ? <Alert tone="warning" title="The request is unconfirmed. Retry or find the original operation before leaving." /> : null}
      {denied || query.isError || write.isError && (uncertain || !selectedId)
        || discovery.isError || access.eligibility.isError ? <Alert live tone="danger"
        title={(denied ?? write.error ?? query.error ?? discovery.error ?? access.eligibility.error)?.message
          ?? 'Authentication status is unavailable.'} /> : null}
    </div>
  </Dialog>
}
