import { logIgnoredError } from '../../diagnostics/ignoredError.js'
/** Native transport ownership, process restart, turn admission and native turn reconciliation. */
import { isWorkflowStart } from '../sessionStart.js'
import { chatExcludedAppMcpServerNames } from '../appMcpLauncher.js'
import type { ExecutionResult } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import { CodexRuntimeNativeOutputTurn } from '../codexNativeOutput.js'
import { codexRequest } from '../codexProtocol.js'
import { CodexRpcError, isObject, object, text, type JsonObject, type RpcRequest } from '../codexStdioTransport.js'
import type { CodexTransport, StartingTurn, Runtime, Prepared } from './types.js'
import { MAX_EVENT_BYTES, MAX_STAGED, INTERRUPT_STARTUP_RETRIES, INTERRUPT_STARTUP_RETRY_MS, advanced,
  threadParameters, stagedNativeOutputTerminal, listCodexTurns } from './support.js'
import { CodexManagerEvents } from './events.js'

export abstract class CodexManagerConnection extends CodexManagerEvents {
  protected async transport(prepared: Prepared, generation: number, signal?: AbortSignal): Promise<{
    transport: CodexTransport
    activate(runtime: Runtime): Promise<void>
  }> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    signal.throwIfAborted()
    let runtime: Runtime | undefined
    let disconnected = false
    let activating = false
    let bufferedBytes = 0
    const buffered: Array<{ request: RpcRequest } | { method: string; params: JsonObject }> = []
    const enqueue = (event: typeof buffered[number]) => {
      bufferedBytes += Buffer.byteLength(JSON.stringify(event))
      if (buffered.length >= MAX_STAGED || bufferedBytes > MAX_EVENT_BYTES) throw new Error('Provider initialization buffer exceeded its limit.')
      buffered.push(event)
    }
    await this.dependencies.assertUnchanged(prepared.qualified)
    signal.throwIfAborted()
    const transport = this.dependencies.transport(
      prepared.qualified.binary, prepared.workingDirectory, prepared.environment, prepared.qualified.protocol,
      async (request) => {
        if (!runtime || activating) { enqueue({ request }); return }
        if (runtime.generation === generation && runtime.transport === transport && !runtime.disposed) await this.handleRequest(runtime, request)
      },
      (method, params) => {
        if (!runtime || activating) { enqueue({ method, params }); return }
        if (runtime.generation === generation && runtime.transport === transport && !runtime.disposed) this.handleNotification(runtime, method, params)
      },
      () => {
        disconnected = true
        if (runtime?.generation === generation && runtime.transport === transport && !runtime.disposed) this.handleDisconnect(runtime)
      },
      undefined, this.processRecovery, prepared.disabledMcpServerNames, undefined,
      { nativeApps: prepared.nativeApps, mcpTransportOverrides: prepared.mcpTransportOverrides ?? {},
        reconnectableStdio: isWorkflowStart(prepared.input)
        && advanced(prepared.harnessConfiguration).sessionPersistence !== 'ephemeral' },
    )
    // Also own cold-attachment candidates before a Runtime has been published.
    this.ownTransport(transport)
    try {
      await transport.start(signal)
      if (this.appMcpAccess === 'none' || prepared.input.kind === 'operator' && prepared.input.observationOnly) {
        // Read the launched process, not the unmodified on-disk CLI configuration.
        const response = object(await transport.request('config/read', { includeLayers: false, cwd: prepared.workingDirectory }, signal))
        const config = object(response.config, 'CODEX_APP_MCP_UNAVAILABLE')
        const servers = config.mcp_servers === undefined ? {} : object(config.mcp_servers, 'CODEX_APP_MCP_UNAVAILABLE')
        if (chatExcludedAppMcpServerNames(this.appMcpServerName).some((name) => {
          const entry = servers[name]
          return prepared.disabledMcpServerNames.includes(name)
            ? !Object.hasOwn(servers, name) || !isObject(entry) || entry.enabled !== false
            : Object.hasOwn(servers, name)
        })) {
          throw new HarnessExecutionError('CODEX_APP_MCP_UNAVAILABLE', 'Foreman Code workflow tools are not available in chat; native launch did not confirm the App MCP entry was disabled.')
        }
      }
    } catch (error) {
      await transport.close()
      throw error
    }
    return {
      transport,
      activate: async (value) => {
        if (disconnected) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The candidate provider disconnected before attachment completed.')
        runtime = value
        activating = true
        try {
          while (buffered.length > 0) {
            const event = buffered.shift()!
            if ('request' in event) await this.handleRequest(runtime, event.request)
            else this.handleNotification(runtime, event.method, event.params)
          }
        } finally { activating = false; bufferedBytes = 0 }
      },
    }
  }

  protected async restart(runtime: Runtime, signal?: AbortSignal, supplied?: Prepared): Promise<void> {
    if (runtime.closed && runtime.transport.reattached?.()
      && runtime.transport.originalProcessClosed?.() !== true) {
      throw new HarnessExecutionError('CODEX_OBSERVER_UNAVAILABLE',
        'The original Codex daemon has not been confirmed closed; reconnect its observer before resuming.', true)
    }
    if (advanced(runtime.configuration).sessionPersistence === 'ephemeral') {
      throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'An ephemeral native session cannot survive a process restart.')
    }
    const prepared = supplied ?? await this.prepareInput(runtime.input, signal)
    this.assertBinding(runtime, prepared.input)
    const generation = runtime.generation + 1
    // Withdraw the old turn's file authority before replacing its process.
    runtime.starting?.preparationController.abort()
    await Promise.allSettled([runtime.starting?.filePreparation, runtime.starting?.nativeOutputPreparation])
    await this.finishTurnResources(runtime)
    // The old transport remains owned until its entire process tree is stopped.
    await runtime.transport.close()
    const candidate = await this.transport(prepared, generation, signal)
    try {
      const response = object(await candidate.transport.request('thread/resume', {
        ...threadParameters(prepared, Boolean(this.chatFiles)), threadId: runtime.session.nativeSessionId, excludeTurns: true,
      }, signal), 'CODEX_THREAD_RESUME_INVALID')
      this.validateThreadResponse(prepared, response, runtime.session.nativeSessionId)
      runtime.transport = candidate.transport
      runtime.generation = generation
      runtime.input = prepared.input
      runtime.scopedCredentialVariable = prepared.scopedCredentialVariable
      runtime.approvedAppMcpServerName = prepared.approvedAppMcpServerName
      runtime.strippedCredentialVariable = prepared.strippedCredentialVariable
      runtime.qualified = { ...prepared.qualified }
      runtime.effectiveSandbox = prepared.effectiveSandbox ? structuredClone(prepared.effectiveSandbox) : undefined
      runtime.closed = false
      delete runtime.observerUnavailable
      for (const waiting of runtime.interactions.values()) waiting.delivery = 'uncertain'
      await candidate.activate(runtime)
    } catch (error) {
      runtime.closed = true
      await candidate.transport.close().catch(cleanupError => {
        logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
        // ignore: preserve the resume failure; shutdown retries the owned transport.
      })
      throw error
    }
  }

  protected rejectStartedTurn(runtime: Runtime, starting: StartingTurn): void {
    if (runtime.starting !== starting || starting.acknowledgedTurnId || runtime.activeTurnId) return
    const result: ExecutionResult = { outcome: 'failed', error: {
      code: 'CODEX_TURN_START_REJECTED', message: 'Codex rejected this message before starting a turn.', retryable: true,
    } }
    runtime.rejectedStarts.set(starting.correlationId, result)
    if (starting.nativeAttemptId) {
      this.responseJournal?.recordTurnRejection(runtime.session, starting.correlationId, starting.nativeAttemptId, result)
    }
    this.restoreRejectedStart(runtime, starting)
  }

  protected restoreRejectedStart(runtime: Runtime, starting: StartingTurn): void {
    if (runtime.starting !== starting) return
    if (starting.acknowledgedTurnId || runtime.activeTurnId) return
    Object.assign(runtime, starting.previous)
    runtime.phase = 'idle'
    runtime.starting = undefined
    starting.resolveIdentity(undefined)
    starting.staged.length = 0
    void this.finishTurnResources(runtime).catch(cleanupError => {
      logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
      // Resources stay owned for the next admission or explicit close to retry.
    })
    this.record(runtime, 'turn.start_rejected', { correlationId: starting.correlationId })
  }

  protected acceptStartedTurn(runtime: Runtime, starting: StartingTurn, value: unknown): Promise<void> {
    if (runtime.disposed || runtime.starting !== starting) return Promise.resolve()
    const turn = object(object(value, 'CODEX_TURN_START_INVALID').turn, 'CODEX_TURN_START_INVALID')
    const turnId = text(turn.id)
    if (!turnId || turnId.length > 1_024 || turnId === starting.previous.activeTurnId
      || (starting.acknowledgedTurnId && starting.acknowledgedTurnId !== turnId)) {
      runtime.phase = 'uncertain'
      return Promise.reject(new HarnessExecutionError('CODEX_TURN_START_INVALID', 'Codex did not establish a new turn identity.'))
    }
    if (starting.acknowledgement) return starting.acknowledgement
    starting.acknowledgedTurnId = turnId
    const acknowledgement = (async () => {
      let admitted = false
      runtime.activeTurnId = turnId
      runtime.activeCorrelationId = starting.correlationId
      starting.resolveIdentity(turnId)
      try {
        // Durable identity FIRST. Early callbacks remain staged across both
        // persistence and token issuance, including a late-ACK recovery path.
        await starting.onSubmitted?.(turnId)
        if (runtime.disposed || runtime.closed) { await this.finishTurnResources(runtime); return }
        if (runtime.files && !runtime.files.closed && !starting.cancelRequested && turn.status === 'inProgress') {
          await runtime.files.activate(turnId)
        } else await this.finishFiles(runtime)
        if (runtime.nativeOutput && !starting.cancelRequested && turn.status === 'inProgress') {
          const output = runtime.nativeOutput, transport = runtime.transport, generation = runtime.generation
          await output.activate({ session: structuredClone(runtime.session), connectionId: runtime.connectionId,
            runtimeGeneration: generation, nativeTurnId: turnId, assertCurrent: () => {
              if (runtime.nativeOutput !== output || runtime.transport !== transport || runtime.generation !== generation
                || runtime.closed || runtime.disposed || runtime.terminalResult || starting.cancelRequested
                || runtime.activeTurnId !== turnId || stagedNativeOutputTerminal(runtime, turnId)) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Original native output turn was withdrawn.')
            } }, starting.preparationController.signal)
        } else if (runtime.nativeOutput) await this.finishTurnResources(runtime)
        runtime.phase = 'active'
        this.record(runtime, 'turn.started', { threadId: runtime.session.nativeSessionId, turnId, clientCorrelationId: starting.correlationId })
        this.applyTurn(runtime, { ...turn, status: 'inProgress' })
        admitted = true
      } catch (error) {
        runtime.phase = 'uncertain'
        delete starting.acknowledgement
        await this.finishTurnResources(runtime)
        throw error
      } finally {
        // Keep the gate closed while draining: callbacks arriving during an
        // awaited file operation must not overtake earlier staged callbacks.
        try {
          while (admitted && !runtime.disposed && starting.staged.length > 0) {
            const event = starting.staged.shift()!
            if ('request' in event) await this.handleRequest(runtime, event.request, true)
            else this.handleNotification(runtime, event.method, event.params, true, event.arrivalOrdinal)
          }
        } finally {
          if (admitted) {
            starting.staged.length = 0
            if (runtime.starting === starting) runtime.starting = undefined
          }
        }
      }
      if (admitted && !runtime.disposed && turn.status !== 'inProgress') this.applyTurn(runtime, turn)
      if (starting.cancelRequested && !runtime.terminalResult) await this.interrupt(runtime)
    })()
    starting.acknowledgement = acknowledgement
    return acknowledgement
  }

  protected async restoreNativeOutputTurn(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    if (!this.nativeOutputs || !runtime.activeTurnId || runtime.terminalResult) return
    const correlationId = runtime.activeCorrelationId
    if (!correlationId || !runtime.effectiveSandbox) throw new HarnessExecutionError(
      'CODEX_NATIVE_OUTPUT_ADMISSION_REQUIRED', 'Recovered native output requires the original turn and sandbox.')
    const activeSignal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    const bridge = await this.nativeOutputs.prepare({
      ...this.nativeOutputQualification(runtime.configuration, runtime.qualified,
        runtime.workingDirectory, runtime.effectiveSandbox.tmpdir),
      effectiveSandbox: structuredClone(runtime.effectiveSandbox), session: structuredClone(runtime.session),
      clientCorrelationId: correlationId, connectionId: runtime.connectionId, runtimeGeneration: runtime.generation,
    }, activeSignal)
    const output = new CodexRuntimeNativeOutputTurn(bridge)
    runtime.nativeOutput = output
    const turnId = runtime.activeTurnId
    await output.activate({ session: structuredClone(runtime.session), connectionId: runtime.connectionId,
      runtimeGeneration: runtime.generation, nativeTurnId: turnId, assertCurrent: () => {
        if (runtime.nativeOutput !== output || runtime.closed || runtime.disposed || runtime.terminalResult
          || runtime.activeTurnId !== turnId) throw new HarnessExecutionError(
          'CODEX_NATIVE_OUTPUT_CLOSED', 'The recovered native output turn was withdrawn.')
      } }, activeSignal)
  }

  protected interrupt(runtime: Runtime): Promise<boolean> {
    const turnId = runtime.activeTurnId
    if (!turnId || runtime.terminalResult) return Promise.resolve(false)
    if (runtime.starting) { runtime.starting.cancelRequested = true; runtime.starting.preparationController.abort() }
    // Cancellation withdraws file authority even when native interrupt delivery is uncertain.
    void this.finishTurnResources(runtime).catch(cleanupError => {
      logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
      // Resources stay owned for the next admission or explicit close to retry.
    })
    if (runtime.cancellation?.turnId === turnId) return runtime.cancellation.promise
    const promise = (async () => {
      for (let attempt = 0; attempt <= INTERRUPT_STARTUP_RETRIES; attempt += 1) {
        if (runtime.terminalResult) return false
        try {
          await codexRequest(runtime.transport, 'turn/interrupt', { threadId: runtime.session.nativeSessionId, turnId })
          this.record(runtime, 'turn.cancel_submitted', { turnId })
          return true
        } catch (error) {
          const startupRace = error instanceof CodexRpcError
            && !error.uncertain
            && error.nativeMessage?.startsWith('no active turn to interrupt')
          if (!startupRace || attempt === INTERRUPT_STARTUP_RETRIES) throw error
          await new Promise((resolve) => this.dependencies.schedule(resolve, INTERRUPT_STARTUP_RETRY_MS))
        }
      }
      return false
    })()
    runtime.cancellation = { turnId, promise }
    void promise.catch(() => {
      if (runtime.cancellation?.promise === promise) runtime.cancellation = undefined
    })
    return promise
  }

  protected async synchronize(runtime: Runtime, correlationId?: string, signal?: AbortSignal): Promise<void> {
    const transport = runtime.transport
    const generation = runtime.generation
    const registered = this.runtimes.get(runtime.session.nativeSessionId)
    const starting = runtime.starting
    if (starting && correlationId !== starting.correlationId) {
      throw new HarnessExecutionError('CODEX_CORRELATION_MISMATCH', 'Reconcile the correlation of the uncertain turn/start operation.')
    }
    const rejectedDuringRead = () => {
      if (this.runtimes.get(runtime.session.nativeSessionId) !== registered || runtime.transport !== transport
        || runtime.generation !== generation || runtime.closed || runtime.disposed) {
        throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The native history owner changed during reconciliation.')
      }
      // A definite rejection can restore idle while an older native read is in flight.
      return starting !== undefined && !starting.acknowledgedTurnId && runtime.starting === undefined
        && runtime.phase === 'idle' && runtime.activeTurnId === starting.previous.activeTurnId
        && runtime.activeCorrelationId === starting.previous.activeCorrelationId
        && runtime.rejectedStarts.has(starting.correlationId)
    }
    const wantedCorrelation = starting?.correlationId ?? correlationId
    const wantedId = starting ? undefined : wantedCorrelation
      ? runtime.activeCorrelationId === wantedCorrelation ? runtime.activeTurnId
        : runtime.input.correlationId === wantedCorrelation ? runtime.input.nativeTurnId : undefined
      : runtime.input.nativeTurnId ?? runtime.activeTurnId
    const response = object(await transport.request('thread/read', {
      threadId: runtime.session.nativeSessionId, includeTurns: false,
    }, signal), 'CODEX_THREAD_READ_INVALID')
    if (rejectedDuringRead()) return
    const thread = object(response.thread, 'CODEX_THREAD_READ_INVALID')
    if (thread.id !== runtime.session.nativeSessionId) throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Reconciliation returned another thread.')
    const matches = (turn: JsonObject) => wantedId ? turn.id === wantedId
      : wantedCorrelation ? Array.isArray(turn.items) && turn.items.some((item) => isObject(item) && item.type === 'userMessage' && item.clientId === wantedCorrelation)
        : true
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObject) : []
    let selected = [...turns].reverse().find(matches)
    if (!selected || selected.itemsView !== 'full') {
      let cursor: string | undefined
      const seenCursors = new Set<string>()
      selected = undefined
      for (let page = 0; page < 20; page += 1) {
        const result = await listCodexTurns(transport, {
          threadId: runtime.session.nativeSessionId, limit: 50, sortDirection: 'desc', itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        }, signal)
        if (rejectedDuringRead()) return
        // Before its first turn lands the thread has no history; an unacknowledged turn/start is still pending.
        if (!result) { if (starting && !starting.acknowledgedTurnId) return; break }
        const candidates = Array.isArray(result.data) ? result.data.filter(isObject).filter(matches) : []
        if (wantedCorrelation && candidates.length > 1) throw new HarnessExecutionError('CODEX_CORRELATION_AMBIGUOUS', 'More than one native turn has this correlation.')
        if (candidates[0]) { selected = candidates[0]; break }
        cursor = text(result.nextCursor)
        if (!cursor) break
        if (seenCursors.has(cursor)) throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'Codex repeated a history cursor.')
        seenCursors.add(cursor)
      }
    }
    if (!selected) {
      if (wantedId || wantedCorrelation) {
        runtime.phase = 'uncertain'
        throw new HarnessExecutionError('CODEX_RECONCILIATION_UNCERTAIN', 'The submitted native turn was not found; absence of history does not authorize replay.')
      }
      runtime.phase = 'idle'
      return
    }
    if (!text(selected.id) || !['inProgress', 'completed', 'failed', 'interrupted'].includes(String(selected.status))) {
      throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'The reconciled native turn is malformed.')
    }
    if (selected.itemsView !== 'full') throw new HarnessExecutionError('CODEX_HISTORY_INCOMPLETE', 'Native reconciliation did not return full turn items.')
    if (runtime.phase === 'active' && runtime.activeTurnId && runtime.activeTurnId !== selected.id) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A different native turn is still active; an older result cannot replace its ownership.')
    }
    if (starting) await this.acceptStartedTurn(runtime, starting, { turn: selected })
    else {
      runtime.activeCorrelationId = wantedCorrelation
        ?? (runtime.input.nativeTurnId === selected.id ? runtime.input.correlationId : undefined)
      if (runtime.activeTurnId !== selected.id) {
        runtime.activeTurnId = String(selected.id)
        runtime.finalAnswer = undefined
        runtime.lastAgentMessage = undefined
        runtime.finalAnswerId = undefined
        runtime.lastAgentMessageId = undefined
        runtime.terminalResult = undefined
        runtime.seenNotifications.clear()
      }
      this.applyTurn(runtime, selected)
    }
    // Retain the actual full native turn read, not just its derived terminal enum.
    this.record(runtime, 'thread.reconciled', {
      threadId: thread.id, thread: { id: thread.id, turns: [selected] },
    })
  }
}
