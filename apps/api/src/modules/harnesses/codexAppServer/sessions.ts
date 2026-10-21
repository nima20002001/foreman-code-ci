import { logIgnoredError } from '../../diagnostics/ignoredError.js'
/** Session creation, attachment, original residency, closure, login control and shutdown. */
import { isWorkflowStart, sessionStartDirectory, sessionStartCorrelation, sessionStartSystemPrompt } from '../sessionStart.js'
import { NativeSessionReferenceSchema, type ApprovalResponseOption, type NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../../errors.js'
import { HarnessExecutionError, NativeDeliveryError, NativeTurnNotActiveError } from '../errors.js'
import { codexChatFileDeclarations } from '../codexFiles/declarations.js'
import { codexNativeOutputDeclarations } from '../codexNativeOutput.js'
import { detachedStdioEnvironment, hasDetachedStdioProcess } from '../recovery/processRegistry.js'
import type { NativeSessionStart } from '../port.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { CodexRpcError, object, text, type JsonObject } from '../codexStdioTransport.js'
import type { CodexOriginalResidency, CodexOriginalSessionLifetime, Runtime, Creation } from './types.js'
import { advanced, accepted, binding, credentialIdentity, configuration, threadParameters, isUncertain } from './support.js'
import { CodexManagerTurns } from './turns.js'
import { assertConsultationSession } from '../consultationSession.js'

export abstract class CodexManagerSessions extends CodexManagerTurns {
  async createSession(source: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    if (source.kind === 'workflow-consultation') throw new HarnessExecutionError('CONSULTATION_NATIVE_ATTACH_REQUIRED',
      'A consultation can only attach its persisted coordinator session.')
    if (isWorkflowStart(source) && source.sessionContinuation) {
      return this.attachSessionRuntime(source.sessionContinuation.session, { ...source, instructionsDelivered: true },
        { signal, workflowContinuation: true })
    }
    return this.beginCreation(source, { signal })
  }

  protected async beginCreation(source: NativeSessionStart,
    options: { forkSource?: NativeSessionReference; signal?: AbortSignal | undefined }): Promise<NativeSessionReference> {
    const { forkSource, signal } = options
    this.shutdownController.signal.throwIfAborted()
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source)
    if (forkSource && input.kind !== 'operator') input.instructionsDelivered = true
    const key = this.creationKey(input)
    const identity = this.creationIdentity(input, forkSource)
    const existing = this.creations.get(key)
    if (existing) {
      if (existing.identity !== identity) throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH', 'The creation correlation belongs to a different accepted session.')
      if (existing.session) return structuredClone(existing.session)
      if (existing.status === 'rejected') return this.rejectCreation(existing)
      if (existing.status === 'uncertain') throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'A native thread may already exist for this creation correlation; do not create another one.')
      return structuredClone(await existing.promise!)
    }
    if (this.creations.size >= 128) throw new HarnessExecutionError('CODEX_CREATION_LIMIT', 'Resolve or close existing sessions before creating more.')
    const creation: Creation = { identity, status: 'creating', ...(forkSource ? { source: structuredClone(forkSource) } : {}) }
    this.creations.set(key, creation)
    creation.promise = this.create(input, creation, key, signal)
    return structuredClone(await creation.promise)
  }

  /** Retrieve an identity learned from a late thread/start response without replaying it. */
  async reconcileSessionCreation(input: NativeSessionStart, signal?: AbortSignal,
    forkSource?: NativeSessionReference): Promise<NativeSessionReference> {
    signal?.throwIfAborted()
    this.shutdownController.signal.throwIfAborted()
    const creation = this.creations.get(this.creationKey(input))
    const identity = this.creationIdentity(input, forkSource)
    if (!creation) {
      throw new HarnessExecutionError('NATIVE_SESSION_CREATION_STATE_LOST', 'The original native creation state is no longer available; no replacement thread was created.')
    }
    if (creation.identity !== identity) {
      throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'Native creation identity is not established; no replacement thread was created.')
    }
    if (creation.status === 'rejected') return this.rejectCreation(creation)
    if (!creation.session) {
      throw new HarnessExecutionError('CODEX_SESSION_CREATION_UNCERTAIN', 'Native creation identity is not established; no replacement thread was created.')
    }
    return structuredClone(creation.session)
  }

  protected creationIdentity(input: NativeSessionStart, source?: NativeSessionReference): string {
    return canonicalJsonNumericKeysFirstLegacy({ binding: binding(input), configuration: accepted(input),
      systemPrompt: sessionStartSystemPrompt(input) ?? null,
      environment: input.environment ?? null, source: source ?? null,
      sessionPreferences: input.sessionPreferences ?? this.startupPreferences ?? null })
  }

  protected async rejectCreation(creation: Creation): Promise<never> {
    try { await creation.transport?.close() } catch (error) {
      throw new NativeDeliveryError('session_creation', 'not_sent', error, 'pending')
    }
    throw new NativeDeliveryError('session_creation', 'not_sent', creation.rejection)
  }

  protected creationKey(input: NativeSessionStart): string {
    const correlation = sessionStartCorrelation(input)
    if (!correlation) throw new HarnessExecutionError('CODEX_CORRELATION_REQUIRED', 'Session creation requires a stable correlation ID.')
    return canonicalJsonNumericKeysFirstLegacy([binding(input), correlation])
  }

  protected async create(input: NativeSessionStart, creation: Creation, key: string, signal?: AbortSignal): Promise<NativeSessionReference> {
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    let candidate: Awaited<ReturnType<CodexManagerSessions['transport']>> | undefined
    let expiration: NodeJS.Timeout | undefined
    let creationAttempted = false
    let creationAccepted = false
    const method = creation.source ? 'thread/fork' : 'thread/start'
    try {
      const prepared = await this.prepareInput(input, signal)
      if (creation.source) {
        this.assertSessionVersion(creation.source)
      }
      candidate = await this.transport(prepared, 0, signal)
      creation.transport = candidate.transport
      const publish = async (value: unknown): Promise<NativeSessionReference> => {
        creationAccepted = true
        this.shutdownController.signal.throwIfAborted()
        const response = object(value, 'CODEX_THREAD_START_INVALID')
        const thread = this.validateThreadResponse(prepared, response)
        if (thread.id === creation.source?.nativeSessionId) {
          throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex returned the source thread instead of a fork.')
        }
        const session = NativeSessionReferenceSchema.parse({ harness: 'codex', providerVersion: prepared.qualified.providerVersion, nativeSessionId: thread.id })
        if (this.runtimes.has(session.nativeSessionId)) throw new HarnessExecutionError('CODEX_SESSION_COLLISION', 'Codex returned an already-owned native session identity.')
        const runtime = this.runtime(prepared, session, candidate!.transport)
        this.runtimes.set(session.nativeSessionId, runtime)
        try { await candidate!.activate(runtime); this.shutdownController.signal.throwIfAborted() } catch (error) {
          if (this.runtimes.get(session.nativeSessionId) === runtime) this.runtimes.delete(session.nativeSessionId)
          throw error
        }
        creation.status = 'ready'
        creation.session = session
        this.dependencies.cancelTimer(expiration)
        this.record(runtime, creation.source ? 'thread.forked' : 'thread.started', {
          threadId: session.nativeSessionId,
          ...(creation.source ? { sourceThreadId: creation.source.nativeSessionId } : {}),
        })
        return session
      }
      const params = {
        ...threadParameters(prepared, Boolean(creation.source && this.chatFiles)),
        ephemeral: advanced(prepared.harnessConfiguration).sessionPersistence === 'ephemeral',
        ...(creation.source ? { threadId: creation.source.nativeSessionId, excludeTurns: true } : {}),
        // Codex persists declarations at thread/start; thread/resume cannot add
        // them when a text-first Operator later attaches files.
        // Declarations grant no access: handlers still require an admitted file
        // turn and its durable ACK, never the credentialed text-mode process.
        ...(!creation.source && (this.chatFiles || prepared.input.kind === 'operator')
          ? { dynamicTools: codexChatFileDeclarations(prepared.harnessConfiguration, prepared.qualified.providerVersion) }
          : !creation.source && this.nativeOutputs ? { dynamicTools: codexNativeOutputDeclarations(prepared.harnessConfiguration, prepared.qualified.providerVersion, this.nativeOutputs) } : {}),
      }
      creationAttempted = true
      const result = await candidate.transport.request(method, params, signal, (value, error) => {
        void (async () => {
          if (error) {
            this.dependencies.cancelTimer(expiration)
            creation.status = 'rejected'
            creation.rejection = error
            await candidate!.transport.close()
          } else await publish(value)
        })().catch(error => {
          logIgnoredError('harness', 'handle late native session response', error)
          void candidate!.transport.close().catch(cleanupError => {
            logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
            // ignore: late-response cleanup stays owned for shutdown to retry.
          })
        })
      })
      return await publish(result)
    } catch (error) {
      const notCreated = !creationAttempted || !creationAccepted && error instanceof CodexRpcError
        && error.method === method && !error.uncertain
      if (!notCreated && isUncertain(error) && candidate && !this.shutdownController.signal.aborted) {
        // A late rejection can arrive before the original request failure unwinds.
        if (creation.status !== 'rejected') {
          creation.status = 'uncertain'
          // Keep a bounded late-response window. Expiry never authorizes a retry.
          expiration = this.dependencies.schedule(() => {
            void candidate!.transport.close().catch(cleanupError => {
              logIgnoredError('harness', 'clean up Codex turn resources', cleanupError)
              // ignore: late-response cleanup stays owned for shutdown to retry.
            })
          }, 300_000)
          creation.timer = expiration
          expiration.unref()
        }
      } else {
        try { await candidate?.transport.close() }
        catch (cleanupError) {
          creation.status = notCreated ? 'rejected' : 'uncertain'
          if (notCreated) creation.rejection = error
          throw new NativeDeliveryError('session_creation', notCreated ? 'not_sent' : 'unknown',
            new AggregateError([error, cleanupError], 'Native setup failed and transport closure is unconfirmed.', { cause: cleanupError }), 'pending')
        }
        if (notCreated) this.creations.delete(key)
        else creation.status = 'uncertain'
      }
      throw new NativeDeliveryError('session_creation', notCreated ? 'not_sent' : 'unknown', error)
    }
  }

  /** Passive lookup; never launches, reads history, renews credentials or replaces ownership. */
  originalSessionLifetime(session: NativeSessionReference, source: NativeSessionStart): CodexOriginalSessionLifetime | undefined {
    this.assertSessionVersion(session)
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime) return undefined
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source), reference = structuredClone(session)
    this.assertOriginalBinding(runtime, session, input)
    if (!this.isOriginalResident(runtime)) return undefined
    const residency: CodexOriginalResidency = {
      session: structuredClone(runtime.session), connectionId: runtime.connectionId,
      runtimeGeneration: runtime.generation, nativeTurnId: runtime.activeTurnId,
    }
    // Capture a private copy: mutating a caller's readback cannot retarget the fence.
    const pin = structuredClone(residency)
    return { residency, assertCurrent: () => { this.requireOriginalResidency(reference, input, pin) } }
  }

  /** Reattach only the surviving original stdio runtime. Cold/generation reconnect is unsupported. */
  async reattachOriginalSession(session: NativeSessionReference, source: NativeSessionStart,
    residency: CodexOriginalResidency, signal?: AbortSignal): Promise<NativeSessionReference> {
    const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source), pin = structuredClone(residency)
    return this.exclusive(session.nativeSessionId, async () => {
      signal?.throwIfAborted()
      const runtime = this.requireOriginalResidency(session, input, pin)
      const response = object(await runtime.transport.request('thread/read', {
        threadId: session.nativeSessionId, includeTurns: false,
      }, signal))
      // A late read must not bless a disconnected, replaced or differently admitted turn.
      signal?.throwIfAborted()
      this.requireOriginalResidency(session, input, pin)
      if (object(response.thread).id !== session.nativeSessionId) {
        throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex read a different native thread.')
      }
      return structuredClone(runtime.session)
    })
  }

  /** Control is restricted to the exact admitted original turn; no cold-attach fallback. */
  async cancelOriginalTurn(session: NativeSessionReference, source: NativeSessionStart,
    residency: CodexOriginalResidency, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    this.requireOriginalResidency(session, source, residency)
    if (!residency.nativeTurnId) throw new NativeTurnNotActiveError()
    return this.cancel(session, signal, residency.nativeTurnId)
  }

  async respondOriginal(session: NativeSessionReference, source: NativeSessionStart,
    residency: CodexOriginalResidency, nativeRequestId: string, option: ApprovalResponseOption, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    const runtime = this.requireOriginalResidency(session, source, residency)
    const waiting = [...runtime.interactions.values()].find((entry) => entry.pending.turn.nativeRequestId === nativeRequestId)
    if (!residency.nativeTurnId || runtime.terminalResult
      || waiting && waiting.pending.turn.nativeTurnId !== residency.nativeTurnId) throw new NativeTurnNotActiveError()
    return this.respond(session, nativeRequestId, option, signal)
  }

  protected isOriginalResident(runtime: Runtime): boolean {
    return !runtime.attached && runtime.generation === 0 && !runtime.closed && !runtime.disposed
      && !runtime.starting && runtime.phase !== 'uncertain' && this.transports.has(runtime.transport)
      && runtime.transport.isConnected?.() === true
      && !this.shutdownController.signal.aborted
  }

  protected assertOriginalBinding(runtime: Runtime, session: NativeSessionReference, input: NativeSessionStart): void {
    if (runtime.session.providerVersion !== session.providerVersion) {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
    }
    this.assertBinding(runtime, input)
    if (input.nativeTurnId !== undefined && input.nativeTurnId !== runtime.activeTurnId) {
      throw new HarnessExecutionError('CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The accepted native turn does not match the resident turn.')
    }
    if (credentialIdentity(runtime.input) !== credentialIdentity(input)) {
      throw new HarnessExecutionError('CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED', 'Original residency requires the accepted process environment.')
    }
  }

  protected requireOriginalResidency(session: NativeSessionReference, input: NativeSessionStart, pin: CodexOriginalResidency): Runtime {
    this.assertSessionVersion(session)
    const runtime = this.runtimes.get(session.nativeSessionId)
    if (!runtime) throw new HarnessExecutionError('CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The original stdio runtime is not resident; saved history cannot recover its process or callbacks.')
    this.assertOriginalBinding(runtime, session, input)
    if (!this.isOriginalResident(runtime) || pin.session.harness !== session.harness
      || pin.session.providerVersion !== session.providerVersion || pin.session.nativeSessionId !== session.nativeSessionId
      || pin.connectionId !== runtime.connectionId || pin.runtimeGeneration !== runtime.generation
      || pin.nativeTurnId !== runtime.activeTurnId) {
      throw new HarnessExecutionError('CODEX_ORIGINAL_RESIDENCY_UNAVAILABLE', 'The original connection, generation or admitted turn is no longer current.')
    }
    return runtime
  }

  async attachSession(session: NativeSessionReference, source: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    assertConsultationSession(source, session)
    return this.attachSessionRuntime(session, source, { signal })
  }

  private async attachSessionRuntime(session: NativeSessionReference, source: NativeSessionStart,
    options: { signal?: AbortSignal | undefined; workflowContinuation?: true }): Promise<NativeSessionReference> {
    const signal = options.signal
    this.assertSessionVersion(session)
    if (this.locks.has(session.nativeSessionId)) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'A session lifecycle operation is in progress.')
    }
    return this.exclusive(session.nativeSessionId, async () => {
      const input = structuredClone(this.startupPreferences && !source.sessionPreferences
      ? { ...source, sessionPreferences: this.startupPreferences } : source)
      const loaded = this.runtimes.get(session.nativeSessionId)
      if (loaded) {
        if (loaded.disposed) throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'Session closure is still unconfirmed; retry cleanup before attaching.')
        if (loaded.session.providerVersion !== session.providerVersion) throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
        this.assertBinding(loaded, input)
        if (credentialIdentity(loaded.input) !== credentialIdentity(input)) {
          throw new HarnessExecutionError('CODEX_SESSION_ENVIRONMENT_REFRESH_REQUIRED', 'Use explicit idle-boundary credential refresh instead of attaching with a different environment.')
        }
        if (loaded.closed) await this.restart(loaded, signal)
        const response = object(await loaded.transport.request('thread/read', { threadId: session.nativeSessionId, includeTurns: false }, signal))
        if (object(response.thread).id !== session.nativeSessionId) throw new HarnessExecutionError('CODEX_SESSION_ID_MISMATCH', 'Codex read a different native thread.')
        return structuredClone(loaded.session)
      }
      const detached = this.processRecovery && hasDetachedStdioProcess(this.processRecovery)
      if (this.processRecovery && isWorkflowStart(input) && !input.sessionContinuation && !detached) {
        throw new HarnessExecutionError('EXECUTION_INTERRUPTED',
          'The original workflow native process exited before it produced an accepted result.', true)
      }
      const prepared = detached
        ? await this.dependencies.withDiagnostics({ binary: this.binary, cwd: sessionStartDirectory(input),
          configurationIdentity: canonicalJsonNumericKeysFirstLegacy(configuration(input)),
          scopedCredentialVariables: Object.keys(input.environment?.variables ?? {}),
          ...(signal ? { signal } : {}) }, io => this.prepareInput(input, signal, io))
        : await this.prepareInput(input, signal)
      if (advanced(prepared.harnessConfiguration).sessionPersistence === 'ephemeral') {
        throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED', 'Ephemeral sessions cannot be resumed after their process exits.')
      }
      const candidate = await this.transport(prepared, 0, signal)
      let attachedRuntime: Runtime | undefined
      try {
        const response = candidate.transport.reattached?.()
          ? object(await candidate.transport.request('thread/read', {
            threadId: session.nativeSessionId, includeTurns: false,
          }, signal), 'CODEX_THREAD_READ_INVALID')
          : object(await candidate.transport.request('thread/resume', {
            ...threadParameters(prepared, Boolean(this.chatFiles)), threadId: session.nativeSessionId, excludeTurns: true,
          }, signal), 'CODEX_THREAD_RESUME_INVALID')
        const settings = candidate.transport.reattached?.()
          ? candidate.transport.retainedThreadSettings?.(session.nativeSessionId) : response
        if (!settings) throw new HarnessExecutionError('CODEX_EFFECTIVE_SETTINGS_MISMATCH',
          'The original daemon has no accepted thread settings.')
        this.validateThreadResponse(prepared, { ...settings, thread: response.thread }, session.nativeSessionId)
        let runtime = this.runtime(prepared, structuredClone(session), candidate.transport, true)
        attachedRuntime = runtime
        const rejected = input.correlationId && this.responseJournal?.readTurnRejection(session, input.correlationId)
        if (!rejected) {
          await this.synchronize(runtime, candidate.transport.reattached?.() ? input.correlationId : undefined, signal)
        }
        if (options.workflowContinuation && candidate.transport.reattached?.() !== true) {
          if (runtime.phase !== 'idle' || runtime.interactions.size > 0) {
            throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'The previous workflow turn is still active.')
          }
          // Continue the native transcript, but own only this new execution's turns and results.
          runtime = this.runtime(prepared, structuredClone(session), candidate.transport)
          attachedRuntime = runtime
        }
        if (candidate.transport.reattached?.()) await this.restoreNativeOutputTurn(runtime, signal)
        await candidate.activate(runtime)
        this.runtimes.set(session.nativeSessionId, runtime)
        this.record(runtime, 'thread.attached', { threadId: session.nativeSessionId })
        return structuredClone(session)
      } catch (error) {
        if (attachedRuntime) attachedRuntime.disposed = true
        const restarting = candidate.transport.reattached?.() && signal?.reason instanceof DomainError
          && signal.reason.code === 'ENGINE_RESTART'
        const results = await Promise.allSettled([
          attachedRuntime ? this.finishTurnResources(attachedRuntime) : Promise.resolve(),
          restarting ? candidate.transport.detachForRestart!() : candidate.transport.close(),
        ])
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length) {
          throw new AggregateError([error, ...failures], 'Native attachment cleanup is unconfirmed.', { cause: error })
        }
        throw error
      }
    })
  }

  /** `thread/fork` copies the source history into a new thread; the source thread is never written. */
  async forkSession(source: NativeSessionReference, value: NativeSessionStart, signal?: AbortSignal): Promise<NativeSessionReference> {
    if (value.kind === 'workflow-consultation') throw new HarnessExecutionError('CONSULTATION_NATIVE_ATTACH_REQUIRED',
      'A consultation cannot fork its coordinator session.')
    return this.beginCreation(value, { forkSource: source, signal })
  }

  async closeForResume(session: NativeSessionReference): Promise<void> {
    this.assertIdle(this.requireRuntime(session))
    await this.close(session)
  }

  async close(session: NativeSessionReference): Promise<void> {
    this.assertSessionVersion(session)
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.runtimes.get(session.nativeSessionId)
      if (!runtime) return
      if (runtime.session.providerVersion !== session.providerVersion) throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
      runtime.closed = true
      runtime.disposed = true
      if (runtime.capacityRetry?.failure) runtime.capacityRetry.controller.abort()
      for (const [id, child] of this.childRuntimes) {
        if (child.runtime.parent !== runtime) continue
        child.runtime.closed = true
        child.runtime.disposed = true
        for (const waiting of child.runtime.interactions.values()) waiting.resolve('cleared')
        this.wake(child.runtime)
        this.childRuntimes.delete(id)
      }
      runtime.starting?.preparationController.abort()
      runtime.starting?.resolveIdentity(undefined)
      // Stop the process even when host cleanup or token revocation fails. Keep
      // ownership until BOTH cleanups succeed, so explicit disposal can retry.
      const fileCleanup = (async () => {
        await Promise.allSettled([runtime.starting?.filePreparation, runtime.starting?.nativeOutputPreparation])
        await this.finishTurnResources(runtime)
      })()
      for (const waiting of runtime.interactions.values()) waiting.resolve('cleared')
      this.wake(runtime)
      const outcomes = await Promise.allSettled([fileCleanup, runtime.transport.close()])
      const failed = outcomes.find((outcome) => outcome.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      if (this.runtimes.get(session.nativeSessionId) === runtime) this.runtimes.delete(session.nativeSessionId)
      for (const [key, creation] of this.creations) if (creation.session?.nativeSessionId === session.nativeSessionId) this.creations.delete(key)
    })
  }

  async originalEnvironment(session: NativeSessionReference, signal?: AbortSignal) {
    this.assertSessionVersion(session)
    if (!this.processRecovery) return undefined
    return detachedStdioEnvironment(this.processRecovery, signal)
  }

  canDetachForRestart(session: NativeSessionReference): boolean {
    const runtime = this.runtimes.get(session.nativeSessionId)
    const pendingTurn = runtime?.phase === 'starting' && runtime.starting?.cancelRequested === false
    return !!this.processRecovery && process.platform === 'linux' && !!runtime
      && runtime.session.harness === session.harness && runtime.session.providerVersion === session.providerVersion
      && !runtime.closed && !runtime.disposed
      && (runtime.activeTurnId !== undefined || pendingTurn)
      && advanced(runtime.configuration).sessionPersistence !== 'ephemeral'
      && runtime.transport.detachForRestart !== undefined
  }

  async closeForRestart(session: NativeSessionReference): Promise<void> {
    this.assertSessionVersion(session)
    const loaded = this.runtimes.get(session.nativeSessionId)
    if (!this.processRecovery || process.platform !== 'linux' || !loaded?.transport.detachForRestart
      || advanced(loaded.configuration).sessionPersistence === 'ephemeral') {
      await this.close(session)
      return
    }
    await this.exclusive(session.nativeSessionId, async () => {
      const runtime = this.runtimes.get(session.nativeSessionId)
      if (!runtime) return
      runtime.closed = true
      runtime.disposed = true
      runtime.starting?.preparationController.abort()
      await Promise.allSettled([runtime.starting?.filePreparation, runtime.starting?.nativeOutputPreparation])
      await this.finishTurnResources(runtime)
      await runtime.transport.detachForRestart!()
      this.transports.delete(runtime.transport)
      this.wake(runtime)
      this.runtimes.delete(session.nativeSessionId)
      for (const [id, child] of this.childRuntimes) {
        if (child.runtime.parent !== runtime) continue
        child.runtime.disposed = true
        this.wake(child.runtime)
        this.childRuntimes.delete(id)
      }
    })
  }

  /** A control-only transport makes fresh login possible without creating a thread. */
  async startDeviceCodeLogin(session?: NativeSessionReference, signal?: AbortSignal): Promise<JsonObject> {
    if (session) {
      const runtime = this.requireRuntime(session)
      this.assertIdle(runtime)
      return object(await runtime.transport.request('account/login/start', { type: 'chatgptDeviceCode' }, signal), 'CODEX_LOGIN_START_INVALID')
    }
    if (this.loginStarting || this.loginControl) throw new HarnessExecutionError('CODEX_LOGIN_ACTIVE', 'A device-code login is already in progress.')
    this.shutdownController.signal.throwIfAborted()
    signal = signal ? AbortSignal.any([signal, this.shutdownController.signal]) : this.shutdownController.signal
    this.loginStarting = true
    try {
      await this.dependencies.prepareEnvironment?.()
      const environment = this.dependencies.environment()
      const qualified = await this.dependencies.qualify(this.binary, process.cwd(), environment, false, signal)
      await this.dependencies.assertUnchanged(qualified)
      const transport = this.dependencies.transport(
        qualified.binary, process.cwd(), environment, qualified.protocol,
        async (request) => { await transport.reject(request.id, -32601, 'Execution requests are not supported by the login transport.') },
        (method) => {
          if (method === 'account/login/completed') {
            void this.closeLoginControl().catch(cleanupError => {
              logIgnoredError('harness', 'clean up Codex login', cleanupError)
              // ignore: failed cleanup retains the login control for explicit close or shutdown.
            })
          }
        },
        () => {
          void this.closeLoginControl().catch(cleanupError => {
            logIgnoredError('harness', 'clean up Codex login', cleanupError)
            // ignore: failed cleanup retains the login control for explicit close or shutdown.
          })
        },
      )
      this.loginControl = { transport }
      try {
        await transport.start(signal)
        const response = object(await transport.request('account/login/start', { type: 'chatgptDeviceCode' }, signal), 'CODEX_LOGIN_START_INVALID')
        const loginId = text(response.loginId)
        if (!loginId) throw new HarnessExecutionError('CODEX_LOGIN_START_INVALID', 'Codex did not return a login identity.')
        if (!this.loginControl) throw new HarnessExecutionError('CODEX_LOGIN_DISCONNECTED', 'The login transport disconnected.')
        this.loginControl.loginId = loginId
        this.loginControl.timer = this.dependencies.schedule(() => {
          void this.closeLoginControl().catch(cleanupError => {
            logIgnoredError('harness', 'clean up Codex login', cleanupError)
            // ignore: failed cleanup retains the login control for explicit close or shutdown.
          })
        }, 15 * 60_000)
        this.loginControl.timer.unref()
        return response
      } catch (error) {
        await this.closeLoginControl().catch(cleanupError => {
          logIgnoredError('harness', 'clean up Codex login', cleanupError)
          // ignore: preserve the login failure; explicit close or shutdown retries cleanup.
        })
        throw error
      }
    } finally { this.loginStarting = false }
  }

  async cancelLogin(session: NativeSessionReference | undefined, loginId: string, signal?: AbortSignal): Promise<void> {
    if (session) { await this.requireRuntime(session).transport.request('account/login/cancel', { loginId }, signal); return }
    const control = this.loginControl
    if (!control || control.loginId !== loginId) throw new HarnessExecutionError('CODEX_LOGIN_UNKNOWN', 'This login identity is not active on the control transport.')
    try { await control.transport.request('account/login/cancel', { loginId }, signal) } finally { await this.closeLoginControl() }
  }

  dispose(): Promise<void> { return this.shutdown() }

  /** Both disposal entry points share one cleanup attempt, including on retries. */
  shutdown(): Promise<void> {
    this.disposal ??= this.shutdownOwned().catch((error: unknown) => {
      this.disposal = undefined
      throw error
    })
    return this.disposal
  }

  /** Application shutdown also owns control and uncertain-creation transports. */
  protected async shutdownOwned(): Promise<void> {
    this.shutdownController.abort(new Error('Codex session manager is shutting down.'))
    const cleanups: Promise<unknown>[] = [...this.transports].map((transport) => transport.close())
    for (const runtime of this.runtimes.values()) cleanups.push(this.close(runtime.session))
    for (const creation of this.creations.values()) {
      this.dependencies.cancelTimer(creation.timer)
      if (creation.transport) cleanups.push(creation.transport.close())
      if (creation.promise) cleanups.push(creation.promise.catch(() => {
        // ignore: creation failure belongs to its caller; shutdown still closes its transport.
      }).then(async () => {
        await creation.transport?.close()
      }))
    }
    cleanups.push(this.closeLoginControl())
    const results = await Promise.allSettled(cleanups)
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    this.creations.clear()
  }

  async closeLoginControl(): Promise<void> {
    const control = this.loginControl
    if (!control) return
    this.dependencies.cancelTimer(control.timer)
    await control.transport.close()
    if (this.loginControl === control) this.loginControl = undefined
  }
}
