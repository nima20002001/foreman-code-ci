import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ChatDeliveryReceipt, DeliveryTarget } from '@foreman-code/contracts'
import { Button, LoadingState } from '../../../shared/ui/nocturne'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../../shared/api/accessError'
import { ChatDeliveryReceipts } from './ChatDeliveryReceipts'
import { chatDeliveryClient, type RetainedInput } from './client'

export type DirectRecovery = { origin: 'direct'; receipt: ChatDeliveryReceipt; input: RetainedInput;
  choice: 'outside_run' | 'historical_follow_up' }

/** Inputs that never reached a native message remain their own immutable, exact-target records. */
export function RetainedDeliveryInputs({ target, receipts, onDenied, onRecover, onOpenGroup, onCancel, onRefresh, controlsReason, representedCommandIds }: {
  target: DeliveryTarget; receipts: readonly ChatDeliveryReceipt[]; onDenied(error: Error): void
  onRecover?(recovery: DirectRecovery): void; onOpenGroup?(postId: string): void
  onCancel?(receipt: ChatDeliveryReceipt): void; onRefresh(): void
  controlsReason?: string
  /** Existing standalone user/queued rows already display these immutable inputs. */
  representedCommandIds?: readonly string[]
}) {
  const inputs = useInfiniteQuery({ queryKey: ['chat-delivery-inputs', identityEpoch(), JSON.stringify(target)],
    maxPages: 4, initialPageParam: undefined as string | undefined, retry: false,
    queryFn: async ({ pageParam, signal }) => {
      try { return await chatDeliveryClient.inputs(target, { cursor: pageParam, limit: 25 }, { signal }) }
      catch (error) { if (isApiAccessError(error)) onDenied(error); throw error }
    }, getNextPageParam: page => page.nextCursor ?? undefined,
  })
  const represented = new Set(representedCommandIds)
  const items = [...(inputs.data?.pages ?? [])].reverse().flatMap(page => page.items)
    .filter(input => !represented.has(input.commandId))
  if (!items.length && !inputs.isPending && !inputs.isError && !inputs.hasNextPage) return null
  return <section aria-label="Original delivery inputs">
    <h3>Original delivery inputs</h3>
    {inputs.isPending ? <LoadingState label="Loading original inputs…" rows={1} /> : null}
    {inputs.isError ? <p role="alert">Original inputs could not be loaded. <Button onClick={() => void inputs.refetch()}>Retry inputs</Button></p> : null}
    {inputs.hasNextPage ? <Button loading={inputs.isFetching} onClick={() => void inputs.fetchNextPage()}>Load earlier inputs</Button> : null}
    {items.map(input => <RetainedInputCard key={input.receiptId} input={input} target={target}
      receipt={receipts.find(receipt => receipt.id === input.receiptId)} onDenied={onDenied} onRecover={onRecover}
      onOpenGroup={onOpenGroup} onCancel={onCancel} controlsReason={controlsReason} onRefresh={() => { void inputs.refetch(); onRefresh() }} />)}
  </section>
}

function RetainedInputCard({ input, target, receipt, onDenied, onRecover, onOpenGroup, onCancel, onRefresh, controlsReason }: {
  input: RetainedInput; target: DeliveryTarget; receipt?: ChatDeliveryReceipt; onDenied(error: Error): void
  onRecover?(recovery: DirectRecovery): void; onOpenGroup?(postId: string): void
  onCancel?(receipt: ChatDeliveryReceipt): void; onRefresh(): void
  controlsReason?: string
}) {
  const exactReceipt = useQuery({ queryKey: ['chat-delivery-receipt', identityEpoch(), JSON.stringify(target), input.receiptId],
    enabled: !receipt, retry: false,
    queryFn: async ({ signal }) => {
      try {
        const result = await chatDeliveryClient.receiptById(target, input.receiptId, { signal })
        const exact = result.receipts.find(item => item.id === input.receiptId && item.commandId === input.commandId)
        if (!exact) throw new Error('The delivery receipt is unavailable for this original input.')
        return exact
      } catch (error) { if (isApiAccessError(error)) onDenied(error); throw error }
    } })
  const exact = exactReceipt.data
  const currentReceipt = exact && (!receipt || Date.parse(exact.updatedAt) >= Date.parse(receipt.updatedAt)) ? exact : receipt
  const refreshStatus = () => { void exactReceipt.refetch(); onRefresh() }
  const body = useInfiniteQuery({ queryKey: ['chat-delivery-input-body', identityEpoch(), JSON.stringify(target), input.receiptId],
    enabled: false, retry: false, initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await chatDeliveryClient.inputs(target, { receiptId: input.receiptId, bodyCursor: pageParam }, { signal })
        const exact = page.items.find(item => item.receiptId === input.receiptId && item.commandId === input.commandId)
        if (!exact) throw new Error('The original input is unavailable for this receipt.')
        return exact
      } catch (error) { if (isApiAccessError(error)) onDenied(error); throw error }
    }, getNextPageParam: page => page.bodyCursor ?? undefined,
  })
  const pages = body.data?.pages, content = pages ? pages.map(page => page.content).join('') : input.content
  const incomplete = pages ? !!body.hasNextPage : input.truncated
  const original = { ...input, content, truncated: incomplete, bodyCursor: pages ? pages.at(-1)?.bodyCursor ?? null : input.bodyCursor }
  return <article className="agent-chat-message" aria-label="Retained input">
    <p style={{ whiteSpace: 'pre-wrap' }}>{content}</p>
    {input.attachments.length ? <ul aria-label="Original file revisions">{input.attachments.map(file =>
      <li key={`${file.fileId}:${file.revisionId}`}>File {file.fileId} · Revision {file.revisionId}</li>)}</ul> : null}
    {incomplete ? <Button loading={body.isFetching} onClick={() => void body.fetchNextPage()}>{pages ? 'Load more input' : 'Show full input'}</Button> : null}
    {body.isError ? <p role="alert">Could not load the full input. <Button onClick={() => void body.refetch()}>Retry full input</Button></p> : null}
    {input.origin === 'group' && input.sourcePostId ? <p>Reply belongs to Group chat.
      {onOpenGroup ? <Button onClick={() => onOpenGroup(input.sourcePostId!)}>Open Group message</Button> : null}</p> : null}
    {currentReceipt ? <ChatDeliveryReceipts receipts={[currentReceipt]} onCancel={onCancel} controlsReason={controlsReason} onRefresh={refreshStatus}
      onRecover={input.origin === 'direct' && onRecover && !incomplete ? (failed, choice) => onRecover({ origin: 'direct', receipt: failed, input: original, choice }) : undefined} />
      : <p role="status">{exactReceipt.isError ? 'Delivery status could not be loaded.' : 'Delivery status is loading.'} <Button onClick={refreshStatus}>Refresh delivery status</Button></p>}
    {currentReceipt && exactReceipt.isError ? <p role="alert">Delivery status could not be refreshed. The last known receipt is shown.
      <Button disabled={exactReceipt.isFetching} onClick={refreshStatus}>Retry status</Button></p>
      : currentReceipt && currentReceipt.state !== 'unknown' ? <Button disabled={exactReceipt.isFetching}
        onClick={refreshStatus}>Refresh delivery status</Button> : null}
    {currentReceipt?.errorCode === 'TARGET_SETTLED' && input.origin === 'direct' ? <p>Recovery opens a direct Agent composer. Your reply stays in direct chat.</p> : null}
  </article>
}
