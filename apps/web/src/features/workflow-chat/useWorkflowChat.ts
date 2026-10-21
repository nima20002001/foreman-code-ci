import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { WorkflowChatPostRequestSchema, type WorkflowChatPostRequest, type WorkflowChatPostResponse } from '@foreman-code/contracts'
import { ApiError } from '../../shared/api/client'
import { isApiAccessError } from '../../shared/api/accessError'
import { identityEpoch, protectedKey } from '../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { createStreamReadback } from '../../shared/api/streamReadback'
import { workflowChatClient, type WorkflowChatClient, type WorkflowChatEvent, type WorkflowChatScope } from './client'
import { subscribeWorkflowChat } from './stream'
import { readWorkflowDraft, useWorkflowDraftStore, workflowDraftKey } from './draft'

export type WorkflowChatSnapshot = { posts: Awaited<ReturnType<WorkflowChatClient['read']>>;
  receipts: Awaited<ReturnType<WorkflowChatClient['deliveries']>> }
type Snapshot = WorkflowChatSnapshot
const pendingKey = (scope: WorkflowChatScope) => protectedKey('draft', `${workflowDraftKey(scope)}:pending`)
const pendingSchema = z.object({ request: WorkflowChatPostRequestSchema, draftRevision: z.string().optional(), draftKey: z.string() })
type PendingPost = z.infer<typeof pendingSchema>
function pendingCommand(scope: WorkflowChatScope): PendingPost | undefined {
  try {
    const raw = localStorage.getItem(pendingKey(scope))
    return raw ? pendingSchema.parse(JSON.parse(raw)) : undefined
  } catch { return undefined /* ignore: malformed local state never becomes a send. */ }
}
function rememberPending(scope: WorkflowChatScope, request?: PendingPost) {
  if (request) localStorage.setItem(pendingKey(scope), JSON.stringify(request))
  else localStorage.removeItem(pendingKey(scope))
}

function patchSnapshot(previous: Snapshot, events: WorkflowChatEvent[], runId?: string, postId?: string): Snapshot {
  const posts = new Map(previous.posts.items.map(post => [post.id, post]))
  const receipts = new Map(previous.receipts.items.map(receipt => [receipt.id, receipt]))
  let postRevision = previous.posts.revision, receiptRevision = previous.receipts.revision
  for (const event of events) {
    if (event.revision >= previous.posts.revision) {
      if (event.post && (!postId || event.post.id === postId) && (!runId || event.post.execution?.runId === runId || posts.has(event.post.id))) posts.set(event.post.id, event.post)
      postRevision = Math.max(postRevision, event.revision)
    }
    if (event.revision >= previous.receipts.revision) {
      if (event.receipt?.postId && posts.has(event.receipt.postId)) receipts.set(event.receipt.id, event.receipt)
      receiptRevision = Math.max(receiptRevision, event.revision)
    }
  }
  const items = [...posts.values()].sort((a, b) => a.sequence - b.sequence).slice(-100)
  const ids = new Set(items.map(post => post.id))
  return { posts: { ...previous.posts, items, revision: postRevision }, receipts: { ...previous.receipts,
    items: [...receipts.values()].filter(receipt => receipt.postId && ids.has(receipt.postId)).slice(-3200), revision: receiptRevision } }
}

export function useWorkflowChat(scope: WorkflowChatScope, runId?: string, client = workflowChatClient) {
  const cache = useQueryClient(), generation = sessionGeneration(), epoch = identityEpoch()
  const key = useMemo(() => ['workflow-chat', epoch, scope.workspaceId, scope.workflowId, runId ?? null],
    [epoch, scope.workspaceId, scope.workflowId, runId])
  const stableScope = useMemo(() => ({ workspaceId: scope.workspaceId, workflowId: scope.workflowId }), [scope.workspaceId, scope.workflowId])
  const denied = useRef(false)
  const [accessDenied, setAccessDenied] = useState(false)
  const releaseStream = useRef<(() => void) | undefined>(undefined)
  const revoke = useCallback(() => {
    denied.current = true; setAccessDenied(true); releaseStream.current?.()
    for (const name of ['workflow-chat', 'workflow-chat-post', 'workflow-chat-receipt', 'workflow-chat-body']) {
      const prefix = [name, epoch, stableScope.workspaceId, stableScope.workflowId]
      void cache.cancelQueries({ queryKey: prefix })
      cache.removeQueries({ queryKey: prefix })
    }
  }, [cache, epoch, stableScope])
  const [connection, setConnection] = useState<'connected' | 'reconnecting' | 'unavailable'>('reconnecting')
  const query = useQuery({ queryKey: key, enabled: false, retry: false, queryFn: async ({ signal }) => {
    try {
      const [posts, receipts] = await Promise.all([client.read(stableScope, { runId, limit: 50 }, { signal }),
        client.deliveries(stableScope, { runId, limit: 100 }, { signal })])
      signal.throwIfAborted(); assertSession(generation); denied.current = false; setAccessDenied(false)
      return { posts, receipts }
    } catch (error) {
      if (isApiAccessError(error)) {
        revoke()
      }
      throw error
    }
  } })
  const refresh = query.refetch
  useEffect(() => {
    if (accessDenied) return
    let disposed = false, buffered: WorkflowChatEvent[] = [], ready = false, seen = -1
    const identities = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const readback = createStreamReadback(async () => {
      const result = await refresh()
      if (disposed || !result.data || result.error || denied.current) return
      ready = true
      seen = Math.min(result.data.posts.revision, result.data.receipts.revision)
      flush()
    })
    function flush() {
      clearTimeout(timer); timer = undefined
      if (disposed || !ready || denied.current) return
      const events = buffered; buffered = []
      cache.setQueryData<Snapshot>(key, previous => previous ? patchSnapshot(previous, events, runId) : previous)
      for (const exact of cache.getQueryCache().findAll({ queryKey: ['workflow-chat-post', epoch, stableScope.workspaceId, stableScope.workflowId], type: 'active' })) {
        const postId = exact.queryKey[4]
        if (typeof postId === 'string') cache.setQueryData<Snapshot>(exact.queryKey, previous => previous ? patchSnapshot(previous, events, undefined, postId) : previous)
      }
    }
    // Attach first, then bootstrap; bounded buffering closes the subscribe/read race.
    const close = subscribeWorkflowChat(stableScope, {
      connection: setConnection, reconnect: readback.request,
      event: event => {
        if (disposed || denied.current) return
        const identity = JSON.stringify([event.revision, event.post?.id, event.receipt?.id, event.receipt?.state, event.receipt?.updatedAt])
        if (identities.has(identity)) return
        identities.add(identity)
        if (identities.size > 500) identities.delete(identities.values().next().value!)
        if (event.snapshotRequired || runId && event.post && !event.post.execution || buffered.length >= 200 || ready && seen >= 0 && event.revision > seen + 1) {
          ready = false; readback.request()
          void cache.invalidateQueries({ queryKey: ['workflow-chat-post', epoch, stableScope.workspaceId, stableScope.workflowId], type: 'active' })
          void cache.invalidateQueries({ queryKey: ['workflow-chat-receipt', epoch, stableScope.workspaceId, stableScope.workflowId], type: 'active' })
        }
        if (event.revision < seen && ready) return
        seen = Math.max(seen, event.revision)
        if (buffered.length < 200) buffered.push(event)
        if (!timer) timer = setTimeout(flush, 100)
      },
    })
    releaseStream.current = () => { close(); buffered = [] }
    readback.request()
    return () => { disposed = true; clearTimeout(timer); readback.dispose(); close(); buffered = []; releaseStream.current = undefined }
  }, [accessDenied, cache, client, epoch, key, refresh, runId, stableScope])
  return { query, data: denied.current ? undefined : query.data,
    denied: denied.current, connection, refresh: () => { void refresh() }, key, stableScope, revoke }
}

export function useWorkflowPost(scope: WorkflowChatScope, onPosted: (result: WorkflowChatPostResponse) => void,
  client = workflowChatClient, draftKey = workflowDraftKey(scope)) {
  const generation = sessionGeneration(), epoch = identityEpoch()
  const [pending, setPending] = useState(() => pendingCommand(scope))
  const [feedback, setFeedback] = useState<string>()
  const [denial, setDenial] = useState<Error>()
  const lock = useRef(false)
  const mutation = useMutation({ retry: false, networkMode: 'always', mutationFn: async ({ request }: PendingPost) => {
    assertSession(generation)
    if (!navigator.onLine) throw new Error('You are offline. Your draft is kept.')
    return client.post(request)
  }, onSuccess: (result, { request, draftRevision, draftKey: submittedKey }) => {
    assertSession(generation)
    if (epoch !== identityEpoch()) return
    rememberPending(scope); setPending(undefined); setFeedback(undefined)
    useWorkflowDraftStore.getState().clear(submittedKey, request, draftRevision)
    onPosted(result)
  }, onError: error => {
    if (epoch !== identityEpoch()) return
    if (isApiAccessError(error)) setDenial(error)
    if (ApiError.is(error) && error.status >= 400 && error.status < 500 && !['REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code)
      && !isApiAccessError(error)) {
      rememberPending(scope); setPending(undefined)
    }
    setFeedback(error instanceof Error ? error.message : 'Could not confirm posting. Check status before retrying.')
  } })
  const post = async (input: Omit<WorkflowChatPostRequest, 'commandId'>) => {
    if (lock.current || mutation.isPending || pending) return
    lock.current = true
    try {
      const request = WorkflowChatPostRequestSchema.parse({ ...input, commandId: crypto.randomUUID() })
      const command = { request, draftRevision: readWorkflowDraft(draftKey).draftRevision, draftKey }
      rememberPending(scope, command); setPending(command)
      await mutation.mutateAsync(command)
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Could not post this message.') }
    finally { lock.current = false }
  }
  const reconcile = async (retry = false) => {
    if (!pending || lock.current) return
    lock.current = true
    try {
      assertSession(generation)
      const [posts, receipts] = await Promise.all([client.read(scope, { commandId: pending.request.commandId }),
        client.deliveries(scope, { commandId: pending.request.commandId })])
      assertSession(generation)
      const post = posts.items[0]
      if (post) {
        rememberPending(scope); setPending(undefined); setFeedback(undefined)
        useWorkflowDraftStore.getState().clear(pending.draftKey, pending.request, pending.draftRevision)
        onPosted({ post, receipts: receipts.items, replayed: true })
      } else if (retry) await mutation.mutateAsync(pending)
      else setFeedback('No receipt found yet. Retry the original message to use the same command identity.')
    } catch (error) {
      if (isApiAccessError(error)) setDenial(error)
      setFeedback(error instanceof Error ? error.message : 'Could not check posting status.')
    }
    finally { lock.current = false }
  }
  return { post, pending, mutation, feedback, reconcile, denial }
}
