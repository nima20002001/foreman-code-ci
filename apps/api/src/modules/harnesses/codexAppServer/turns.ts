import { logIgnoredError } from '../../diagnostics/ignoredError.js'
/** Turn submission, streaming, steering, cancellation, history and native interaction responses. */
import { runtimeTimingPoint } from '../../diagnostics/runtimeTiming.js'
import { DEVICE_HISTORY_PAGE_BYTES } from '@foreman-code/contracts/device-application'
import { isWorkflowStart, hasWorkflowRequest } from '../sessionStart.js'
import { SessionPreferencesSchema, type ApprovalResponseOption, type NativeHarnessEvent, type NativeSessionReference,
  type PendingNativeInteraction, isSessionNativeInteraction } from '@foreman-code/contracts'
import { codexCollaborationMode } from '../codexSessionControls.js'
import { retryCodexAppMcp } from '../codexMcpReadiness.js'
import { DomainError } from '../../errors.js'
import { HarnessExecutionError, NativeDeliveryError, NativeTurnNotActiveError } from '../errors.js'
import { CodexRuntimeFileTurn, type CodexChatFiles } from '../codexFiles/runtime.js'
import { CodexFilePreparationCleanupError } from '../codexFiles/turn.js'
import { codexChatFileTools } from '../codexFiles/declarations.js'
import type { JsonValue } from '../codexMethodTypes.js'
import { CodexRuntimeNativeOutputTurn, type CodexNativeOutputs } from '../codexNativeOutput.js'
import type { NativeHistory, NativeSteerInput, NativeSteerReceipt, NativeTurnInput } from '../port.js'
import { codexRequest } from '../codexProtocol.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { resolveCodexInteractionResponse } from '../codexInteractions.js'
import { responseValueDigest } from '../../interactions/delivery.js'
import { unavailableNativeResponse, type NativeResponseAvailability, type NativeResponseAvailabilityQuery } from '../responseAvailability.js'
import { CodexRpcError, isObject, object, text } from '../codexStdioTransport.js'
import { codexCapacityDelay, waitForCodexCapacity } from '../codexCapacity.js'
import type { StartingTurn, Runtime } from './types.js'
import { MAX_HISTORY_BYTES, RESPONSE_DEADLINE_MS, requestKey, snapshot, deadline, listCodexTurns } from './support.js'
import { CodexManagerControls } from './controls.js'

export abstract class CodexManagerTurns extends CodexManagerControls {
  startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal): AsyncIterable<NativeHarnessEvent> {
    const subscriber = new AbortController()
    const iterator = this.streamTurn(session, input, signal, subscriber.signal)
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => iterator.next(),
          return: async () => { subscriber.abort(); return iterator.return() },
          throw: async (error: unknown) => { subscriber.abort(); return iterator.throw(error) },
        }
      },
    }
  }

  protected async *streamTurn(session: NativeSessionReference, input: NativeTurnInput, signal: AbortSignal | undefined,
    subscriberSignal: AbortSignal): AsyncGenerator<NativeHarnessEvent, void> {
    let runtime: Runtime
    try {
      runtime = this.requireRuntime(session)
    } catch (error) {
      throw new NativeDeliveryError('turn_submission', 'not_sent', error)
    }
    if (runtime.capacityRetry) throw new NativeDeliveryError('turn_submission', 'not_sent',
      new HarnessExecutionError('CODEX_TURN_ACTIVE', 'This session is waiting for model capacity.'))
    const retry: NonNullable<Runtime['capacityRetry']> = {
      attempt: 1, canAdvanceIdentity: !input.onSubmitted || Boolean(input.onRetry), controller: new AbortController(),
    }
    runtime.capacityRetry = retry
    const retrySignal = AbortSignal.any([retry.controller.signal, subscriberSignal,
      this.shutdownController.signal, ...(signal ? [signal] : [])])
    const attemptSignal = AbortSignal.any([retry.controller.signal, ...(signal ? [signal] : [])])
    try {
      for (;;) {
        yield* this.streamTurnAttempt(session, input, attemptSignal, subscriberSignal)
        if (!retry.failure || retrySignal.aborted || runtime.closed) return
        await this.finishTurnResources(runtime)
        const turnId = runtime.activeTurnId!
        const delayMs = codexCapacityDelay(retry.attempt)
        this.record(runtime, 'turn.capacity_wait', {
          threadId: session.nativeSessionId, turnId, attempt: retry.attempt, delayMs,
        })
        yield structuredClone(runtime.events.at(-1)!)
        await waitForCodexCapacity(delayMs, retrySignal, this.dependencies)
        retrySignal.throwIfAborted()
        await input.onRetry?.(turnId)
        retrySignal.throwIfAborted()
        this.record(runtime, 'turn.capacity_retry', { threadId: session.nativeSessionId, turnId })
        yield structuredClone(runtime.events.at(-1)!)
        retrySignal.throwIfAborted()
        retry.attempt += 1
        delete retry.failure
      }
    } catch (error) {
      if (!retrySignal.aborted || error !== retrySignal.reason) throw error
      if (!signal?.aborted && !subscriberSignal.aborted) {
        runtime.terminalResult = { outcome: 'canceled' }
        this.record(runtime, 'turn.retry_canceled', { threadId: session.nativeSessionId, turnId: runtime.activeTurnId })
        yield structuredClone(runtime.events.at(-1)!)
      }
    } finally {
      delete runtime.capacityRetry
    }
  }

  protected async *streamTurnAttempt(session: NativeSessionReference, input: NativeTurnInput,
    signal: AbortSignal | undefined, subscriberSignal: AbortSignal): AsyncGenerator<NativeHarnessEvent, void> {
    let runtime: Runtime
    try {
      runtime = this.requireRuntime(session)
      signal?.throwIfAborted()
      this.assertTurnStartable(runtime, session)
      if (input.sessionPreferences && canonicalJsonNumericKeysFirstLegacy(input.sessionPreferences) !== canonicalJsonNumericKeysFirstLegacy(runtime.sessionPreferences ?? runtime.input.sessionPreferences ?? SessionPreferencesSchema.parse({}))) {
        await this.applySessionPreferences(session, input.sessionPreferences, signal)
      }
      if (!input.clientCorrelationId.trim()) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Turn startup requires a stable correlation ID.')
    } catch (error) {
      throw new NativeDeliveryError('turn_submission', 'not_sent', error)
    }
    const starting = this.beginStartingTurn(runtime, input)
    const abort = () => {
      const restarting = signal?.reason instanceof DomainError && signal.reason.code === 'ENGINE_RESTART'
      if (!restarting) starting.cancelRequested = true
      starting.preparationController.abort(signal?.reason)
      void this.finishTurnResources(runtime).catch(cleanupError => {
        logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
        // Resources stay owned for the next admission or explicit close to retry.
      })
      if (!restarting && runtime.activeTurnId && !runtime.terminalResult) {
        void this.interrupt(runtime).catch(cleanupError => {
          logIgnoredError('harness', 'interrupt aborted Codex turn', cleanupError)
          // ignore: abort cannot await delivery; interrupt records uncertainty for reconciliation.
        })
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    let cursor = runtime.sequence
    runtime.streamCursor = cursor
    let nativeSubmissionAttempted = false
    let operationFailure: Error | undefined
    let cleaningUp = false
    try {
      try {
        await this.finishTurnResources(runtime)
        runtime.files = undefined
        runtime.fileCleanup = undefined
        runtime.nativeOutput = undefined
        runtime.nativeOutputCleanup = undefined
        runtime.fileRequests.clear()
        const preparationSignal = AbortSignal.any([starting.preparationController.signal, this.shutdownController.signal, subscriberSignal, ...(signal ? [signal] : [])])
        preparationSignal.throwIfAborted()
        if (hasWorkflowRequest(runtime.input) && this.appMcpAccess === 'scoped') {
          const serverName = runtime.approvedAppMcpServerName ?? this.appMcpServerName
          const retries = retryCodexAppMcp(runtime.transport, session.nativeSessionId, serverName,
            preparationSignal, this.dependencies, async retrySignal => {
              await deadline(this.dependencies.assertUnchanged(runtime.qualified),
                retrySignal, 120_000, this.dependencies)
              retrySignal.throwIfAborted()
              await runtime.transport.request('config/mcpServer/reload', undefined, retrySignal)
            })
          for await (const retry of retries) {
            this.record(runtime, 'turn.mcp_startup_retry', { threadId: session.nativeSessionId, serverName, ...retry })
            for (const event of runtime.events.filter(event => event.sequence >= cursor)) {
              cursor = event.sequence + 1
              runtime.streamCursor = cursor
              yield structuredClone(event)
            }
          }
        }
        if (this.chatFiles) {
          starting.filePreparation = this.prepareTurnFiles(this.chatFiles, runtime, session, input, starting, preparationSignal)
        }
        preparationSignal.throwIfAborted()
        if (this.nativeOutputs && isWorkflowStart(runtime.input)) {
          starting.nativeOutputPreparation = this.prepareTurnNativeOutput(this.nativeOutputs, runtime, session, input, starting,
            preparationSignal)
          await starting.nativeOutputPreparation
        }
        const preparedFiles = await starting.filePreparation
        const nativeInput = preparedFiles ? await preparedFiles.bridge.nativeInput(input.prompt)
          : [{ type: 'text' as const, text: input.prompt, text_elements: [] }]
        preparationSignal.throwIfAborted()
        if (runtime.disposed || runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'The session closed during file preparation.')
        runtime.rejectedStarts.delete(starting.correlationId)
        if (this.responseJournal) {
          starting.nativeAttemptId = this.responseJournal.beginTurnAttempt(session, starting.correlationId)
        }
        nativeSubmissionAttempted = true
        runtimeTimingPoint('harness', 'native.submit', { nativeSessionId: session.nativeSessionId })
        const result = await codexRequest(runtime.transport, 'turn/start', {
          threadId: session.nativeSessionId, clientUserMessageId: input.clientCorrelationId,
          input: nativeInput,
          ...(input.outputSchema ? { outputSchema: input.outputSchema as JsonValue } : {}),
          ...(input.sessionMode ? { collaborationMode: codexCollaborationMode(input.sessionMode, runtime.configuration.model, runtime.configuration.reasoningEffort) } : {}),
          serviceTierForTurn: runtime.configuration.serviceTier === 'priority' ? 'fast' : 'default',
        }, AbortSignal.any([subscriberSignal, ...(signal ? [signal] : [])]), (value, error) => {
          if (runtime.starting !== starting || runtime.disposed) return
          if (error instanceof CodexRpcError && !error.uncertain) this.rejectStartedTurn(runtime, starting)
          else if (error) runtime.phase = 'uncertain'
          else void this.acceptStartedTurn(runtime, starting, value).catch(error => {
            logIgnoredError('harness', 'accept late native turn response', error)
            runtime.phase = 'uncertain'
            this.record(runtime, 'turn.start_uncertain', { correlationId: starting.correlationId })
          })
        }).catch((error: unknown) => {
          const rejected = !starting.acknowledgedTurnId && !runtime.activeTurnId
            && error instanceof CodexRpcError && error.method === 'turn/start' && !error.uncertain
          if (rejected) nativeSubmissionAttempted = false
          if (runtime.starting === starting) {
            if (!rejected) {
              runtime.phase = 'uncertain'
              this.record(runtime, 'turn.start_uncertain', { correlationId: starting.correlationId })
            } else this.rejectStartedTurn(runtime, starting)
          }
          throw error
        })
        await this.acceptStartedTurn(runtime, starting, result)
        await input.onSettingsApplied?.()
        while (!signal?.aborted && !subscriberSignal.aborted) {
          const firstSequence = runtime.events[0]?.sequence ?? runtime.sequence
          if (cursor < firstSequence) {
            await input.onEventsSkipped?.({ fromSequence: cursor, toSequence: firstSequence - 1, reason: 'retention' })
            cursor = firstSequence
            runtime.streamCursor = cursor
            continue
          }
          const available = runtime.events.filter((event) => event.sequence >= cursor)
          for (const event of available) {
            cursor = event.sequence + 1
            runtime.streamCursor = cursor
            yield structuredClone(event)
          }
          // The consumer can suspend at yield while more events (including terminal
          // events) arrive. Drain them before returning or registering a waiter.
          if (runtime.events.some((event) => event.sequence >= cursor)) continue
          if (runtime.observerUnavailable && !runtime.terminalResult) throw runtime.observerUnavailable
          if (runtime.terminalResult || runtime.closed) { await this.finishTurnResources(runtime); return }
          await this.wait(runtime, AbortSignal.any([subscriberSignal, ...(signal ? [signal] : [])]))
        }
      } catch (error) {
        if (!nativeSubmissionAttempted) this.restoreRejectedStart(runtime, starting)
        if (!subscriberSignal.aborted) {
          const restart = signal?.reason instanceof DomainError && signal.reason.code === 'ENGINE_RESTART'
          operationFailure = restart ? signal.reason
            : new NativeDeliveryError('turn_submission', nativeSubmissionAttempted ? 'unknown' : 'not_sent', error)
          throw operationFailure
        }
      } finally {
        if (!nativeSubmissionAttempted || signal?.aborted || subscriberSignal.aborted || runtime.closed || runtime.terminalResult) {
          cleaningUp = true
          await this.finishTurnResources(runtime)
          cleaningUp = false
        }
      }
    } catch (error) {
      if (!cleaningUp) throw error
      const cause = operationFailure
        ? new AggregateError([operationFailure, error], 'Native turn failed and resource cleanup is unconfirmed.', { cause: error })
        : error
      throw new NativeDeliveryError('turn_submission', nativeSubmissionAttempted ? 'unknown' : 'not_sent', cause, 'pending')
    } finally {
      signal?.removeEventListener('abort', abort)
      runtime.streamActive = false
      delete runtime.streamCursor
    }
  }

  protected assertTurnStartable(runtime: Runtime, session: NativeSessionReference): void {
    if ((runtime.input.kind === 'operator' || runtime.input.kind === 'workflow-consultation') && runtime.input.observationOnly) {
      throw new HarnessExecutionError('CODEX_OBSERVATION_ONLY', 'Refresh the scoped environment before sending another turn.')
    }
    if (this.locks.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
    if (runtime.closed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconcile the disconnected session before starting another turn.')
    if (runtime.compaction && ['accepted', 'running', 'uncertain'].includes(runtime.compaction.status)) {
      throw new HarnessExecutionError('CODEX_COMPACT_PENDING', 'Recover native compaction before sending another turn.')
    }
    if (runtime.phase !== 'idle' || runtime.streamActive || runtime.interactions.size > 0) {
      throw new HarnessExecutionError('CODEX_TURN_ACTIVE', 'This session has an active or uncertain turn or interaction.')
    }
  }

  async retireTurn(session: NativeSessionReference, correlationId: string): Promise<void> {
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      if (runtime.activeCorrelationId !== correlationId || !runtime.terminalResult) {
        throw new HarnessExecutionError('CODEX_TURN_NOT_COMPLETED', 'Only the completed owned turn can be retired.')
      }
      if (runtime.phase !== 'idle' || runtime.starting || runtime.interactions.size > 0) {
        throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'Finish native work before retiring its turn resources.')
      }
      await this.finishTurnResources(runtime)
    })
  }

  /** Reserves the runtime for one starting turn and clears the previous turn's observations. */
  protected beginStartingTurn(runtime: Runtime, input: NativeTurnInput): StartingTurn {
    let resolveIdentity!: StartingTurn['resolveIdentity']
    const nativeIdentity = new Promise<string | undefined>((resolve) => { resolveIdentity = resolve })
    const starting: StartingTurn = {
      correlationId: input.clientCorrelationId, previous: snapshot(runtime), cancelRequested: false,
      preparationController: new AbortController(),
      ...(input.onSubmitted ? { onSubmitted: input.onSubmitted } : {}),
      nativeIdentity, resolveIdentity, staged: [], stagedBytes: 0,
    }
    runtime.streamActive = true
    runtime.starting = starting
    runtime.phase = 'starting'
    runtime.activeTurnId = undefined
    runtime.activeCorrelationId = input.clientCorrelationId
    runtime.terminalResult = undefined
    runtime.finalAnswer = undefined
    runtime.lastAgentMessage = undefined
    runtime.finalAnswerId = undefined
    runtime.lastAgentMessageId = undefined
    runtime.cancellation = undefined
    runtime.seenNotifications.clear()
    return starting
  }

  protected prepareTurnFiles(chatFiles: CodexChatFiles, runtime: Runtime, session: NativeSessionReference, input: NativeTurnInput,
    starting: StartingTurn, preparationSignal: AbortSignal): Promise<CodexRuntimeFileTurn | undefined> {
    return chatFiles.prepare({ session: structuredClone(session),
      clientCorrelationId: input.clientCorrelationId, signal: preparationSignal }).then(async (bridge) => {
      if (!bridge) return undefined
      const files = new CodexRuntimeFileTurn(bridge, session.nativeSessionId)
      runtime.files = files
      if (runtime.disposed || runtime.closed || starting.cancelRequested || preparationSignal.aborted) {
        await files.close()
        throw new HarnessExecutionError('CODEX_FILE_TURN_CLOSED', 'File preparation was canceled before native submission.')
      }
      if (!starting.onSubmitted) {
        await files.close()
        throw new HarnessExecutionError('CODEX_FILE_RECEIPT_REQUIRED', 'File turns require durable native identity persistence.')
      }
      if (bridge.allowedTools().some((tool) => !codexChatFileTools(runtime.configuration).includes(tool))) {
        await files.close()
        throw new HarnessExecutionError('CODEX_FILE_POLICY_MISMATCH', 'File admission exceeds this chat harness policy.')
      }
      return files
    }, (error: unknown) => {
      if (error instanceof CodexFilePreparationCleanupError) {
        runtime.files = new CodexRuntimeFileTurn(error.turn, session.nativeSessionId)
      }
      throw error
    })
  }

  protected prepareTurnNativeOutput(nativeOutputs: CodexNativeOutputs, runtime: Runtime, session: NativeSessionReference,
    input: NativeTurnInput, starting: StartingTurn, preparationSignal: AbortSignal): Promise<CodexRuntimeNativeOutputTurn> {
    if (!starting.onSubmitted || !runtime.effectiveSandbox) throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_ADMISSION_REQUIRED', 'Native outputs require measured policy and durable turn admission.')
    return nativeOutputs.prepare({
      ...this.nativeOutputQualification(runtime.configuration, runtime.qualified, runtime.workingDirectory, runtime.effectiveSandbox.tmpdir),
      effectiveSandbox: structuredClone(runtime.effectiveSandbox), session: structuredClone(session),
      clientCorrelationId: input.clientCorrelationId, connectionId: runtime.connectionId, runtimeGeneration: runtime.generation,
    }, preparationSignal).then(async (bridge) => {
      const output = new CodexRuntimeNativeOutputTurn(bridge)
      runtime.nativeOutput = output
      if (runtime.closed || runtime.disposed || starting.cancelRequested || preparationSignal.aborted) {
        await output.close(); throw new HarnessExecutionError('CODEX_NATIVE_OUTPUT_CLOSED', 'Native output preparation was withdrawn.')
      }
      return output
    })
  }

  async steerTurn(session: NativeSessionReference, input: NativeSteerInput, signal?: AbortSignal): Promise<{ nativeTurnId: string }> {
    const runtime = this.requireRuntime(session)
    signal?.throwIfAborted()
    if (runtime.closed || runtime.disposed) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Reconcile the disconnected session before steering.')
    if (!input.clientCorrelationId.trim()) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Steering requires a stable correlation ID.')
    if (!runtime.activeTurnId || runtime.terminalResult || runtime.activeTurnId !== input.expectedTurnId) throw new NativeTurnNotActiveError()
    let result: unknown
    try {
      result = await codexRequest(runtime.transport, 'turn/steer', {
        threadId: session.nativeSessionId, expectedTurnId: input.expectedTurnId, clientUserMessageId: input.clientCorrelationId,
        input: [{ type: 'text' as const, text: input.prompt, text_elements: [] }],
      }, signal)
    } catch (error) {
      // Codex enforces expectedTurnId. A definite RPC rejection accepted no input.
      if (error instanceof CodexRpcError && !error.uncertain) throw new NativeTurnNotActiveError(`Codex rejected the steer: ${error.nativeMessage ?? error.message}`, { cause: error })
      throw error
    }
    const turnId = object(result, 'CODEX_TURN_STEER_INVALID').turnId
    if (!text(turnId) || turnId !== input.expectedTurnId) throw new HarnessExecutionError('CODEX_TURN_STEER_INVALID', 'Codex did not acknowledge the exact expected turn.')
    this.record(runtime, 'turn.steered', { turnId, correlationId: input.clientCorrelationId })
    return { nativeTurnId: String(turnId) }
  }

  /** Inspect persisted user-message identities without synchronizing/retargeting the live owner. */
  async reconcileSteers(session: NativeSessionReference,
    inputs: readonly Pick<NativeSteerInput, 'clientCorrelationId' | 'expectedTurnId'>[],
    signal?: AbortSignal): Promise<readonly NativeSteerReceipt[]> {
    signal = AbortSignal.any([this.shutdownController.signal, signal ?? AbortSignal.timeout(RESPONSE_DEADLINE_MS)])
    return this.exclusive(session.nativeSessionId, async () => {
      signal.throwIfAborted()
      const runtime = this.requireRuntime(session)
      if (!inputs.length) return []
      if (runtime.closed) await this.restart(runtime, signal)
      const response = object(await runtime.transport.request('thread/read', {
        threadId: session.nativeSessionId, includeTurns: false,
      }, signal), 'CODEX_THREAD_READ_INVALID')
      if (object(response.thread, 'CODEX_THREAD_READ_INVALID').id !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Steer reconciliation returned another thread.')
      }
      const wanted = new Map(inputs.map((input) => [input.clientCorrelationId, input.expectedTurnId]))
      const found = new Map<string, NativeSteerReceipt>()
      const seen = new Map<string, string>()
      const cursors = new Set<string>()
      let cursor: string | undefined
      do {
        signal.throwIfAborted()
        const page = await listCodexTurns(runtime.transport, {
          threadId: session.nativeSessionId, limit: 50, sortDirection: 'desc', itemsView: 'full',
          ...(cursor ? { cursor } : {}),
        }, signal) ?? { data: [] }
        if (!Array.isArray(page.data)) throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'Codex returned an invalid turn page.')
        for (const turn of page.data.filter(isObject)) {
          const nativeTurnId = text(turn.id)
          if (!nativeTurnId || turn.itemsView !== 'full' || !Array.isArray(turn.items)) continue
          for (const item of turn.items.filter(isObject)) {
            const correlationId = text(item.clientId)
            if (item.type !== 'userMessage' || !correlationId || !wanted.has(correlationId)) continue
            if (seen.has(correlationId) && seen.get(correlationId) !== nativeTurnId) {
              throw new HarnessExecutionError('CODEX_CORRELATION_AMBIGUOUS', 'More than one native turn has this steering correlation.')
            }
            seen.set(correlationId, nativeTurnId)
            if (wanted.get(correlationId) === nativeTurnId) {
              found.set(correlationId, { nativeSessionId: session.nativeSessionId, nativeTurnId, correlationId })
            }
          }
        }
        cursor = text(page.nextCursor)
        if (cursor && cursors.has(cursor)) throw new HarnessExecutionError('CODEX_THREAD_READ_INVALID', 'Codex repeated a history cursor.')
        if (cursor) cursors.add(cursor)
      } while (cursor && found.size < wanted.size)
      return [...found.values()]
    })
  }

  async pending(session: NativeSessionReference): Promise<PendingNativeInteraction | undefined> {
    const first = [...this.requireRuntime(session).interactions.values()].find((entry) => entry.delivery === 'pending')
    return first ? structuredClone(first.pending) : undefined
  }

  /** Inspects only this manager's current exact native callback; never reconstructs one from history. */
  async inspectResponseAvailability(session: NativeSessionReference, query: NativeResponseAvailabilityQuery,
    signal?: AbortSignal): Promise<NativeResponseAvailability> {
    signal?.throwIfAborted()
    const unavailable = (reason: NativeResponseAvailability['reason']) => unavailableNativeResponse(session, query, reason)
    if (this.shutdownController.signal.aborted) return unavailable('session_closed')
    if (session.harness !== 'codex') return unavailable('unqualified')
    const child = this.childRuntimes.get(session.nativeSessionId)
    try { child?.assertCurrent() } catch (error) {
      logIgnoredError('harness', 'verify native child response evidence', error, {}, ['SUBAGENT_OWNER_STALE'])
      return unavailable('session_closed')
    }
    const runtime = this.runtimes.get(session.nativeSessionId) ?? child?.runtime
    if (!runtime) return unavailable('callback_lost')
    if (runtime.session.providerVersion !== session.providerVersion) return unavailable('identity_mismatch')
    if (runtime.closed || runtime.disposed) return unavailable('session_closed')
    const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === query.nativeRequestId)
    if (!waiting) {
      const consumed = [...runtime.resolvedRequests.values()].find((entry) => entry.nativeRequestId === query.nativeRequestId)
      if (consumed && (consumed.method !== query.nativeRequestType
        || query.expectedNativeTurnId !== undefined && consumed.nativeTurnId !== query.expectedNativeTurnId)) return unavailable('identity_mismatch')
      return unavailable(consumed ? 'request_consumed' : 'callback_lost')
    }
    const turnId = waiting.pending.turn.nativeTurnId
    if (waiting.method !== query.nativeRequestType || waiting.pending.nativeRequestType !== query.nativeRequestType
      || waiting.pending.session.harness !== session.harness || waiting.pending.session.nativeSessionId !== session.nativeSessionId || waiting.pending.session.providerVersion !== session.providerVersion
      || query.expectedNativeTurnId !== undefined && turnId !== query.expectedNativeTurnId) return unavailable('identity_mismatch')
    if (waiting.generation !== runtime.generation || waiting.transport !== runtime.transport
      || runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) !== waiting) {
      return { ...unavailable('callback_lost'), state: 'recovery_required' }
    }
    if (waiting.conflictingIdentity) return { ...unavailable('identity_mismatch'), state: 'recovery_required' }
    const standalone = isSessionNativeInteraction(waiting.pending)
    if (!standalone && (!turnId || turnId !== runtime.activeTurnId || runtime.terminalResult)) return unavailable('identity_mismatch')
    if ((!standalone && runtime.phase !== 'active') || runtime.starting
      || !runtime.qualified.schemaManifestSha256) return unavailable('unqualified')
    if (!this.transports.has(runtime.transport) || runtime.transport.isConnected?.() !== true) return unavailable('callback_lost')
    const current = { ...unavailable('callback_lost'), ...(turnId ? { nativeTurnId: turnId } : {}),
      generation: `${runtime.connectionId}:${runtime.generation}`, qualified: true }
    if (waiting.delivery !== 'pending') return { ...current, state: 'recovery_required', reason: 'response_in_flight' }
    return { ...current, state: 'available', path: 'live_callback', reason: 'live_callback' }
  }

  async respond(session: NativeSessionReference, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    const dispatch = async () => {
      const runtime = this.requireRuntime(session)
      const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === nativeRequestId)
      if (!waiting) throw new HarnessExecutionError('NATIVE_RESPONSE_UNKNOWN_REQUEST', 'The addressed native request is not pending in this session.')
      const stored = waiting.responses.get(option.optionId)
      if (!stored) throw new HarnessExecutionError('NATIVE_RESPONSE_OPTION_INVALID', 'The selected response was not offered for this native request.')
      if (waiting.delivery !== 'pending' || waiting.conflictingIdentity || waiting.generation !== runtime.generation || waiting.transport !== runtime.transport || runtime.closed) {
        throw new HarnessExecutionError('NATIVE_RESPONSE_RECONCILIATION_REQUIRED', 'A submitted, disconnected, or uncertain native response cannot be retransmitted.')
      }
      signal?.throwIfAborted()
      const nativeResponse = resolveCodexInteractionResponse(stored, option)
      // Synchronous reservation prevents two competing responses from both writing.
      waiting.delivery = 'submitting'
      waiting.selectedOptionId = stored.option.optionId
      runtime.responseDecisions.set(nativeRequestId, { pending: waiting.pending, option, nativeResponse,
        sequence: runtime.sequence })
      this.record(runtime, 'interaction.submitting', { nativeRequestId, optionId: option.optionId })
      const delivery = (async () => {
        try {
          await runtime.transport.respond(waiting.requestId, waiting.method, nativeResponse)
          this.record(runtime, 'interaction.submitted', { nativeRequestId, optionId: stored.option.optionId,
            semantic: stored.option.semantic, responseDigest: responseValueDigest(option.response) })
          if (runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) === waiting) {
            waiting.delivery = 'submitted'
          }
          const resolved = await deadline(waiting.resolution, signal, undefined, this.dependencies)
          if (resolved === 'cleared') throw new HarnessExecutionError('NATIVE_RESPONSE_CLEARED', 'The native request was cleared; acceptance of the selected response was not confirmed.')
        } catch (error) {
          if (runtime.interactions.get(requestKey(waiting.generation, waiting.requestId)) === waiting) {
            const code = error instanceof HarnessExecutionError ? error.result.error?.code : undefined
            waiting.delivery = ['NATIVE_RESPONSE_DELIVERY_FAILED', 'NATIVE_RESPONSE_INVALID'].includes(code ?? '') ? 'pending' : 'uncertain'
            this.record(runtime, 'interaction.delivery_state', { nativeRequestId, delivery: waiting.delivery })
          }
          throw error
        }
      })()
      // Resolution may require reconciliation or closure, so release the lifecycle lock after dispatch.
      return { delivery }
    }
    // Without lifecycle work to wait for, reserve the callback before another caller can inspect it.
    const { delivery } = await (this.locks.has(session.nativeSessionId)
      ? this.exclusive(session.nativeSessionId, dispatch) : dispatch())
    await delivery
  }

  async cancel(session: NativeSessionReference, signal?: AbortSignal, nativeTurnId?: string): Promise<boolean> {
    const runtime = this.requireRuntime(session)
    // An explicit stale target cannot withdraw the newly preparing turn's files.
    if (nativeTurnId && nativeTurnId !== runtime.activeTurnId) return false
    if (runtime.capacityRetry?.failure) {
      runtime.capacityRetry.controller.abort()
      return true
    }
    if (runtime.starting) {
      runtime.starting.cancelRequested = true
      runtime.starting.preparationController.abort()
      void this.finishTurnResources(runtime).catch(cleanupError => {
        logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
        // Resources stay owned for the next admission or explicit close to retry.
      })
      const id = await deadline(runtime.starting.nativeIdentity, signal, undefined, this.dependencies)
      if (!id) return false
    }
    if (!runtime.activeTurnId || runtime.terminalResult || (nativeTurnId && nativeTurnId !== runtime.activeTurnId)) return false
    return deadline(this.interrupt(runtime), signal, undefined, this.dependencies)
  }

  async history(session: NativeSessionReference): Promise<NativeHistory> {
    const runtime = this.requireRuntime(session)
    this.captureResponseDeliveries(runtime)
    const all = [...runtime.interactions.values()]
    const first = all.find((entry) => entry.delivery === 'pending')
    // Streamed frames are persisted individually. Observation proofs need a
    // smaller window so their combined JSON stays within graph traversal limits.
    let firstEvent = runtime.events.length
    let historyBytes = 0
    while (firstEvent > 0) {
      const size = runtime.eventSizes[firstEvent - 1]!
      if (historyBytes + size > MAX_HISTORY_BYTES && firstEvent < runtime.events.length) break
      historyBytes += size
      firstEvent -= 1
    }
    const events = runtime.events.slice(firstEvent)
    const terminalEvent = runtime.terminalResult ? runtime.events.findLast((event) => {
      if (event.type === 'turn.completed') return event.payload.turnId === runtime.activeTurnId
      const thread = event.payload.thread
      return event.type === 'thread.reconciled' && isObject(thread) && Array.isArray(thread.turns)
        && thread.turns.some((turn) => isObject(turn) && turn.id === runtime.activeTurnId)
    }) : undefined
    // Reconciliation can append metadata after a large original terminal read.
    // Keep that atomic provider frame even when transcript context rolls out.
    if (terminalEvent && !events.includes(terminalEvent)) events.unshift(terminalEvent)
    const gapStart = terminalEvent && terminalEvent.sequence < (runtime.events[firstEvent]?.sequence ?? runtime.sequence)
      ? terminalEvent.sequence + 1 : undefined
    return structuredClone({
      events,
      ...(gapStart !== undefined && gapStart < runtime.events[firstEvent]!.sequence
        ? { gap: { fromSequence: gapStart, toSequence: runtime.events[firstEvent]!.sequence - 1,
          reason: 'retention' as const } } : {}),
      pendingInteractions: all.map((entry) => entry.pending),
      ...(first?.delivery === 'pending' ? { pendingInteraction: first.pending } : {}),
      ...(runtime.terminalResult && !runtime.capacityRetry?.failure ? { terminalResult: runtime.terminalResult } : {}),
      ...((runtime.finalAnswer !== undefined ? runtime.finalAnswerId : runtime.lastAgentMessageId)
        ? { nativeMessageId: runtime.finalAnswer !== undefined ? runtime.finalAnswerId! : runtime.lastAgentMessageId! } : {}),
      firstRetainedSequence: events[0]?.sequence ?? runtime.sequence,
      nextSequence: runtime.sequence,
      interactionDeliveries: all.map((entry) => ({
        nativeRequestId: entry.pending.turn.nativeRequestId!, state: entry.delivery,
        ...(entry.selectedOptionId ? { selectedOptionId: entry.selectedOptionId } : {}),
      })),
      responseDeliveries: [...runtime.responseDeliveries.values()],
    })
  }

  async reconcileResponse(
    session: NativeSessionReference,
    response: import('../port.js').NativeResponseIdentity,
    signal?: AbortSignal,
  ): Promise<NativeHistory> {
    signal?.throwIfAborted()
    const durable = this.responseJournal?.read(session, response)
    if (durable && !this.runtimes.has(session.nativeSessionId) && !this.childRuntimes.has(session.nativeSessionId)) {
      return { events: [], pendingInteractions: [], responseDeliveries: [durable] }
    }
    const history = await this.history(session)
    if (durable) return { ...history, responseDeliveries: [...(history.responseDeliveries ?? []), durable] }
    if (history.responseDeliveries?.some(proof => proof.nativeRequestId === response.nativeRequestId)) return history
    const runtime = this.requireRuntime(session)
    const decision = runtime.responseDecisions.get(response.nativeRequestId)
    if (decision?.pending.nativeRequestType === 'mcpServer/elicitation/request' && !runtime.closed) {
      const transport = runtime.transport
      const generation = runtime.generation
      const { thread } = await codexRequest(transport, 'thread/read', {
        threadId: session.nativeSessionId, includeTurns: true,
      }, signal)
      if (this.requireRuntime(session) !== runtime || runtime.transport !== transport || runtime.generation !== generation
        || runtime.closed || thread.id !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The response readback owner changed.')
      }
      const latest = thread.turns.at(-1)
      this.record(runtime, 'interaction.readback', { nativeRequestId: response.nativeRequestId,
        threadId: thread.id, observedTurnId: latest?.id ?? null, observedTurnStatus: latest?.status ?? null })
      const observed = await this.history(session)
      if (observed.responseDeliveries?.some(proof => proof.nativeRequestId === response.nativeRequestId)) return observed
    }
    // A transport write or terminal clearing alone cannot acknowledge delivery.
    this.record(this.requireRuntime(session), 'interaction.reconciliation_unconfirmed', {
      nativeRequestId: response.nativeRequestId, nativeRequestType: response.nativeRequestType,
      detail: 'The provider has not supplied an exact response-delivery receipt.',
    })
    return history
  }

  async reconcile(session: NativeSessionReference, correlationId: string, signal?: AbortSignal): Promise<NativeHistory> {
    return this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.requireRuntime(session)
      const rejected = runtime.rejectedStarts.get(correlationId)
        ?? this.responseJournal?.readTurnRejection(session, correlationId)
      if (rejected) return { ...await this.history(session), correlationId,
        nonSubmission: { nativeSessionId: session.nativeSessionId, clientCorrelationId: correlationId,
          result: structuredClone(rejected) } }
      const observedTerminal = runtime.activeCorrelationId === correlationId
        && runtime.activeTurnId !== undefined && runtime.terminalResult !== undefined
      const restarted = runtime.closed && !observedTerminal
      if (restarted) await this.restart(runtime, signal)
      const locallyIdle = !runtime.attached && runtime.phase === 'idle' && runtime.activeCorrelationId === undefined
        && runtime.activeTurnId === undefined && runtime.interactions.size === 0
      if (!locallyIdle && !observedTerminal) {
        try { await this.synchronize(runtime, correlationId, signal) }
        catch (error) {
          signal?.throwIfAborted()
          const disconnected = error instanceof HarnessExecutionError
            && error.result.error?.code === 'CODEX_APP_SERVER_DISCONNECTED'
          if (!disconnected || !runtime.closed || restarted) throw error
          await this.restart(runtime, signal)
          await this.synchronize(runtime, correlationId, signal)
        }
      }
      const lateRejection = runtime.rejectedStarts.get(correlationId)
        ?? this.responseJournal?.readTurnRejection(session, correlationId)
      if (lateRejection) return { ...await this.history(session), correlationId,
        nonSubmission: { nativeSessionId: session.nativeSessionId, clientCorrelationId: correlationId,
          result: structuredClone(lateRejection) } }
      const history = await this.history(session)
      return runtime.activeCorrelationId === correlationId && runtime.activeTurnId
        ? {
            ...history,
            correlationId,
            nativeTurnId: runtime.activeTurnId,
            ...(runtime.terminalResult && !runtime.capacityRetry?.failure ? {
              terminalTurn: {
                correlationId,
                providerId: runtime.activeTurnId,
                result: runtime.terminalResult,
              },
            } : {}),
          }
        : history
    })
  }

  async reconcileHistoryPage(session: NativeSessionReference, correlationId: string,
    afterSequence: number, signal?: AbortSignal): Promise<NativeHistory> {
    const history = await this.reconcile(session, correlationId, signal)
    return this.historyPageFrom(session, history, afterSequence)
  }

  async historyPage(session: NativeSessionReference, afterSequence: number): Promise<NativeHistory> {
    return this.historyPageFrom(session, await this.history(session), afterSequence)
  }

  private historyPageFrom(session: NativeSessionReference, history: NativeHistory, afterSequence: number): NativeHistory {
    const runtime = this.requireRuntime(session)
    const events: NativeHarnessEvent[] = []
    let bytes = 0
    for (let index = 0; index < runtime.events.length; index++) {
      const event = runtime.events[index]!
      if (event.sequence <= afterSequence) continue
      const size = runtime.eventSizes[index]!
      if (events.length && (events.length >= 1024 || bytes + size > DEVICE_HISTORY_PAGE_BYTES)) break
      events.push(event)
      bytes += size
    }
    // The recent snapshot can contain a protected terminal frame separated by a gap.
    // Cursor pages use the contiguous retained window instead.
    delete history.gap
    return { ...history, events: structuredClone(events),
      firstRetainedSequence: runtime.events[0]?.sequence ?? runtime.sequence, nextSequence: runtime.sequence }
  }
}
