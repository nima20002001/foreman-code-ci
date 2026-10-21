/** Native callback contexts, callback authority and live response availability. */
import type { NativeSessionReference } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import { unavailableNativeResponse, type NativeResponseAvailability } from '../responseAvailability.js'
import type { ClaudeResponseAvailabilityQuery, ClaudeNativeCallbackContext, ClaudeCallbackAuthority,
  ClaudePendingNotification } from './callbackAvailability.js'
import { componentLogger } from '../../diagnostics/logger.js'
import { failRuntime } from './sessionFailure.js'
import type { ClaudeManagerContext, Runtime, Turn } from './sessionTypes.js'
import { record } from './sessionState.js'

export function findCallbackContext(ctx: ClaudeManagerContext, toolUseId: string, nativeSessionId?: string): ClaudeNativeCallbackContext | undefined {
  const contexts: ClaudeNativeCallbackContext[] = []
  for (const runtime of ctx.resident.values()) {
    if (nativeSessionId && runtime.session?.nativeSessionId !== nativeSessionId) continue
    const turn = runtime.toolOwners.get(toolUseId)
    if (!runtime.closed && !runtime.failure && turn?.submitted && turn.nativeMessageId && !turn.terminal && runtime.session) {
      contexts.push({ nativeSessionId: runtime.session.nativeSessionId, nativeMessageId: turn.nativeMessageId,
        clientCorrelationId: turn.correlationId, generation: runtime.generation })
    }
  }
  return contexts.length === 1 ? contexts[0] : undefined
}

export function resolveCallbackWaiters(ctx: ClaudeManagerContext): void {
  for (const waiter of ctx.callbackWaiters) {
    const context = findCallbackContext(ctx, waiter.toolUseId, waiter.nativeSessionId)
    if (!context) continue
    ctx.callbackWaiters.delete(waiter)
    waiter.signal.removeEventListener('abort', waiter.abort)
    waiter.resolve(context)
  }
}

export function rejectCallbackWaiters(ctx: ClaudeManagerContext): void {
  for (const waiter of ctx.callbackWaiters) {
    ctx.callbackWaiters.delete(waiter)
    waiter.signal.removeEventListener('abort', waiter.abort)
    waiter.reject(new HarnessExecutionError('CLAUDE_CALLBACK_CONTEXT_CLOSED', 'The owned native callback context closed.'))
  }
}

export function callbackAuthority(ctx: ClaudeManagerContext, context: ClaudeNativeCallbackContext): ClaudeCallbackAuthority | undefined {
  const runtime = ctx.resident.get(context.nativeSessionId)
  const turn = runtime?.turns.get(context.clientCorrelationId)
  if (!runtime || runtime.closed || runtime.generation !== context.generation || !turn?.submitted
    || turn.nativeMessageId !== context.nativeMessageId || turn.terminal || !turn.authority) return undefined
  return { ...turn.authority }
}

export function observeSubagentHook(ctx: ClaudeManagerContext, sessionId: string, agentId: string, agentType: string, status: 'running' | 'unknown'): void {
  const runtime = ctx.resident.get(sessionId)
  if (!runtime?.session || !agentId || agentId.length > 512 || runtime.closed || ctx.disposed) return
  publishCallback(ctx, runtime, 'claude.subagent', { nativeSessionId: sessionId, agentId, agentType: agentType.slice(0, 512), status }, runtime.active)
}

export function notifyPendingChanged(ctx: ClaudeManagerContext, notification: ClaudePendingNotification): void {
  const runtime = ctx.resident.get(notification.nativeSessionId)
  const turn = runtime?.turns.get(notification.clientCorrelationId)
  if (!runtime || runtime.closed || runtime.generation !== notification.generation || !turn?.submitted
    || turn.nativeMessageId !== notification.nativeMessageId || turn.terminal) return
  publishCallback(ctx, runtime, 'interaction.pending', { nativeSessionId: notification.nativeSessionId,
    nativeMessageId: notification.nativeMessageId, nativeRequestId: notification.nativeRequestId,
    nativeRequestType: notification.nativeRequestType, generation: notification.generation }, turn)
}

function publishCallback(
  ctx: ClaudeManagerContext, runtime: Runtime, type: string, payload: Record<string, unknown>, turn?: Turn,
): void {
  void record(ctx, runtime, type, payload, turn).catch(async error => {
    // The fact is already in history; a closed or detached observer ends only its live publication.
    if (runtime.closed || turn && !turn.observing) return
    await failRuntime(ctx, runtime, error)
  }).catch((error: unknown) => {
    componentLogger('harness').error({ err: error }, 'Claude callback publication cleanup failed')
  })
}

export async function waitNativeCallbackContext(ctx: ClaudeManagerContext, toolUseId: string, signal: AbortSignal, nativeSessionId?: string): Promise<ClaudeNativeCallbackContext> {
  signal.throwIfAborted()
  if (ctx.disposed) throw new HarnessExecutionError('CLAUDE_CALLBACK_CONTEXT_CLOSED', 'Claude allocation is disposed.')
  const context = findCallbackContext(ctx, toolUseId, nativeSessionId)
  if (context) return context
  if (ctx.callbackWaiters.size >= 128) throw new HarnessExecutionError('CLAUDE_CALLBACK_CONTEXT_LIMIT', 'The bounded native callback context window is full.')
  return new Promise((resolve, reject) => {
    const waiter = { toolUseId, ...(nativeSessionId ? { nativeSessionId } : {}), signal, resolve, reject,
      abort() { ctx.callbackWaiters.delete(waiter); signal.removeEventListener('abort', waiter.abort); reject(signal.reason) } }
    ctx.callbackWaiters.add(waiter)
    signal.addEventListener('abort', waiter.abort, { once: true })
    if (signal.aborted) waiter.abort()
  })
}

export async function inspectResponseAvailability(ctx: ClaudeManagerContext, session: NativeSessionReference, query: ClaudeResponseAvailabilityQuery, signal?: AbortSignal): Promise<NativeResponseAvailability> {
  signal?.throwIfAborted()
  const runtime = ctx.resident.get(session.nativeSessionId)
  if (!runtime || runtime.closed || ctx.disposed) return unavailableNativeResponse(session, query, 'session_closed')
  if (session.harness !== ctx.harness || query.expectedNativeTurnId !== undefined) {
    return unavailableNativeResponse(session, query, 'identity_mismatch')
  }
  if (!ctx.options.qualification.interactions) return unavailableNativeResponse(session, query, 'unqualified')
  if (!ctx.options.liveCallbacks) return unavailableNativeResponse(session, query, 'callback_lost')
  const turn = runtime.active
  if (!turn?.submitted || !turn.nativeMessageId || runtime.failure) return unavailableNativeResponse(session, query, 'callback_lost')
  if (query.expectedNativeMessageId !== undefined && query.expectedNativeMessageId !== turn.nativeMessageId
    || query.expectedGeneration !== undefined && query.expectedGeneration !== runtime.generation) {
    return unavailableNativeResponse(session, query, 'identity_mismatch')
  }
  const result = await ctx.options.liveCallbacks.inspectCallbackAvailability({ ...query, nativeSessionId: session.nativeSessionId,
    nativeMessageId: turn.nativeMessageId, generation: runtime.generation })
  signal?.throwIfAborted()
  if (runtime.closed || ctx.disposed || ctx.resident.get(session.nativeSessionId) !== runtime) return unavailableNativeResponse(session, query, 'session_closed')
  if (runtime.active !== turn || turn.terminal || result.nativeSessionId !== session.nativeSessionId
    || result.nativeRequestId !== query.nativeRequestId || result.nativeRequestType !== query.nativeRequestType
    || result.state === 'available' && (result.nativeMessageId !== turn.nativeMessageId || result.generation !== runtime.generation || !result.qualified || result.path !== 'live_callback' || result.reason !== 'live_callback' || result.nativeTurnId !== undefined)) {
    return unavailableNativeResponse(session, query, 'identity_mismatch')
  }
  return result
}
