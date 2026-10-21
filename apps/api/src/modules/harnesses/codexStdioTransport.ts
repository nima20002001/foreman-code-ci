import { beginRuntimeTiming, runtimeTimingPoint } from '../diagnostics/runtimeTiming.js'
import { randomUUID } from 'node:crypto'
import { HarnessExecutionError } from './errors.js'
import { spawnOwnedStdioProcess } from './process.js'
import { attachDetachedStdio, detachRecoveredChild, hasDetachedStdioProcess,
  nativeProcessExit, type NativeProcessRecovery } from './recovery/processRegistry.js'
import { redactKnownSecrets } from './secrets.js'
import { openCodexRuntimeTiming } from './codexRuntimeTiming.js'
import { ignoreError, logIgnoredError } from '../diagnostics/ignoredError.js'

export type JsonObject = Record<string, unknown>
export type RequestId = string | number
export interface RpcRequest { id: RequestId; method: string; params?: JsonObject }
export interface CodexProtocol {
  providerVersion?: string | undefined
  request(message: RpcRequest): void
  notification(message: JsonObject): void
  serverRequest(message: RpcRequest): void
  response(method: string, value: unknown): void
  serverResponse(method: string, value: unknown): void
}
export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
export function object(value: unknown, code = 'CODEX_PROTOCOL_INVALID'): JsonObject {
  if (!isObject(value)) throw new HarnessExecutionError(code, 'Codex returned an invalid structured response.')
  return value
}

export class CodexRpcError extends HarnessExecutionError {
  readonly nativeMessage: string | undefined
  constructor(
    readonly method: string,
    readonly operationId: RequestId,
    readonly uncertain: boolean,
    code: string,
    details: { nativeMessage?: string | undefined; providerVersion?: string | undefined } = {},
    options?: ErrorOptions,
  ) {
    const message = uncertain
      ? `Codex ${details.providerVersion ?? 'unknown version'}: the outcome of ${method} is uncertain; reconcile before retrying.`
      : `Codex ${details.providerVersion ?? 'unknown version'} did not accept the ${method} command contract.`
    const preflightMessage = options?.cause instanceof HarnessExecutionError ? options.cause.message : undefined
    super(code, preflightMessage ?? message, false, options)
    this.nativeMessage = details.nativeMessage
  }
}

interface Operation {
  method: string
  submitted: boolean
  reconnectFrame?: string
  resolve(value: unknown): void
  reject(error: Error): void
  cleanup(): void
  late?: (value: unknown, error?: Error) => void
}
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const MAX_OPERATIONS = 256
const MODEL_REFRESH_FAILURE = 'failed to refresh available models:'
const RECONNECT_READ_METHODS = new Set(['thread/read', 'thread/turns/list', 'thread/items/list'])

/** All stream and dispatch failures end at this boundary, never at EventEmitter. */
export class CodexStdioTransport {
  private owned?: Awaited<ReturnType<typeof spawnOwnedStdioProcess>>
  private reconnected?: Awaited<ReturnType<typeof attachDetachedStdio>>
  private readonly requestPrefix = randomUUID()
  private detached = false
  reattached(): boolean { return this.reconnected !== undefined }
  originalProcessClosed(): boolean {
    return this.reconnected?.originalProcessClosed() === true
  }
  retainedThreadSettings(threadId: string): JsonObject | undefined {
    const settings = this.reconnected?.threadSettings[threadId]
    return isObject(settings) ? settings : undefined
  }
  private readonly operations = new Map<RequestId, Operation>()
  private readonly uncertainOperations = new Map<RequestId, Operation>()
  private readonly writes = new Set<(error: Error) => void>()
  private nextId = 1
  private stopped = false
  private closePromise: Promise<void> | undefined
  private reconnection: Promise<void> | undefined
  private observerUnavailable: Error | undefined
  private readonly connectionController = new AbortController()
  private timing: Awaited<ReturnType<typeof openCodexRuntimeTiming>> | undefined
  private diagnosticTail = ''

  constructor(
    private readonly binary: string,
    private readonly cwd: string,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly protocol: CodexProtocol,
    private readonly onRequest: (request: RpcRequest) => Promise<void>,
    private readonly onNotification: (method: string, params: JsonObject) => void,
    private readonly onDisconnect: (error: Error) => void,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly processRecovery?: NativeProcessRecovery,
    /** Process-local only; never edits the native configuration file. */
    private readonly disabledMcpServerNames: readonly string[] = [],
    private readonly onModelRefreshFailure?: () => void,
    private readonly restartOptions: {
      reconnectableStdio?: boolean
      nativeApps?: boolean | undefined
      nativePlugins?: boolean
      mcpTransportOverrides?: Record<string, string>
    } = {},
  ) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.owned || this.reconnected || this.stopped) throw new HarnessExecutionError('CODEX_TRANSPORT_REUSED', 'Create a new provider transport.')
    if (this.restartOptions.reconnectableStdio && this.processRecovery && hasDetachedStdioProcess(this.processRecovery)) {
      this.reconnected = await attachDetachedStdio(this.processRecovery, signal)
      this.observeSocket(this.reconnected)
      return
    }
    if (this.disabledMcpServerNames.some((name) => !/^[A-Za-z0-9_-]+$/.test(name))) {
      throw new HarnessExecutionError('CODEX_APP_MCP_UNAVAILABLE', 'The App MCP name cannot be represented safely by a native dotted-key override.')
    }
    if (this.environment.FOREMAN_CODE_CODEX_RUNTIME_TIMING === '1') {
      try { this.timing = await openCodexRuntimeTiming() }
      catch (error) { logIgnoredError('harness', 'publish native API timing', error); runtimeTimingPoint('harness', 'native.api_timing_unavailable', { eventType: 'receiver_unavailable' }) }
    }
    try {
      this.owned = await spawnOwnedStdioProcess({
        binary: this.binary, args: ['app-server', '--stdio',
          ...Object.entries(this.restartOptions.mcpTransportOverrides ?? {})
            .flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
          ...this.disabledMcpServerNames.flatMap((name) => ['-c', `mcp_servers.${name}.enabled=false`]),
          ...(this.restartOptions.nativeApps !== undefined
            ? ['-c', `features.apps=${this.restartOptions.nativeApps}`] : []),
          ...(this.restartOptions.nativePlugins !== undefined
            ? ['-c', `features.plugins=${this.restartOptions.nativePlugins}`] : []),
          ...(this.timing?.arguments ?? []),
        ], cwd: this.cwd, environment: this.environment,
        onError: (error) => this.fail(error),
        ...(signal ? { signal } : {}),
        beforeSpawn: () => {
          if (this.stopped) throw new HarnessExecutionError('CODEX_TRANSPORT_REUSED', 'Create a new provider transport.')
        },
        ...(this.onModelRefreshFailure ? { preserveReadableDrain: true } : {}),
        ...(this.processRecovery ? { recovery: this.processRecovery } : {}),
        ...(this.restartOptions.reconnectableStdio && this.processRecovery ? { reconnectableStdio: true } : {}),
      })
    } catch (error) { await this.closeTiming(); throw error }
    const { child, closed } = this.owned
    // Drain diagnostics without retaining or exposing provider stderr.
    if (this.onModelRefreshFailure) child.stderr.on('data', (chunk: Buffer) => {
      const text = this.diagnosticTail + chunk.toString('utf8')
      if (text.includes(MODEL_REFRESH_FAILURE)) this.onModelRefreshFailure?.()
      this.diagnosticTail = text.slice(-(MODEL_REFRESH_FAILURE.length - 1))
    })
    else child.stderr.resume()
    void this.readFrames().catch((error: unknown) => this.fail(error instanceof Error ? error : new Error('Codex dispatch failed.')))
    void closed.then(() => this.fail(new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Codex app-server disconnected.')))
    try {
      await this.request('initialize', {
        clientInfo: { name: 'foreman-code', title: 'Foreman Code', version: '0.1.0' },
        capabilities: { experimentalApi: true, extensions: { 'openai/form': {} } },
      }, signal)
      await this.write({ method: 'initialized' })
    } catch (error) {
      await this.close().catch(ignoreError('harness', 'close Codex transport', { connectionId: this.requestPrefix }))
      throw error
    }
  }

  async request(
    method: string, params?: JsonObject, signal?: AbortSignal,
    late?: (value: unknown, error?: Error) => void,
  ): Promise<unknown> {
    if (this.reconnected && (this.observerUnavailable || this.reconnected.socket.destroyed)) {
      this.recoverObserver(this.reconnected, this.observerUnavailable ?? new HarnessExecutionError(
        'CODEX_APP_SERVER_DISCONNECTED', 'The original Codex observer disconnected.'))
    }
    if (this.reconnection) await this.waitForReconnection(signal)
    const id = `${this.requestPrefix}:${this.nextId++}`
    let frame: string
    try {
      signal?.throwIfAborted()
      this.assertConnected()
      const message: RpcRequest = { id, method, ...(params === undefined ? {} : { params }) }
      this.protocol.request(message)
      frame = this.encode({ ...message })
      if (this.operations.size + this.uncertainOperations.size >= MAX_OPERATIONS) {
        throw new HarnessExecutionError('CODEX_OPERATION_LIMIT', 'Too many unresolved provider operations; reconcile before submitting more.')
      }
    } catch (error) {
      const fallback = signal?.aborted ? 'CODEX_APP_SERVER_REQUEST_CANCELED' : 'CODEX_PROTOCOL_INVALID'
      const code = error instanceof HarnessExecutionError ? error.result.error!.code : fallback
      throw new CodexRpcError(method, id, false, code, { providerVersion: this.protocol.providerVersion }, { cause: error })
    }
    const finished = beginRuntimeTiming('harness', 'native.rpc', { operation: method, intervalMs: this.timeoutMs,
      ...(typeof params?.threadId === 'string' ? { nativeSessionId: params.threadId } : {}) })
    return new Promise<unknown>((resolve, reject) => {
      const abort = () => this.settleFailure(id, 'CODEX_APP_SERVER_REQUEST_CANCELED')
      const timer = setTimeout(() => {
        const recoveringRead = RECONNECT_READ_METHODS.has(method) && this.reconnection !== undefined
        this.settleFailure(id, recoveringRead ? 'CODEX_OBSERVER_UNAVAILABLE' : 'CODEX_APP_SERVER_TIMEOUT')
      }, this.timeoutMs)
      const operation: Operation = {
        method, resolve, reject, submitted: false, ...(late ? { late } : {}),
        ...(RECONNECT_READ_METHODS.has(method) ? { reconnectFrame: frame } : {}),
        cleanup: () => { finished(); clearTimeout(timer); signal?.removeEventListener('abort', abort) },
      }
      this.operations.set(id, operation)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      // Once write is attempted, neither EPIPE nor abort proves non-delivery.
      operation.submitted = true
      try {
        this.input().write(frame, (error: Error | null | undefined) => {
          if (error) this.operationWriteFailed(id, error)
        })
      } catch (error) {
        this.operationWriteFailed(id, error instanceof Error ? error : new Error('Provider write failed.'))
      }
    })
  }

  async respond(id: RequestId, method: string, result: JsonObject): Promise<void> {
    try { this.protocol.serverResponse(method, result) } catch {
      throw new HarnessExecutionError('NATIVE_RESPONSE_INVALID', 'The response does not match the qualified native schema; nothing was submitted.')
    }
    this.assertConnected('NATIVE_RESPONSE_DELIVERY_FAILED')
    try { this.encode({ id, result }) } catch {
      throw new HarnessExecutionError('NATIVE_RESPONSE_INVALID', 'The native response exceeds the bounded frame size; nothing was submitted.')
    }
    if (this.writes.size >= MAX_OPERATIONS) throw new HarnessExecutionError(
      'NATIVE_RESPONSE_DELIVERY_FAILED', 'Too many outstanding provider writes; nothing was submitted.')
    try { await this.write({ id, result }) } catch {
      throw new HarnessExecutionError('NATIVE_RESPONSE_DELIVERY_UNCERTAIN', 'The native response may have been submitted; wait for native resolution before retrying.')
    }
  }

  async reject(id: RequestId, code: number, message: string): Promise<void> {
    await this.write({ id, error: { code, message } })
  }

  close(): Promise<void> {
    if (this.detached) return Promise.resolve()
    if (this.closePromise) return this.closePromise
    this.stop(new HarnessExecutionError('CODEX_APP_SERVER_CLOSED', 'Codex transport was closed.'))
    const physical = this.onModelRefreshFailure ? this.closeModelInspection()
      : this.closeProcess()
    const attempt = this.timing ? physical.then(() => this.closeTiming()) : physical
    this.closePromise = attempt
    // A failed cleanup stays fenced, but the next explicit close must retry it.
    void attempt.catch(() => { if (this.closePromise === attempt) this.closePromise = undefined })
    return attempt
  }

  async detachForRestart(): Promise<void> {
    if (this.detached) return
    if (!this.restartOptions.reconnectableStdio || !this.processRecovery) {
      await this.close()
      return
    }
    this.stop(new HarnessExecutionError('CODEX_APP_SERVER_DETACHED', 'Codex observation paused for restart.'))
    if (this.reconnection) await Promise.allSettled([this.reconnection])
    if (this.reconnected) await this.reconnected.detach()
    else if (this.owned) await detachRecoveredChild(this.owned.child)
    this.detached = true
    await this.closeTiming()
  }

  private input() {
    if (this.reconnected) return this.reconnected.socket
    if (!this.owned) throw new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED', 'Codex is not connected.')
    return this.owned.child.stdin
  }

  private async closeProcess(): Promise<void> {
    if (this.reconnection) await Promise.allSettled([this.reconnection])
    await (this.reconnected?.close() ?? this.owned?.close())
  }

  private async waitForReconnection(signal?: AbortSignal): Promise<void> {
    if (!signal) return this.reconnection
    signal.throwIfAborted()
    let abort: (() => void) | undefined
    try {
      await Promise.race([this.reconnection, new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })])
    } finally {
      if (abort) signal.removeEventListener('abort', abort)
    }
  }

  private operationWriteFailed(id: RequestId, error: Error): void {
    if (this.reconnected) this.recoverObserver(this.reconnected, error)
    else this.settleFailure(id, 'CODEX_APP_SERVER_REQUEST_UNCERTAIN')
  }

  private observeSocket(connection: NonNullable<CodexStdioTransport['reconnected']>): void {
    const { socket } = connection
    socket.on('error', error => this.recoverObserver(connection, error))
    socket.on('close', () => this.recoverObserver(connection, new HarnessExecutionError(
      'CODEX_APP_SERVER_DISCONNECTED', 'The original Codex observer disconnected.')))
    void this.readFrames(socket).catch(error => {
      const failure = error instanceof Error ? error : new Error('Codex dispatch failed.')
      if (socket.destroyed) this.recoverObserver(connection, failure)
      else this.fail(failure)
    })
    socket.resume()
  }

  private recoverObserver(connection: NonNullable<CodexStdioTransport['reconnected']>, error: Error): void {
    if (this.stopped || this.reconnected !== connection || this.reconnection) return
    for (const [id, operation] of this.operations) {
      if (!operation.reconnectFrame) this.settleFailure(id, 'CODEX_OBSERVER_UNAVAILABLE')
    }
    for (const failed of [...this.writes]) failed(error)
    const attempt = Promise.resolve().then(() => this.reconnectObserver(connection))
      .catch(failure => this.recoveryFailed(connection, failure))
    this.reconnection = attempt
    const clear = () => {
      if (this.reconnection === attempt) this.reconnection = undefined
    }
    void attempt.then(clear, clear)
  }

  private async reconnectObserver(connection: NonNullable<CodexStdioTransport['reconnected']>): Promise<void> {
    // Authenticated release keeps the registered daemon and drops incomplete observer input.
    await connection.detach()
    this.connectionController.signal.throwIfAborted()
    const replacement = await attachDetachedStdio(this.processRecovery!, this.connectionController.signal)
    this.reconnected = replacement
    this.observerUnavailable = undefined
    if (this.stopped) return
    this.observeSocket(replacement)
    const replayed: Promise<void>[] = []
    for (const operation of this.operations.values()) {
      if (!operation.reconnectFrame) continue
      replayed.push(new Promise<void>((resolve, reject) => {
        replacement.socket.write(operation.reconnectFrame!, error => {
          if (error) reject(error)
          else resolve()
        })
      }))
    }
    await Promise.all(replayed)
    if (replacement.socket.destroyed) throw new HarnessExecutionError(
      'CODEX_APP_SERVER_DISCONNECTED', 'The original Codex observer could not reconnect.')
    this.onNotification('transport/reconnected', {})
  }

  private recoveryFailed(connection: NonNullable<CodexStdioTransport['reconnected']>, failure: unknown): never {
    if (this.stopped) throw failure
    let closed = false
    try { closed = connection.originalProcessClosed() }
    catch (closureError) {
      failure = new AggregateError([failure, closureError], 'Original Codex process closure is unconfirmed.')
    }
    if (closed) {
      const disconnected = new HarnessExecutionError('CODEX_APP_SERVER_DISCONNECTED',
        'The original Codex daemon has exited.', false, { cause: failure })
      this.fail(disconnected)
      throw disconnected
    }
    this.observerUnavailable = new HarnessExecutionError('CODEX_OBSERVER_UNAVAILABLE',
      'Codex is still recoverable, but its observer connection is unavailable.', true, { cause: failure })
    for (const id of this.operations.keys()) this.settleFailure(id, 'CODEX_OBSERVER_UNAVAILABLE')
    this.onNotification('transport/observerUnavailable', {})
    throw this.observerUnavailable
  }

  private async closeTiming() {
    // Optional diagnostics cannot change native execution or physical-closure results.
    try { await this.timing?.close() }
    catch (error) {
      runtimeTimingPoint('harness', 'native.api_timing_unavailable', { eventType: 'receiver_close_failed' })
      logIgnoredError('harness', 'close timing receiver', error, { connectionId: this.requestPrefix })
    }
  }

  private async closeModelInspection(): Promise<void> {
    if (!this.owned) return
    let timer: NodeJS.Timeout | undefined
    let failed = false
    let failure: unknown
    try {
      // EOF and child close drain stderr before deciding whether discovery succeeded.
      this.owned.child.stdin.end()
      await Promise.race([this.owned.closed, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE',
          'Native model diagnostics did not finish.', true)), this.timeoutMs)
      })])
    } catch (error) {
      failed = true
      failure = error
    } finally { clearTimeout(timer) }
    try { await this.owned.close() }
    catch (cleanup) {
      if (failed) throw new AggregateError([failure, cleanup], 'Native model diagnostics and cleanup failed.', { cause: cleanup })
      throw cleanup
    }
    if (failed) throw failure
  }

  /** Current writable callback channel only; this snapshot is not delivery evidence. */
  isConnected(): boolean {
    if (this.reconnected) {
      return !this.stopped && !this.observerUnavailable && !this.reconnection && !this.reconnected.socket.destroyed
    }
    const child = this.owned?.child
    if (this.stopped || !child) return false
    try {
      const outcome = nativeProcessExit(child, { exitCode: child.exitCode, exitSignal: child.signalCode })
      if (outcome.exitCode !== null || outcome.exitSignal !== null) return false
    } catch (error) { logIgnoredError('harness', 'read Codex process exit evidence', error); return false }
    return child.stdin.writable && !child.stdin.destroyed && !child.stdin.writableEnded
  }

  private assertConnected(code = 'CODEX_APP_SERVER_DISCONNECTED'): void {
    if (this.stopped || this.input().destroyed) {
      throw new HarnessExecutionError(code, 'Codex app-server is not connected.')
    }
  }

  private write(message: JsonObject): Promise<void> {
    this.assertConnected()
    const frame = this.encode(message)
    if (this.writes.size >= MAX_OPERATIONS) throw new HarnessExecutionError(
      'CODEX_WRITE_LIMIT', 'Too many outstanding provider writes; wait for delivery before submitting more.')
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error | null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.writes.delete(finish)
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => finish(new Error('Provider write timed out.')), this.timeoutMs)
      this.writes.add(finish)
      try { this.input().write(frame, finish) } catch (error) {
        finish(error instanceof Error ? error : new Error('Provider write failed.'))
      }
    })
  }

  /** Reject oversized output before any write, so delivery is definitely absent. */
  private encode(message: JsonObject): string {
    const frame = JSON.stringify(message) + '\n'
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new HarnessExecutionError(
      'CODEX_OUTBOUND_FRAME_LIMIT', 'The provider request exceeds the bounded frame size; nothing was submitted.')
    return frame
  }

  private settleFailure(id: RequestId, code: string): void {
    const operation = this.operations.get(id)
    if (!operation) return
    this.operations.delete(id)
    operation.cleanup()
    if (operation.submitted && (!operation.reconnectFrame || operation.late)) {
      this.uncertainOperations.set(id, operation)
    }
    operation.reject(new CodexRpcError(operation.method, id, operation.submitted, code, { providerVersion: this.protocol.providerVersion }))
  }

  private async readFrames(stdout = this.reconnected?.socket ?? this.owned!.child.stdout): Promise<void> {
    stdout.setEncoding('utf8')
    let pending = ''
    for await (const chunk of stdout) {
      if (this.stopped) {
        if (this.onModelRefreshFailure) continue
        break
      }
      pending += String(chunk)
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) throw new Error('Codex stdout frame exceeded its limit.')
        if (line.trim()) await this.receive(line)
        if (this.stopped) {
          if (this.onModelRefreshFailure) { pending = ''; break }
          return
        }
      }
      if (Buffer.byteLength(pending) > MAX_FRAME_BYTES) throw new Error('Codex stdout frame exceeded its limit.')
    }
    if (pending && !this.stopped) this.onNotification('protocol/malformed', { reason: 'incomplete_frame' })
  }

  private async receive(line: string): Promise<void> {
    let message: unknown
    try { message = redactKnownSecrets(JSON.parse(line), [this.environment.GRAPHQL_MCP_TOKEN ?? '', this.environment.FOREMAN_CODE_MCP_TOKEN ?? '']) } catch {
      this.onNotification('protocol/malformed', { reason: 'invalid_json' }); return
    }
    if (!isObject(message)) { this.onNotification('protocol/malformed', { reason: 'invalid_envelope' }); return }
    const id = typeof message.id === 'string' || (typeof message.id === 'number' && Number.isSafeInteger(message.id)) ? message.id : undefined
    const method = text(message.method)
    if ((typeof id === 'string' && id.length > 1_024) || (method && method.length > 256)) {
      this.onNotification('protocol/malformed', { reason: 'identity_size_limit' }); return
    }
    if (id !== undefined && method) {
      const request: RpcRequest = { id, method, ...(isObject(message.params) ? { params: message.params } : {}) }
      try {
        this.protocol.serverRequest(request)
        await this.onRequest(request)
      } catch {
        // Never echo untrusted native payloads or secrets in errors.
        await this.reject(id, -32602, 'Invalid or unsupported native interaction.').catch((error: unknown) => {
          this.fail(error instanceof Error ? error : new Error('Native request rejection failed.'))
        })
        this.onNotification('protocol/malformed', { reason: 'invalid_request', nativeMethod: method })
      }
      return
    }
    if (id !== undefined) {
      const operation = this.operations.get(id) ?? this.uncertainOperations.get(id)
      if (!operation) return
      const wasLate = this.uncertainOperations.has(id)
      let error: Error | undefined
      if (isObject(message.error) && typeof message.error.code === 'number' && typeof message.error.message === 'string') {
        error = new CodexRpcError(operation.method, id, false, message.error.code === -32601 ? 'CODEX_CONTRACT_UNSUPPORTED' : 'CODEX_APP_SERVER_REQUEST_FAILED',
          { nativeMessage: message.error.message, providerVersion: this.protocol.providerVersion })
      } else {
        try {
          if (!Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) throw new Error('Malformed response.')
          this.protocol.response(operation.method, message.result)
        } catch {
          this.settleFailure(id, 'CODEX_APP_SERVER_RESPONSE_INVALID')
          this.onNotification('protocol/malformed', { reason: 'invalid_response', nativeMethod: operation.method })
          return
        }
      }
      this.operations.delete(id)
      this.uncertainOperations.delete(id)
      operation.cleanup()
      if (wasLate) operation.late?.(message.result, error)
      else if (error) operation.reject(error)
      else operation.resolve(message.result)
      return
    }
    if (method) {
      try { this.protocol.notification(message) } catch {
        this.onNotification('protocol/malformed', { reason: 'invalid_notification', nativeMethod: method }); return
      }
      this.onNotification(method, isObject(message.params) ? message.params : {})
    } else this.onNotification('protocol/malformed', { reason: 'invalid_envelope' })
  }

  private stop(error: Error): boolean {
    if (this.stopped) return false
    this.stopped = true
    this.connectionController.abort(error)
    for (const id of this.operations.keys()) this.settleFailure(id, 'CODEX_APP_SERVER_DISCONNECTED')
    for (const failed of [...this.writes]) failed(error)
    this.writes.clear()
    return true
  }

  private fail(error: Error): void {
    if (!this.stop(error)) return
    try { this.onDisconnect(error) } catch (observerError) { logIgnoredError('harness', 'publish Codex disconnect', observerError) }
    void this.close().catch(ignoreError('harness', 'close Codex transport', { connectionId: this.requestPrefix }))
  }
}
