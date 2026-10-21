/** Message turns: submission, cancellation, retirement, history and read-only reconciliation. */
import { claudeNativeEvent } from './nativeEvents.js'
import { createClaudeEventNormalizer } from './normalization.js'
import { childHistoryCursor, childHistoryEvent, encodeChildHistoryCursor } from '../../subagents/nativeReadback.js'
import type { NativeHarnessEvent, NativeSessionReference, PendingNativeInteraction, ApprovalResponseOption } from '@foreman-code/contracts'
import type { NativeHistory, NativeTurnInput, NativeSubagentHistoryPage } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import { ClaudeInputNotDeliveredError } from './port.js'
import { claudePromptUuid, type ClaudeMessageTurnInput, type ClaudeManagerContext } from './sessionTypes.js'
import { qualified, runtimeFor, createTurn, subscribe } from './sessionState.js'
import { applyPreferences } from './sessionSettings.js'

export function startTurn(ctx: ClaudeManagerContext, session: NativeSessionReference, rawInput: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
  qualified(ctx, 'basicTurns')
  signal?.throwIfAborted()
  const runtime = runtimeFor(ctx, session)
  if (runtime.failure) throw runtime.failure
  if (runtime.closed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned native output stream is closed.')
  if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
  if (runtime.active || runtime.startingTurn) throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'A Claude message is still active or uncertain; no second prompt may be offered.')
  if (runtime.turns.has(rawInput.clientCorrelationId) || runtime.restoredReceipts.has(rawInput.clientCorrelationId)) throw new HarnessExecutionError('CLAUDE_PROMPT_REPLAY_FORBIDDEN', 'This correlation was already offered; use read-only reconciliation.')
  const input = rawInput as ClaudeMessageTurnInput
  if (input.onSubmitted && !input.onMessageSubmitted) throw new HarnessExecutionError('CLAUDE_MESSAGE_RECEIPT_REQUIRED', 'Claude has native message receipts; this caller requires a native-turn receipt.')
  runtime.sdk.assertInputCapacity()
  const turn = createTurn(input)
  runtime.turns.set(turn.correlationId, turn)
  runtime.startingTurn = turn
  runtime.controlPending = true
  let offerStarted = false
  // Subscribe before offering. A returned iterable does not fabricate admission.
  const offer = async () => {
    if (ctx.options.messageSubmitted && await ctx.options.messageSubmitted(turn.correlationId)) {
      throw new ClaudeInputNotDeliveredError('This correlation was already submitted; use read-only reconciliation.')
    }
    if (!ctx.options.messageSubmitted && runtime.retiredTurns) {
      for (let offset = 0; ; offset += 256) {
        const rows = await ctx.options.runner.history({ ...ctx.options.scope, nativeSessionId: session.nativeSessionId },
          ctx.options.scope, signal, { offset, limit: 256 })
        if (rows.some(row => row && typeof row === 'object' && (row as { uuid?: string }).uuid === turn.promptUuid
          && (row as { type?: string }).type === 'user')) {
          throw new ClaudeInputNotDeliveredError('This correlation was already submitted; use read-only reconciliation.')
        }
        if (rows.length < 256) break
      }
    }
    runtime.controlPending = false
    if (input.sessionPreferences) await applyPreferences(ctx, runtime, input.sessionPreferences, signal)
    runtime.active = turn
    runtime.startingTurn = undefined
    if (input.sessionMode && runtime.sdk.setPermissionMode) {
      await runtime.sdk.setPermissionMode(input.sessionMode === 'plan' ? 'plan' : 'default')
    } else if (input.sessionMode === 'plan') {
      throw new HarnessExecutionError('CLAUDE_PLAN_UNAVAILABLE', 'The owned SDK query cannot enter Plan mode.')
    }
    await input.onSettingsApplied?.()
    offerStarted = true
    await runtime.sdk.offer({ promptUuid: turn.promptUuid, content: input.prompt }, signal)
  }
  void offer().catch((error: unknown) => {
    runtime.controlPending = false
    runtime.startingTurn = undefined
    const notOffered = !offerStarted || error instanceof ClaudeInputNotDeliveredError || error && typeof error === 'object'
      && 'deliveryState' in error && error.deliveryState === 'not-delivered'
    if (notOffered) {
      if (runtime.active === turn) delete runtime.active
      runtime.turns.delete(turn.correlationId)
      const rejection = Object.assign(new Error(error instanceof Error ? error.message : 'Claude input was not offered.',
        { cause: error }), { certainty: 'definite' as const, deliveryState: 'not-delivered' as const })
      turn.events.close(rejection)
    } else {
      turn.events.close(error)
      runtime.failure = error
    }
  })
  return subscribe(turn, signal)
}

export async function pending(ctx: ClaudeManagerContext, session: NativeSessionReference, signal?: AbortSignal): Promise<PendingNativeInteraction | undefined> {
  // The callback bridge remains owned while the idle query is replaced on resume.
  runtimeFor(ctx, session, { readOnly: true })
  return ctx.options.interactionPort?.pending(session, signal)
}

export async function respond(ctx: ClaudeManagerContext, session: NativeSessionReference, requestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
  runtimeFor(ctx, session)
  if (!ctx.options.qualification.interactions || !ctx.options.interactionPort) throw new HarnessExecutionError('CLAUDE_RESPONSE_UNQUALIFIED', 'No live qualified native callback is bound to this response.')
  return ctx.options.interactionPort.respond(session, requestId, option, signal)
}

/** Interrupts only the exact active turn, identified by its native message receipt. */
export async function cancel(ctx: ClaudeManagerContext, session: NativeSessionReference, signal?: AbortSignal, nativeMessageId?: string): Promise<boolean> {
  signal?.throwIfAborted()
  const runtime = runtimeFor(ctx, session)
  const turn = runtime.active
  if (runtime.closed || runtime.failure || !turn?.submitted || turn.terminal || !turn.nativeMessageId
    || nativeMessageId !== undefined && nativeMessageId !== turn.nativeMessageId) return false
  if (turn.cancelRequested) return true
  // Set before the await: the interrupted result can be pumped before interrupt() resolves.
  turn.cancelRequested = true
  try { await runtime.sdk.interrupt() } catch (error) { turn.cancelRequested = false; throw error }
  return true
}

export async function subagentHistory(ctx: ClaudeManagerContext, session: NativeSessionReference, cursor?: string, signal?: AbortSignal): Promise<NativeSubagentHistoryPage> {
  const runtime = runtimeFor(ctx, session)
  qualified(ctx, 'history')
  if (!ctx.options.runner.subagentHistory) throw new HarnessExecutionError('SUBAGENT_HISTORY_UNAVAILABLE', 'The exact SDK child history port is unavailable.')
  const page = childHistoryCursor(session.nativeSessionId, cursor)
  const history = await ctx.options.runner.subagentHistory({ ...ctx.options.scope, nativeSessionId: session.nativeSessionId }, ctx.options.scope,
    page.target === session.nativeSessionId ? undefined : page.target, page.offset ?? 0, signal)
  if (runtimeFor(ctx, session) !== runtime || runtime.closed || ctx.disposed) throw new HarnessExecutionError('SUBAGENT_HISTORY_OWNER_STALE', 'The exact SDK child history owner changed.')
  if (!history.agentId) return { events: [], nextCursor: null }
  const frames = history.messages.map(value => value && typeof value === 'object' ? value as Record<string, unknown> : {})
  const spawn = frames.find(frame => typeof frame.parent_tool_use_id === 'string')?.parent_tool_use_id
  const parentAgentId = frames.find(frame => typeof frame.parent_agent_id === 'string')?.parent_agent_id
  if (frames.some(frame => frame.session_id !== session.nativeSessionId)) throw new HarnessExecutionError('SUBAGENT_ANCESTRY_INVALID', 'SDK child transcript returned another root session.')
  // The native transcript proves the Agent/tool join; task and agent IDs are never equated.
  const task = typeof spawn === 'string' ? runtime.events.find(event => event.type === 'claude.task' && event.payload.taskType === 'local_agent' && event.payload.toolUseId === spawn) : undefined
  const discovery = childHistoryEvent('claude.subagent', { nativeSessionId: session.nativeSessionId, agentId: history.agentId, ancestry: 'verified',
    ...(typeof parentAgentId === 'string' ? { parentAgentId } : {}), ...(typeof spawn === 'string' ? { spawnToolUseId: spawn } : {}),
    ...(typeof task?.payload.taskId === 'string' ? { taskId: task.payload.taskId } : {}), status: 'unknown' })
  const decoded = createClaudeEventNormalizer({ owner: { ownerId: ctx.options.scope.deviceId, attemptId: session.nativeSessionId, generation: runtime.generation }, observedAt: ctx.now })
  const events = [discovery, ...frames.flatMap(frame => decoded.ingest(frame).filter(event => ['text', 'tool'].includes(event.change.kind))
    .map(event => { const native = claudeNativeEvent(event, 0); return childHistoryEvent(native.type, { ...native.payload, agentId: history.agentId, subagentNativeId: history.agentId }, native.occurredAt) }))]
  const next = history.agentIds.find(id => id > history.agentId!)
  return { events, nextCursor: history.hasMore ? encodeChildHistoryCursor({ root: page.root, target: history.agentId, cursor: null, offset: (page.offset ?? 0) + 50 })
    : next ? encodeChildHistoryCursor({ root: page.root, target: next, cursor: null, offset: 0 }) : null }
}

export async function history(ctx: ClaudeManagerContext, session: NativeSessionReference): Promise<NativeHistory> {
  const runtime = runtimeFor(ctx, session, { readOnly: true })
  return { events: [...runtime.events], pendingInteractions: [...(ctx.options.pendingInteractions?.(session) ?? [])], firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.nextSequence, nextSequence: runtime.nextSequence }
}

export async function retireTurn(ctx: ClaudeManagerContext, session: NativeSessionReference, correlationId: string): Promise<void> {
  const runtime = runtimeFor(ctx, session, { readOnly: true })
  const turn = runtime.turns.get(correlationId)
  if (!turn?.terminal || !turn.nativeMessageId) return
  if (runtime.active === turn) delete runtime.active
  turn.observing = false
  turn.events.close(undefined, true)
  runtime.turns.delete(correlationId)
  ctx.initialTurns.delete(correlationId)
  for (const owners of [runtime.messageOwners, runtime.toolOwners]) {
    for (const [id, owner] of owners) if (owner === turn) owners.delete(id)
  }
  if (runtime.restoredReceipts.size >= 256) runtime.restoredReceipts.delete(runtime.restoredReceipts.keys().next().value!)
  runtime.restoredReceipts.set(correlationId, { kind: 'message', nativeSessionId: session.nativeSessionId,
    nativeMessageId: turn.nativeMessageId, clientCorrelationId: correlationId })
  runtime.retiredTurns = true
}

export async function reconcile(ctx: ClaudeManagerContext, session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
  const runtime = runtimeFor(ctx, session, { readOnly: true })
  const turn = runtime.turns.get(correlationId)
  if (!turn && !runtime.restoredReceipts.has(correlationId) && ctx.options.qualification.history) {
    const expectedUuid = claudePromptUuid(correlationId)
    if (!runtime.historyScanOffsets.has(correlationId) && runtime.historyScanOffsets.size >= 256) {
      throw new HarnessExecutionError('CLAUDE_RECOVERY_WINDOW_EXHAUSTED', 'The native history recovery window is full.')
    }
    let accepted: boolean
    for (let offset = runtime.historyScanOffsets.get(correlationId) ?? 0; ; offset += 256) {
      signal?.throwIfAborted()
      const rows = await ctx.options.runner.history({ ...ctx.options.scope, nativeSessionId: session.nativeSessionId },
        ctx.options.scope, signal, { offset, limit: 256 })
      signal?.throwIfAborted()
      if (runtimeFor(ctx, session, { readOnly: true }) !== runtime || ctx.disposed) {
        throw new HarnessExecutionError('CLAUDE_SESSION_UNAVAILABLE',
          'The owned native history reader changed during reconciliation.')
      }
      accepted = rows.some((value) => {
        const frame = value && typeof value === 'object' ? value as Record<string, unknown> : {}
        return frame.type === 'user' && frame.uuid === expectedUuid && frame.session_id === session.nativeSessionId && frame.parent_tool_use_id == null
      })
      if (accepted || rows.length < 256) break
      // Interrupted reads resume after the last complete page, never report a partial scan as a miss.
      runtime.historyScanOffsets.set(correlationId, offset + 256)
    }
    if (accepted) {
      if (!runtime.restoredReceipts.has(correlationId) && runtime.restoredReceipts.size >= 256) {
        runtime.restoredReceipts.delete(runtime.restoredReceipts.keys().next().value!)
      }
      runtime.restoredReceipts.set(correlationId, { kind: 'message', nativeSessionId: session.nativeSessionId, nativeMessageId: expectedUuid, clientCorrelationId: correlationId })
    }
    runtime.historyScanOffsets.delete(correlationId)
  }
  const restored = runtime.restoredReceipts.get(correlationId)
  return {
    firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.nextSequence,
    nextSequence: runtime.nextSequence,
    ...(restored ? { correlationId, nativeSubmission: restored } : {}),
    events: runtime.events.filter(event => event.payload.clientCorrelationId === correlationId),
    pendingInteractions: (ctx.options.pendingInteractions?.(session) ?? []).filter(pending =>
      (pending.turn as typeof pending.turn & { nativeMessageId?: string }).nativeMessageId
        === (turn?.nativeMessageId ?? restored?.nativeMessageId)),
    ...(turn?.nativeMessageId ? { correlationId, nativeSubmission: { kind: 'message' as const,
      nativeSessionId: session.nativeSessionId, nativeMessageId: turn.nativeMessageId,
      clientCorrelationId: correlationId } } : {}),
    ...(turn?.assistantMessageId ? { nativeMessageId: turn.assistantMessageId } : {}),
    ...(turn?.terminal && turn.nativeMessageId ? { terminalResult: turn.terminal,
      terminalTurn: { correlationId, providerId: turn.nativeMessageId, result: turn.terminal } } : {}),
  }
}
