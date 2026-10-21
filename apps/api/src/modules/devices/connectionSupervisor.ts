import { DEVICE_APPLICATION_MAX_EXTENSIONS, negotiateDeviceExtensions, parseExtensionDescriptors } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, DeviceApplicationError, deviceNegotiationHash, extensionDescriptors, type DeviceApplicationRequestOptions, type DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import { verifyMainIdentityProof } from '@foreman-code/contracts/device-identity-node'
import type { MainIdentityProofRequest } from '@foreman-code/contracts/device-identity'
import { randomBytes, randomUUID } from 'node:crypto'
import { DEVICE_PROTOCOL_VERSION, type DeviceConnectionView, type DeviceHello, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DeviceConnectionError, nextFrame, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket } from './deviceWire.js'
import { componentLogger } from '../diagnostics/logger.js'
import { deviceRequestTimeoutMs } from './deviceRequestRetry.js'

const healthyConnectionMs = 60_000

export class DeviceConnectionSupervisor {
  private state: DeviceConnectionView = { desired: false, phase: 'disconnected', generation: 0, failure: null }
  private task: Promise<void> | undefined
  private abort: AbortController | undefined
  private socket: DeviceSocket | undefined
  private channel: DeviceApplicationChannel | undefined
  private lostAt: number | undefined
  constructor(private readonly options: {
    identity: Omit<DeviceSessionBinding, 'connectionEpoch' | 'connectionGeneration'>; appVersion: string; mainPublicKeyFingerprint: string
    connect(signal: AbortSignal): Promise<DeviceSocket>
    refresh?(signal: AbortSignal): Promise<{
      identity: Omit<DeviceSessionBinding, 'connectionEpoch' | 'connectionGeneration'>
      mainPublicKeyFingerprint: string
    }>
    reconcile(binding: DeviceSessionBinding, signal: AbortSignal): Promise<void>
    onState?(view: DeviceConnectionView): void
    handshakeMs?: number; heartbeatMs?: number; random?: () => number; extensions?: DeviceExtensionRegistration[]
  }) { extensionDescriptors(options.extensions ?? []) }
  status(): DeviceConnectionView { return { ...this.state } }
  private update(phase: DeviceConnectionView['phase'], failure: DeviceConnectionView['failure'] = null) {
    if (phase === 'ready' || phase === 'blocked' || phase === 'disconnected') this.lostAt = undefined
    else this.lostAt ??= Date.now()
    this.state = { ...this.state, phase, failure }; this.options.onState?.(this.status())
  }
  /** When the last ready session was lost while reconnection continues; undefined while ready, blocked or stopped. */
  linkLostAt(): number | undefined {
    if (this.state.phase === 'blocked' || this.state.phase === 'disconnected') return undefined
    if (this.state.phase === 'ready' && !this.currentBinding()) this.lostAt ??= Date.now()
    return this.lostAt
  }
  request(namespace: string, payload: unknown, options?: DeviceApplicationRequestOptions) {
    if (!this.channel || this.state.phase !== 'ready') return Promise.reject(new DeviceApplicationError('unavailable'))
    return this.channel.request(namespace, payload, options)
  }
  /** Captures the same authenticated channel; callers must retain its exact binding. */
  captureRequest(namespace: string) {
    if (!this.channel || this.state.phase !== 'ready') return undefined
    try { return this.channel.captureRequest(namespace) } catch { return undefined }
  }
  currentBinding(): Readonly<DeviceSessionBinding> | undefined {
    if (!this.channel || this.state.phase !== 'ready') return undefined
    try { return this.channel.currentBinding() } catch { return undefined }
  }
  capabilities() { return this.channel?.capabilities() ?? [] }
  mainNow(): number | undefined { return this.channel?.mainNow() }
  start(): void {
    if (this.task) return
    this.abort = new AbortController(); this.state.desired = true
    this.task = this.run(this.abort.signal).finally(() => { this.task = undefined })
  }
  async stop(): Promise<void> {
    this.state.desired = false; this.abort?.abort(); this.socket?.close(); await this.task
    this.update('disconnected')
  }
  private async run(signal: AbortSignal) {
    let failures = 0
    while (!signal.aborted) {
      this.state.generation++
      const attempt = new AbortController()
      const cancel = () => attempt.abort()
      signal.addEventListener('abort', cancel, { once: true })
      let socket: DeviceSocket | undefined
      let mainReadyAt: number | undefined
      try {
        this.update('connecting')
        const registration = this.options.refresh
          ? await withDeviceDeadline(this.options.refresh(attempt.signal), attempt.signal, this.options.handshakeMs ?? 10_000)
          : this.options
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          socket = await Promise.race([
            this.options.connect(attempt.signal).then((value) => { if (attempt.signal.aborted) { value.close(); throw new DeviceConnectionError('transport') }; return value }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { attempt.abort(); reject(new DeviceConnectionError('timeout')) }, this.options.handshakeMs ?? 10_000); attempt.signal.addEventListener('abort', () => reject(new DeviceConnectionError('transport')), { once: true }) }),
          ])
        } finally { if (timer) clearTimeout(timer) }
        this.socket = socket
        this.update('authenticating')
        const hello: DeviceHello = { ...registration.identity, connectionEpoch: randomUUID(), type: 'hello', protocolVersion: DEVICE_PROTOCOL_VERSION, appVersion: this.options.appVersion, nonce: randomBytes(32).toString('base64url'), connectionGeneration: this.state.generation, extensions: extensionDescriptors(this.options.extensions ?? []) }
        hello.observedAt = new Date().toISOString()
        sendFrame(socket, hello); this.update('negotiating')
        const iterator = socket.messages[Symbol.asyncIterator]()
        const next = await nextFrame(iterator, attempt.signal, this.options.handshakeMs ?? 10_000)
        if (next.done) throw new DeviceConnectionError('transport')
        const frame = readFrame(next.value)
        if (frame.type === 'blocked') throw new DeviceConnectionError(classifiedFailure(frame.code))
        if (frame.protocolVersion !== DEVICE_PROTOCOL_VERSION) throw new DeviceConnectionError('incompatible-protocol')
        if (frame.mainId !== hello.mainId) throw new DeviceConnectionError('wrong-main')
        for (const key of ['deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision', 'bootId'] as const) if (frame[key] !== hello[key]) throw new DeviceConnectionError('authentication')
        const capabilities = frame.capabilities as Record<string, unknown> | undefined
        if (frame.type !== 'welcome' || typeof frame.connectionEpoch !== 'string' || !frame.connectionEpoch || !capabilities || capabilities.heartbeat !== true || typeof capabilities.dispatch !== 'boolean' || typeof capabilities.transfer !== 'boolean') throw new DeviceConnectionError('malformed-frame')
        if (frame.connectionGeneration !== hello.connectionGeneration) throw new DeviceConnectionError('wrong-main')
        const advertised = capabilities.extensions ?? []
        if (!Array.isArray(advertised) || advertised.length > DEVICE_APPLICATION_MAX_EXTENSIONS) throw new DeviceConnectionError('malformed-frame')
        const extensions = advertised as import('@foreman-code/contracts/device-application').DeviceNegotiatedExtension[]
        let recomputed: typeof extensions
        try {
          recomputed = negotiateDeviceExtensions(parseExtensionDescriptors(extensions.map(item => {
            let role: DeviceExtensionRegistration['role'] = 'server'
            if (item.mainCanRequest) role = 'client'
            if (item.mainCanRequest && item.workerCanRequest) role = 'duplex'
            return {
              namespace: item.namespace, version: item.version, role,
              maxJsonBytes: item.maxJsonBytes, maxBinaryBytes: item.maxBinaryBytes,
              ...(item.observationAdmission !== undefined ? { observationAdmission: item.observationAdmission } : {}),
              ...(item.ciStopAdmission !== undefined ? { ciStopAdmission: item.ciStopAdmission } : {}),
              ...(item.callbackAdmission !== undefined ? { callbackAdmission: item.callbackAdmission } : {}),
              ...(item.stopReadAdmission !== undefined ? { stopReadAdmission: item.stopReadAdmission } : {}),
            }
          })), extensionDescriptors(this.options.extensions ?? []))
        } catch { throw new DeviceConnectionError('malformed-frame') }
        if (JSON.stringify(recomputed) !== JSON.stringify(extensions)) throw new DeviceConnectionError('malformed-frame')
        const dispatch = extensions.some((item) => ['execution-v1', 'job-v1'].includes(item.namespace) && item.mainCanRequest)
        const transfer = extensions.some((item) => item.namespace === 'byte-transfer-v1' && (item.mainCanRequest || item.workerCanRequest))
        if (capabilities.dispatch !== dispatch || capabilities.transfer !== transfer) throw new DeviceConnectionError('malformed-frame')
        const expectedProof: MainIdentityProofRequest = { audience: 'graphql-worker-main-v1', ...registration.identity, nonce: hello.nonce, connectionGeneration: hello.connectionGeneration, connectionEpoch: hello.connectionEpoch, mainConnectionEpoch: frame.connectionEpoch, protocolVersion: DEVICE_PROTOCOL_VERSION, workerApplicationVersion: hello.appVersion, negotiationHash: deviceNegotiationHash(extensions) }
        if (!await withDeviceDeadline(verifyMainIdentityProof(frame.mainIdentityProof, expectedProof, registration.mainPublicKeyFingerprint), attempt.signal, this.options.handshakeMs ?? 10_000)) throw new DeviceConnectionError('wrong-main')
        if ((frame.mainIdentityProof as { mainApplicationVersion: string }).mainApplicationVersion !== frame.appVersion) throw new DeviceConnectionError('wrong-main')
        if (attempt.signal.aborted) break
        const binding = { ...registration.identity, connectionEpoch: frame.connectionEpoch, connectionGeneration: hello.connectionGeneration }
        this.update('synchronizing'); await withDeviceDeadline(this.options.reconcile(binding, attempt.signal), attempt.signal, deviceRequestTimeoutMs)
        if (attempt.signal.aborted) break
        sendFrame(socket, { type: 'ready', connectionEpoch: binding.connectionEpoch })
        this.channel = new DeviceApplicationChannel({ side: 'worker', binding, socket, signal: attempt.signal, extensions,
          ...(typeof frame.observedAt === 'string' && Number.isFinite(Date.parse(frame.observedAt))
            ? { mainTime: Date.parse(frame.observedAt) } : {}),
          onMainReady: () => { mainReadyAt ??= Date.now() }, registrations: this.options.extensions ?? [] })
        this.update('ready')
        await this.channel.run(iterator, this.options.heartbeatMs ?? 15_000)
      } catch (error) {
        if (signal.aborted) break
        const code = error instanceof DeviceConnectionError ? error.code : 'transport'
        componentLogger('devices').warn({ code, detail: error instanceof DeviceConnectionError ? error.detail : undefined,
          err: error instanceof DeviceConnectionError ? undefined : error, phase: this.state.phase, generation: this.state.generation },
        'Device link to Main lost')
        if (code === 'revoked') { this.update('blocked', code); return }
        attempt.abort(); socket?.close(); this.socket = undefined
        this.channel?.close(); this.channel = undefined
        this.update('backoff', code)
        if (mainReadyAt !== undefined && Date.now() - mainReadyAt >= healthyConnectionMs) failures = 0
        const baseDelay = 500 * 2 ** Math.min(failures++, 6)
        const delay = Math.min(30_000, baseDelay * (0.75 + (this.options.random?.() ?? Math.random()) * 0.5))
        await pause(delay, signal)
      } finally { attempt.abort(); signal.removeEventListener('abort', cancel); socket?.close(); this.socket = undefined; this.channel?.close(); this.channel = undefined }
    }
  }
}
function classifiedFailure(code: unknown): import('@foreman-code/contracts/device-connection').DeviceFailureCode {
  return ['authentication', 'revoked', 'permission', 'wrong-main', 'incompatible-protocol', 'malformed-frame', 'backpressure', 'timeout', 'transport'].includes(String(code)) ? code as import('@foreman-code/contracts/device-connection').DeviceFailureCode : 'malformed-frame'
}
function pause(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms); signal.addEventListener('abort', done, { once: true })
  })
}
