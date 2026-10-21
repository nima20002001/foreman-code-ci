import type { z } from 'zod'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChatSendRequestSchema, DeliveryTargetSchema, type ChatSendRequest, type ChatDeliveryReceipt, type DeliveryTarget } from '@foreman-code/contracts'
import { ApiError } from '../../../shared/api/client'
import { isApiAccessError } from '../../../shared/api/accessError'
import { identityEpoch, protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { chatDeliveryClient } from './client'
import { deliveryAction, type DeliveryPresentation } from './deliveryAction'
import { useChatControl } from './useChatControl'
import { acceptDeliveryReadback } from './deliveryReadback'
import { sameDeliveryTarget } from '../../workflow-chat/draft'

const subscribeOnline = (change: () => void) => {
  window.addEventListener('online', change); window.addEventListener('offline', change)
  return () => { window.removeEventListener('online', change); window.removeEventListener('offline', change) }
}
const onlineSnapshot = () => navigator.onLine
export const useChatOnline = () => useSyncExternalStore(subscribeOnline, onlineSnapshot, () => true)
const emptyPresentation: DeliveryPresentation = { state: 'idle', capabilities: { steer: 'unavailable', queue: false, interruptAndSend: false },
  unavailableReason: 'Loading targets…' }
const locks = new Set<string>()
function readPending(key: string): ChatSendRequest | undefined {
  try { const raw = localStorage.getItem(key); return raw ? ChatSendRequestSchema.parse(JSON.parse(raw)) : undefined }
  catch { return undefined /* ignore: malformed local commands never dispatch. */ }
}
type Accepted = (receipt: ChatDeliveryReceipt, request: ChatSendRequest) => void
type Attempt = { request: ChatSendRequest; key: string; generation: number; epoch: string; accepted?: Accepted }

/** One exact target; callbacks and pending storage stay attached to the submitting selection. */
export function useChatDelivery(target: DeliveryTarget | undefined, enabled: boolean, lifecycle: string,
  onAccepted?: Accepted, options: { onDenied?: (error: Error) => void; nativeTurnId?: string } = {}) {
  const targetKey = JSON.stringify(target ?? null), epoch = identityEpoch(), generation = sessionGeneration()
  const cache = useQueryClient()
  const selected = useMemo(() => targetKey === 'null' ? undefined : DeliveryTargetSchema.parse(JSON.parse(targetKey)), [targetKey])
  const key = protectedKey('draft', `delivery:${targetKey}`)
  const scope = useRef(key); scope.current = key
  const [local, setLocal] = useState<{ key: string; pending?: ChatSendRequest; feedback?: string }>({ key, pending: readPending(key) })
  const current = local.key === key ? local : { key, pending: readPending(key) }
  const [denial, setDenial] = useState<string>(), online = useChatOnline()
  const queryKey = useMemo(() => ['chat-delivery', epoch, targetKey] as const, [epoch, targetKey])
  const deny = (error: Error) => {
    setDenial(key); options.onDenied?.(error)
    for (const kind of ['chat-delivery', 'chat-delivery-inputs', 'chat-delivery-input-body', 'chat-delivery-receipt']) {
      const protectedQuery = [kind, epoch, targetKey]
      void cache.cancelQueries({ queryKey: protectedQuery }); cache.removeQueries({ queryKey: protectedQuery })
    }
  }
  const query = useQuery({ queryKey, enabled: enabled && !!selected && denial !== key, retry: false,
    queryFn: async ({ signal }) => {
      try {
        const result = await chatDeliveryClient.read(selected!, { signal }); signal.throwIfAborted(); assertSession(generation)
        const accepted = acceptDeliveryReadback(cache.getQueryData<Awaited<ReturnType<typeof chatDeliveryClient.read>>>(queryKey), result)
        setDenial(undefined); return accepted
      }
      catch (error) { if (isApiAccessError(error)) deny(error); throw error }
    } })
  const refresh = query.refetch
  useEffect(() => {
    if (enabled && selected && denial !== key) {
      void refresh()
      void cache.invalidateQueries({ queryKey: ['chat-delivery-inputs', epoch, targetKey] })
    }
  }, [enabled, lifecycle, refresh, selected, denial, key, cache, epoch, targetKey])
  const accept = (receipt: ChatDeliveryReceipt, attempt: Attempt) => {
    assertSession(attempt.generation)
    if (attempt.epoch !== identityEpoch()) return
    if (receipt.commandId !== attempt.request.commandId || !sameDeliveryTarget(receipt.target, attempt.request.target)) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The response did not confirm this exact command and target.' })
    }
    const unresolved = receipt.state === 'unknown' || receipt.state === 'submitting' && receipt.appliedIntent === 'steer'
    if (!unresolved && readPending(attempt.key)?.commandId === attempt.request.commandId) localStorage.removeItem(attempt.key)
    if (scope.current === attempt.key) {
      setLocal({ key: attempt.key, pending: readPending(attempt.key), feedback: unresolved
        ? 'Delivery is unconfirmed. Your draft is kept; check the original command before sending again.'
        : ['failed', 'canceled'].includes(receipt.state) ? 'The message was not delivered. Your draft is kept.' : undefined })
      void refresh()
    }
    void cache.invalidateQueries({ queryKey: ['chat-delivery-inputs', attempt.epoch, JSON.stringify(attempt.request.target)] })
    if (!unresolved && !['failed', 'canceled'].includes(receipt.state)) attempt.accepted?.(receipt, attempt.request)
  }
  const send = useMutation({ retry: false, networkMode: 'always', mutationFn: ({ request, generation: expected }: Attempt) => {
    assertSession(expected)
    if (!navigator.onLine) throw new Error('You are offline. Your draft is kept.')
    return chatDeliveryClient.send(request)
  }, onSuccess: accept, onError: (error, attempt) => {
    if (attempt.epoch !== identityEpoch() || scope.current !== attempt.key) return
    if (isApiAccessError(error)) deny(error)
    const definite = ApiError.is(error) && error.status >= 400 && error.status < 500
      && !['REQUEST_TIMEOUT', 'INVALID_RESPONSE'].includes(error.code) && !isApiAccessError(error)
    if (definite && readPending(attempt.key)?.commandId === attempt.request.commandId) localStorage.removeItem(attempt.key)
    setLocal({ key: attempt.key, pending: readPending(attempt.key), feedback: error.message })
  } })
  const state = denial === key ? undefined : query.data
  // Frozen engine messages are history, not proof of the currently active native turn.
  const presentation: DeliveryPresentation = state ? 'delivery' in state ? state.delivery
    : { state: state.state, capabilities: state.capabilities, nativeTurnId: state.nativeTurnId ?? options.nativeTurnId }
    : { ...emptyPresentation, ...(query.isError ? { unavailableReason: query.error.message } : {}) }
  const control = useChatControl(selected, enabled && denial !== key, presentation.nativeTurnId, () => { void refresh() }, deny)
  const submit = (input: Omit<z.input<typeof ChatSendRequestSchema>, 'target' | 'commandId'>): boolean => {
    if (!enabled || !selected || !online || locks.has(key) || readPending(key) || control.pending || denial === key) return false
    const reason = deliveryAction({ ...presentation, hasAttachments: !!input.attachments?.length }, input.intent).reason
    if (reason) { setLocal(previous => ({ ...previous, key, feedback: reason })); return false }
    locks.add(key)
    try {
      const request = ChatSendRequestSchema.parse({ ...input, target: selected, commandId: crypto.randomUUID() })
      localStorage.setItem(key, JSON.stringify(request)); setLocal({ key, pending: request })
      void send.mutateAsync({ request, key, generation, epoch, accepted: onAccepted })
        .catch(() => { /* ignore: the mutation retains the command and visible error. */ }).finally(() => { locks.delete(key) })
      return true
    } catch (error) { locks.delete(key); setLocal({ key, feedback: error instanceof Error ? error.message : 'Could not prepare message.' }); return false }
  }
  const reconcile = async (retry = false) => {
    const pending = readPending(key)
    if (!selected || !pending || locks.has(key) || !online) return
    locks.add(key)
    try {
      let receipt: ChatDeliveryReceipt | undefined
      try { receipt = (await chatDeliveryClient.receipt(selected, pending.commandId!)).receipts.find(item => item.commandId === pending.commandId) }
      catch (error) { if (!(ApiError.is(error) && error.code === 'CHAT_RECEIPT_NOT_FOUND')) throw error }
      const attempt = { request: pending, key, generation, epoch, accepted: onAccepted }
      if (receipt) accept(receipt, attempt)
      else if (retry) await send.mutateAsync(attempt)
      else setLocal(previous => ({ ...previous, key, feedback: 'No receipt found yet. Retry original message to reuse its command identity.' }))
    } catch (error) {
      if (isApiAccessError(error)) deny(error)
      setLocal(previous => ({ ...previous, key, feedback: error instanceof Error ? error.message : 'Could not check delivery.' }))
    } finally { locks.delete(key) }
  }
  return { state, presentation, query, queryKey, submit, pending: current.pending, busy: send.isPending || control.busy,
    feedback: current.feedback ?? control.feedback, online, denied: denial === key, revoke: deny, refresh: () => { void refresh() }, reconcile,
    pendingControl: control.pending, retryControl: control.retry, stop: control.stop, cancel: control.cancel, cancelAll: () => control.cancel() }
}
