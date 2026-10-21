import { logIgnoredError } from '../../diagnostics/ignoredError.js'
/** Native callbacks and notifications: staging, translation, interactions and turn resources. */
import { codexCompactionNotification, codexContextSnapshot } from '../codexSessionControls.js'
import { createHash } from 'node:crypto'
import type { ExecutionResult } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import { CODEX_NATIVE_OUTPUT_TOOL_ALIASES } from '../codexNativeOutput.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { translateCodexInteraction } from '../codexInteractions.js'
import { normalizeCodexNotification } from '../codexNormalization.js'
import { isObject, text, type JsonObject, type RpcRequest } from '../codexStdioTransport.js'
import { CODEX_CAPACITY_ATTEMPTS, isCodexCapacityError } from '../codexCapacity.js'
import { codexTurnFailure } from '../codexTurnFailure.js'
import type { WaitingRequest, ResolvedRequest, StartingTurn, Runtime } from './types.js'
import { MAX_EVENTS, MAX_EVENT_BYTES, MAX_STAGED, MAX_INTERACTIONS, requestKey, itemNotificationKey,
  stagedNativeOutputTerminal } from './support.js'
import { CodexManagerPreparation } from './preparation.js'

export abstract class CodexManagerEvents extends CodexManagerPreparation {
  protected finishTurnResources(runtime: Runtime): Promise<void> {
    if (runtime.nativeOutput && !runtime.nativeOutputCleanup) {
      const attempt = runtime.nativeOutput.close()
      runtime.nativeOutputCleanup = attempt
      void attempt.catch(cleanupError => {
        logIgnoredError('harness', 'clean up Codex native output', cleanupError)
        if (runtime.nativeOutputCleanup === attempt) runtime.nativeOutputCleanup = undefined
      })
    }
    return Promise.all([this.finishFiles(runtime), runtime.nativeOutputCleanup]).then(() => undefined)
  }

  protected finishFiles(runtime: Runtime): Promise<void> {
    if (!runtime.files) return Promise.resolve()
    if (runtime.fileCleanup) return runtime.fileCleanup
    const attempt = runtime.files.close()
    runtime.fileCleanup = attempt
    void attempt.catch(cleanupError => {
      logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
      // Keep the bridge owned so close/dispose or the next admission can retry.
      if (runtime.fileCleanup === attempt) runtime.fileCleanup = undefined
      this.record(runtime, 'files.cleanup_failed', {})
    })
    return attempt
  }

  protected stage(runtime: Runtime, event: StartingTurn['staged'][number]): boolean {
    const starting = runtime.starting
    if (!starting) return false
    starting.stagedBytes += Buffer.byteLength(JSON.stringify(event))
    if (starting.staged.length >= MAX_STAGED || starting.stagedBytes > MAX_EVENT_BYTES) {
      runtime.phase = 'uncertain'
      throw new Error('The turn-start notification buffer exceeded its limit.')
    }
    starting.staged.push(event)
    return true
  }

  protected applyTurn(runtime: Runtime, turn: JsonObject): void {
    if (turn.id !== runtime.activeTurnId || !Array.isArray(turn.items)) return
    if (runtime.capacityRetry?.failure) return
    if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))) return
    for (const value of turn.items) {
      if (isObject(value) && text(value.id) && !['userMessage', 'agentMessage'].includes(String(value.type))) {
        const fingerprint = createHash('sha256').update(canonicalJsonNumericKeysFirstLegacy(['snapshot', turn.id, value])).digest('hex')
        if (!runtime.seenNotifications.has(fingerprint)) {
          runtime.seenNotifications.add(fingerprint)
          if (runtime.seenNotifications.size > MAX_EVENTS) runtime.seenNotifications.delete(runtime.seenNotifications.values().next().value!)
          this.record(runtime, 'item.snapshot', { threadId: runtime.session.nativeSessionId, turnId: turn.id, nativeTurnStatus: turn.status, item: value })
        }
      }
      if (!isObject(value) || value.type !== 'agentMessage' || typeof value.text !== 'string') continue
      if (turn.status !== 'inProgress' && text(value.id)) {
        const fingerprint = itemNotificationKey(runtime.generation, 'item/completed', turn.id, value.id, value.type)
        if (!runtime.seenNotifications.has(fingerprint)) {
          runtime.seenNotifications.add(fingerprint)
          this.record(runtime, 'item.completed', {
            threadId: runtime.session.nativeSessionId, turnId: turn.id, item: value,
          })
        }
      }
      runtime.lastAgentMessage = value.text
      runtime.lastAgentMessageId = text(value.id)
      if (value.phase === 'final_answer') {
        runtime.finalAnswer = value.text
        runtime.finalAnswerId = text(value.id)
      }
    }
    if (turn.status === 'inProgress') {
      if (!runtime.terminalResult) runtime.phase = 'active'
      return
    }
    const result: ExecutionResult = turn.status === 'completed'
      ? { outcome: 'succeeded', output: { text: runtime.finalAnswer ?? runtime.lastAgentMessage ?? '' } }
      : turn.status === 'interrupted' ? { outcome: 'canceled' }
        : codexTurnFailure(turn.error)
    const retry = runtime.capacityRetry
    runtime.terminalResult = result
    if (turn.status === 'failed' && retry?.canAdvanceIdentity && isCodexCapacityError(turn.error)
      && retry.attempt < CODEX_CAPACITY_ATTEMPTS && !retry.controller.signal.aborted) retry.failure = result
    runtime.phase = 'idle'
    void this.finishTurnResources(runtime).catch(cleanupError => {
      logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
      // Resources stay owned for the next admission or explicit close to retry.
    })
    for (const [key, waiting] of runtime.interactions) {
      if (waiting.pending.turn.nativeTurnId === turn.id) this.resolveInteraction(runtime, key, waiting, 'cleared')
    }
    this.wake(runtime)
  }

  protected async handleRequest(runtime: Runtime, request: RpcRequest, staged = false): Promise<void> {
    if (runtime.closed || runtime.disposed) return
    const params = request.params ?? {}
    const key = requestKey(runtime.generation, request.id)
    const root = runtime.parent ?? runtime
    const callbackOwner = root.callbackOwners.get(key)
    if (callbackOwner && callbackOwner !== params.threadId) {
      const owner = callbackOwner === root.session.nativeSessionId
        ? root : this.childRuntimes.get(callbackOwner)?.runtime
      const interaction = owner?.interactions.get(key)
      const file = owner?.fileRequests.get(key)
      if (interaction) interaction.conflictingIdentity = true
      if (file) file.conflictingIdentity = true
      this.record(root, 'protocol.conflicting_request_identity', { nativeRequestKey: key })
      return
    }
    if (!runtime.parent && params.threadId !== runtime.session.nativeSessionId) {
      const child = this.childRuntimes.get(String(params.threadId))
      if (child?.runtime.parent === runtime) {
        child.assertCurrent()
        await this.handleRequest(child.runtime, request, staged)
        return
      }
    }
    const signature = createHash('sha256').update(canonicalJsonNumericKeysFirstLegacy([request.method, params])).digest('hex')
    const existing = runtime.interactions.get(key)
    const resolved = runtime.resolvedRequests.get(key)
    const file = runtime.fileRequests.get(key)
    if (existing || resolved || file) {
      // All callbacks share one connection/generation/typed RPC-ID namespace.
      // Never reply to a conflicting envelope using the original callback's ID.
      if ((existing?.signature ?? resolved?.signature ?? file?.signature) !== signature) {
        if (existing) existing.conflictingIdentity = true
        if (file) file.conflictingIdentity = true
        this.record(runtime, 'protocol.conflicting_request_identity', { nativeRequestKey: key })
        return
      }
      // Equivalent file retries retain their existing receipt, never a second
      // concurrent writer. Consumed identities from earlier turns stay fenced.
      if (!file || file.conflictingIdentity || request.method !== 'item/tool/call') return
    }
    if (params.threadId !== runtime.session.nativeSessionId) {
      await runtime.transport.reject(request.id, -32602, 'This request belongs to another thread.'); return
    }
    root.callbackOwners.set(key, runtime.session.nativeSessionId)
    if (!staged && this.stage(runtime, { request })) return
    if (request.method === 'item/tool/call') {
      // Do not block the stdio frame reader on file I/O: turn/completed and
      // interrupt acknowledgements must be able to withdraw authority mid-call.
      void this.handleFileCall(runtime, request, typeof params.tool === 'string'
        && Object.hasOwn(CODEX_NATIVE_OUTPUT_TOOL_ALIASES, params.tool)).catch(error => {
          logIgnoredError('harness', 'deliver native file response', error)
        this.record(runtime, 'files.response_unconfirmed', {})
      })
      return
    }
    if (runtime.interactions.size >= MAX_INTERACTIONS) {
      await runtime.transport.reject(request.id, -32000, 'Native pending-interaction limit exceeded.'); return
    }
    const standalone = request.method === 'mcpServer/elicitation/request' && params.turnId == null
    if (!standalone && (!text(params.turnId) || params.turnId !== runtime.activeTurnId || runtime.terminalResult)) {
      await runtime.transport.reject(request.id, -32602, 'The request does not belong to the active turn.'); return
    }
    const translated = this.translateRequest(runtime, request, signature)
    if (!translated) {
      await runtime.transport.reject(request.id, -32601, 'This native approval request has no supported response mapping.')
      return
    }
    const retainedBytes = [...runtime.interactions.values()].reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry.pending)), 0)
    if (retainedBytes + Buffer.byteLength(JSON.stringify(translated.pending)) > MAX_EVENT_BYTES) {
      await runtime.transport.reject(request.id, -32000, 'Native pending-interaction memory limit exceeded.')
      this.record(runtime, 'interaction.capacity_exceeded', { nativeMethod: request.method })
      return
    }
    runtime.interactions.set(key, translated)
    let observedTurnStatus: string | null = runtime.activeTurnId ? 'inProgress' : null
    if (runtime.terminalResult?.outcome === 'succeeded') observedTurnStatus = 'completed'
    else if (runtime.terminalResult?.outcome === 'canceled') observedTurnStatus = 'interrupted'
    else if (runtime.terminalResult?.outcome === 'failed') observedTurnStatus = 'failed'
    this.record(runtime, 'interaction.pending', {
      nativeRequestId: translated.pending.turn.nativeRequestId, nativeRequestType: request.method,
      turnId: translated.pending.turn.nativeTurnId,
      observedTurnId: runtime.activeTurnId ?? null,
      observedTurnStatus,
    })
  }

  protected async handleFileCall(runtime: Runtime, request: RpcRequest, nativeOutputCall = false): Promise<void> {
    const params = request.params ?? {}
    const transport = runtime.transport
    const generation = runtime.generation
    const key = requestKey(generation, request.id)
    const signature = createHash('sha256').update(canonicalJsonNumericKeysFirstLegacy([request.method, params])).digest('hex')
    const prior = runtime.fileRequests.get(key)
    if (prior?.pending || prior?.conflictingIdentity) return
    if ([...runtime.resolvedRequests.values()].filter((entry) => entry.pending).length >= MAX_INTERACTIONS) {
      this.record(runtime, 'files.response_capacity_exceeded', { nativeRequestKey: key })
      // An untrackable live ID cannot be forgotten while this connection keeps
      // accepting callbacks. Fence it synchronously and retain failed cleanup.
      this.handleDisconnect(runtime)
      void runtime.transport.close().catch(cleanupError => {
        logIgnoredError('harness', 'close Codex transport', cleanupError)
        this.record(runtime, 'transport.close_unconfirmed', {})
      })
      return
    }
    const reservation: ResolvedRequest = { signature, nativeRequestId: undefined,
      nativeTurnId: text(params.turnId), method: request.method, generation, pending: true }
    // This connection-owned identity survives next-turn file-cache cleanup and
    // remains pinned until the entire file call and transport response settle.
    this.rememberResolvedRequest(runtime, key, reservation)
    const denied = { success: false, contentItems: [{ type: 'inputText', text: 'File operation unavailable or denied.' }] }
    const capacityExceeded = runtime.fileRequests.size >= MAX_INTERACTIONS && !prior
    const receipt: NonNullable<typeof prior> = prior ?? { signature, pending: true }
    receipt.pending = true
    if (!capacityExceeded) runtime.fileRequests.set(key, receipt)
    try {
      if (capacityExceeded || runtime.closed || runtime.disposed || runtime.terminalResult || params.turnId !== runtime.activeTurnId
        || (nativeOutputCall ? !runtime.nativeOutput : !runtime.files) || typeof params.callId !== 'string' || typeof params.tool !== 'string'
        || (params.namespace != null && typeof params.namespace !== 'string')) {
        await transport.respond(request.id, request.method, denied); return
      }
      const output = runtime.nativeOutput
      const outputTool = nativeOutputCall
      if (outputTool && params.namespace != null) { await transport.respond(request.id, request.method, denied); return }
      const assertCurrent = () => {
        if (!output || runtime.nativeOutput !== output || runtime.transport !== transport || runtime.generation !== generation
          || runtime.closed || runtime.disposed || runtime.terminalResult || runtime.activeTurnId !== params.turnId
          || runtime.fileRequests.get(key) !== receipt || receipt.conflictingIdentity || !receipt.pending
          || runtime.transport.isConnected?.() !== true || stagedNativeOutputTerminal(runtime, String(params.turnId))) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Original native output callback was withdrawn.')
      }
      const result = outputTool && output ? await output.dispatch(params.tool, params.arguments, {
        session: structuredClone(runtime.session), connectionId: runtime.connectionId, runtimeGeneration: generation,
        nativeTurnId: String(params.turnId), rpcId: request.id, callId: params.callId, assertCurrent,
      }) : runtime.files ? await runtime.files.dispatch({ threadId: runtime.session.nativeSessionId,
        turnId: String(params.turnId), callId: params.callId, tool: params.tool, arguments: params.arguments,
        ...(typeof params.namespace === 'string' ? { namespace: params.namespace } : {}),
      }) : denied
      if (outputTool) assertCurrent()
      if (runtime.transport === transport && runtime.generation === generation && !runtime.disposed && !runtime.closed
        && runtime.fileRequests.get(key) === receipt && !receipt.conflictingIdentity) {
        await transport.respond(request.id, request.method, { ...result })
      }
    } finally {
      receipt.pending = false
      reservation.pending = false
    }
  }

  protected translateRequest(runtime: Runtime, request: RpcRequest, signature: string): WaitingRequest | undefined {
    const translated = translateCodexInteraction({ session: runtime.session, configuration: runtime.configuration,
      connectionId: runtime.connectionId, generation: runtime.generation }, request)
    if (!translated) return undefined
    const { pending, responses } = translated
    let resolve!: WaitingRequest['resolve']
    const resolution = new Promise<'resolved' | 'cleared'>((complete) => { resolve = complete })
    return { pending, requestId: request.id, method: request.method, generation: runtime.generation, transport: runtime.transport,
      signature, responses, delivery: 'pending', resolution, resolve }
  }

  protected handleNotification(runtime: Runtime, method: string, params: JsonObject, staged = false, arrivalOrdinal = ++runtime.arrivalOrdinal): void {
    if (!runtime.parent && params.threadId !== runtime.session.nativeSessionId) {
      const child = this.childRuntimes.get(String(params.threadId))
      if (child?.runtime.parent === runtime) {
        try { child.assertCurrent() } catch (error) {
          logIgnoredError('harness', 'verify native child notification', error, {}, ['SUBAGENT_OWNER_STALE'])
          return
        }
        this.handleNotification(child.runtime, method, params, staged)
      }
    }
    const turnId = text(params.turnId) ?? text(isObject(params.turn) ? params.turn.id : undefined)
    if (turnId || method === 'serverRequest/resolved') {
      if (params.threadId === runtime.session.nativeSessionId && !staged && this.stage(runtime, { method, params, arrivalOrdinal })) return
    }
    if (method === 'thread/tokenUsage/updated') {
      const context = codexContextSnapshot(params, runtime.session.nativeSessionId, runtime.configuration.model, arrivalOrdinal)
      if (context) runtime.context = { ...context, generation: `${runtime.connectionId}:${runtime.generation}` }
    }
    if (runtime.compaction && ['accepted', 'running', 'uncertain'].includes(runtime.compaction.status)
      && params.threadId === runtime.session.nativeSessionId && ['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) {
      if (turnId && runtime.compactionPreviousTurns?.has(turnId)) return
      runtime.compaction = codexCompactionNotification(runtime.compaction, method, params)
      if (runtime.compaction.status === 'completed' && runtime.context) runtime.context = { ...runtime.context, stale: true }
      this.wake(runtime)
      return
    }
    if (method === 'protocol/malformed') { this.record(runtime, 'native.malformed', params); return }
    if (method === 'transport/reconnected') {
      delete runtime.observerUnavailable
      this.record(runtime, 'transport.reconnected', {})
      return
    }
    if (method === 'transport/observerUnavailable') {
      runtime.observerUnavailable = new HarnessExecutionError('CODEX_OBSERVER_UNAVAILABLE',
        'Codex is still recoverable, but its observer connection is unavailable.', true)
      this.record(runtime, 'transport.observer_unavailable', {})
      return
    }
    const normalized = normalizeCodexNotification({ threadId: runtime.session.nativeSessionId, ...(runtime.activeTurnId ? { turnId: runtime.activeTurnId } : {}),
      runtimeGeneration: runtime.generation, terminal: Boolean(runtime.terminalResult),
      knownCommandItem: (itemId) => !runtime.closed && !runtime.disposed && runtime.transport.isConnected?.() === true
        && runtime.seenNotifications.has(itemNotificationKey(runtime.generation, 'item/started', runtime.activeTurnId, itemId, 'commandExecution')) }, {
      providerVersion: runtime.session.providerVersion, schemaIdentity: runtime.schemaIdentity,
      connectionId: runtime.connectionId, runtimeGeneration: runtime.generation, arrivalOrdinal, method, params,
    })
    if (normalized.kind === 'ignored') return
    if (normalized.kind === 'unlinked') {
      this.record(runtime, 'native.unlinked_notification', { ...normalized.evidence })
      return
    }
    if (method === 'serverRequest/resolved') {
      if (typeof params.requestId !== 'string' && typeof params.requestId !== 'number') return
      const key = requestKey(runtime.generation, params.requestId)
      const waiting = runtime.interactions.get(key)
      if (waiting) this.resolveInteraction(runtime, key, waiting, 'resolved')
      return
    }
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = isObject(params.turn) ? params.turn : undefined
      if (!turn || !text(turn.id) || turn.id !== runtime.activeTurnId || runtime.terminalResult) return
      if (!Array.isArray(turn.items) || !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(turn.status))) return
      if (method === 'turn/completed' && turn.status === 'inProgress') return
      this.applyTurn(runtime, turn)
      this.record(runtime, method === 'turn/started' ? 'turn.started' : 'turn.completed', {
        threadId: params.threadId, turnId: turn.id, status: turn.status,
        ...(runtime.capacityRetry?.failure ? { willRetry: true } : {}),
      })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params.threadId !== runtime.session.nativeSessionId || params.turnId !== runtime.activeTurnId
        || runtime.terminalResult && !(normalized.kind === 'item' && normalized.knownAfterTerminal)) return
      const item = isObject(params.item) ? params.item : undefined
      if (!item || !text(item.id) || !text(item.type)) return
      const fingerprint = itemNotificationKey(runtime.generation, method, params.turnId, item.id, item.type)
      if (runtime.seenNotifications.has(fingerprint)) return
      runtime.seenNotifications.add(fingerprint)
      if (runtime.seenNotifications.size > MAX_EVENTS) runtime.seenNotifications.delete(runtime.seenNotifications.values().next().value!)
      if (method === 'item/completed' && item.type === 'agentMessage' && typeof item.text === 'string') {
        runtime.lastAgentMessage = item.text
        runtime.lastAgentMessageId = text(item.id)
        if (item.phase === 'final_answer') {
          runtime.finalAnswer = item.text
          runtime.finalAnswerId = text(item.id)
        }
      }
      this.record(runtime, method === 'item/started' ? 'item.started' : 'item.completed', params)
      return
    }
    // Streaming events with turn correlation obey the same identity gate.
    if (params.turnId !== undefined && (params.turnId !== runtime.activeTurnId || runtime.terminalResult)) return
    if (method === 'thread/started') {
      if (!isObject(params.thread) || params.thread.id !== runtime.session.nativeSessionId) return
      this.record(runtime, 'thread.started', { threadId: runtime.session.nativeSessionId })
    } else this.record(runtime, 'native.notification', { nativeMethod: method, ...params })
  }

  protected resolveInteraction(runtime: Runtime, key: string, waiting: WaitingRequest, result: 'resolved' | 'cleared'): void {
    if (runtime.interactions.get(key) !== waiting) return
    runtime.interactions.delete(key)
    this.rememberResolvedRequest(runtime, key, { signature: waiting.signature,
      nativeRequestId: waiting.pending.turn.nativeRequestId, nativeTurnId: waiting.pending.turn.nativeTurnId,
      method: waiting.method, generation: waiting.generation })
    waiting.resolve(result)
    // Native "resolved" means answered OR cleared, not proof of a permission grant.
    this.record(runtime, `interaction.${result}`, {
      nativeRequestId: waiting.pending.turn.nativeRequestId,
      ...(waiting.selectedOptionId ? { submittedOptionId: waiting.selectedOptionId } : {}),
      evidence: result === 'resolved' ? 'serverRequest/resolved' : 'terminal_turn',
    })
  }

  protected rememberResolvedRequest(runtime: Runtime, key: string, request: ResolvedRequest): void {
    runtime.resolvedRequests.set(key, request)
    if (runtime.resolvedRequests.size > MAX_EVENTS) {
      const expired = [...runtime.resolvedRequests].find(([, entry]) => !entry.pending)
      if (expired) runtime.resolvedRequests.delete(expired[0])
    }
  }

  protected handleDisconnect(runtime: Runtime): void {
    runtime.closed = true
    runtime.starting?.preparationController.abort()
    void this.finishTurnResources(runtime).catch(cleanupError => {
      logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
      // Resources stay owned for the next admission or explicit close to retry.
    })
    if (runtime.phase === 'starting' || runtime.phase === 'active') runtime.phase = 'uncertain'
    for (const waiting of runtime.interactions.values()) waiting.delivery = 'uncertain'
    this.record(runtime, 'transport.disconnected', { unresolvedInteractions: runtime.interactions.size })
  }
}
