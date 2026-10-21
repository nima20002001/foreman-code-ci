/** Manager state, ownership guards and the bounded native event log. */
import { beginRuntimeTiming, runtimeTimingPoint } from '../../diagnostics/runtimeTiming.js'
import { isWorkflowStart, sessionStartSystemPrompt } from '../sessionStart.js'
import { type SessionPreferences, NativeHarnessEventSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { APP_MCP_SERVER_NAME } from '../appMcpLauncher.js'
import { randomUUID } from 'node:crypto'
import { HarnessExecutionError } from '../errors.js'
import type { CodexChatFiles } from '../codexFiles/runtime.js'
import type { CodexNativeOutputs } from '../codexNativeOutput.js'
import { qualifyNativeCodexModel } from '../codexQualification.js'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import type { NativeSessionStart } from '../port.js'
import { runCommand } from '../process.js'
import { assertCodexUnchanged, qualifyCodex } from '../codexProtocol.js'
import { canonicalJsonNumericKeysFirstLegacy } from '@foreman-code/contracts/canonical-json'
import { CodexChildControls } from '../codexChildControls.js'
import { codexResponseDeliveryEvidence } from '../codexResponseDelivery.js'
import type { NativeResponseJournal } from '../recovery/responseJournal.js'
import type { RunSubagent } from '@foreman-code/contracts/subagents'
import { CodexStdioTransport, isObject, type JsonObject } from '../codexStdioTransport.js'
import type { CodexTransport, CodexSessionOperations, CodexSessionDependencies, CodexInspectionOptions, Runtime,
  Creation } from './types.js'
import { MAX_EVENTS, MAX_EVENT_BYTES, MAX_UNREAD_EVENT_BYTES, MAX_INTERACTIONS, accepted, ownerId, binding,
  safeEnvironment, validateEnvironmentOwner } from './support.js'

export abstract class CodexManagerBase {
  readonly harness = 'codex' as const
  protected startupPreferences: SessionPreferences | undefined
  protected readonly runtimes = new Map<string, Runtime>()
  protected readonly locks = new Set<string>()
  protected readonly creations = new Map<string, Creation>()
  protected readonly childControls = new CodexChildControls()
  protected readonly childRuntimes = new Map<string, { runtime: Runtime; child: RunSubagent; assertCurrent(): void }>()
  protected readonly lifecycleTails = new Map<string, Promise<void>>()
  protected loginControl: { transport: CodexTransport; loginId?: string; timer?: NodeJS.Timeout } | undefined
  protected loginStarting = false
  protected disposal: Promise<void> | undefined
  protected readonly shutdownController = new AbortController()
  protected readonly transports = new Set<CodexTransport>()

  protected readonly dependencies: CodexSessionOperations

  constructor(
    protected readonly binary: string,
    protected readonly expectedVersion?: string,
    protected readonly appMcpServerName: string = APP_MCP_SERVER_NAME,
    protected readonly processRecovery?: NativeProcessRecovery,
    /** Agent chat disables only its App MCP entry with a verified process-local override. */
    protected readonly appMcpAccess: 'scoped' | 'none' = 'scoped',
    protected readonly chatFiles?: CodexChatFiles,
    dependencies: CodexSessionDependencies = { mode: 'native' },
    protected readonly inspection: CodexInspectionOptions = {},
    protected readonly nativeOutputs?: CodexNativeOutputs,
    protected readonly responseJournal?: NativeResponseJournal,
  ) {
    const defaults: CodexSessionOperations = {
      transport: (...args) => new CodexStdioTransport(...args),
      qualify: (binary, cwd, environment, authentication, signal) =>
        qualifyCodex(binary, cwd, environment, authentication, signal, this.processRecovery),
      assertUnchanged: assertCodexUnchanged, environment: safeEnvironment,
      runCommand: (binary, args, cwd, signal, environment, options) => runCommand(binary, args, cwd, signal, environment,
        { ...options, ...(this.processRecovery ? { recovery: this.processRecovery } : {}) }),
      qualifyModel: (configuration, binary, cwd, environment, signal, _recovery, inspection) =>
        qualifyNativeCodexModel(configuration, binary, cwd, environment, signal, this.processRecovery, inspection),
      id: randomUUID, now: () => new Date(), schedule: setTimeout, cancelTimer: clearTimeout,
      withDiagnostics: async (pin, run) => {
        if (this.processRecovery) throw new HarnessExecutionError('CODEX_DIAGNOSTIC_OWNER_REQUIRED',
          'Idle native inspection requires a separately owned diagnostic lifetime.')
        return run({ ...this.dependencies, environment: (_input, names = []) =>
          this.dependencies.environment(undefined, [...pin.scopedCredentialVariables, ...names]) })
      },
    }
    if (dependencies.mode === 'replay') {
      for (const key of Object.keys(defaults) as Array<keyof CodexSessionOperations>) {
        if (typeof dependencies[key] !== 'function') throw new HarnessExecutionError(
          'CODEX_REPLAY_DEPENDENCIES_REQUIRED', 'Replay requires every native IO boundary to be explicitly supplied.')
      }
    }
    this.dependencies = { ...defaults, ...dependencies }
  }

  protected assertSessionVersion(session: NativeSessionReference): void {
    if (session.harness !== 'codex') {
      throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The session does not match this qualified Codex provider.')
    }
  }
  protected requireRuntime(session: NativeSessionReference): Runtime {
    this.assertSessionVersion(session)
    const child = this.childRuntimes.get(session.nativeSessionId)
    child?.assertCurrent()
    const runtime = this.runtimes.get(session.nativeSessionId) ?? child?.runtime
    if (!runtime || runtime.disposed) throw new HarnessExecutionError('CODEX_SESSION_UNAVAILABLE', 'The Codex native session is not loaded.')
    if (runtime.session.providerVersion !== session.providerVersion) throw new HarnessExecutionError('CODEX_SESSION_VERSION_MISMATCH', 'The loaded session belongs to another Codex release.')
    return runtime
  }
  protected assertBinding(runtime: Runtime, input: NativeSessionStart): void {
    validateEnvironmentOwner(input)
    if (runtime.binding !== binding(input) || runtime.ownerId !== ownerId(input)) {
      throw new HarnessExecutionError('CODEX_SESSION_OWNER_MISMATCH', 'The loaded session belongs to a different owner or scope.')
    }
    if (runtime.configurationIdentity !== canonicalJsonNumericKeysFirstLegacy(accepted(input))) {
      throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH', 'The loaded session has a different accepted configuration snapshot.')
    }
    if (canonicalJsonNumericKeysFirstLegacy(sessionStartSystemPrompt(runtime.input) ?? null)
      !== canonicalJsonNumericKeysFirstLegacy(sessionStartSystemPrompt(input) ?? null)) {
      throw new HarnessExecutionError('CODEX_SESSION_CONFIGURATION_MISMATCH',
        'The loaded session has a different accepted system prompt snapshot.')
    }
  }
  protected assertIdle(runtime: Runtime): void {
    if (runtime.phase !== 'idle' || runtime.streamActive || runtime.interactions.size > 0) {
      throw new HarnessExecutionError('CODEX_SESSION_BUSY', 'This operation requires an idle, fully reconciled session.')
    }
  }
  protected async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.lifecycleTails.get(key)
    let release!: () => void
    const tail = new Promise<void>((resolve) => { release = resolve })
    this.lifecycleTails.set(key, tail)
    this.locks.add(key)
    try {
      await previous
      return await operation()
    } finally {
      if (this.lifecycleTails.get(key) === tail) {
        this.lifecycleTails.delete(key)
        this.locks.delete(key)
      }
      release()
    }
  }

  protected ownTransport(transport: CodexTransport): CodexTransport {
    this.transports.add(transport)
    const close = transport.close.bind(transport)
    transport.close = async () => {
      await close()
      this.transports.delete(transport)
    }
    return transport
  }

  protected record(runtime: Runtime, type: string, payload: JsonObject): void {
    const event = NativeHarnessEventSchema.parse({
      sequence: runtime.sequence, connectionId: runtime.connectionId, type, occurredAt: this.dependencies.now().toISOString(), payload,
    })
    const size = Buffer.byteLength(JSON.stringify(event))
    if (size > MAX_EVENT_BYTES) throw new HarnessExecutionError('NATIVE_EVENT_TOO_LARGE', 'A native event exceeded the bounded delivery window.')
    runtime.sequence += 1
    runtime.events.push(event)
    const item = isObject(payload.item) ? payload.item : undefined
    runtimeTimingPoint('harness', 'native.event', { nativeSessionId: runtime.session.nativeSessionId,
      ...(isWorkflowStart(runtime.input)
        ? { runId: runtime.input.request.runId, executionId: runtime.input.request.executionId } : {}),
      eventType: type, sequence: event.sequence,
      ...(typeof payload.nativeMethod === 'string' ? { nativeMethod: payload.nativeMethod } : {}),
      ...(typeof payload.turnId === 'string' ? { nativeTurnId: payload.turnId } : {}),
      ...(typeof item?.type === 'string' ? { itemType: item.type } : {}) })
    runtime.eventSizes.push(size)
    runtime.eventBytes += size
    while (runtime.events.length > MAX_EVENTS || runtime.eventBytes > MAX_EVENT_BYTES) {
      const unread = runtime.streamCursor !== undefined && runtime.events[0]!.sequence >= runtime.streamCursor
      if (unread && runtime.eventBytes <= MAX_UNREAD_EVENT_BYTES) break
      runtime.events.shift()
      runtime.eventBytes -= runtime.eventSizes.shift()!
    }
    this.captureResponseDeliveries(runtime)
    this.wake(runtime)
  }
  protected captureResponseDeliveries(runtime: Runtime): void {
    for (const [id, decision] of runtime.responseDecisions) {
      const proof = codexResponseDeliveryEvidence(decision.pending, decision.option, decision.nativeResponse,
        { events: runtime.events, pendingInteractions: [] })
      if (!proof) {
        if (decision.sequence < (runtime.events[0]?.sequence ?? runtime.sequence)) runtime.responseDecisions.delete(id)
        continue
      }
      this.responseJournal?.record(proof)
      runtime.responseDeliveries.set(id, proof)
      runtime.responseDecisions.delete(id)
      if (runtime.responseDeliveries.size > MAX_INTERACTIONS) {
        runtime.responseDeliveries.delete(runtime.responseDeliveries.keys().next().value!)
      }
    }
  }
  protected wake(runtime: Runtime): void {
    for (const resolve of runtime.wake) resolve()
    runtime.wake.clear()
  }
  protected wait(runtime: Runtime, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    return new Promise<void>((resolve, reject) => {
      const finished = beginRuntimeTiming('harness', 'native.notification_wait',
        { nativeSessionId: runtime.session.nativeSessionId })
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Aborted')) }
      const cleanup = () => { finished(); runtime.wake.delete(done); signal?.removeEventListener('abort', abort) }
      runtime.wake.add(done)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
}
