import { CI_HOST_NAMESPACE, CiHostRequestSchema } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import { createHash, randomUUID } from 'node:crypto'
import {
  DEVICE_APPLICATION_BUFFER_BYTES, DEVICE_APPLICATION_CHUNK_BYTES, DEVICE_APPLICATION_CHUNK_WINDOW,
  WORKER_MCP_CHUNK_WINDOW,
  DEVICE_APPLICATION_IN_FLIGHT, DEVICE_APPLICATION_OBSERVATION_IN_FLIGHT,
  DEVICE_APPLICATION_STOP_IN_FLIGHT, DEVICE_APPLICATION_STOP_BYTES,
  DEVICE_APPLICATION_CALLBACK_IN_FLIGHT,
  parseExtensionDescriptors, type DeviceApplicationResult, type DeviceExtensionDescriptor, type DeviceNegotiatedExtension,
  type DeviceRequestPriority,
} from '@foreman-code/contracts/device-application'
import { DEVICE_BUFFER_BYTES, type DeviceFrame, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RemoteExecutionRpcRequestSchema, WorkerConversationRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { ExecutionAuthorityRequestSchema, EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import type { AcceptedNodePlacement, DispatchIntent } from '@foreman-code/contracts/node-placement'
import { DeviceConnectionError, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket, type DeviceMessageIterator } from './deviceWire.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError, deviceApplicationFailure } from './deviceApplicationError.js'
import { deviceRequestTimeoutMs, retryDeviceRequest, waitForDeviceRetry } from './deviceRequestRetry.js'
import { MainClock } from './workerClock.js'
import { isTransientDatabaseOrSocketError } from '@foreman-code/contracts/failure'
import {
  DeviceRequestQueue, deviceForegroundWaitMs, deviceRequestIsBulk, deviceRequestIsObservation,
  effectiveDeviceRequestPriority, deviceRequestIsCopyAuthorization,
} from './deviceRequestQueue.js'
import { operationProgressReporter, withOperationProgress } from '../operationProgress.js'
export { DeviceApplicationError } from './deviceApplicationError.js'

/** A link whose authority was confirmed this recently keeps serving work while the database is slow or short of
 * connections. Revocation closes the link directly, and every heartbeat still re-reads its authority. */
const authorizationReuseMs = 120_000

export interface DeviceExtensionContext { binding: Readonly<DeviceSessionBinding>; signal: AbortSignal; connectionSignal?: AbortSignal; bytes?: Uint8Array }
export interface DeviceExtensionRegistration extends DeviceExtensionDescriptor {
  /** Domain handler MUST validate its execution/job/transfer grant and immutable target. */
  handle?(payload: unknown, context: DeviceExtensionContext): Promise<DeviceApplicationResult>
}
export interface DeviceApplicationRequestOptions {
  signal?: AbortSignal; bytes?: Uint8Array; timeoutMs?: number; priority?: DeviceRequestPriority
  /** Renew the response deadline only when the peer reports increasing byte progress. */
  progressTimeoutMs?: number
  uploadTimeoutMs?: number
  onUploadStarted?(): void
  onUploaded?(): void
  onUploadProgress?(acknowledgedBytes: number): void
}
export interface CapturedDeviceApplicationRequest {
  binding: Readonly<DeviceSessionBinding>
  readonly stopReadAdmission?: true
  readonly busy?: boolean
  request(payload: unknown, options?: DeviceApplicationRequestOptions): Promise<DeviceApplicationResult>
}
interface Pending {
  resolve(value: DeviceApplicationResult): void
  reject(error: Error): void
  namespace: string
  abort: AbortController
  stop: boolean
  observation: boolean
  callback: boolean
  progress(bytes: number): void
  onUploadProgress?(acknowledgedBytes: number): void
}
interface Assembly {
  namespace: string; kind: 'request' | 'response' | 'error'; jsonBytes: number; binaryBytes: number
  received: number; chunks: Buffer[]; abort: AbortController
  stop: boolean; observation: boolean; callback: boolean; progress: boolean; released?: boolean
}
export function extensionDescriptors(registrations: DeviceExtensionRegistration[]) {
  for (const registration of registrations) if (registration.role !== 'client' && typeof registration.handle !== 'function') throw new Error('A device server extension requires its actual domain handler')
  return parseExtensionDescriptors(registrations.map(registration => ({
    ...registration,
    ...((registration.namespace === 'computer-maintenance-v2' && registration.version === 2
      || registration.namespace === 'execution-v1' && registration.version === 1)
      ? { observationAdmission: true as const } : {}),
    ...(registration.namespace === CI_HOST_NAMESPACE && registration.version === 1
      ? { ciStopAdmission: true as const } : {}),
    ...(registration.namespace === 'execution-v1' && registration.version === 1
      ? { callbackAdmission: true as const, stopReadAdmission: true as const } : {}),
  })))
}
export function deviceNegotiationHash(extensions: DeviceNegotiatedExtension[]) {
  return createHash('sha256').update(JSON.stringify(extensions)).digest('hex')
}
/** One reader per authenticated epoch. Chunk ACKs attest receipt only, never task acceptance. */
export class DeviceApplicationChannel {
  private readonly mainClock = new MainClock()
  mainNow(): number | undefined { return this.mainClock.observed ? this.mainClock.now() : undefined }
  private readonly abort = new AbortController()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly extensions: DeviceNegotiatedExtension[]
  private readonly bufferBytes: number
  private readonly registrations: DeviceExtensionRegistration[]
  private readonly binding: Readonly<DeviceSessionBinding>
  private readonly pending = new Map<string, Pending>()
  private readonly requestQueue = new DeviceRequestQueue()
  private saturationReportedAt = -Infinity
  private readonly assemblies = new Map<string, Assembly>()
  private readonly handlers = new Map<string, Assembly>()
  private readonly rawHandlers = new Map<string, Assembly>()
  private readonly replies = new Map<string, Assembly>()
  private readonly uploads = new Map<string, AbortController>()
  private readonly acknowledgements = new Map<string, Map<number, { resolve(): void; reject(error: Error): void }>>()
  private readonly chunkTransmissions = new Set<Promise<void>>()
  private frameTransmission = Promise.resolve()
  private inboundBytes = 0
  private outboundBytes = 0
  private failure: Error | undefined
  private authorization: Promise<void> | undefined
  // The endpoint admits a link only after a live authorization read.
  private authorizedAt = Date.now()
  private heartbeatAuthorizing = false
  private readonly detach: () => void
  constructor(private readonly options: {
    side: 'main' | 'worker'; binding: DeviceSessionBinding; socket: DeviceSocket; signal: AbortSignal
    extensions: DeviceNegotiatedExtension[]; registrations: DeviceExtensionRegistration[]
    /** Main live device authorization, separate from the handler's operation authority. */
    revalidate?(): Promise<void>
    onObservedFrame?(observedAt: string): void
    onMainReady?(): void
    onPeerTime?(peerTime: number | null, mainTime: number): void
    mainTime?: number
    beforeRequest?(namespace: string, payload: unknown): Promise<void>
  }) {
    if (options.mainTime !== undefined) this.mainClock.observe(options.mainTime)
    this.extensions = options.extensions.map((item) => Object.freeze({ ...item }))
    this.bufferBytes = Math.max(DEVICE_APPLICATION_BUFFER_BYTES,
      ...this.extensions.map(item => item.maxJsonBytes + item.maxBinaryBytes + DEVICE_APPLICATION_STOP_BYTES))
    this.registrations = options.registrations.map((item) => Object.freeze({ ...item }))
    this.binding = Object.freeze({ ...options.binding })
    const close = () => this.close(new DeviceConnectionError('transport'))
    options.signal.addEventListener('abort', close, { once: true })
    this.detach = () => options.signal.removeEventListener('abort', close)
    if (options.signal.aborted) close()
  }
  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }
  /** Joins physical callbacks as well as canceled deadline wrappers. Close first for shutdown. */
  async join(): Promise<void> { while (this.tasks.size) await Promise.allSettled([...this.tasks]) }
  currentBinding(): Readonly<DeviceSessionBinding> { this.current(); return this.binding }
  currentBindingForIncoming(namespace: string): Readonly<DeviceSessionBinding> { this.current(); this.negotiated(namespace, false); return this.binding }
  captureRequest(namespace: string): CapturedDeviceApplicationRequest {
    this.current()
    const extension = this.negotiated(namespace, true)
    const { requestQueue } = this
    return Object.freeze({ binding: this.binding, get busy() { return requestQueue.busy },
      ...(extension.stopReadAdmission ? { stopReadAdmission: true as const } : {}),
      request: (payload: unknown, options?: DeviceApplicationRequestOptions) => this.request(namespace, payload, options) })
  }
  confirmMainReady(): void {
    this.queueFrame({ type: 'pong', connectionEpoch: this.binding.connectionEpoch,
      observedAt: new Date().toISOString(), mainReady: true })
  }
  capabilities(): DeviceNegotiatedExtension[] { return this.extensions.map((item) => ({ ...item })) }
  private current() { if (this.abort.signal.aborted) throw this.failure ?? new DeviceConnectionError('transport') }
  private negotiated(namespace: string, outgoing: boolean) {
    const extension = this.extensions.find((item) => item.namespace === namespace)
    const allowed = extension && (this.options.side === 'main' ? outgoing ? extension.mainCanRequest : extension.workerCanRequest : outgoing ? extension.workerCanRequest : extension.mainCanRequest)
    if (!extension || !allowed) throw new DeviceApplicationError('unavailable')
    return extension
  }
  private async authorized(fresh = false) {
    this.current()
    if (this.options.revalidate && (fresh || Date.now() - this.authorizedAt >= authorizationReuseMs)) {
      if (!this.authorization) {
        const startedAt = Date.now()
        this.authorization = this.track(this.options.revalidate().then(() => { this.authorizedAt = startedAt }, error => {
          // A denial closes the link even after all deadline waiters have timed out.
          if (!isTransientDatabaseOrSocketError(error)
            && !(error instanceof DeviceConnectionError && error.code === 'timeout')) {
            this.close(error instanceof Error ? error : new DeviceConnectionError('transport'))
          }
          throw error
        }))
          .finally(() => { this.authorization = undefined })
      }
      try {
        await withDeviceDeadline(this.authorization, this.abort.signal, 10_000)
      } catch (error) {
        this.current()
        if (isTransientDatabaseOrSocketError(error)
          || error instanceof DeviceConnectionError && error.code === 'timeout') {
          const failure = deviceApplicationFailure(error)
          throw new DeviceApplicationError(failure.code, undefined, { cause: error, class: failure.class })
        }
        throw error
      }
    }
    this.current()
  }
  private revalidateHeartbeat() {
    if (this.heartbeatAuthorizing) return
    this.heartbeatAuthorizing = true
    void this.track(this.authorized(true)).catch(error => {
      if (this.abort.signal.aborted) return
      if (error instanceof DeviceApplicationError && error.retryable) {
        componentLogger('devices').warn({ err: error, deviceId: this.binding.deviceId,
          operation: 'revalidate device heartbeat' }, 'Device heartbeat authorization temporarily unavailable')
        return
      }
      this.close(error instanceof Error ? error : new DeviceConnectionError('transport'))
    }).finally(() => { this.heartbeatAuthorizing = false })
  }
  private stopRequest(namespace: string, payload: unknown): boolean {
    if (namespace === CI_HOST_NAMESPACE) {
      const parsed = CiHostRequestSchema.safeParse(payload)
      return parsed.success && parsed.data.operation === 'cancel'
    }
    if (namespace === EXECUTION_AUTHORITY_EXTENSION.namespace) {
      const parsed = ExecutionAuthorityRequestSchema.safeParse(payload)
      return parsed.success && parsed.data.action === 'stop'
        && this.stopPlacement(parsed.data.intent, parsed.data.placement)
    }
    if (namespace !== 'execution-v1') return false
    const conversation = WorkerConversationRpcRequestSchema.safeParse(payload)
    if (conversation.success && conversation.data.method === 'conversation.cancel') {
      const { binding, session } = conversation.data
      const target = binding.profile.target
      return target.hostRef.kind === 'device' && target.hostRef.mainId === this.binding.mainId
        && target.hostRef.deviceId === this.binding.deviceId
        && target.applicationInstallationId === this.binding.workerInstallationId
        && session.harness === binding.harness
    }
    const parsed = RemoteExecutionRpcRequestSchema.safeParse(payload)
    if (!parsed.success) return false
    if ((parsed.data.method === 'status' || parsed.data.method === 'receipt-continuation') && parsed.data.forStop) {
      return this.extensions.some(extension => extension.namespace === namespace && extension.stopReadAdmission)
        && this.stopPlacement(parsed.data.intent, parsed.data.placement)
    }
    if (parsed.data.method !== 'control' || parsed.data.command.action.kind !== 'stop') return false
    const { intent, placement, command } = parsed.data
    return this.stopPlacement(intent, placement)
      && command.bindingHash === intent.bindingHash
      && command.operationId === intent.operationId && command.executionId === intent.executionId
      && command.attemptId === intent.attemptId && command.owner.grantId === intent.owner.grantId
      && command.owner.epoch === intent.owner.epoch
  }
  private stopPlacement(intent: DispatchIntent, placement: AcceptedNodePlacement): boolean {
    if (placement.hostRef.kind !== 'device' || !placement.registration) return false
    const registration = placement.registration
    return intent.mainId === this.binding.mainId && placement.mainId === intent.mainId
      && placement.hostRef.deviceId === this.binding.deviceId
      && registration.workerInstallationId === this.binding.workerInstallationId
      && registration.keyRevision === this.binding.keyRevision
      && registration.authorizationRevision === this.binding.authorizationRevision
      && placement.runId === intent.runId && placement.nodeId === intent.nodeId
      && placement.bindingHash === intent.bindingHash
  }
  private releaseIncoming(assembly: Assembly) {
    if (assembly.released) return
    assembly.released = true
    this.inboundBytes -= assembly.jsonBytes + assembly.binaryBytes
  }
  request(namespace: string, payload: unknown, options: DeviceApplicationRequestOptions = {}): Promise<DeviceApplicationResult> {
    return this.track(this.requestInternal(namespace, payload, options))
  }
  private async requestInternal(namespace: string, payload: unknown, options: DeviceApplicationRequestOptions): Promise<DeviceApplicationResult> {
    const extension = this.negotiated(namespace, true)
    this.current()
    const stopNamespace = this.options.side === 'main' ? 'execution-v1' : EXECUTION_AUTHORITY_EXTENSION.namespace
    const stop = (namespace === stopNamespace || namespace === CI_HOST_NAMESPACE
      && this.options.side === 'main' && extension.ciStopAdmission === true)
      && !options.bytes && this.stopRequest(namespace, payload)
    const priority = effectiveDeviceRequestPriority(namespace, payload, options.priority)
    const bulk = deviceRequestIsBulk(namespace, payload, options.bytes !== undefined)
    const observation = options.bytes === undefined && deviceRequestIsObservation(namespace, payload)
    const callback = this.options.side === 'worker' && extension.callbackAdmission === true
      && options.bytes === undefined && deviceRequestIsCopyAuthorization(namespace, payload)
    const timeoutMs = Math.min(900_000, Math.max(1, options.timeoutMs ?? 30_000))
    const deadline = Date.now() + timeoutMs
    const release = await this.requestQueue.acquire({
      priority, stop, bulk, observation, callback, namespace, signal: options.signal, timeoutMs,
    }).catch((error: unknown) => {
      if (error instanceof DeviceApplicationAdmissionError) this.reportSaturation(namespace, error.reason)
      throw error
    })
    try {
      const signal = AbortSignal.any([this.abort.signal, ...(options.signal ? [options.signal] : [])])
      let backoff = 50
      while (true) {
        await this.authorized()
        if (options.signal?.aborted) throw new DeviceApplicationError('cancelled')
        await this.options.beforeRequest?.(namespace, payload)
        if (options.signal?.aborted) throw new DeviceApplicationError('cancelled')
        this.current()
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new DeviceApplicationError('timeout')
        try {
          return await this.sendRequest(namespace, payload, extension.version,
            { ...options, timeoutMs: remaining }, { stop, observation, callback, priority })
        } catch (error) {
          const remaining = deadline - Date.now()
          if (priority !== 'foreground' || !(error instanceof DeviceApplicationAdmissionError)
            || error.reason !== 'remote_capacity' || remaining <= 0) throw error
          await waitForDeviceRetry(Math.min(backoff, remaining), signal)
          backoff = Math.min(1_000, backoff * 2)
        }
      }
    } finally { release() }
  }
  private async sendRequest(namespace: string, payload: unknown, version: number,
    options: DeviceApplicationRequestOptions,
    admission: { stop: boolean; observation: boolean; callback: boolean; priority: DeviceRequestPriority }) {
    const id = randomUUID(), abort = new AbortController()
    let uploading = true
    let reject!: (error: Error) => void
    let acknowledgedProgress = 0
    const reportProgress = operationProgressReporter()
    const result = new Promise<DeviceApplicationResult>((resolve, fail) => {
      reject = fail
      this.pending.set(id, { namespace, resolve, reject: fail, abort,
        stop: admission.stop, observation: admission.observation, callback: admission.callback,
        progress: bytes => {
          if (options.progressTimeoutMs === undefined || abort.signal.aborted || bytes <= acknowledgedProgress) return
          reportProgress(bytes - acknowledgedProgress)
          acknowledgedProgress = bytes
          clearTimeout(timer)
          timer = setTimeout(timeout, responseTimeoutMs)
        },
        ...(options.onUploadProgress ? { onUploadProgress: options.onUploadProgress } : {}) })
    })
    const cancel = () => { abort.abort(); reject(new DeviceApplicationError('cancelled')); this.trySendCancel(id) }
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.signal?.aborted) cancel()
    const timeout = () => {
      const failure = uploading && !this.uploads.has(id)
        ? new DeviceApplicationAdmissionError('upload_capacity_timeout') : new DeviceApplicationError('timeout')
      this.reportSaturation(namespace, failure instanceof DeviceApplicationAdmissionError ? failure.reason : failure.message)
      abort.abort()
      reject(failure)
      this.trySendCancel(id)
    }
    const responseTimeoutMs = Math.min(900_000, Math.max(1, options.progressTimeoutMs ?? options.timeoutMs ?? 30_000))
    let timer = setTimeout(timeout, Math.min(900_000, Math.max(1, options.uploadTimeoutMs ?? responseTimeoutMs)))
    // Observe rejection immediately while the request bytes are still uploading.
    void result.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    try {
      await this.sendPacket(id, namespace, version, 'request', payload, options.bytes, abort.signal, {
        ...admission, progress: options.progressTimeoutMs !== undefined,
        ...(options.onUploadStarted ? { onUploadStarted: options.onUploadStarted } : {}),
      })
      uploading = false
      if (options.uploadTimeoutMs !== undefined) {
        clearTimeout(timer)
        timer = setTimeout(timeout, responseTimeoutMs)
      }
      options.onUploaded?.()
      return await result
    } catch (error) {
      this.trySendCancel(id)
      if (abort.signal.aborted) return await result
      throw error
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); this.pending.delete(id); abort.abort()
    }
  }
  /** Names the in-flight requests by namespace when a request is refused or times out; at most one line per 30 s per channel. */
  private reportSaturation(namespace: string, reason: string) {
    const now = Date.now()
    if (now - this.saturationReportedAt < 30_000) return
    this.saturationReportedAt = now
    componentLogger('devices').warn({ side: this.options.side, deviceId: this.binding.deviceId, namespace, reason,
      slots: this.requestQueue.snapshot() }, 'Device application channel saturated')
  }
  private trySendCancel(id: string) {
    if (!this.abort.signal.aborted) this.queueFrame({ type: 'application-cancel', id })
  }
  private queueFrame(frame: DeviceFrame): void {
    void this.track(this.sendWhenReady(frame, this.abort.signal)).catch(error => {
      this.close(error instanceof Error ? error : new DeviceConnectionError('transport'))
    })
  }
  private async waitForCapacity(attempt: () => boolean, signal: AbortSignal,
    options: { timeoutMs?: number; timeoutError?: Error } = {}): Promise<void> {
    const deadline = Date.now() + (options.timeoutMs ?? deviceRequestTimeoutMs)
    const waiting = AbortSignal.any([signal, this.abort.signal])
    let backoff = 50
    while (true) {
      this.current()
      if (signal.aborted) throw new DeviceApplicationError('cancelled')
      if (attempt()) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw options.timeoutError ?? new DeviceApplicationError('timeout')
      try {
        await waitForDeviceRetry(Math.min(backoff, remaining), waiting)
      } catch (error) {
        this.current()
        if (signal.aborted) throw new DeviceApplicationError('cancelled', undefined, { cause: error })
        throw error
      }
      backoff = Math.min(1_000, backoff * 2)
    }
  }
  private sendWhenReady(frame: DeviceFrame, signal: AbortSignal): Promise<void> {
    // Serialize writes, not ACK waits, so a larger transfer window still lets the peer drain its socket queue.
    const transmission = this.frameTransmission.then(async () => {
      const size = Buffer.byteLength(JSON.stringify(frame))
      await this.waitForCapacity(() => {
        if (this.options.socket.bufferedAmount + size > DEVICE_BUFFER_BYTES) return false
        sendFrame(this.options.socket, frame)
        return true
      }, signal)
    })
    // Each caller handles its own failure; subsequent control frames must still be able to send.
    this.frameTransmission = transmission.then(() => undefined, () => undefined)
    return transmission
  }
  private async waitAck(id: string, offset: number, signal: AbortSignal, frame: DeviceFrame) {
    this.current()
    let abort: (() => void) | undefined
    const receipts = this.acknowledgements.get(id) ?? new Map()
    this.acknowledgements.set(id, receipts)
    const acknowledged = new Promise<void>((resolve, reject) => {
      receipts.set(offset, { resolve, reject })
      abort = () => reject(new DeviceApplicationError('cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else void this.track(this.sendWhenReady(frame, signal)).catch(reject)
    })
    try { await withDeviceDeadline(acknowledged, this.abort.signal, deviceRequestTimeoutMs) }
    finally {
      if (abort) signal.removeEventListener('abort', abort)
      receipts.delete(offset)
      if (!receipts.size) this.acknowledgements.delete(id)
    }
  }
  private async sendChunk(id: string, offset: number, chunk: Buffer, signal: AbortSignal,
    admission: { stop: boolean }, window: number) {
    // A channel-wide window also bounds queued socket bytes across concurrent uploads.
    while (this.chunkTransmissions.size >= window + (admission.stop ? 1 : 0)) {
      await withDeviceDeadline(Promise.race(this.chunkTransmissions), signal, deviceRequestTimeoutMs)
    }
    this.current()
    if (signal.aborted) throw new DeviceApplicationError('cancelled')
    const transmission = this.waitAck(id, offset + chunk.byteLength, signal,
      { type: 'application-chunk', id, offset, data: chunk.toString('base64') })
    const finished = transmission.then(() => undefined, () => undefined)
    this.chunkTransmissions.add(finished)
    try { await transmission }
    finally { this.chunkTransmissions.delete(finished) }
  }
  private async sendPacket(id: string, namespace: string, version: number, kind: Assembly['kind'],
    payload: unknown, bytes: Uint8Array | undefined, signal: AbortSignal,
    admission: { stop: boolean; observation?: boolean; callback?: boolean; progress?: boolean;
      priority?: DeviceRequestPriority; onUploadStarted?(): void } = { stop: false }) {
    this.current()
    const { stop } = admission
    const extension = this.extensions.find((item) => item.namespace === namespace)!
    const json = Buffer.from(JSON.stringify(payload === undefined ? null : payload))
    if (json.byteLength > extension.maxJsonBytes || (bytes?.byteLength ?? 0) > extension.maxBinaryBytes) throw new DeviceApplicationError('payload-too-large')
    const size = json.byteLength + (bytes?.byteLength ?? 0)
    if (stop && kind === 'request' && size > DEVICE_APPLICATION_STOP_BYTES) throw new DeviceApplicationError('payload-too-large')
    const byteLimit = this.bufferBytes - (stop ? 0 : DEVICE_APPLICATION_STOP_BYTES)
    if (kind === 'request') {
      if (admission.priority === 'foreground') {
        await this.waitForCapacity(() => {
          if (this.outboundBytes + size > byteLimit) return false
          this.outboundBytes += size
          return true
        }, signal, { timeoutMs: deviceForegroundWaitMs,
          timeoutError: new DeviceApplicationAdmissionError('upload_capacity_timeout') })
      } else {
        if (this.outboundBytes + size > byteLimit) throw new DeviceApplicationAdmissionError()
        this.outboundBytes += size
      }
    } else {
      // Keep a completed handler's reply until uploads drain; replaying the handler may repeat a write.
      await this.waitForCapacity(() => {
        if (this.outboundBytes + size > byteLimit) return false
        this.outboundBytes += size
        return true
      }, signal)
    }
    const upload = new AbortController(), cancel = () => upload.abort()
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel()
    this.uploads.set(id, upload)
    try {
      await this.waitAck(id, 0, upload.signal, { type: 'application-open', id, namespace, version, kind,
        jsonBytes: json.byteLength, binaryBytes: bytes?.byteLength ?? 0,
        ...(kind === 'request' && stop ? { admission: 'stop' as const } : {}),
        ...(kind === 'request' && admission.callback ? { admission: 'callback' as const } : {}),
        ...(kind === 'request' && admission.progress ? { progress: true as const } : {}),
        // Older peers accept observations as ordinary requests.
        ...(kind === 'request' && admission.observation
          && this.negotiated(namespace, true).observationAdmission === true
          ? { admission: 'observation' as const } : {}) })
      admission.onUploadStarted?.()
      const packet = bytes ? Buffer.concat([json, Buffer.from(bytes)]) : json
      // Short calls share one window so a later MCP request cannot bypass waiting short requests.
      const binaryMcp = bytes !== undefined && namespace === WORKER_MCP_EXTENSION.namespace
      const window = binaryMcp ? WORKER_MCP_CHUNK_WINDOW : DEVICE_APPLICATION_CHUNK_WINDOW
      const windowBytes = DEVICE_APPLICATION_CHUNK_BYTES * window
      for (let start = 0; start < packet.byteLength; start += windowBytes) {
        const chunks: Promise<void>[] = []
        for (let offset = start; offset < Math.min(start + windowBytes, packet.byteLength); offset += DEVICE_APPLICATION_CHUNK_BYTES) {
          chunks.push(this.track(this.sendChunk(id, offset,
            packet.subarray(offset, offset + DEVICE_APPLICATION_CHUNK_BYTES), upload.signal, admission, window)))
        }
        await Promise.all(chunks)
      }
    } finally { this.outboundBytes -= size; this.uploads.delete(id); signal.removeEventListener('abort', cancel); upload.abort() }
  }
  private async sendReply(
    id: string, assembly: Assembly, registration: DeviceExtensionRegistration,
    kind: 'response' | 'error', result: DeviceApplicationResult,
  ): Promise<void> {
    try {
      await retryDeviceRequest(() => this.sendPacket(id, assembly.namespace, registration.version, kind,
        result.payload, result.bytes, assembly.abort.signal, { stop: assembly.stop }),
      { retry: 'admission', signal: assembly.abort.signal })
    } catch (error) {
      // A peer can abandon a reply after its completed handler releases the request slot.
      if (error instanceof DeviceApplicationError && error.code === 'cancelled') return
      if (!(error instanceof DeviceApplicationError) || assembly.abort.signal.aborted) throw error
      if (error.code === 'backpressure') {
        // A rejection needs no packet allocation when uploads exhaust the shared byte budget.
        this.queueFrame({ type: 'application-reject', id, code: 'backpressure' })
        return
      }
      if (kind === 'error') throw error
      await this.sendReply(id, assembly, registration, 'error', { payload: deviceApplicationFailure(error) })
    }
  }
  /** Called only by run()'s sole socket reader; control frames never wait for a domain handler. */
  private receive(frame: Record<string, unknown>) {
    this.current()
    if (typeof frame.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(frame.id)) throw new DeviceConnectionError('malformed-frame')
    const id = frame.id
    if (frame.type === 'application-progress') {
      if (typeof frame.bytes !== 'number' || !Number.isSafeInteger(frame.bytes) || frame.bytes <= 0) {
        throw new DeviceConnectionError('malformed-frame')
      }
      this.pending.get(id)?.progress(frame.bytes)
      return
    }
    if (frame.type === 'application-ack') {
      if (typeof frame.offset !== 'number' || !Number.isSafeInteger(frame.offset) || frame.offset < 0) throw new DeviceConnectionError('malformed-frame')
      const receipts = this.acknowledgements.get(id)
      if (!receipts) return // Cancellation can race a chunk receipt; receipts acquire no authority.
      const ack = receipts.get(frame.offset)
      if (!ack) throw new DeviceConnectionError('malformed-frame')
      ack.resolve()
      if (frame.offset > 0) this.pending.get(id)?.onUploadProgress?.(frame.offset)
      return
    }
    if (frame.type === 'application-cancel') {
      this.uploads.get(id)?.abort(); this.handlers.get(id)?.abort.abort(); this.replies.get(id)?.abort.abort()
      const assembly = this.assemblies.get(id)
      if (assembly) { this.releaseIncoming(assembly); this.assemblies.delete(id); assembly.abort.abort() }
      this.pending.get(id)?.reject(new DeviceApplicationError('cancelled')); return
    }
    if (frame.type === 'application-reject') {
      if (frame.code !== 'backpressure') throw new DeviceConnectionError('malformed-frame')
      const rejectedBeforeUpload = this.acknowledgements.get(id)?.has(0) === true
      const error = rejectedBeforeUpload
        ? new DeviceApplicationAdmissionError('remote_capacity') : new DeviceApplicationError('backpressure')
      for (const ack of this.acknowledgements.get(id)?.values() ?? []) ack.reject(error)
      this.pending.get(id)?.reject(error)
      this.uploads.get(id)?.abort()
      return
    }
    if (frame.type === 'application-open') {
      if (typeof frame.namespace !== 'string' || !['request', 'response', 'error'].includes(String(frame.kind))) throw new DeviceConnectionError('malformed-frame')
      const kind = frame.kind as Assembly['kind']
      const stopNamespace = this.options.side === 'worker' ? 'execution-v1' : EXECUTION_AUTHORITY_EXTENSION.namespace
      if (frame.admission !== undefined) {
        const allowed = kind === 'request' && (frame.admission === 'stop'
          && (frame.namespace === stopNamespace || frame.namespace === CI_HOST_NAMESPACE && this.options.side === 'worker')
          || frame.admission === 'observation' && ['execution-v1', 'computer-maintenance-v2'].includes(frame.namespace)
          || frame.admission === 'callback' && frame.namespace === 'execution-v1' && this.options.side === 'main'
            && this.negotiated(frame.namespace, false).callbackAdmission === true)
        if (!allowed) throw new DeviceConnectionError('malformed-frame')
      }
      const stop = kind === 'request' ? frame.admission === 'stop' : this.pending.get(id)?.stop === true
      const observation = kind === 'request'
        ? frame.admission === 'observation' : this.pending.get(id)?.observation === true
      const callback = kind === 'request'
        ? frame.admission === 'callback' : this.pending.get(id)?.callback === true
      if (frame.progress !== undefined && (frame.progress !== true || kind !== 'request')) {
        throw new DeviceConnectionError('malformed-frame')
      }
      const extension = kind === 'request' ? this.negotiated(frame.namespace, false) : this.extensions.find((item) => item.namespace === frame.namespace)
      if (kind !== 'request' && !this.pending.has(id)) { this.trySendCancel(id); return }
      if (!extension || frame.version !== extension.version || (kind !== 'request' && this.pending.get(id)?.namespace !== frame.namespace)) throw new DeviceConnectionError('malformed-frame')
      const jsonBytes = Number(frame.jsonBytes), binaryBytes = Number(frame.binaryBytes), total = jsonBytes + binaryBytes
      if (typeof frame.jsonBytes !== 'number' || typeof frame.binaryBytes !== 'number' || !Number.isSafeInteger(jsonBytes) || jsonBytes < 1 || jsonBytes > extension.maxJsonBytes || !Number.isSafeInteger(binaryBytes) || binaryBytes < 0 || binaryBytes > extension.maxBinaryBytes) throw new DeviceConnectionError('malformed-frame')
      // Replies to admitted outgoing requests have their own bounded capacity.
      if (this.assemblies.has(id) || this.handlers.has(id) || this.rawHandlers.has(id) || this.replies.has(id)) throw new DeviceConnectionError('malformed-frame')
      const active = kind === 'request' ? new Map([...this.rawHandlers, ...this.handlers]) : this.replies
      const sameClass = (item: Assembly) => item.stop === stop && item.observation === observation && item.callback === callback
      const assembling = [...this.assemblies.values()].filter(item =>
        (item.kind === 'request') === (kind === 'request') && sameClass(item)).length
      const occupied = [...active.values()].filter(sameClass).length
      let countLimit = DEVICE_APPLICATION_IN_FLIGHT
      if (stop) countLimit = DEVICE_APPLICATION_STOP_IN_FLIGHT
      else if (observation) countLimit = DEVICE_APPLICATION_OBSERVATION_IN_FLIGHT
      else if (callback) countLimit = DEVICE_APPLICATION_CALLBACK_IN_FLIGHT
      const byteLimit = this.bufferBytes - (stop ? 0 : DEVICE_APPLICATION_STOP_BYTES)
      if (assembling + occupied >= countLimit || this.inboundBytes + total > byteLimit
        || stop && kind === 'request' && (total > DEVICE_APPLICATION_STOP_BYTES || binaryBytes !== 0)
        || (observation || callback) && kind === 'request' && binaryBytes !== 0) {
        this.queueFrame({ type: 'application-reject', id, code: 'backpressure' })
        return
      }
      this.inboundBytes += total
      this.assemblies.set(id, { namespace: frame.namespace, kind, jsonBytes, binaryBytes, received: 0,
        chunks: [], abort: new AbortController(), stop, observation, callback, progress: frame.progress === true })
      this.queueFrame({ type: 'application-ack', id, offset: 0 }); return
    }
    if (frame.type !== 'application-chunk') throw new DeviceConnectionError('malformed-frame')
    const assembly = this.assemblies.get(id)
    if (!assembly) { this.trySendCancel(id); return }
    if (frame.offset !== assembly.received || typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new DeviceConnectionError('malformed-frame')
    const chunk = Buffer.from(frame.data, 'base64')
    if (!chunk.byteLength || chunk.byteLength > DEVICE_APPLICATION_CHUNK_BYTES || assembly.received + chunk.byteLength > assembly.jsonBytes + assembly.binaryBytes) throw new DeviceConnectionError('malformed-frame')
    assembly.chunks.push(chunk); assembly.received += chunk.byteLength
    this.queueFrame({ type: 'application-ack', id, offset: assembly.received })
    if (assembly.received === assembly.jsonBytes + assembly.binaryBytes) {
      this.assemblies.delete(id); (assembly.kind === 'request' ? this.handlers : this.replies).set(id, assembly)
      void this.track(this.complete(id, assembly)).catch((error: unknown) => this.close(error instanceof Error ? error : new DeviceConnectionError('transport')))
    }
  }
  private async complete(id: string, assembly: Assembly) {
    try {
      const packet = Buffer.concat(assembly.chunks); assembly.chunks.length = 0
      const payload: unknown = JSON.parse(packet.subarray(0, assembly.jsonBytes).toString())
      const bytes = assembly.binaryBytes ? packet.subarray(assembly.jsonBytes) : undefined
      if (assembly.kind !== 'request') {
        try { await this.authorized() }
        catch (error) {
          this.pending.get(id)?.reject(error instanceof Error ? error : new DeviceConnectionError('transport'))
          return
        }
        if (assembly.abort.signal.aborted) return
        const pending = this.pending.get(id)
        if (pending) {
          if (assembly.kind === 'error') {
            const failure = deviceApplicationFailure(payload)
            pending.reject(new DeviceApplicationError(failure.code, failure.details, { class: failure.class }))
          }
          else pending.resolve({ payload, ...(bytes ? { bytes } : {}) })
        }
        return
      }
      const registration = this.registrations.find((item) => item.namespace === assembly.namespace)
      if (!registration?.handle || assembly.abort.signal.aborted) return
      let result: DeviceApplicationResult
      try {
        await this.authorized()
        if (assembly.stop && !this.stopRequest(assembly.namespace, payload)) throw new DeviceApplicationError('forbidden')
        if (assembly.observation && !deviceRequestIsObservation(assembly.namespace, payload)) {
          throw new DeviceApplicationError('forbidden')
        }
        if (assembly.callback && !deviceRequestIsCopyAuthorization(assembly.namespace, payload)) {
          throw new DeviceApplicationError('forbidden')
        }
        let progressedBytes = 0
        const progress = (bytes: number) => {
          if (!assembly.progress || assembly.abort.signal.aborted || this.abort.signal.aborted || bytes <= 0) return
          progressedBytes += bytes
          this.queueFrame({ type: 'application-progress', id, bytes: progressedBytes })
        }
        this.rawHandlers.set(id, assembly)
        const raw = this.track(Promise.resolve().then(() => withOperationProgress(progress, () => registration.handle!(payload, {
          binding: Object.freeze({ ...this.binding }), signal: assembly.abort.signal, connectionSignal: this.abort.signal, ...(bytes ? { bytes } : {}),
        }))))
        const drained = () => {
          this.rawHandlers.delete(id)
          if (!this.handlers.has(id)) this.releaseIncoming(assembly)
        }
        void raw.then(drained, drained)
        result = await withDeviceDeadline(raw, assembly.abort.signal, 900_000)
        await this.authorized()
      } catch (error) {
        if (assembly.abort.signal.aborted || this.abort.signal.aborted) return
        componentLogger('devices').error({ err: error, namespace: assembly.namespace }, 'Device extension request failed')
        const failure = deviceApplicationFailure(error)
        this.handlers.delete(id)
        if (!this.rawHandlers.has(id)) this.releaseIncoming(assembly)
        await this.sendReply(id, assembly, registration, 'error', { payload: failure })
        return
      }
      if (!assembly.abort.signal.aborted) {
        this.handlers.delete(id)
        if (!this.rawHandlers.has(id)) this.releaseIncoming(assembly)
        await this.sendReply(id, assembly, registration, 'response', result)
      }
    } catch (error) {
      if (!assembly.abort.signal.aborted && !this.abort.signal.aborted) throw error
    } finally {
      (assembly.kind === 'request' ? this.handlers : this.replies).delete(id)
      if (!this.rawHandlers.has(id)) this.releaseIncoming(assembly)
      assembly.abort.abort()
    }
  }
  run(iterator: DeviceMessageIterator, heartbeatMs: number): Promise<void> { return this.track(this.runInternal(iterator, heartbeatMs)) }
  private async runInternal(iterator: DeviceMessageIterator, heartbeatMs: number): Promise<void> {
    let lastHeartbeat = Date.now(), timer: ReturnType<typeof setInterval> | undefined
    const worker = this.options.side === 'worker'
    if (worker) {
      let sending = false
      const ping = () => {
        if (sending || this.abort.signal.aborted) return
        sending = true
        void this.track(this.sendWhenReady({
          type: 'ping', connectionEpoch: this.binding.connectionEpoch, observedAt: new Date().toISOString(),
        }, this.abort.signal)).catch(error => {
          this.close(error instanceof Error ? error : new DeviceConnectionError('transport'))
        }).finally(() => { sending = false })
      }
      ping(); timer = setInterval(ping, heartbeatMs)
    }
    const heartbeatBudgetMs = heartbeatMs * (worker ? 2 : 1)
    let heartbeatTimer: ReturnType<typeof setTimeout>
    const checkHeartbeat = () => {
      const remaining = lastHeartbeat + heartbeatBudgetMs - Date.now()
      if (remaining <= 0) this.close(new DeviceConnectionError('timeout'))
      else heartbeatTimer = setTimeout(checkHeartbeat, remaining)
    }
    heartbeatTimer = setTimeout(checkHeartbeat, heartbeatBudgetMs)
    try {
      // Application assemblies already reserve bounded receive capacity before any chunks arrive.
      // Drain frames synchronously so a coalesced upload window does not occupy the handshake queue.
      const receive = (text: string) => {
        const observedAt = new Date().toISOString()
        const frame = readFrame(text)
        if (frame.type === (worker ? 'pong' : 'ping')) {
          if (frame.connectionEpoch !== this.binding.connectionEpoch) throw new DeviceConnectionError('malformed-frame')
          lastHeartbeat = Date.now()
          const peerTime = typeof frame.observedAt === 'string' ? Date.parse(frame.observedAt) : NaN
          if (worker && Number.isFinite(peerTime)) this.mainClock.observe(peerTime)
          if (worker && frame.mainReady === true) this.options.onMainReady?.()
          if (!worker) {
            this.options.onPeerTime?.(Number.isFinite(peerTime) ? peerTime : null, lastHeartbeat)
            this.queueFrame({ type: 'pong', connectionEpoch: this.binding.connectionEpoch,
              observedAt: new Date(lastHeartbeat).toISOString() })
          }
          // Transport liveness does not wait for database-backed application authority.
          this.revalidateHeartbeat()
        } else if (frame.type === 'blocked') throw new DeviceConnectionError(classify(frame.code))
        else this.receive(frame)
        this.current(); this.options.onObservedFrame?.(observedAt)
      }
      await iterator.consume(text => {
        try { receive(text) }
        catch (error) {
          // The channel sends the failure reason before the adapter closes the socket.
          this.close(error instanceof Error ? error : new DeviceConnectionError('transport'))
        }
      }, this.abort.signal)
      if (this.failure) throw this.failure
      throw new DeviceConnectionError('transport', this.options.socket.closeDetail ?? 'peer closed the link')
    } catch (error) {
      this.close(error instanceof Error ? error : new DeviceConnectionError('transport'))
      throw error
    } finally {
      clearTimeout(heartbeatTimer)
      if (timer) clearInterval(timer)
      this.close()
    }
  }
  close(error: Error = new DeviceConnectionError('transport')) {
    if (this.failure) return
    this.requestQueue.close(error)
    this.failure = error; this.detach()
    const code = error instanceof DeviceConnectionError ? error.code : undefined
    componentLogger('devices').warn({ side: this.options.side, deviceId: this.binding.deviceId,
      connectionGeneration: this.binding.connectionGeneration, code: code ?? (error as { code?: unknown }).code,
      detail: error instanceof DeviceConnectionError ? error.detail : undefined, ...(code ? {} : { err: error }) },
    'Device link closed')
    // Send the reason before aborting the synchronous reader, which closes the adapter.
    if (code && code !== 'transport') {
      try { sendFrame(this.options.socket, { type: 'blocked', code }) } catch { /* ignore: the socket is already unusable */ }
    }
    this.abort.abort()
    for (const pending of this.pending.values()) { pending.abort.abort(); pending.reject(error) }
    for (const assembly of this.assemblies.values()) assembly.abort.abort()
    for (const assembly of this.handlers.values()) assembly.abort.abort()
    for (const assembly of this.rawHandlers.values()) assembly.abort.abort()
    for (const assembly of this.replies.values()) assembly.abort.abort()
    for (const controller of this.uploads.values()) controller.abort()
    for (const receipts of this.acknowledgements.values()) for (const ack of receipts.values()) ack.reject(error)
    this.assemblies.clear(); this.options.socket.close()
  }
}
function classify(code: unknown): import('@foreman-code/contracts/device-connection').DeviceFailureCode {
  return ['authentication', 'revoked', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport'].includes(String(code)) ? code as import('@foreman-code/contracts/device-connection').DeviceFailureCode : 'malformed-frame'
}
