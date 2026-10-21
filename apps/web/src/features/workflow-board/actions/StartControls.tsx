import { useEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { sameWorkflowValue, type GraphEditIntentV3, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../../graph/store'
import { ApiError } from '../../../shared/api/client'
import { nextDraftKey } from '../../graph/nextDraft/state'
import { readEditOutbox } from '../../graph/nextDraft/editIntentStorage'
import { activeEditIntent, editIntentCommandKey, graphEditIntentKey } from '../../graph/nextDraft/useGraphEditIntent'
import { boardStartClient, type BoardStartInput } from '../startClient'
import { acknowledgeBoardStart, readBoardStart, reserveBoardStart, useBoardStartOutbox } from '../startOutbox'
import { scopeForBoardRun } from '../client'
import { recoverBoardStart } from '../startRecovery'
import { prepareNewFullRun, runActionsClient } from './client'
import { useActionLifetime, useDisclosure } from './state'
import { newFullRunReason, type ActionRun } from './policy'

export function StartControls({ scope, run, permitted, available, refresh, viewRun }: {
  scope: RepeatGraphScopeV3; run: ActionRun; permitted: boolean; available: boolean;
  refresh(): void; viewRun?(scope: RepeatGraphScopeV3): void
}) {
  const key = nextDraftKey(scope.workspaceId, scope.workflowId), outbox = useBoardStartOutbox(key)
  const life = useActionLifetime(), [confirming, setConfirming] = useDisclosure()
  const cache = useQueryClient()
  // Same journal the main Start honours: legacy writer flags, the local edit
  // outbox and the authoritative (cached) edit intent for this draft.
  const hasPendingEdit = (edit = useGraphDraftStore.getState().nextDrafts[key]) => {
    if (edit?.busy || edit?.pending || edit?.remoteEditIntent || readEditOutbox(key)) return true
    if (cache.isMutating({ mutationKey: editIntentCommandKey(key) }) > 0) return true
    const draftId = edit?.context.draft.id
    const intent = draftId ? cache.getQueryData<{ intent?: GraphEditIntentV3 | null }>(graphEditIntentKey(scope.workspaceId, scope.workflowId, draftId))?.intent : undefined
    return activeEditIntent(intent)
  }
  const editPending = useGraphDraftStore((state) => hasPendingEdit(state.nextDrafts[key]))
  const assertNoPendingEdit = () => {
    if (hasPendingEdit()) throw new Error('Resolve the existing Save / Stop-and-save / Discard journal before starting new work. Pending edits are preserved.')
  }
  const trigger = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null)
  const sectionHeading = useRef<HTMLHeadingElement>(null), wasConfirming = useRef(false)
  const authorize = () => runActionsClient.authorize('runs:start', {
    workspaceId: scope.workspaceId, workflowId: scope.workflowId,
  }, { signal: life.signal })
  const preflight = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    life.assertCurrent()
    assertNoPendingEdit()
    if (readBoardStart(key)) throw new Error('Reconcile the retained Start before preparing another command.')
    const prepared = await prepareNewFullRun(scope, crypto.randomUUID(), { signal: life.signal })
    life.assertCurrent()
    return prepared
  }, onSuccess: () => setConfirming(true) })
  // The confirmation renders only once its preflight has loaded.
  const confirmationShown = confirming && !!preflight.data
  useEffect(() => {
    if (confirming) { if (confirmationShown) heading.current?.focus() }
    else if (wasConfirming.current) {
      if (trigger.current && !trigger.current.disabled) trigger.current.focus()
      else sectionHeading.current?.focus()
    }
    wasConfirming.current = confirming
  }, [confirming, confirmationShown])
  const cancel = () => setConfirming(false)
  function hideDeniedPreparation(error: unknown) {
    if (ApiError.is(error) && [401, 403, 404].includes(error.status ?? 0)) {
      setConfirming(false)
      preflight.reset()
      refresh()
    }
  }
  const start = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    const displayed = preflight.data
    if (!displayed) throw new Error('Review the exact fresh Start pins first.')
    life.assertCurrent()
    assertNoPendingEdit()
    const fresh = await prepareNewFullRun(scope, displayed.request.commandId, { signal: life.signal })
    if (!sameWorkflowValue(fresh, displayed)) throw new Error('Start pins or execution folder changed after review. Cancel and review again; no command was sent.')
    life.assertCurrent()
    assertNoPendingEdit()
    const retained = await reserveBoardStart(key, displayed.request)
    if (!sameWorkflowValue(retained, displayed.request)) throw new Error('Another Start is retained for this workflow. Reconcile that command; no different command was sent.')
    life.assertCurrent()
    const result = await boardStartClient.start(retained)
    life.assertCurrent()
    if (result.run.id === scope.runId || result.run.executionLocation?.runnerId !== displayed.location?.runnerId
      || result.run.executionLocation?.rootPath !== displayed.location?.rootPath) {
      throw new Error('Start did not return a new Run with the reviewed execution folder. The command remains retained for reconciliation.')
    }
    await acknowledgeBoardStart(key, retained)
    setConfirming(false)
    refresh()
    return result
  }, onError: hideDeniedPreparation })
  const reconcile = useMutation({ retry: false, gcTime: 0, mutationFn: async (displayed: BoardStartInput) => {
    life.assertCurrent()
    await authorize()
    const retained = readBoardStart(key)
    if (!retained || !sameWorkflowValue(retained, displayed)) throw new Error('The retained Start changed. Refresh its identity before reconciliation.')
    life.assertCurrent()
    // Deliberately no re-pin, draft read, new command ID, or current-head preflight.
    const result = await boardStartClient.start(retained)
    life.assertCurrent()
    await acknowledgeBoardStart(key, retained)
    setConfirming(false)
    refresh()
    return result
  }, onError: hideDeniedPreparation, onSuccess: () => sectionHeading.current?.focus() })
  const recovery = useMutation<
    Awaited<ReturnType<typeof recoverBoardStart>>['result'], Error, BoardStartInput
  >({ retry: false, gcTime: 0, mutationFn: async (request) => {
    life.assertCurrent()
    await authorize()
    const resolved = await recoverBoardStart(key, request)
    life.assertCurrent()
    if (resolved.acknowledgement !== 'superseded') {
      setConfirming(false)
      preflight.reset()
    }
    refresh()
    return resolved.result
  }, onError: hideDeniedPreparation })
  const busy = preflight.isPending || start.isPending || reconcile.isPending || recovery.isPending
  const reason = editPending ? 'Resolve pending Save / Stop-and-save / Discard before starting new work. Edits are preserved.'
    : !permitted ? 'Start permission is unavailable at workflow scope. A grant limited to this Run cannot create a new Run.'
    : !available ? 'Native Start capability is unavailable or could not be read.'
      : outbox.error ?? (outbox.request ? 'Reconcile the retained Start before creating another command.' : newFullRunReason(run))
  const result = recovery.data?.status === 'accepted' ? { run: recovery.data.run, replayed: true } : reconcile.data ?? start.data
  return <section aria-label="Start reconciliation and full-run retry">
    <h4 ref={sectionHeading} tabIndex={-1}>Start reconciliation and full-run retry</h4>
    {outbox.error ? <p role="alert">{outbox.error}</p> : null}
    {outbox.request ? <div className="run-action-notice">
      <p>Uncertain Start for this workflow: command <code>{outbox.request.commandId}</code>, saved version <code>{outbox.request.workflowVersionId}</code>.
        {' '}This retained command is not necessarily the selected Run. Reconciliation may admit the original command if it was never accepted.</p>
      <button type="button" disabled={!permitted || busy} onClick={() => outbox.request && reconcile.mutate(outbox.request)}>
        {reconcile.isPending ? 'Reconciling exact Start…' : 'Reconcile retained Start'}</button>
      <button type="button" disabled={!permitted || busy} onClick={() => outbox.request && recovery.mutate(outbox.request)}>
        {recovery.isPending ? 'Recovering Start…' : 'Recover Start'}</button>
      <p>Recovery finds the accepted Run or cancels this pending Start. Review a new full Run after cancellation.</p>
    </div> : null}
    {reconcile.isError ? <p role="alert">Start reconciliation is not confirmed: {(reconcile.error as Error).message} The original command remains retained.</p> : null}
    {recovery.isError ? <p role="alert">Start recovery is not confirmed: {recovery.error.message}</p> : null}
    {recovery.data ? <p role="status">{recovery.data.status === 'canceled'
      ? 'The earlier Start was canceled. Review the current settings before starting again.'
      : `The earlier Run was accepted: ${recovery.data.run.id}.`}</p> : null}
    <button type="button" ref={trigger} disabled={!!reason || busy || confirming} title={reason}
      onClick={() => { start.reset(); reconcile.reset(); preflight.mutate() }}>{preflight.isPending ? 'Reading fresh Start pins…' : 'Review new full Run'}</button>
    {reason ? <p>{reason}</p> : null}
    <p>A full retry starts a NEW Run of this same saved version from its entry, with the prior accepted Run input and a freshly validated execution location.
      {' '}It never retries a selected node, resumes the historical Run, applies pending edits, or changes business repetition.</p>
    {preflight.isError ? <p role="alert">New full Run is unavailable: {preflight.error.message}</p> : null}
    {confirming && preflight.data ? <div className="run-action-confirmation" onKeyDown={(event) => {
      if (event.key === 'Escape' && !start.isPending) { event.preventDefault(); cancel() }
    }}>
      <h5 ref={heading} tabIndex={-1}>Confirm a new full Run</h5>
      <p>Source Run <code>{scope.runId}</code> stays unchanged. Saved version <code>{preflight.data.request.workflowVersionId}</code>.
        {' '}Workflow revision {preflight.data.request.expectedWorkflowRevision}; location revision {preflight.data.request.expectedLocationRevision}.</p>
      <p>New command <code>{preflight.data.request.commandId}</code>. Current execution folder (not a historical fact):</p>
      <pre tabIndex={0}>{JSON.stringify(preflight.data.location, null, 2)}</pre>
      <details><summary>Exact input and configuration pins to send</summary>
        <pre tabIndex={0}>{JSON.stringify({ input: preflight.data.request.input,
          agentConfigurationVersionIds: preflight.data.request.expectedAgentConfigurationVersionIds }, null, 2)}</pre></details>
      <button type="button" disabled={!permitted || !available || editPending || busy || !!outbox.request || start.isError}
        onClick={() => start.mutate()}>{start.isPending ? 'Starting new full Run…' : 'Start new full Run'}</button>
      <button type="button" disabled={start.isPending} onClick={cancel}>Cancel</button>
    </div> : null}
    {start.isError ? <p role="alert">New Start is not confirmed: {(start.error as Error).message} Any reserved command is retained; do not replace it.</p> : null}
    {result ? <div role="status"><p>{result.replayed ? 'Reconciled' : 'Accepted'} Run <code>{result.run.id}</code>, saved version <code>{result.run.workflowVersionId}</code>.
</p>
      {viewRun ? <button type="button" onClick={() => viewRun(scopeForBoardRun(result.run))}>View accepted Run in this Board</button> : null}</div> : null}
  </section>
}
