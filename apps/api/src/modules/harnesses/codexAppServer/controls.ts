/** Idle-session controls: preferences, compaction, native inspection and environment refresh. */
import { SessionPreferencesSchema, type SessionPreferences, type CompactionState, type ContextSnapshot,
  type SessionControlCapabilities, type NativeSessionReference } from '@foreman-code/contracts'
import { codexCollaborationMode, codexCompactionNotification } from '../codexSessionControls.js'
import type { NativeCompactInput, NativeSessionStart } from '../port.js'
import { createHash } from 'node:crypto'
import { HarnessExecutionError } from '../errors.js'
import { codexRequest } from '../codexProtocol.js'
import { CodexRpcError, object, type JsonObject } from '../codexStdioTransport.js'
import { advanced, threadParameters } from './support.js'
import { CodexManagerConnection } from './connection.js'

export abstract class CodexManagerControls extends CodexManagerConnection {
  async configureSessionPreferences(preferences: SessionPreferences) {
    if (this.runtimes.size) throw new HarnessExecutionError('CODEX_SETTINGS_BUSY', 'Startup settings require an idle new allocation.')
    this.startupPreferences = SessionPreferencesSchema.parse(preferences)
  }

  async applySessionPreferences(session: NativeSessionReference, preferences: SessionPreferences, signal?: AbortSignal) {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      const capabilities = await this.sessionControlCapabilities(session)
      if (preferences.contextBudget !== null && !capabilities.contextBudgets.includes(preferences.contextBudget)) {
        throw new HarnessExecutionError('CODEX_CONTEXT_BUDGET_INVALID', 'Choose a qualified native context budget.')
      }
      const start = { ...runtime.input, sessionPreferences: preferences }
      const prepared = await this.prepareIdleInput(runtime, start, signal)
      const response = object(await runtime.transport.request('thread/resume', {
        ...threadParameters(prepared, true), threadId: session.nativeSessionId, excludeTurns: true,
      }, signal), 'CODEX_THREAD_RESUME_INVALID')
      this.validateThreadResponse(prepared, response, session.nativeSessionId)
      runtime.input = start
      runtime.sessionPreferences = structuredClone(preferences)
      if (runtime.context) runtime.context = { ...runtime.context, stale: true }
    })
  }

  appliedSessionPreferences(session: NativeSessionReference): SessionPreferences | null {
    const runtime = this.requireRuntime(session)
    // Native thread startup/resume acknowledges configuration; usable context can include a provider reserve.
    return runtime.sessionPreferences ?? runtime.input.sessionPreferences ?? SessionPreferencesSchema.parse({})
  }

  async sessionControlCapabilities(session: NativeSessionReference): Promise<SessionControlCapabilities> {
    const runtime = this.requireRuntime(session)
    const supports = (method: string, params: JsonObject) => {
      try { runtime.qualified.protocol.request({ id: 0, method, params }); return true } catch { return false }
    }
    const plan = supports('turn/start', { threadId: session.nativeSessionId, input: [],
      collaborationMode: codexCollaborationMode('plan', runtime.configuration.model, runtime.configuration.reasoningEffort) })
    const compact = supports('thread/compact/start', { threadId: session.nativeSessionId })
    const supportedBudget = supports('thread/resume', { threadId: session.nativeSessionId, config: { model_context_window: 100000 } })
    const capacity = runtime.contextBudgetLimit
      ?? (runtime.input.sessionPreferences?.contextBudget == null ? runtime.context?.capacityTokens ?? null : null)
    if (capacity !== null && runtime.input.sessionPreferences?.contextBudget == null) runtime.contextBudgetLimit = capacity
    const budgets = supportedBudget && capacity !== null
      ? [...new Set([Math.floor(capacity / 2), capacity])].filter(value => value > 0) : []
    const contextBudgetReason = !supportedBudget ? 'This qualified app-server schema has no per-thread context override.'
      : capacity === null ? 'A native default context-window observation is required before choosing a budget.' : null
    const unsupported = { supported: false, reason: 'This installed profile has no automatic-compaction toggle.' }
    return { compact: { supported: compact, reason: compact ? null : 'Native compaction is unavailable in this schema.' },
      plan: { supported: plan, reason: plan ? null : 'Native Plan mode is unavailable in this schema.' },
      autoCompact: unsupported, autoCompactBudget: unsupported, contextBudgetReason, contextBudgets: budgets, contextProfiles: [],
      modelCapacity: capacity, model: runtime.configuration.model, profileKey: createHash('sha256').update(runtime.configurationIdentity).digest('hex') }
  }

  contextSnapshot(session: NativeSessionReference): ContextSnapshot | null {
    // A Worker can read retained history after its provider runtime closed; no live context remains then.
    const loaded = this.runtimes.get(session.nativeSessionId) ?? this.childRuntimes.get(session.nativeSessionId)?.runtime
    if (!loaded || loaded.disposed) return null
    return this.requireRuntime(session).context ?? null
  }

  async compactSession(session: NativeSessionReference, input: NativeCompactInput, signal?: AbortSignal): Promise<CompactionState> {
    return this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      if (runtime.input.kind === 'operator' && runtime.input.observationOnly) {
        throw new HarnessExecutionError('CODEX_OBSERVATION_ONLY', 'Refresh the scoped environment before compacting.')
      }
      this.assertIdle(runtime)
      if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconnect before compacting.')
      const before = await codexRequest(runtime.transport, 'thread/read', { threadId: session.nativeSessionId, includeTurns: true }, signal)
      runtime.compactionPreviousTurns = new Set(before.thread.turns.map(turn => turn.id))
      runtime.compaction = { requestId: input.requestId, nativeSessionId: session.nativeSessionId,
        baselineTurnId: before.thread.turns.at(-1)?.id ?? null,
        nativeOperationId: null, status: 'accepted', message: 'Compaction is starting.',
        beforeTokens: runtime.context?.usedTokens ?? null, observedAt: new Date().toISOString() }
      let dispatched = false
      try {
        await input.onProgress(runtime.compaction)
        await input.onDispatch?.()
        dispatched = true
        await runtime.transport.request('thread/compact/start', { threadId: session.nativeSessionId }, signal)
        await input.onProgress(runtime.compaction)
        const waitSignal = AbortSignal.any([this.shutdownController.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])])
        while (['accepted', 'running'].includes(runtime.compaction.status) && !runtime.closed) {
          await this.wait(runtime, waitSignal)
          await input.onProgress(runtime.compaction)
        }
        if (runtime.closed) runtime.compaction = { ...runtime.compaction, status: 'uncertain', message: 'Reconnect to recover compaction.' }
        this.record(runtime, 'session.compaction', { ...runtime.compaction })
        return runtime.compaction
      } catch (error) {
        const definite = !dispatched || error instanceof CodexRpcError && error.method === 'thread/compact/start' && !error.uncertain
        runtime.compaction = { ...runtime.compaction, status: definite ? 'failed' : 'uncertain',
          message: definite ? 'Codex rejected compaction.' : 'Native compaction is unconfirmed.' }
        throw error
      }
    })
  }

  async readCompaction(session: NativeSessionReference, start: NativeSessionStart,
    state: CompactionState, signal?: AbortSignal): Promise<CompactionState> {
    this.assertSessionVersion(session)
    if (state.nativeSessionId !== session.nativeSessionId) return state
    const prepared = await this.prepareInput(start, signal)
    const candidate = await this.transport(prepared, 0, signal)
    try {
      const result = await codexRequest(candidate.transport, 'thread/read', {
        threadId: session.nativeSessionId, includeTurns: true,
      }, signal)
      if (result.thread.id !== session.nativeSessionId) throw new Error('Codex read a different native thread')
      return this.compactionFromTurns(state, result.thread.turns)
    } finally { await candidate.transport.close() }
  }

  async reconcileCompaction(session: NativeSessionReference, state: CompactionState, signal?: AbortSignal): Promise<CompactionState> {
    const runtime = this.requireRuntime(session)
    if (runtime.compaction?.requestId === state.requestId) {
      state = runtime.compaction
      if (!['accepted', 'running', 'uncertain'].includes(state.status)) return state
    }
    if (state.nativeSessionId !== session.nativeSessionId) return state
    const result = await codexRequest(runtime.transport, 'thread/read', { threadId: session.nativeSessionId, includeTurns: true }, signal)
    if (result.thread.id !== session.nativeSessionId) throw new Error('Codex read a different native thread')
    const recovered = this.compactionFromTurns(state, result.thread.turns)
    runtime.compaction = recovered
    if (recovered.status === 'completed' && runtime.context) runtime.context = { ...runtime.context, stale: true }
    // History can settle compaction before its completion notification arrives.
    if (['completed', 'failed', 'no-op'].includes(recovered.status)) this.wake(runtime)
    return recovered
  }

  protected compactionFromTurns(state: CompactionState,
    turns: Array<{ id: string; status: string; items: Array<{ type: string }> }>): CompactionState {
    let turn = turns.find(entry => entry.id === state.nativeOperationId)
    if (!turn && state.baselineTurnId !== undefined) {
      const baseline = state.baselineTurnId === null ? -1
        : turns.findIndex(entry => entry.id === state.baselineTurnId)
      const matches = baseline < 0 && state.baselineTurnId !== null ? [] : turns.slice(baseline + 1)
        .filter(entry => entry.items.some(item => item.type === 'contextCompaction'))
      if (matches.length === 1) turn = matches[0]
    }
    if (!turn) return state
    return codexCompactionNotification({ ...state, nativeOperationId: turn.id }, 'turn/completed', {
      threadId: state.nativeSessionId, turn,
    })
  }

  async inspectConfiguration(session: NativeSessionReference, includeLayers = true, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return object(await runtime.transport.request('config/read', { includeLayers, cwd: runtime.workingDirectory }, signal), 'CODEX_CONFIG_READ_INVALID')
  }

  async inspectNativeMcp(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    const runtime = this.requireRuntime(session)
    return object(await runtime.transport.request('mcpServerStatus/list', { detail: 'toolsAndAuthOnly', threadId: session.nativeSessionId }, signal), 'CODEX_MCP_STATUS_INVALID')
  }

  async listNativeModels(session: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    return object(await this.requireRuntime(session).transport.request('model/list', { includeHidden: false }, signal), 'CODEX_MODEL_CATALOG_INVALID')
  }

  async reloadNativeMcp(session: NativeSessionReference, signal?: AbortSignal): Promise<void> {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reload requires a live native process.')
      const before = { generation: runtime.generation, transport: runtime.transport, closed: runtime.closed }
      // Revalidate policy/credentials before allowing a newly enabled MCP entry.
      const prepared = await this.prepareIdleInput(runtime, runtime.input, signal)
      this.assertIdleAfterDiagnostics(runtime, before, signal)
      if (prepared.scopedCredentialVariable !== runtime.scopedCredentialVariable) {
        throw new HarnessExecutionError('CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED', 'MCP credential requirements changed; refresh the process environment first.')
      }
      await runtime.transport.request('config/mcpServer/reload', undefined, signal)
    })
  }

  async refreshProcessEnvironment(
    session: NativeSessionReference,
    environment: NonNullable<NativeSessionStart['environment']>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      if (runtime.ownerId !== environment.agentId) throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The replacement environment belongs to another Agent.')
      this.assertIdle(runtime)
      const before = { generation: runtime.generation, transport: runtime.transport, closed: runtime.closed }
      const nextInput = { ...structuredClone(runtime.input), environment: structuredClone(environment) }
      if (nextInput.kind === 'operator') delete nextInput.observationOnly
      // Validate through separately owned diagnostics while the idle process remains usable.
      const prepared = await this.prepareIdleInput(runtime, nextInput, signal)
      this.assertIdleAfterDiagnostics(runtime, before, signal)
      if (advanced(runtime.configuration).sessionPersistence === 'ephemeral') {
        throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'Refreshing an ephemeral process would discard its native session.')
      }
      runtime.closed = true
      await runtime.transport.close()
      await this.restart(runtime, signal, prepared)
      this.record(runtime, 'transport.environment_refreshed', { agentId: runtime.ownerId })
    })
  }
}
