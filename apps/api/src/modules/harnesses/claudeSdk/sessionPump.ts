/** Native SDK output pump: session observation, events, ownership and terminal results. */
import { closeOutput, failRuntime } from './sessionFailure.js'
import { claudeCompactionResultMatches } from './compactionResults.js'
import { claudeContextSnapshot } from './sessionControls.js'
import { HarnessExecutionError } from '../errors.js'
import type { ClaudeNativeObservation } from './port.js'
import type { ClaudeMessageSubmission, ClaudeManagerContext, Runtime, Turn } from './sessionTypes.js'
import { record, rememberOwner } from './sessionState.js'
import { resolveCallbackWaiters } from './sessionCallbacks.js'

export async function observed(ctx: ClaudeManagerContext, runtime: Runtime, observation: ClaudeNativeObservation) {
  for (const turn of runtime.turns.values()) {
    if (!observation.promptUuids.includes(turn.promptUuid)) continue
    if (observation.kind === 'reply') turn.replyObserved = true
    if (turn.submitted) continue
    await runtime.initialized // Native SID persistence precedes input ACK/file/callback publication.
    // Only a native echo establishes consumption of this client UUID as a native input message.
    const identity: ClaudeMessageSubmission = { kind: 'message', nativeSessionId: observation.nativeSessionId, nativeMessageId: turn.promptUuid, clientCorrelationId: turn.correlationId }
    await turn.input.onMessageSubmitted?.(identity)
    turn.submitted = true
    turn.nativeMessageId = turn.promptUuid
    await record(ctx, runtime, 'message.submitted', { nativeSessionId: observation.nativeSessionId, nativeMessageId: turn.promptUuid, clientCorrelationId: turn.correlationId,
      ...(observation.providerMessageId ? { source: { eventId: observation.providerMessageId } } : {}) }, turn)
  }
}

export async function pump(ctx: ClaudeManagerContext, runtime: Runtime): Promise<void> {
  try {
    for await (const output of runtime.sdk.output) {
      const frame = output.raw && typeof output.raw === 'object' ? output.raw as Record<string, unknown> : {}
      observeInitContract(ctx, runtime, frame)
      if (!runtime.session && frame.type === 'system' && frame.subtype === 'init' && typeof frame.session_id === 'string' && frame.session_id.length > 0) {
        runtime.session = { harness: ctx.harness, providerVersion: String(frame.claude_code_version), nativeSessionId: frame.session_id }
        if (ctx.resident.has(frame.session_id)) throw new Error('Claude native session is already leased to another runtime')
        ctx.resident.set(frame.session_id, runtime)
        await runtime.onSessionObserved?.(runtime.session)
        await record(ctx, runtime, 'session.idle', { nativeSessionId: frame.session_id })
        runtime.resolveInit(runtime.session)
      }
      observeContextSnapshot(ctx, runtime, frame)
      if (frame.type === 'system' && frame.subtype === 'compact_boundary' && runtime.session
        && frame.session_id === runtime.session.nativeSessionId) {
        const metadata = frame.compact_metadata as { pre_tokens?: number; trigger?: string } | undefined
        if (runtime.context) runtime.context = { ...runtime.context, stale: true }
        await record(ctx, runtime, 'session.compaction', { nativeSessionId: runtime.session.nativeSessionId,
          nativeOperationId: typeof frame.uuid === 'string' ? frame.uuid : null,
          trigger: metadata?.trigger ?? 'unknown', beforeTokens: metadata?.pre_tokens ?? null }, runtime.active)
        if (runtime.compaction && metadata?.trigger === 'manual') {
          runtime.compaction.boundary = true
          runtime.compaction.state = { ...runtime.compaction.state,
            nativeOperationId: typeof frame.uuid === 'string' ? frame.uuid : null,
            message: 'Compaction boundary observed. Waiting for the command result.',
            beforeTokens: metadata?.pre_tokens ?? null }
          await runtime.compaction.progress(runtime.compaction.state)
        }
      }
      observeResultCapacity(ctx, runtime, frame)
      if (await settleCompactionResult(runtime, frame)) continue
      if (isBackgroundWork(frame)) {
        await record(ctx, runtime, 'claude.background.unsupported', { nativeSessionId: frame.session_id,
          ...(typeof frame.task_id === 'string' ? { nativeTaskId: frame.task_id } : {}) })
        throw new HarnessExecutionError('CLAUDE_BACKGROUND_UNQUALIFIED', 'Native background work was observed despite the qualified disabled policy; parent results cannot settle this work.')
      }
      const active = runtime.active
      const matched = output.observation && [...runtime.turns.values()].find((turn) => output.observation!.promptUuids.includes(turn.promptUuid))
      const rootOwner = attributeRootOwner(runtime, frame, matched)
      const knownResult = typeof frame.is_error === 'boolean' && typeof frame.uuid === 'string' && frame.uuid.length > 0
        && ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'].includes(String(frame.subtype))
      const successfulResult = frame.subtype === 'success' && frame.is_error === false
      const command = matched?.input.prompt.match(/^\/([a-z]+)(?:\s|$)/u)?.[1]
      const localCommandResult = command !== undefined && frame.local_command === command
        && ctx.options.sdkOptions.verbatimPrompts !== true
      if (matched && frame.type === 'result' && successfulResult && !matched.replyObserved && !localCommandResult) {
        matched.resultBeforeReply = true
      }
      const terminalAdmissible = knownResult && matched?.submitted
        && (!successfulResult || localCommandResult || matched.replyObserved && !matched.resultBeforeReply)
      const decoded = runtime.decode?.(output.raw) ?? []
      if (frame.type === 'result' && !terminalAdmissible) {
        // Native consumption is a receipt, not proof that a queued wake's result answers this request.
        await record(ctx, runtime, 'claude.result.unattributed', { nativeSessionId: frame.session_id, nativeResult: output.raw }, matched)
      } else {
        for (const event of decoded) {
          const parentId = typeof event.payload.parentToolUseId === 'string' ? event.payload.parentToolUseId : undefined
          const toolId = typeof event.payload.toolUseId === 'string' ? event.payload.toolUseId : undefined
          const eventOwner = parentId ? runtime.toolOwners.get(parentId)
            : event.type === 'claude.task' ? toolId ? runtime.toolOwners.get(toolId) : undefined
              : rootOwner ?? (typeof event.payload.messageId === 'string' ? runtime.messageOwners.get(event.payload.messageId) : undefined)
                ?? (toolId && event.type === 'claude.tool' ? runtime.toolOwners.get(toolId) : undefined)
          if (eventOwner && toolId && event.type === 'claude.tool' && !parentId) {
            rememberOwner(runtime.toolOwners, toolId, eventOwner)
            resolveCallbackWaiters(ctx)
          }
          const payload = frame.type === 'result' && event.type === 'claude.result'
            ? { ...event.payload, nativeResult: output.raw } : event.payload
          await record(ctx, runtime, event.type, payload, frame.type === 'result' ? matched : eventOwner?.submitted ? eventOwner : undefined)
        }
      }
      if (matched && !matched.terminal && terminalAdmissible && frame.type === 'result') {
        matched.terminal = successfulResult
          ? { outcome: 'succeeded', output: typeof frame.result === 'string' ? frame.result : '' }
          : matched.cancelRequested ? { outcome: 'canceled' }
          : { outcome: 'failed', error: { code: 'CLAUDE_NATIVE_RESULT_ERROR', message: Array.isArray(frame.errors) ? frame.errors.join('\n') : 'Claude returned an error result.', retryable: false } }
        let persistenceFailure: { error: unknown } | undefined
        try {
          await matched.input.onTerminal?.({
            submission: { kind: 'message', nativeSessionId: runtime.session!.nativeSessionId,
              nativeMessageId: matched.nativeMessageId!, clientCorrelationId: matched.correlationId },
            result: matched.terminal,
            ...(matched.assistantMessageId ? { nativeMessageId: matched.assistantMessageId } : {}),
            history: {
              correlationId: matched.correlationId,
              nativeSubmission: { kind: 'message', nativeSessionId: runtime.session!.nativeSessionId,
                nativeMessageId: matched.nativeMessageId!, clientCorrelationId: matched.correlationId },
              ...(matched.assistantMessageId ? { nativeMessageId: matched.assistantMessageId } : {}),
              terminalResult: matched.terminal,
              terminalTurn: { correlationId: matched.correlationId, providerId: matched.nativeMessageId!,
                result: matched.terminal },
              events: runtime.events.filter(event => event.payload.clientCorrelationId === matched.correlationId),
              pendingInteractions: [...(ctx.options.pendingInteractions?.(runtime.session!) ?? [])],
              responseDeliveries: [...(await ctx.options.responseDeliveries?.(runtime.session!) ?? [])],
            },
          })
        } catch (error) {
          // Keep the result resident so the caller can retry saving it before native disposal.
          persistenceFailure = { error }
          matched.observing = false
        }
        await record(ctx, runtime, 'turn.completed', { nativeSessionId: frame.session_id, nativeMessageId: matched.nativeMessageId, clientCorrelationId: matched.correlationId, result: matched.terminal,
          ...(typeof frame.uuid === 'string' ? { source: { eventId: frame.uuid } } : {}) }, matched)
        matched.events.close(persistenceFailure?.error)
        matched.observing = false
        if (active === matched) delete runtime.active
      }
    }
    closeOutput(runtime, new Error('Claude output closed before compaction completed'),
      new Error('Claude stream ended without an exact result; submission remains uncertain'))
    if (!runtime.session && !runtime.replacingForResume) runtime.rejectInit(new Error('Claude stream ended before native initialization'))
  } catch (error) {
    await failRuntime(ctx, runtime, error)
  }
}

type Frame = Record<string, unknown>

function observeInitContract(ctx: ClaudeManagerContext, runtime: Runtime, frame: Frame): void {
  if (frame.type === 'system' && frame.subtype === 'init') {
    runtime.commands = Array.isArray(frame.slash_commands) ? frame.slash_commands.filter((value): value is string => typeof value === 'string') : []
    if (typeof frame.claude_code_version !== 'string' || !frame.claude_code_version || frame.cwd !== ctx.options.scope.cwd) {
      throw new HarnessExecutionError('CLAUDE_CONTRACT_UNSUPPORTED', `Claude Code ${String(frame.claude_code_version ?? ctx.options.qualification.cliVersion)} does not satisfy the init version/cwd contract.`)
    }
    runtime.nativeProviderVersion = frame.claude_code_version
  }
}

function observeContextSnapshot(ctx: ClaudeManagerContext, runtime: Runtime, frame: Frame): void {
  if (runtime.session) {
    const context = claudeContextSnapshot(frame, runtime.session.nativeSessionId,
      String(ctx.options.sdkOptions.model ?? ''), runtime.nextSequence)
    if (context) runtime.context = { ...context, generation: runtime.generation,
      capacityTokens: runtime.modelCapacity ?? null }
  }
}

function observeResultCapacity(ctx: ClaudeManagerContext, runtime: Runtime, frame: Frame): void {
  if (frame.type === 'result' && runtime.context && frame.session_id === runtime.session?.nativeSessionId) {
    const modelUsage = frame.modelUsage as Record<string, { contextWindow?: number; inputTokens?: number; outputTokens?: number }> | undefined
    const usage = modelUsage?.[String(ctx.options.sdkOptions.model ?? '')]
    if (usage?.contextWindow && usage.contextWindow > 0) runtime.context = { ...runtime.context,
      capacityTokens: usage.contextWindow }
  }
}

/** Settles a pending manual compaction from its command result; true when the frame was consumed. */
async function settleCompactionResult(runtime: Runtime, frame: Frame): Promise<boolean> {
  if (runtime.compaction && runtime.session
    && claudeCompactionResultMatches(frame, runtime.session.nativeSessionId, runtime.compaction.promptUuid)) {
    const control = runtime.compaction
    if (frame.is_error === true) control.state = { ...control.state, status: 'failed', message: 'Claude rejected compaction.' }
    else if (control.boundary) control.state = { ...control.state, status: 'completed', message: 'Context compacted.' }
    else control.state = { ...control.state,
      status: 'no-op', message: 'Claude completed the command without a compaction boundary.' }
    await control.progress(control.state)
    control.finish()
    return true
  }
  return false
}

function isBackgroundWork(frame: Frame): boolean {
  const patch = frame.patch && typeof frame.patch === 'object' ? frame.patch as Record<string, unknown> : {}
  return frame.type === 'system' && (frame.subtype === 'task_started' && frame.is_backgrounded === true
    || frame.subtype === 'task_updated' && patch.is_backgrounded === true
    || frame.subtype === 'background_tasks_changed' && Array.isArray(frame.tasks) && frame.tasks.length > 0)
    || frame.type === 'result' && (frame.deferred_tool_use != null || ['tool_deferred', 'background_requested'].includes(String(frame.terminal_reason)))
}

/** Remembers the observed root message owner and returns the turn that owns this root frame. */
function attributeRootOwner(runtime: Runtime, frame: Frame, matched: Turn | undefined): Turn | undefined {
  const message = frame.message && typeof frame.message === 'object' ? frame.message as Record<string, unknown> : {}
  const streamEvent = frame.event && typeof frame.event === 'object' ? frame.event as Record<string, unknown> : {}
  const streamMessage = streamEvent.message && typeof streamEvent.message === 'object' ? streamEvent.message as Record<string, unknown> : {}
  const messageId = typeof message.id === 'string' ? message.id : typeof streamMessage.id === 'string' ? streamMessage.id : undefined
  if (matched?.submitted && frame.parent_tool_use_id == null) {
    if (messageId) rememberOwner(runtime.messageOwners, messageId, matched)
    if (typeof frame.uuid === 'string') rememberOwner(runtime.messageOwners, frame.uuid, matched)
  }
  // Root follow-up blocks need the same observed message identity, never the latest active turn.
  const rootOwner = frame.parent_tool_use_id == null ? matched
    ?? (messageId ? runtime.messageOwners.get(messageId) : undefined)
    ?? (typeof frame.uuid === 'string' ? runtime.messageOwners.get(frame.uuid) : undefined) : undefined
  if (rootOwner?.submitted && !rootOwner.terminal && frame.type === 'assistant' && frame.parent_tool_use_id == null) {
    if (messageId) rootOwner.assistantMessageId = messageId
    else if (typeof frame.uuid === 'string') rootOwner.assistantMessageId = frame.uuid
  }
  return rootOwner
}
