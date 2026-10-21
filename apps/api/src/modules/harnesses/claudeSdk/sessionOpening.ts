/** Session lifecycle: inspection runtime, open/resume, attachment rollover, fork, close and disposal. */
import { isWorkflowStart, sessionStartDirectory, sessionStartCorrelation } from '../sessionStart.js'
import { SessionPreferencesSchema, type NativeHarnessEvent, type NativeSessionReference } from '@foreman-code/contracts'
import { ClaudePreferenceError } from './sessionControls.js'
import { isDeepStrictEqual } from 'node:util'
import type { NativeSessionStart } from '../port.js'
import { HarnessExecutionError } from '../errors.js'
import { claudeMcpDetection } from './mcpInspection.js'
import { ClaudeInputNotDeliveredError } from './port.js'
import type { ClaudeInitialTurnInput, ClaudeNativeSessionManager, ClaudeManagerContext, Turn, Runtime } from './sessionTypes.js'
import { startupSignal, sameJson, queryOptions, qualified, canonicalStart, sessionContext, makeRuntime, createTurn,
  subscribe } from './sessionState.js'
import { ownedControl, deliverCredentials } from './sessionCredentials.js'
import { rejectCallbackWaiters } from './sessionCallbacks.js'
import { observed, pump } from './sessionPump.js'
import { inspectSettings, applyPreferences } from './sessionSettings.js'
import { assertConsultationSession, assertConsultationRebind } from '../consultationSession.js'
import { runtimeFor } from './sessionState.js'

export async function prepareRuntime(ctx: ClaudeManagerContext, start: NativeSessionStart, signal?: AbortSignal): Promise<Runtime> {
  signal?.throwIfAborted()
  if (ctx.disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
  const cwd = sessionStartDirectory(start)
  if (cwd !== ctx.options.scope.cwd) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'Inspection differs from the pinned working directory.')
  const nativeOptions = queryOptions(ctx, start)
  const identity = JSON.stringify(canonicalStart(start))
  if (ctx.prepared) {
    if (!sameJson(ctx.prepared.identity, identity)) throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT', 'The owned SDK query already has another immutable inspection context.')
    return ctx.prepared.opening
  }
  const runtime = makeRuntime(ctx, start)
  const startup = startupSignal(signal)
  const opening = (async () => {
    try {
      runtime.sdk = await ctx.options.runner.open({ scope: ctx.options.scope,
        options: nativeOptions,
        ...(startup.signal ? { signal: startup.signal } : {}), onObservation: (observation) => observed(ctx, runtime, observation),
        ...(ctx.options.cancelPendingRequests ? { cancelPendingRequests: () => { if (!runtime.replacingForResume) ctx.options.cancelPendingRequests!() } } : {}) })
      runtime.appliedPreferences = SessionPreferencesSchema.parse({})
      runtime.pumping = pump(ctx, runtime)
      if (!runtime.sdk.initializationResult) throw new HarnessExecutionError('CLAUDE_INIT_INSPECTION_UNAVAILABLE', 'The SDK initialization control result is unavailable.')
      await ownedControl(ctx, runtime, () => inspectSettings(ctx, runtime), signal)
      if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_INSPECTION_CLOSED', 'The inspected SDK query closed.')
      startup.release()
      return runtime
    } catch (error) {
      startup.release()
      runtime.rejectInit(error)
      runtime.closed = true
      delete runtime.httpCredentialAcknowledgement
      await runtime.sdk?.close()
      await runtime.pumping
      throw error
    }
  })()
  ctx.prepared = { identity, opening }
  return opening
}

export async function open(ctx: ClaudeManagerContext, start: NativeSessionStart, resume?: NativeSessionReference, signal?: AbortSignal, initial?: { turn: Turn; onSessionObserved(session: NativeSessionReference): Promise<void> }): Promise<NativeSessionReference> {
  if (ctx.disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
  qualified(ctx, resume ? 'resume' : 'basicTurns')
  const cwd = sessionStartDirectory(start)
  if (cwd !== ctx.options.scope.cwd) throw new HarnessExecutionError('CLAUDE_SCOPE_MISMATCH', 'Claude working directory differs from the pinned scope.')
  const nativeOptions = queryOptions(ctx, start)
  const identity = JSON.stringify(canonicalStart(start))
  const inspected = ctx.prepared
  if (inspected && !sameJson(inspected.identity, identity)) {
    const previous = JSON.parse(inspected.identity) as Record<string, unknown>
    const current = JSON.parse(identity) as Record<string, unknown>
    const changed = ['kind', 'correlationId', 'request', 'environment', 'nativeTurnId', 'instructionsDelivered']
      .filter(key => !isDeepStrictEqual(previous[key], current[key]))
    throw new HarnessExecutionError('CLAUDE_INSPECTION_CONTEXT_CONFLICT',
      `Input differs from the exact inspected owner/configuration/environment (${changed.join(', ')}).`)
  }
  const previous = inspected ? await inspected.opening : undefined
  if (previous?.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
  if (previous?.closed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned SDK query is closed.')
  if (resume && previous && (previous.session || previous.turns.size)) throw new HarnessExecutionError('CLAUDE_INSPECTION_ALREADY_STARTED', 'Resume cannot replace a query that already owns native input.')
  const retained = resume ? ctx.rolloverSources.get(resume.nativeSessionId) : undefined
  const credentialServers = resume ? previous?.credentialServers ?? retained?.credentialServers : undefined
  if (resume && previous) {
    // Session selection is immutable in the SDK. Retire only the unused
    // inspection query; it has no message callbacks to cancel in this owner.
    previous.replacingForResume = true
    previous.closed = true
    delete previous.httpCredentialAcknowledgement
    await previous.sdk.close()
    await previous.pumping
    ctx.all.delete(previous)
  }
  const runtime = !resume && previous ? previous : makeRuntime(ctx, start)
  if (retained) {
    runtime.replacingForResume = true
    runtime.turns = new Map(retained.turns)
    runtime.restoredReceipts = new Map(retained.restoredReceipts)
    runtime.historyScanOffsets = new Map(retained.historyScanOffsets)
    runtime.retiredTurns = retained.retiredTurns
    runtime.events = [...retained.events]
    runtime.nextSequence = retained.nextSequence
  }
  if (runtime.controlPending) throw new HarnessExecutionError('CLAUDE_INSPECTION_BUSY', 'Model input cannot be offered while an owned SDK control operation is pending.')
  if (runtime.closed || ctx.disposed) throw new HarnessExecutionError('CLAUDE_SESSION_CLOSED', 'The owned SDK query is closed.')
  if (initial) {
    runtime.onSessionObserved = initial.onSessionObserved
    runtime.turns.set(initial.turn.correlationId, initial.turn)
  }
  if (resume) runtime.session = structuredClone(resume)
  ctx.all.add(runtime)
  const startup = startupSignal(signal)
  let offerStarted = false
  try {
    if (!runtime.sdk) runtime.sdk = await ctx.options.runner.open({
      scope: ctx.options.scope, options: nativeOptions,
      ...(startup.signal ? { signal: startup.signal } : {}),
      ...(resume ? { resume: { ...ctx.options.scope, nativeSessionId: resume.nativeSessionId } } : {}),
      onObservation: (observation) => observed(ctx, runtime, observation),
      ...(ctx.options.cancelPendingRequests ? { cancelPendingRequests: () => { if (!runtime.replacingForResume) ctx.options.cancelPendingRequests!() } } : {}),
    })
    runtime.appliedPreferences ??= SessionPreferencesSchema.parse({})
    runtime.pumping ??= pump(ctx, runtime)
    if (resume) {
      if (!runtime.sdk.initializationResult) throw new HarnessExecutionError('CLAUDE_INIT_INSPECTION_UNAVAILABLE', 'The pinned SDK must acknowledge exact-session resume initialization.')
      await ownedControl(ctx, runtime, () => inspectSettings(ctx, runtime), signal)
      if (credentialServers) {
        const snapshot = await deliverCredentials(ctx, runtime, start, credentialServers, signal)
        const expected = ctx.expectedMcp
        const detection = claudeMcpDetection(snapshot, { ...expected,
          ...(snapshot.httpCredentialAcknowledgement ? { url: snapshot.httpCredentialAcknowledgement.endpoint } : {}) })
        if (detection.state !== 'connected' || detection.endpointMatches === false
          || snapshot.httpCredentialAcknowledgement && detection.credentialArrangement?.kind !== 'scoped_http_header') {
          throw new HarnessExecutionError('CLAUDE_RESUME_MCP_UNAVAILABLE', 'The resumed SDK query did not establish its scoped MCP connection before input.')
        }
      }
      if (inspected) ctx.prepared = { identity, opening: Promise.resolve(runtime) }
      if (ctx.resident.has(resume.nativeSessionId)) throw new Error('Claude native session is already leased to another runtime')
      ctx.resident.set(resume.nativeSessionId, runtime)
      runtime.resolveInit(runtime.session!)
    }
    if (!resume && !previous && runtime.sdk.initializationResult) await inspectSettings(ctx, runtime)
    if (runtime.failure) throw runtime.failure
    await applyPreferences(ctx, runtime, start.sessionPreferences ?? ctx.sessionPreferences ?? SessionPreferencesSchema.parse({}), signal)
    if (initial) {
      runtime.active = initial.turn
      if (initial.turn.input.sessionMode) {
        if (runtime.sdk.setPermissionMode) {
          await runtime.sdk.setPermissionMode(initial.turn.input.sessionMode === 'plan' ? 'plan' : 'default')
        } else if (initial.turn.input.sessionMode === 'plan') {
          throw new ClaudePreferenceError('CLAUDE_PLAN_UNAVAILABLE', 'The owned SDK mode control is unavailable.')
        }
        await initial.turn.input.onSettingsApplied?.()
      }
      offerStarted = true
      await runtime.sdk.offer({ promptUuid: initial.turn.promptUuid, content: initial.turn.input.prompt }, signal)
    }
    const timer = setTimeout(() => runtime.rejectInit(new HarnessExecutionError('CLAUDE_INIT_TIMEOUT', 'Claude initialization did not provide an exact native session.')), ctx.options.initializationTimeoutMs ?? 10_000)
    try {
      const session = await runtime.initialized
      if (retained) runtime.replacingForResume = false
      return session
    } finally {
      clearTimeout(timer)
      startup.release()
    }
  } catch (error) {
    startup.release()
    let failure = runtime.failure ?? error
    if (initial && (!offerStarted || error instanceof ClaudeInputNotDeliveredError)) {
      failure = Object.assign(failure instanceof Error ? failure : new Error('Claude input was not offered.'),
        { certainty: 'definite' as const, deliveryState: 'not-delivered' as const })
    }
    runtime.rejectInit(failure)
    await runtime.sdk?.close()
    await runtime.pumping
    if (runtime.session && ctx.resident.get(runtime.session.nativeSessionId) === runtime) ctx.resident.delete(runtime.session.nativeSessionId)
    ctx.all.delete(runtime)
    initial?.turn.events.close(failure)
    throw failure
  }
}

export async function createSession(manager: ClaudeNativeSessionManager, start: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
  if (isWorkflowStart(start) && start.sessionContinuation) {
    const { sessionContinuation, ...acceptedStart } = start
    return manager.attachSession(sessionContinuation.session, acceptedStart, signal)
  }
  throw new HarnessExecutionError('CLAUDE_INITIAL_TURN_REQUIRED', 'Claude reports a native session only after first input; use the admitted atomic initial-turn lifecycle.')
}

export function startInitialTurn(ctx: ClaudeManagerContext, start: NativeSessionStart, input: ClaudeInitialTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
  if (start.kind === 'workflow-consultation') throw new HarnessExecutionError('CONSULTATION_NATIVE_ATTACH_REQUIRED',
    'A consultation can only attach its persisted coordinator session.')
  signal?.throwIfAborted()
  qualified(ctx, 'basicTurns')
  if (ctx.disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
  if (start.correlationId && start.correlationId !== input.clientCorrelationId) throw new HarnessExecutionError('CLAUDE_INITIAL_CORRELATION_MISMATCH', 'Initial native input differs from the admitted session correlation.')
  if (input.onSubmitted && !input.onMessageSubmitted) throw new HarnessExecutionError('CLAUDE_MESSAGE_RECEIPT_REQUIRED', 'Initial Claude input requires a truthful native message receipt, not a native-turn alias.')
  const identity = JSON.stringify({ start: canonicalStart(start), prompt: input.prompt, correlationId: input.clientCorrelationId })
  const previous = ctx.initialTurns.get(input.clientCorrelationId)
  if (previous) {
    if (!sameJson(previous.identity, identity)) throw new HarnessExecutionError('CLAUDE_CREATION_IDENTITY_CONFLICT', 'The initial input belongs to another accepted scope.')
    return subscribe(previous.turn, signal)
  }
  if (ctx.initialTurns.size >= 128) throw new HarnessExecutionError('CLAUDE_CREATION_LIMIT', 'Resolve existing initial turn attempts before allocating more.')
  const turn = createTurn(input)
  const opening = open(ctx, start, undefined, signal, { turn, onSessionObserved: input.onSessionObserved })
  ctx.initialTurns.set(input.clientCorrelationId, { identity, turn, opening })
  void opening.catch((error: unknown) => turn.events.close(error)) // An uncertain initial offer is never another create/replay.
  return subscribe(turn, signal)
}

export async function attachSession(ctx: ClaudeManagerContext, manager: ClaudeNativeSessionManager, session: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
  assertConsultationSession(start, session)
  signal?.throwIfAborted()
  if (session.harness !== ctx.harness) throw new HarnessExecutionError('CLAUDE_SESSION_MISMATCH', 'Persisted Claude installation identity differs.')
  if (ctx.disposed) throw new HarnessExecutionError('CLAUDE_MANAGER_DISPOSED', 'Claude manager is disposed.')
  const existing = ctx.resident.get(session.nativeSessionId) ?? ctx.rolloverSources.get(session.nativeSessionId)
    ?? ctx.retired.get(session.nativeSessionId)
  if (!existing) return open(ctx, start, session, signal)
  if (!isDeepStrictEqual(sessionContext(existing.start), sessionContext(start))) {
    throw new HarnessExecutionError('CLAUDE_SESSION_CONTEXT_CONFLICT',
      'The resident Claude session has another accepted configuration or environment.')
  }
  const pending = ctx.rollovers.get(session.nativeSessionId)
  if (pending) return pending
  const rolloverSource = ctx.rolloverSources.get(session.nativeSessionId) === existing
  if (!rolloverSource && ctx.all.has(existing) && !existing.closed && !existing.failure) {
    try {
      existing.sdk.assertInputCapacity()
      return existing.session!
    } catch (error) {
      if (!(error instanceof ClaudeInputNotDeliveredError)) throw error
    }
  }
  if (existing.active || existing.controlPending) {
    throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'Finish the owned input or control before resuming this session.')
  }
  qualified(ctx, 'resume')
  if (existing.failure || !ctx.retired.has(session.nativeSessionId)) ctx.retired.set(session.nativeSessionId, existing)
  ctx.rolloverSources.set(session.nativeSessionId, existing)
  const rollover = (async () => {
    // Completed inputs have no live callbacks; keep the owner bridge usable on resume.
    existing.replacingForResume = true
    await manager.close(session)
    if (ctx.prepared && (await ctx.prepared.opening) === existing) ctx.prepared = undefined
    const resumed = await open(ctx, start, session, signal)
    ctx.rolloverSources.delete(session.nativeSessionId)
    ctx.retired.delete(session.nativeSessionId)
    return resumed
  })()
  ctx.rollovers.set(session.nativeSessionId, rollover)
  try {
    return await rollover
  } finally {
    ctx.rollovers.delete(session.nativeSessionId)
  }
}

export async function forkSession(ctx: ClaudeManagerContext, source: NativeSessionReference, start: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
  if (start.kind === 'workflow-consultation') throw new HarnessExecutionError('CONSULTATION_NATIVE_ATTACH_REQUIRED',
    'A consultation cannot fork its coordinator session.')
  qualified(ctx, 'fork')
  signal?.throwIfAborted()
  const cwd = sessionStartDirectory(start)
  if (cwd !== ctx.options.scope.cwd || source.harness !== ctx.harness) throw new HarnessExecutionError('CLAUDE_FORK_SCOPE_MISMATCH', 'Claude fork scope differs from the pinned source.')
  const key = sessionStartCorrelation(start)
  if (!key) throw new HarnessExecutionError('CLAUDE_CORRELATION_REQUIRED', 'Native fork requires its admitted correlation.')
  const identity = JSON.stringify({ source, start })
  const previous = ctx.forks.get(key)
  if (previous) {
    if (previous.identity !== identity) throw new HarnessExecutionError('CLAUDE_FORK_IDENTITY_CONFLICT', 'The fork request belongs to another exact native source.')
    return previous.promise
  }
  if (ctx.forks.size >= 128) throw new HarnessExecutionError('CLAUDE_FORK_LIMIT', 'Resolve existing Claude fork attempts before allocating more.')
  const promise = (async () => {
    const fork = await ctx.options.runner.fork({ ...ctx.options.scope, nativeSessionId: source.nativeSessionId }, ctx.options.scope, signal)
    return open(ctx, start, { harness: ctx.harness, providerVersion: ctx.options.qualification.cliVersion, nativeSessionId: fork.nativeSessionId }, signal)
  })()
  ctx.forks.set(key, { identity, promise })
  return promise
}

export async function close(ctx: ClaudeManagerContext, session: NativeSessionReference): Promise<void> {
  const runtime = ctx.resident.get(session.nativeSessionId)
  if (!runtime) return
  runtime.closed = true
  delete runtime.httpCredentialAcknowledgement
  if ([...ctx.resident.values()].every((entry) => entry.closed)) rejectCallbackWaiters(ctx)
  if (runtime.active) {
    runtime.active.observing = false
    runtime.active.events.close(undefined, true)
  }
  await runtime.sdk.close()
  await runtime.pumping
  ctx.resident.delete(session.nativeSessionId)
  ctx.all.delete(runtime)
}

export async function rebindApplicationAccess(ctx: ClaudeManagerContext, session: NativeSessionReference,
  start: NativeSessionStart, signal?: AbortSignal): Promise<void> {
  const runtime = runtimeFor(ctx, session)
  assertConsultationRebind(runtime.start, start, session)
  if (runtime.active || runtime.startingTurn || runtime.controlPending) throw new HarnessExecutionError(
    'CLAUDE_TURN_ACTIVE', 'Finish the exact current message before changing its application subject.')
  // The SDK owns the same saved session. Credential replacement uses its
  // explicit idle control and does not offer another model input.
  const servers = queryOptions(ctx, start).mcpServers as Record<string, unknown> | undefined
  if (servers) await deliverCredentials(ctx, runtime, start, servers, signal)
  else {
    throw new HarnessExecutionError('CLAUDE_MCP_CONTROL_UNAVAILABLE', 'The retained SDK query has no scoped MCP configuration.')
  }
  runtime.start = structuredClone(start)
}

export async function closeForResume(ctx: ClaudeManagerContext, session: NativeSessionReference): Promise<void> {
  const runtime = runtimeFor(ctx, session)
  if (runtime.active || runtime.startingTurn || runtime.controlPending) throw new HarnessExecutionError(
    'CLAUDE_TURN_ACTIVE', 'Finish the current message before closing its idle process.')
  await close(ctx, session)
}

export async function dispose(ctx: ClaudeManagerContext): Promise<void> {
  ctx.disposed = true
  rejectCallbackWaiters(ctx)
  for (const runtime of ctx.all) {
    runtime.closed = true
    delete runtime.httpCredentialAcknowledgement
    if (runtime.active) {
      runtime.active.observing = false
      runtime.active.events.close(undefined, true)
    }
  }
  await ctx.options.runner.dispose()
  await Promise.all([...ctx.all].map((runtime) => runtime.pumping))
  ctx.resident.clear()
  ctx.rolloverSources.clear()
  ctx.retired.clear()
  ctx.all.clear()
}
