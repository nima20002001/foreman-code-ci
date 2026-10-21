import { useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { z } from 'zod'
import { ChatQueueCancelRequestSchema, ChatStopRequestSchema, type DeliveryTarget } from '@foreman-code/contracts'
import { identityEpoch, protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { isApiAccessError } from '../../../shared/api/accessError'
import { chatDeliveryClient } from './client'

const commandSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('stop'), request: ChatStopRequestSchema }),
  z.object({ operation: z.literal('cancel'), request: ChatQueueCancelRequestSchema }),
])
type Command = z.infer<typeof commandSchema>
const locks = new Set<string>()
function read(key: string): Command | undefined {
  try { const value = localStorage.getItem(key); return value ? commandSchema.parse(JSON.parse(value)) : undefined }
  catch { return undefined /* ignore: malformed stored control cannot become a command. */ }
}

/** Unknown Stop/cancel retries replay the original request, never stop a later queued turn. */
export function useChatControl(target: DeliveryTarget | undefined, enabled: boolean, nativeTurnId: string | undefined,
  refresh: () => void, onDenied: (error: Error) => void) {
  const key = protectedKey('draft', `delivery-control:${JSON.stringify(target ?? null)}`)
  const currentKey = useRef(key); currentKey.current = key
  const [state, setState] = useState<{ key: string; command?: Command; error?: string }>({ key, command: read(key) })
  const current = state.key === key ? state : { key, command: read(key) }
  const mutation = useMutation({ retry: false, networkMode: 'always', mutationFn: async (attempt: {
    command: Command; key: string; generation: number; epoch: string
  }) => {
    assertSession(attempt.generation)
    const command = attempt.command
    return command.operation === 'stop' ? chatDeliveryClient.stop(command.request) : chatDeliveryClient.cancel(command.request)
  }, onSuccess: (receipt, attempt) => {
    assertSession(attempt.generation)
    if (receipt.commandId !== attempt.command.request.commandId) throw new Error('The response did not confirm this control.')
    if (read(attempt.key)?.request.commandId === receipt.commandId) localStorage.removeItem(attempt.key)
    if (attempt.epoch === identityEpoch() && currentKey.current === attempt.key) { setState({ key: attempt.key }); refresh() }
  }, onError: (error, attempt) => {
    if (attempt.epoch !== identityEpoch() || currentKey.current !== attempt.key) return
    if (isApiAccessError(error)) onDenied(error)
    setState({ key: attempt.key, command: read(attempt.key), error: error.message })
  } })
  const run = (fresh?: Command) => {
    if (!enabled || !target || !navigator.onLine || locks.has(key)) return
    const command = read(key) ?? fresh
    if (!command) return
    locks.add(key)
    try {
      localStorage.setItem(key, JSON.stringify(command)); setState({ key, command })
      void mutation.mutateAsync({ command, key, generation: sessionGeneration(), epoch: identityEpoch() })
        .catch(() => { /* ignore: the original control and visible failure remain available. */ }).finally(() => { locks.delete(key) })
    } catch (error) { locks.delete(key); setState({ key, error: error instanceof Error ? error.message : 'Could not retain control request.' }) }
  }
  return { pending: current.command, feedback: current.error, busy: mutation.isPending, retry: () => run(),
    stop: () => target && run({ operation: 'stop', request: { target, commandId: crypto.randomUUID(), scope: 'active_turn',
      ...(nativeTurnId ? { expectedNativeTurnId: nativeTurnId } : {}) } }),
    cancel: (receiptId?: string) => target && run({ operation: 'cancel', request: { target, commandId: crypto.randomUUID(),
      selection: receiptId ? { kind: 'one', receiptId } : { kind: 'all' } } }) }
}
