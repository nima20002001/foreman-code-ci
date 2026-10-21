import { InfoHint } from '../../shared/ui/InfoHint'
import { PinnedNodePlacement } from '../node-placement/PinnedNodePlacement'
import { SavedWorkflowWorktree } from './SavedWorkflowWorktree'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { useEffect, useRef, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { Alert, Badge, Button } from '../../shared/ui/nocturne'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'
import { useCurrentRunQuery, currentRunKey } from './currentRunQuery'
import { readPinnedRun } from './runDetailsClient'
import { useRunVersionQuery } from './inspect/queries'
import { ExecutionInspector } from './inspect/ExecutionInspector'
import { JsonValue } from './inspect/JsonValue'
import { useInspectionPresentation } from './inspect/presentation'
import { recordBoardStopReceipt, reserveBoardStop, sendBoardStop, settleBoardStop, useBoardStopOutbox } from './stopOutbox'
import { canUseBoardAction } from './permissions'
import { runsSelectorApi } from '../runs-selector/client'
import { PinnedProviderAccount } from '../provider-accounts/PinnedProviderAccount'
import { RunHistory } from './RunHistory'

/** Lane C replaces the action controls, not the Board's passive Stop-journal
 * settlement. Both authenticated Run readbacks must confirm terminal + cleanup
 * settled before the existing locked, exact-request outbox may be cleared. */
export type RunDetailsProps = { scope: RepeatGraphScopeV3; runActions?: ReactNode }
export function CurrentRunDetails({ scope, runActions }: RunDetailsProps) {
  const canonical = useCurrentRunQuery(scope, false), cache = useQueryClient(), generation = sessionGeneration()
  const access = useLocalHumanAccessQuery(), outbox = useBoardStopOutbox(scope)
  const identity = JSON.stringify([generation, scope]), detailsKey = ['workbench', 'pinned-v3-run-details', generation, scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId]
  const run = useQuery({ queryKey: detailsKey, queryFn: ({ signal }) => readPinnedRun(scope, { signal }), retry: false,
    staleTime: Infinity, refetchOnMount: 'always', refetchOnReconnect: false, refetchOnWindowFocus: false })
  const runDenied = useProtectedAccessError(run), canonicalDenied = useProtectedAccessError(canonical)
  const detail = run.isError || runDenied || canonicalDenied ? undefined : run.data
  const denied = !!runDenied || !!canonicalDenied
  // A confirmed same-scope denial also withdraws sibling private views: the
  // action slot's independently cached status and reports are dropped.
  useEffect(() => {
    if (denied) cache.removeQueries({ queryKey: ['workbench', 'pinned-v3-run-details', generation, scope.workspaceId, scope.workflowId, scope.runId, 'actions'] })
  }, [denied, cache, generation, scope.workspaceId, scope.workflowId, scope.runId])
  const pinned = useRunVersionQuery(scope, !runDenied && !canonicalDenied)
  const pinnedDenied = useProtectedAccessError(pinned)
  const version = pinned.isError || pinnedDenied || runDenied || canonicalDenied ? undefined : pinned.data?.version
  const accountSnapshot = useQuery({
    queryKey: ['provider-accounts', generation, 'run', scope], retry: false,
    enabled: !runDenied && !canonicalDenied,
    queryFn: async ({ signal }) => {
      const result = await runsSelectorApi.snapshot({ workspaceId: scope.workspaceId, workflowId: scope.workflowId,
        runId: scope.runId }, { signal })
      assertSession(generation)
      if (result.snapshot.kind === 'available' && result.snapshot.workflowVersionId !== scope.workflowVersionId) {
        throw new Error('Saved account readback belongs to a different workflow version.')
      }
      return result.snapshot
    },
  })
  const accountsDenied = useProtectedAccessError(accountSnapshot)
  const acceptedAccounts = !accountSnapshot.isError && !accountsDenied && !denied
    && accountSnapshot.data?.kind === 'available' ? accountSnapshot.data : undefined
  const configurationKey = `${identity}:configuration`
  const configurationOpen = useInspectionPresentation((state) => !!state.open[configurationKey])
  const computersKey = `${identity}:computers`
  const computersOpen = useInspectionPresentation((state) => !!state.open[computersKey])
  const snapshot = canonical.isError || canonical.isPaused || canonicalDenied || runDenied ? undefined : canonical.data
  // Only a terminal/cleanup transition needs a fresh private Run read for the
  // pre-existing Stop settlement fence. Never poll execution/activity arrays.
  const refetchRun = run.refetch
  const lastSettlement = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!snapshot || runDenied || canonicalDenied) return
    const terminal = snapshot.state.run.executionState === 'completed'
    const marker = JSON.stringify([scope.runId, terminal, snapshot.state.run.cleanupPending])
    if (lastSettlement.current === marker) return
    const previous = lastSettlement.current
    lastSettlement.current = marker
    if (terminal && previous !== undefined) void refetchRun()
  }, [scope.runId, snapshot, runDenied, canonicalDenied, refetchRun])
  const stop = useMutation({ retry: false, mutationFn: async () => {
    if (!snapshot || canonical.isError) throw new Error('Refresh the exact selected Run before Stop. No command was sent.')
    const journal = await reserveBoardStop(scope)
    const receipt = await sendBoardStop(journal)
    assertSession(generation)
    await recordBoardStopReceipt(journal, receipt)
    void cache.invalidateQueries({ queryKey: currentRunKey(scope) })
    void cache.invalidateQueries({ queryKey: detailsKey })
    return receipt
  } })
  const settlement = useMutation({ retry: false, mutationFn: async () => {
    const journal = outbox.journal
    assertSession(generation)
    if (journal?.receipt && journal.receipt.status !== 'not_owner'
      && detail?.run.executionState === 'completed' && detail.cleanupPending === false
      && snapshot?.state.run.executionState === 'completed' && snapshot.state.run.cleanupPending === false) {
      await settleBoardStop(scope, journal.request)
    }
  } })
  const { mutate: settleStop, isPending: settlementPending, isError: settlementError } = settlement
  useEffect(() => {
    // The contextual slot can render C's controls while this Board still owns
    // passive settlement. Clearing a journal sends no Stop and moves no focus.
    if (!outbox.journal?.receipt || outbox.journal.receipt.status === 'not_owner' || outbox.error
      || run.isError || canonical.isError || run.isFetching || canonical.isFetching || run.isPaused || canonical.isPaused
      || detail?.run.executionState !== 'completed' || detail.cleanupPending !== false
      || snapshot?.state.run.executionState !== 'completed' || snapshot.state.run.cleanupPending !== false
      || settlementPending || settlementError) return
    settleStop()
  }, [outbox.journal, outbox.error, detail, snapshot, run.isError, canonical.isError, run.isFetching, canonical.isFetching,
    run.isPaused, canonical.isPaused, settlementPending, settlementError, settleStop])
  const principal = !access.isError ? access.data?.principal : undefined
  const permitted = !!principal && Date.parse(principal.expiresAt) > Date.now() && canUseBoardAction(principal.grants, 'runs:stop', scope)
  const receipt = outbox.journal?.receipt
  const canNeedStop = snapshot?.state.run.executionState !== 'completed' || detail?.cleanupPending !== false || !!outbox.journal
  return <section aria-label="Pinned Run details" className="current-run-details">
    <header><Badge tone="neutral">Semantics 3</Badge><p>Run <code>{scope.runId}</code> · saved version <code>{scope.workflowVersionId}</code></p></header>
    {canonical.isPending && !canonical.isPaused ? <p role="status">Loading the bounded current Run state…</p>
      : !snapshot ? <Alert tone="warning" title={canonical.isPaused ? 'Current Run refresh is paused.' : 'Current Run state is unavailable.'}>
      <Button size="sm" onClick={() => void canonical.refetch()}>Refresh exact Run</Button></Alert> : <p role="status">
      Recorded {snapshot.state.run.executionState} · {snapshot.state.run.outcome} · complete cut {snapshot.asOfSequence}.
      {snapshot.state.run.stopRequested ? ' Stop requested; cleanup is not implied.' : ''}</p>}
    {acceptedAccounts ? <section aria-label="Saved Run accounts">
      {acceptedAccounts.nodes.filter(node => node.kind !== 'job').map(node =>
        <PinnedProviderAccount key={node.id} label={`Saved Run account · ${node.name}`}
          binding={acceptedAccounts.providerAccountBindings?.[node.id]} />)}
    </section> : null}
    {accountSnapshot.isError && !denied ? <p role="status">Saved Run accounts are unavailable.</p> : null}
    {run.isPending ? <p role="status">Reading accepted Run facts…</p> : null}
    {detail ? <p>
      <Button size="sm" variant="ghost" disabled={run.isFetching} onClick={() => void refetchRun()}>Refresh accepted Run facts</Button></p> : null}
    {run.isError ? <Alert tone="warning" title="Private Run details are unavailable."><Button size="sm" onClick={() => void refetchRun()}>Retry pinned details</Button></Alert> : null}
    <div data-testid="run-details-actions-slot">{denied ? null : runActions !== undefined ? runActions : <>
    {canNeedStop ? <div className="n-actions"><Button variant="danger" disabled={!permitted || !snapshot || stop.isPending || !!outbox.error}
      onClick={() => stop.mutate()}>{stop.isPending ? 'Sending exact Stop…' : outbox.journal ? 'Reconcile Stop' : 'Stop this Run'}</Button>
      {!permitted ? <span>Stop permission is unavailable for this exact Run.</span> : null}</div> : null}
    {outbox.error || stop.isError || settlement.isError ? <Alert tone="warning" title="Stop is not confirmed.">
      {outbox.error ?? stop.error?.message ?? settlement.error?.message} The original command is retained; no replacement Run is started.</Alert> : null}
    {receipt ? <p role="status">Stop receipt: {receipt.status}{receipt.replayed ? ' (replayed)' : ''}. {receipt.processStopped ? 'Native process closure was observed.' : 'Native process closure has not been confirmed.'}
      {' '}<InfoHint label="Stop receipt">A Stop receipt is not cleanup settlement.</InfoHint></p> : null}
    </>}</div>
    {runActions !== undefined && outbox.journal && settlement.isError ? <Alert tone="warning" title="Stop journal settlement is not confirmed.">
      {settlement.error.message} The retained command was not replaced. Refresh the exact Run and use the cleanup verification control to retry.
    </Alert> : null}
    {version && !denied && !pinnedDenied && <SavedWorkflowWorktree workspaceId={scope.workspaceId}
      value={version.definition.defaultWorktree} />}
    {detail ? <dl><dt>Saved configuration pins</dt><dd><JsonValue label="Run configuration pins" value={detail.run.agentConfigurationVersionIds} /></dd>
      <dt>Accepted execution folder</dt><dd>{detail.run.executionLocation ? <JsonValue label="Run execution folder" value={detail.run.executionLocation} /> : 'Restricted or unavailable; the current workspace folder is not substituted.'}</dd>
      <dt>Accepted Run input</dt><dd><JsonValue label="Accepted Run input" value={detail.run.input} /></dd>
      <dt>Cleanup</dt><dd>{detail.cleanupPending === true ? 'Pending' : detail.cleanupPending === false ? (detail.run.executionState === 'completed' ? 'Cleanup confirmed by the server' : 'None pending; the Run is still active') : 'Unknown'}</dd>
      {detail.run.result ? <><dt>Recorded Run result</dt><dd><JsonValue label="Recorded Run result" value={detail.run.result} /></dd></> : null}</dl> : null}
    <details open={configurationOpen} onToggle={(event) => useInspectionPresentation.getState().setOpen(configurationKey, event.currentTarget.open)}>
      <summary>Exact saved definition and Agent configuration pins</summary>
      {configurationOpen ? <>
        {pinned.isPending ? <p role="status">Reading this Run’s immutable saved version…</p> : null}
        {pinned.isError || pinnedDenied ? <Alert tone="warning" title="The immutable version is unavailable.">
          Current Agent settings are not substituted. {!pinnedDenied ? <Button size="sm" onClick={() => void pinned.refetch()}>Retry saved version</Button> : null}
        </Alert> : null}
        {version ? <JsonValue label="Pinned WorkflowVersion" value={version} /> : null}
      </> : null}
    </details>
    {detail && version && !denied && !pinnedDenied ? <details key={`computers:${identity}`} open={computersOpen}
      onToggle={(event) => useInspectionPresentation.getState().setOpen(computersKey, event.currentTarget.open)}>
      <summary>Accepted node computers</summary>
      {computersOpen ? version.definition.nodes.map((node) => <section key={`${identity}:${node.id}`} aria-label={`Computer evidence for ${node.name ?? node.label}`}>
        <h3>{node.name ?? node.label}</h3><PinnedNodePlacement scope={scope} nodeId={node.id} />
      </section>) : null}
    </details> : null}
    {version ? <ExecutionInspector scope={scope} version={version} /> : pinned.isPending ? <p role="status">Loading the pinned version before inspection…</p>
      : <Alert tone="warning" title="Run inspection is unavailable until its immutable version is verified.">
        {!pinnedDenied && !runDenied && !canonicalDenied ? <Button size="sm" onClick={() => void pinned.refetch()}>Retry Run inspection</Button> : null}
      </Alert>}
    {detail ? <RunHistory scope={scope} /> : null}
  </section>
}
