import { InfoHint } from '../../../shared/ui/InfoHint'
import { useRef } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { reserveBoardStop, sendBoardStop, recordBoardStopReceipt, settleBoardStop, useBoardStopOutbox } from '../stopOutbox'
import { runActionsClient } from './client'
import { useActionLifetime } from './state'
import type { ActionRun } from './policy'

export function StopReceipt({ scope }: { scope: RepeatGraphScopeV3 }) {
  const { journal } = useBoardStopOutbox(scope)
  const receipt = journal?.receipt
  return receipt ? <p role="status">Stop receipt: {receipt.status}{receipt.replayed ? ' (replayed)' : ''}.{' '}
    {receipt.status === 'not_owner' ? 'This backend did not prove ownership; native Stop is not confirmed.'
      : receipt.processStopped ? 'Native process closure was observed.' : 'Native process closure is not confirmed.'}
    {' '}Stop accepted is not cleanup settled.</p> : null
}

export function StopControl({ scope, run, permitted, available, refresh }: {
  scope: RepeatGraphScopeV3; run: ActionRun; permitted: boolean; available: boolean; refresh(): void
}) {
  const outbox = useBoardStopOutbox(scope), life = useActionLifetime(), heading = useRef<HTMLHeadingElement>(null)
  const stop = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    life.assertCurrent()
    const options = { signal: life.signal }
    await runActionsClient.authorize('runs:stop', scope, options)
    const [fresh, capabilities] = await Promise.all([runActionsClient.status(scope, options), runActionsClient.capabilities(options)])
    if (!capabilities.stopAvailable) throw new Error('Native Stop is unavailable on this deployment. No command was sent.')
    if (fresh.executionState === 'completed' && !fresh.cleanupPending && !outbox.journal) {
      throw new Error('This Run is already terminal and cleanup-settled. No Stop is needed.')
    }
    life.assertCurrent()
    const journal = await reserveBoardStop(scope)
    life.assertCurrent()
    const receipt = await sendBoardStop(journal)
    life.assertCurrent()
    await recordBoardStopReceipt(journal, receipt)
    refresh()
    return receipt
  }, onError: refresh })
  const settlement = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    const journal = outbox.journal
    if (!journal?.receipt || journal.receipt.status === 'not_owner') throw new Error('An owned Stop receipt is required before settlement can be confirmed.')
    const fresh = await runActionsClient.status(scope, { signal: life.signal })
    life.assertCurrent()
    if (fresh.executionState !== 'completed' || fresh.cleanupPending) throw new Error('Cleanup is still pending. The retained Stop is not cleared.')
    await settleBoardStop(scope, journal.request)
    return 'Authenticated readback confirms this Run is terminal and cleanup-settled. The exact Stop journal is cleared.'
  }, onError: refresh, onSuccess: () => heading.current?.focus() })
  const reason = !permitted ? 'Stop permission is unavailable for this exact Run.'
    : !available ? 'Native Stop capability is unavailable or could not be read.'
      : outbox.error ?? (run.executionState === 'completed' && !run.cleanupPending && !outbox.journal ? 'This Run is terminal and cleanup-settled.' : undefined)
  const receipt = outbox.journal?.receipt ?? stop.data
  return <section aria-label="Stop and cleanup">
    <h4 ref={heading} tabIndex={-1}>Stop and cleanup<InfoHint label="Stop">It does not save or discard Board edits.</InfoHint></h4>
    <p>Stop targets Run <code>{scope.runId}</code>, saved version <code>{scope.workflowVersionId}</code>.</p>
    <p role="status">{run.cleanupPending ? 'Cleanup pending. Native work or credentials may still need settlement.'
      : run.executionState === 'completed' ? 'Cleanup settled according to authenticated Run readback.' : 'No cleanup is currently reported pending; this Run is still active.'}</p>
    <button type="button" disabled={!!reason || stop.isPending || settlement.isPending} title={reason}
      onClick={() => stop.mutate()}>{stop.isPending ? 'Sending exact Stop…' : outbox.journal ? 'Reconcile Stop' : 'Stop this Run'}</button>
    {reason ? <p>{reason}</p> : null}
    {stop.isError ? <p role="alert">Stop is not confirmed: {stop.error.message} Any reserved command remains retained; no replacement Run is started.</p> : null}
    {receipt ? <StopReceipt scope={scope} /> : null}
    {outbox.journal?.receipt && outbox.journal.receipt.status !== 'not_owner' ? <button type="button"
      disabled={run.executionState !== 'completed' || run.cleanupPending || settlement.isPending || stop.isPending}
      onClick={() => settlement.mutate()}>Verify cleanup settlement</button> : null}
    {settlement.isError ? <p role="alert">{settlement.error.message}</p> : null}
    {settlement.data ? <p role="status">{settlement.data}</p> : null}
  </section>
}
