/** Native settings inspection, session preferences and compaction. */
import { recoveredClaudeCompaction } from './compactionHistory.js'
import { z } from 'zod'
import { SessionPreferencesSchema, type CompactionState, type SessionPreferences, type NativeSessionReference,
  type SessionControlCapabilities } from '@foreman-code/contracts'
import { claudeSessionEnvironment, claudeContextProfiles, ClaudePreferenceError } from './sessionControls.js'
import { randomUUID } from 'node:crypto'
import { HarnessExecutionError } from '../errors.js'
import { ClaudeInputNotDeliveredError } from './port.js'
import type { NativeCompactInput } from '../port.js'
import { claudePromptUuid, type ClaudeManagerContext, type Runtime } from './sessionTypes.js'
import { startupSignal, queryOptions, runtimeFor } from './sessionState.js'
import { deliverCredentials } from './sessionCredentials.js'
import { observed, pump } from './sessionPump.js'

export async function inspectSettings(ctx: ClaudeManagerContext, runtime: Runtime) {
  const initialization = await runtime.sdk.initializationResult!()
  const models = z.object({ models: z.array(z.object({ value: z.string(),
    resolvedModel: z.string().optional(), displayName: z.string().optional() }).passthrough()).optional() }).passthrough().parse(initialization)
  runtime.models = models.models ?? []
  if (!runtime.sdk.getContextUsage) return
  const usage = z.object({ rawMaxTokens: z.number().positive(), maxTokens: z.number().positive(),
    totalTokens: z.number().nonnegative(), model: z.string(), isAutoCompactEnabled: z.boolean() })
    .passthrough().parse(await runtime.sdk.getContextUsage({ detail: 'summary' }))
  runtime.defaultModelCapacity ??= usage.rawMaxTokens
  runtime.modelCapacity = usage.rawMaxTokens
  runtime.selectedModel = usage.model
  if (runtime.session) runtime.context = { nativeSessionId: runtime.session.nativeSessionId,
    model: String(ctx.options.sdkOptions.model ?? ''), sequence: runtime.nextSequence, generation: runtime.generation,
    observedAt: ctx.now(), source: 'claude', accuracy: 'native', usedTokens: usage.totalTokens,
    capacityTokens: usage.rawMaxTokens, lifetimeTokens: null, cost: null, stale: false }
  if (runtime.appliedPreferences?.autoCompact === 'off' && usage.isAutoCompactEnabled
    || runtime.appliedPreferences?.autoCompact === 'on' && !usage.isAutoCompactEnabled) {
    throw new HarnessExecutionError('CLAUDE_SETTINGS_NOT_APPLIED', 'Native automatic compaction differs from the requested setting.')
  }
}

export async function applyPreferences(ctx: ClaudeManagerContext, runtime: Runtime, preferences: SessionPreferences, signal?: AbortSignal) {
  if (JSON.stringify(runtime.appliedPreferences) === JSON.stringify(preferences)) return
  if (runtime.active || runtime.controlPending || runtime.compaction
    || runtime.session && ctx.options.pendingInteractions?.(runtime.session).length) {
    throw new HarnessExecutionError('CLAUDE_SETTINGS_BUSY', 'Wait for the turn and its approvals before resuming settings.')
  }
  if (preferences.autoCompactTokens !== null && runtime.modelCapacity === undefined) {
    throw new ClaudePreferenceError('CLAUDE_MODEL_CAPACITY_UNKNOWN', 'Native model capacity could not be inspected.')
  }
  const profiles = claudeContextProfiles(runtime.models ?? [], String(ctx.options.sdkOptions.model ?? ''),
    runtime.defaultModelCapacity ?? null)
  const profile = profiles.find(entry => entry.id === preferences.contextProfile)
  if (preferences.contextProfile !== null && !profile) {
    throw new ClaudePreferenceError('CLAUDE_CONTEXT_PROFILE_INVALID', 'Choose a context profile offered by this model and account.')
  }
  const capacity = profile?.capacity ?? runtime.defaultModelCapacity
  if (preferences.autoCompactTokens !== null && capacity !== undefined && preferences.autoCompactTokens > capacity) {
    throw new ClaudePreferenceError('CLAUDE_BUDGET_TOO_LARGE', `The automatic budget exceeds this model’s ${capacity.toLocaleString()}-token context capacity.`)
  }
  runtime.controlPending = true
  runtime.replacingForResume = true
  const startup = startupSignal(signal)
  try {
    await runtime.sdk.close()
    await runtime.pumping
    runtime.closed = false
    delete runtime.failure
    runtime.generation = randomUUID()
    const start = runtime.start
    runtime.sdk = await ctx.options.runner.open({ scope: ctx.options.scope,
      options: { ...queryOptions(ctx, start, preferences), model: profile?.id ?? ctx.options.sdkOptions.model,
        ...(runtime.credentialServers ? { mcpServers: runtime.credentialServers } : {}) },
      ...(runtime.session ? { resume: { ...ctx.options.scope, nativeSessionId: runtime.session.nativeSessionId } } : {}),
      ...(startup.signal ? { signal: startup.signal } : {}), onObservation: observation => observed(ctx, runtime, observation),
      ...(ctx.options.cancelPendingRequests ? { cancelPendingRequests: () => {
        if (!runtime.replacingForResume) ctx.options.cancelPendingRequests!()
      } } : {}),
    })
    runtime.appliedPreferences = structuredClone(preferences)
    runtime.pumping = pump(ctx, runtime)
    await inspectSettings(ctx, runtime)
    if (profile) {
      const base = (model: string) => model.replace(/\[(?:1m|200k)\]$/, '')
      const selected = runtime.models?.find(model => model.value === profile.id)
      const family = base(selected?.resolvedModel ?? profile.id)
      const aliases = runtime.models?.filter(model => base(model.resolvedModel ?? model.value) === family)
        .flatMap(model => [model.value, model.resolvedModel ?? model.value, model.displayName ?? model.value]) ?? []
      const actualModel = runtime.selectedModel ? base(runtime.selectedModel) : undefined
      const matchesModel = actualModel !== undefined && aliases.some(alias => base(alias) === actualModel)
      if (runtime.modelCapacity !== profile.capacity || !matchesModel) {
        throw new HarnessExecutionError('CLAUDE_CONTEXT_PROFILE_NOT_APPLIED',
          'Native model or context capacity differs from the selected profile.')
      }
    }
    if (runtime.credentialServers) {
      runtime.controlPending = false
      await deliverCredentials(ctx, runtime, start, runtime.credentialServers, signal)
    }
    if (ctx.prepared) ctx.prepared = { identity: ctx.prepared.identity, opening: Promise.resolve(runtime) }
  } catch (error) {
    delete runtime.appliedPreferences
    throw error
  } finally {
    startup.release()
    runtime.replacingForResume = false
    runtime.controlPending = false
  }
}

export async function configureSessionPreferences(ctx: ClaudeManagerContext, preferences: SessionPreferences): Promise<void> {
  if ([...ctx.all].some(runtime => !runtime.closed)) throw new HarnessExecutionError('CLAUDE_SETTINGS_PENDING', 'These settings require a safe resume or a new session.')
  claudeSessionEnvironment({}, preferences)
  ctx.sessionPreferences = structuredClone(preferences)
}

export async function applySessionPreferences(ctx: ClaudeManagerContext, session: NativeSessionReference, preferences: SessionPreferences, signal?: AbortSignal): Promise<void> {
  const runtime = runtimeFor(ctx, session)
  if (runtime.startingTurn) throw new HarnessExecutionError('CLAUDE_SETTINGS_BUSY', 'A turn is starting.')
  await applyPreferences(ctx, runtime, SessionPreferencesSchema.parse(preferences), signal)
}

export async function sessionControlCapabilities(ctx: ClaudeManagerContext, session: NativeSessionReference): Promise<SessionControlCapabilities> {
  const runtime = runtimeFor(ctx, session)
  const compact = runtime.commands?.includes('compact') === true
  const plan = !!runtime.sdk.setPermissionMode
  return { compact: { supported: compact, reason: compact ? null : 'Native initialization did not advertise compact.' },
    plan: { supported: plan, reason: plan ? null : 'The owned SDK query has no Plan control.' },
    autoCompact: { supported: true, reason: null }, autoCompactBudget: { supported: runtime.modelCapacity !== undefined, reason: runtime.modelCapacity !== undefined ? null : 'Native model capacity is not known yet.' },
    contextBudgets: [], contextProfiles: claudeContextProfiles(runtime.models ?? [],
      String(ctx.options.sdkOptions.model ?? ''), runtime.defaultModelCapacity ?? null), modelCapacity: runtime.modelCapacity ?? null,
    nativeDefaultCapacity: runtime.defaultModelCapacity ?? null,
    model: String(ctx.options.sdkOptions.model ?? ''), profileKey: JSON.stringify(ctx.options.scope) }
}

export async function compactSession(ctx: ClaudeManagerContext, session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal): Promise<CompactionState> {
  const runtime = runtimeFor(ctx, session)
  if (runtime.active || runtime.startingTurn || runtime.controlPending || runtime.compaction
    || ctx.options.pendingInteractions?.(session).length) throw new HarnessExecutionError('CLAUDE_TURN_ACTIVE', 'Wait for the turn and its approvals to finish.')
  if (!runtime.commands?.includes('compact')) throw new HarnessExecutionError('CLAUDE_COMPACT_UNAVAILABLE', 'Native compact is unavailable.')
  const before = await ctx.options.runner.compactionHistory?.({ ...ctx.options.scope, nativeSessionId: session.nativeSessionId }, ctx.options.scope, undefined, signal)
  if (!before) throw new HarnessExecutionError('CLAUDE_COMPACTION_HISTORY_UNAVAILABLE', 'Native compaction requires its persisted session boundary reader.')
  runtime.controlPending = true
  let finish!: () => void
  let rejectCompletion!: (error: unknown) => void
  let completionFailure: { error: unknown } | undefined
  const completed = new Promise<void>((resolve, reject) => { finish = resolve; rejectCompletion = reject })
  // Persistence and SDK admission may still be pending when the output pump or cancellation rejects completion.
  void completed.catch(() => { /* ignore: the control lifetime below awaits and reports the original rejection. */ })
  const fail = (error: unknown): void => {
    completionFailure ??= { error }
    rejectCompletion(error)
  }
  let publication: Promise<void> = Promise.resolve()
  const progress: NativeCompactInput['onProgress'] = state => {
    const snapshot = structuredClone(state)
    const next = publication.then(() => input.onProgress(snapshot))
    publication = next
    void next.catch(fail)
    return next
  }
  const control: NonNullable<Runtime['compaction']> = {
    state: { requestId: input.requestId, nativeSessionId: session.nativeSessionId,
      nativeOperationId: null, nativeRequestId: claudePromptUuid(input.clientCorrelationId),
      claudeSession: { ...ctx.options.scope }, claudeCursor: before.cursor, status: 'running',
      message: 'Compacting context.', beforeTokens: runtime.context?.usedTokens ?? null, observedAt: ctx.now() },
    promptUuid: claudePromptUuid(input.clientCorrelationId), boundary: false, progress, finish, fail,
  }
  runtime.compaction = control
  const waitSignal = AbortSignal.any([AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
  const abort = () => fail(waitSignal.reason)
  waitSignal.addEventListener('abort', abort, { once: true })
  if (waitSignal.aborted) abort()
  let dispatched = false
  const assertPending = (): void => {
    if (!completionFailure) return
    const error = completionFailure.error
    if (!dispatched) {
      throw new ClaudeInputNotDeliveredError(error instanceof Error ? error.message : 'Compaction stopped before delivery.')
    }
    throw error
  }
  try {
    assertPending()
    await progress(control.state)
    assertPending()
    await input.onDispatch?.()
    assertPending()
    dispatched = true
    await runtime.sdk.offer({ promptUuid: control.promptUuid, content: '/compact' }, signal)
    assertPending()
    await progress(control.state)
    await completed
    await publication
    return control.state
  } catch (error) {
    // Join any pump-side save before the caller persists its failed or uncertain outcome.
    await publication.then(() => undefined, () => undefined)
    const definite = !dispatched || !!error && typeof error === 'object' && (
      'deliveryState' in error && error.deliveryState === 'not-delivered'
      || 'certainty' in error && error.certainty === 'definite')
    control.state = { ...control.state, status: definite ? 'failed' : 'uncertain',
      message: definite ? 'Claude rejected the command before delivery.' : 'Read to recover native compaction.' }
    throw error
  } finally {
    waitSignal.removeEventListener('abort', abort)
    if (control.state.status !== 'uncertain' && runtime.compaction === control) runtime.compaction = undefined
    runtime.controlPending = control.state.status === 'uncertain'
  }
}

export async function reconcileCompaction(ctx: ClaudeManagerContext, session: NativeSessionReference, state: CompactionState, signal?: AbortSignal): Promise<CompactionState> {
  const runtime = runtimeFor(ctx, session)
  const control = runtime.compaction?.state.requestId === state.requestId ? runtime.compaction : undefined
  let recovered = control?.state ?? state
  if (['accepted', 'running', 'uncertain'].includes(recovered.status)) {
    const persisted = { ...ctx.options.scope, nativeSessionId: session.nativeSessionId }
    const outcome = recovered.nativeRequestId && ctx.options.runner.compactionOutcome
      ? await ctx.options.runner.compactionOutcome(persisted, ctx.options.scope, recovered.nativeRequestId) : null
    if (outcome) recovered = { ...recovered, ...outcome,
      message: outcome.status === 'failed' ? 'Claude rejected compaction.' : 'Native compaction completed.' }
    else if (recovered.claudeCursor && ctx.options.runner.compactionHistory) {
      const history = await ctx.options.runner.compactionHistory(persisted, ctx.options.scope, recovered.claudeCursor, signal)
      recovered = recoveredClaudeCompaction(recovered, history.boundaries)
    }
  }
  if (!['accepted', 'running', 'uncertain'].includes(recovered.status)) {
    if (control) { control.state = recovered; control.finish() }
    runtime.compaction = undefined
    runtime.controlPending = false
    if (recovered.status === 'completed' && runtime.context) runtime.context = { ...runtime.context, stale: true }
  } else {
    runtime.controlPending = true
  }
  return recovered
}
