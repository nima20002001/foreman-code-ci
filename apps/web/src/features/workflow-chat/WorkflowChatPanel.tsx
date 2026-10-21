import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentIdentity, ChatDeliveryReceipt, WorkflowChatPost, WorkflowChatPostResponse } from '@foreman-code/contracts'
import { Alert, Button, LoadingState, Select } from '../../shared/ui/nocturne'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../shared/api/accessError'
import { useRememberedChatScroll } from '../conversations/chatScrollStore'
import { useChatOnline } from '../conversations/delivery/useChatDelivery'
import { useWorkflowChat, useWorkflowPost } from './useWorkflowChat'
import { workflowChatClient, type WorkflowChatScope } from './client'
import { readWorkflowDraft, useWorkflowDraftStore, workflowDraftKey } from './draft'
import { WorkflowChatComposer } from './WorkflowChatComposer'
import { WorkflowChatMessage } from './WorkflowChatMessage'
import { useWorkflowSelection } from './useWorkflowSelection'
import type { WorkflowTargetResolver } from './RecipientTargetPicker'
import './workflowChat.css'

export type WorkflowChatPanelProps = WorkflowChatScope & {
  visible: boolean
  participants: readonly AgentIdentity[]
  participantsLoading?: boolean
  participantsError?: string
  retryParticipants?: () => void
  resolveTargets: WorkflowTargetResolver
  currentRunId?: string
  selection: { runId?: string; postId?: string; receiptId?: string }
  onSelectionChange(selection: { runId?: string; postId?: string; receiptId?: string }): void
  onOpenAgent?: (post: WorkflowChatPost, receipt?: ChatDeliveryReceipt) => void
}

/** The shell owns destination/navigation. Hidden panels mount no queries or subscriptions. */
export function WorkflowChatPanel(props: WorkflowChatPanelProps) {
  return props.visible ? <WorkflowChatContent key={`${identityEpoch()}:${props.workspaceId}:${props.workflowId}`} {...props} /> : null
}

function WorkflowChatContent(props: WorkflowChatPanelProps) {
  const { selection, currentRunId, onSelectionChange } = props
  const chat = useWorkflowChat(props, selection.runId)
  const online = useChatOnline()
  const cache = useQueryClient(), scroll = useRef<HTMLDivElement>(null), following = useRef(true)
  const draftKey = workflowDraftKey(props)
  useRememberedChatScroll(`${draftKey}:${selection.runId ?? 'all'}`, scroll, following)
  const [recoveryKey, setRecoveryKey] = useState<string>()
  const [unread, setUnread] = useState(false)
  const [olderWindow, setOlderWindow] = useState(false)
  const selected = useWorkflowSelection(props, selection, !chat.denied, chat.revoke)
  const { focused, postId } = selected
  const update = () => { cancel.reset(); earlier.reset(); moreReceipts.reset(); exactReceipts.reset(); chat.refresh();
    if (postId) void focused.refetch(); if (selection.receiptId) void selected.receipt.refetch() }
  const cancel = useMutation({ mutationFn: (receipt: ChatDeliveryReceipt) => {
    if (!navigator.onLine) throw new Error('You are offline. Controls are unavailable.')
    return workflowChatClient.cancel(props, receipt.id, crypto.randomUUID())
  }, onSuccess: update })
  const earlier = useMutation({ mutationFn: async () => {
    const cursor = chat.data?.posts.nextCursor
    if (!cursor) return
    const page = await workflowChatClient.read(props, { runId: selection.runId, cursor })
    cache.setQueryData<typeof chat.data>(chat.key, previous => previous ? { ...previous, posts: { ...page,
      items: [...new Map([...page.items, ...previous.posts.items].map(post => [post.id, post])).values()].sort((a, b) => a.sequence - b.sequence).slice(0, 100) } } : previous)
    setOlderWindow(true)
  } })
  const exactReceipts = useMutation({ mutationFn: async (post: WorkflowChatPost) => {
    const page = await workflowChatClient.deliveries(props, { postId: post.id, limit: 100 })
    cache.setQueryData<typeof chat.data>(chat.key, previous => previous ? { ...previous,
      receipts: { ...previous.receipts, items: [...previous.receipts.items.filter(item => item.postId !== post.id), ...page.items] } } : previous)
    if (post.id === postId) await focused.refetch()
  } })
  const moreReceipts = useMutation({ mutationFn: async () => {
    if (!chat.data?.receipts.hasMore) return
    const page = await workflowChatClient.deliveries(props, { runId: selection.runId, cursor: chat.data.receipts.nextCursor ?? undefined })
    cache.setQueryData<typeof chat.data>(chat.key, previous => previous ? { ...previous, receipts: { ...page,
      items: [...new Map([...previous.receipts.items, ...page.items].map(receipt => [receipt.id, receipt])).values()] } } : previous)
  } })
  useLayoutEffect(() => {
    if (!scroll.current) return
    if (following.current) { scroll.current.scrollTop = scroll.current.scrollHeight; setUnread(false) }
    else setUnread(true)
  }, [chat.data?.posts.revision])
  useLayoutEffect(() => {
    if (postId && focused.data?.posts.items[0]) document.getElementById(`workflow-post-${postId}`)?.focus({ preventScroll: true })
  }, [postId, focused.data])
  const accessError = [focused.error, selected.receipt.error, cancel.error, earlier.error, moreReceipts.error, exactReceipts.error].some(isApiAccessError)
  const revoke = chat.revoke
  useEffect(() => { if (accessError) revoke() }, [accessError, revoke])
  const denied = chat.denied || accessError
  const openPost = (postId: string) => onSelectionChange({ runId: selection.runId, postId })
  const recover = (post: WorkflowChatPost, receipt: ChatDeliveryReceipt, choice: 'outside_run' | 'historical_follow_up') => {
    if (receipt.target.kind === 'operator_conversation') return
    const nodeId = receipt.target.agent.workflowNodeId
    const key = `${draftKey}:recovery:${receipt.id}:${choice}`
    const existing = readWorkflowDraft(key)
    if (!existing.body) useWorkflowDraftStore.getState().save(key, { body: post.body,
      mentions: post.mentions.filter(mention => mention.workflowNodeId === nodeId),
      deliveries: [], replyToPostId: post.id, recovery: { receiptId: receipt.id, sourcePostId: post.id, sourceTarget: receipt.target, choice } })
    setRecoveryKey(key)
  }
  const row = (post: WorkflowChatPost, exact = false) => {
    const data = exact ? focused.data : chat.data
    const receipts = data?.receipts.items.filter(receipt => receipt.postId === post.id) ?? []
    return <WorkflowChatMessage key={post.id} scope={props} post={post} receipts={receipts}
      controlsReason={!online ? 'You are offline. Controls are unavailable.' : undefined}
      truncated={data?.posts.bodyTruncations?.some(body => body.postId === post.id)}
      receiptsIncomplete={new Set(post.mentions.map(mention => mention.workflowNodeId)).size > receipts.length}
      onOpenPost={openPost} onCancel={receipt => cancel.mutate(receipt)} onRefresh={() => exactReceipts.mutate(post)} onDenied={chat.revoke}
      onRecover={(receipt, choice) => recover(post, receipt, choice)} onOpenAgent={props.onOpenAgent} />
  }
  if (denied) return <Alert tone="warning" title="Chat access unavailable"><Button onClick={update}>Refresh access</Button></Alert>
  return <section className="workflow-chat-panel" aria-label="Group chat">
    <header><h2>Group chat</h2><Select label="Message history" value={selection.runId ?? ''}
      options={[{ value: '', label: 'All runs' }, ...(currentRunId ? [{ value: currentRunId, label: 'This run' }] : [])]}
      onChange={event => onSelectionChange({ ...selection, runId: event.target.value || undefined })} /></header>
    {chat.query.isPending ? <LoadingState label="Loading group chat…" rows={2} /> : null}
    {chat.query.isError ? <Alert tone="warning" title={chat.data ? 'Showing saved messages. Reconnecting…' : 'Could not load group chat'}
      action={<Button onClick={chat.refresh}>Retry</Button>} /> : null}
    {chat.connection !== 'connected' && chat.data ? <p role="status">Live updates are reconnecting.</p> : null}
    {selection.postId || selection.receiptId ? <aside aria-label="Selected post">
      {selected.mismatch ? <p role="alert">This delivery belongs to a different post.
        {selected.receiptPostId ? <Button onClick={() => openPost(selected.receiptPostId!)}>Open original post</Button> : null}</p>
        : selection.receiptId && selected.receipt.isPending || postId && focused.isPending ? <LoadingState label="Loading selected post…" rows={1} /> : focused.data?.posts.items[0] ? row(focused.data.posts.items[0], true)
        : <p role="status">{focused.isError || selected.receipt.isError ? 'Could not load this post.' : 'This post is unavailable.'}
          <Button onClick={() => { if (postId) void focused.refetch(); else void selected.receipt.refetch() }}>Retry</Button></p>}
      <Button onClick={() => onSelectionChange({ runId: selection.runId })}>Back to history</Button>
    </aside> : null}
    <div ref={scroll} className="workflow-chat-transcript" role="region" aria-label="Workflow messages" tabIndex={0}
      onScroll={event => { const box = event.currentTarget; following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48 }}>
      {chat.data?.posts.hasMore ? <Button loading={earlier.isPending} onClick={() => { following.current = false; earlier.mutate() }}>Load earlier messages</Button> : null}
      {chat.data?.posts.items.length === 0 ? <p>No messages yet. Mention an agent to start a conversation.</p> : null}
      {chat.data?.posts.items.filter(post => post.id !== postId).map(post => row(post))}
    </div>
    {unread || olderWindow ? <Button onClick={() => { following.current = true; setOlderWindow(false); chat.refresh();
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setUnread(false) }}>Jump to latest</Button> : null}
    {chat.data?.receipts.hasMore ? <Button loading={moreReceipts.isPending} onClick={() => moreReceipts.mutate()}>Load more delivery status</Button> : null}
    {cancel.isError || earlier.isError || moreReceipts.isError ? <p role="alert">{String((cancel.error ?? earlier.error ?? moreReceipts.error)?.message)}</p> : null}
    {recoveryKey ? <Button onClick={() => setRecoveryKey(undefined)}>Back to saved draft</Button> : null}
    <WorkflowPostComposer key={recoveryKey ?? draftKey} {...props} draftKey={recoveryKey ?? draftKey}
      onDenied={chat.revoke} onPosted={result => { update(); openPost(result.post.id) }} />
  </section>
}

function WorkflowPostComposer(props: WorkflowChatPanelProps & { draftKey: string; onPosted(result: WorkflowChatPostResponse): void; onDenied(): void }) {
  const post = useWorkflowPost(props, props.onPosted, workflowChatClient, props.draftKey)
  const accessError = isApiAccessError(post.mutation.error) || !!post.denial
  const onDenied = props.onDenied
  useEffect(() => { if (accessError) onDenied() }, [accessError, onDenied])
  return <>
    {post.feedback ? <p role="alert">{post.feedback}</p> : null}
    {post.pending ? <div role="status">Posting is not yet confirmed.
      <Button onClick={() => void post.reconcile()}>Check status</Button>
      <Button disabled={post.mutation.isPending} onClick={() => void post.reconcile(true)}>Retry original message</Button>
    </div> : null}
    <WorkflowChatComposer scope={props} participants={props.participants} participantsLoading={props.participantsLoading}
      participantsError={props.participantsError} retryParticipants={props.retryParticipants} resolveTargets={props.resolveTargets}
      draftKey={props.draftKey} onSubmit={request => void post.post(request)} pending={post.mutation.isPending || !!post.pending} />
  </>
}
