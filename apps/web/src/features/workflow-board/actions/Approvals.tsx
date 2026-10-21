import { InfoHint } from '../../../shared/ui/InfoHint'
import { useRef } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { DurableInteraction } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { approvalOptionScope } from '../../../shared/ui/approvalOptionScope'
import { NativeInteractionResponse } from '../../../shared/ui/NativeInteractionResponse'
import { runActionsClient } from './client'
import { actionKey, useActionLifetime, useDisclosure } from './state'
import { approvalDeliveryMessage, type ActionRun } from './policy'

function Approval({ scope, item, run, permitted, refresh }: {
  scope: RepeatGraphScopeV3; item: DurableInteraction; run: ActionRun; permitted: boolean; refresh(): void
}) {
  const [open, setOpen] = useDisclosure(), life = useActionLifetime(), feedback = useRef<HTMLParagraphElement>(null), cache = useQueryClient()
  const detail = useQuery({ queryKey: actionKey(scope, 'approval', item.id), enabled: open,
    queryFn: ({ signal }) => runActionsClient.approval(scope, item.id, { signal }),
    retry: false, gcTime: 0, staleTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const response = useMutation({ retry: false, gcTime: 0, mutationFn: async (variables: {
    expected: DurableInteraction; input: Parameters<typeof runActionsClient.respond>[2]
  }) => {
    life.assertCurrent()
    const result = await runActionsClient.respond(scope, variables.expected, variables.input, { signal: life.signal })
    life.assertCurrent()
    return result
  }, onError: refresh, onSuccess: () => {
    void detail.refetch(); refresh(); feedback.current?.focus()
    void cache.invalidateQueries({ queryKey: actionKey(scope, 'human-approvals'), exact: true })
  } })
  const value = detail.isError ? undefined : detail.data
  const interaction = value?.interaction
  const isDirection = item.kind === 'work_direction'
  const hasInput = interaction?.responseOptions.some((option) => option.input)
  const reason = !permitted ? 'Response permission is unavailable for this exact Run.'
    : !value ? 'Read the exact authorized interaction before responding.'
      : value.canRespond !== true ? 'The human approval service does not permit this caller to respond.'
        : run.executionState === 'completed' ? 'This Run is terminal. No new approval decision is available.'
          : interaction?.status !== 'pending' ? 'A decision is already recorded or this interaction is canceled.' : undefined
  return <li><details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{isDirection ? 'Run direction' : 'Human approval'} {item.id} · {(detail.isError ? undefined : detail.data?.interaction.status) ?? item.status}</summary>
    {open ? <div>
      <p>Run <code>{scope.runId}</code> · saved version <code>{scope.workflowVersionId}</code> · interaction <code>{item.id}</code>.</p>
      {detail.isPending ? <p role="status">Reading exact human request and execution identity…</p> : null}
      {detail.isError ? <p role="alert">Approval details are unavailable: {detail.error.message} Cached requests do not authorize a response.</p> : null}
      <button type="button" disabled={detail.isFetching || response.isPending} onClick={() => void detail.refetch()}>Refresh this approval</button>
      {interaction && value ? <>
        <p>Execution <code>{interaction.executionId}</code> · node <code>{value.execution.workflowNodeId}</code> · technical attempt {value.execution.attempt} · interaction revision {interaction.revision}.</p>
        <pre tabIndex={0} aria-label="Exact human approval request">{JSON.stringify(interaction.request, null, 2)}</pre>
        <p role="status">{isDirection ? 'Choose how to handle the remaining findings.'
          : approvalDeliveryMessage(interaction.status, interaction.deliveryState)}</p>
        {interaction.status === 'pending' && hasInput
          ? <NativeInteractionResponse key={interaction.id} options={interaction.responseOptions}
            disabled={!!reason || response.isPending || response.isError || detail.isFetching}
            onSelect={(optionId, values) => response.mutate({ expected: interaction, input: {
              interactionId: interaction.id, optionId, expectedRevision: interaction.revision,
              ...(values !== undefined ? { response: values } : {}),
            } })} /> : null}
        {interaction.status === 'pending' && !hasInput ? <div role="group" aria-label="Offered human responses">{interaction.responseOptions.map((option) => <div key={option.optionId} className="run-action-option">
          <p><strong>{option.label}</strong> — {approvalOptionScope(option)} {option.scopeSummary ?? ''}</p>
          <button type="button" disabled={!!reason || response.isPending || response.isError || detail.isFetching}
            title={reason} onClick={() => response.mutate({ expected: interaction, input: {
              interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision,
            } })}>{option.label}</button>
        </div>)}</div> : null}
      </> : null}
      {reason ? <p>{reason}</p> : null}
      {response.isPending ? <p role="status">{isDirection ? 'Recording Run direction…'
        : 'Sending the exact human decision; native acknowledgement is not implied.'}</p> : null}
      {response.isError ? <div role="alert"><p>Approval response is not confirmed: {response.error.message}
        {' '}No different option or revised request is sent automatically.</p>
        <button type="button" disabled={!permitted || value?.canRespond !== true || response.isPending}
          onClick={() => response.variables && response.mutate(response.variables)}>Reconcile same approval response</button>
      </div> : null}
      <p ref={feedback} tabIndex={-1} role="status">{response.data && isDirection ? 'Run direction recorded.' : ''}
        {response.data && !isDirection ? `Human decision ${response.data.replayed ? 'reconciled' : 'recorded'}. Approval response is not native acknowledgement. Receipt observation: ${approvalDeliveryMessage(response.data.interaction.status, response.data.interaction.deliveryState)}` : ''}</p>
      {interaction?.continuationRunId ? <p>Continuation Run: <code>{interaction.continuationRunId}</code>.</p> : null}
    </div> : null}
  </details></li>
}

export function Approvals({ scope, run, canRead, canRespond, refresh }: {
  scope: RepeatGraphScopeV3; run: ActionRun; canRead: boolean; canRespond: boolean; refresh(): void
}) {
  const [open, setOpen] = useDisclosure(), cache = useQueryClient(), pageHeading = useRef<HTMLHeadingElement>(null)
  const queue = useInfiniteQuery({ queryKey: actionKey(scope, 'human-approvals'), enabled: open && canRead,
    initialPageParam: null as string | null,
    queryFn: ({ signal, pageParam }) => runActionsClient.approvals(scope, pageParam, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    maxPages: 1, retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const rows = queue.isError ? [] : queue.data?.pages[0]?.items ?? []
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Human approvals for this Run<InfoHint label="Human approvals for this Run">Only human-handled interactions are listed. App/Orchestrator approvals are not reassigned to a human here.</InfoHint></summary>
    {open ? <section aria-label="Run human approvals">
      <h4 ref={pageHeading} tabIndex={-1}>Human approval page</h4>
      <p>Run <code>{scope.runId}</code></p>
      {!canRead ? <p>Human approval read permission is unavailable for this exact Run.</p> : <>
        {queue.isPending ? <p role="status">Loading one bounded approval page…</p> : null}
        {queue.isError ? <p role="alert">Approval inbox is unavailable: {queue.error.message}</p> : null}
        <button type="button" disabled={queue.isFetching} onClick={() => void queue.refetch()}>Refresh approval page</button>
        {!queue.isPending && !queue.isError && rows.length === 0 ? <p>No human interactions on this page. This is not evidence of native acknowledgement.</p> : null}
        <ol>{rows.map((item) => <Approval key={item.id} scope={scope} item={item} run={run} permitted={canRespond} refresh={refresh} />)}</ol>
        {queue.hasNextPage ? <button type="button" disabled={queue.isFetching} onClick={() => void queue.fetchNextPage().then(() => pageHeading.current?.focus())}>Next approval page</button> : null}
        {queue.data?.pageParams[0] !== null && queue.data?.pageParams[0] !== undefined ? <button type="button" disabled={queue.isFetching}
          onClick={() => void cache.resetQueries({ queryKey: actionKey(scope, 'human-approvals'), exact: true }).then(() => pageHeading.current?.focus())}>First approval page</button> : null}
        <p>Up to 10 interactions per explicit page; opening a page does not replay approvals.</p>
      </>}
    </section> : null}
  </details>
}
