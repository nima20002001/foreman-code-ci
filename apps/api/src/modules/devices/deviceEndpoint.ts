import { negotiateDeviceExtensions, parseExtensionDescriptors } from '@foreman-code/contracts/device-application'
import { DeviceApplicationChannel, deviceNegotiationHash, extensionDescriptors, type DeviceApplicationRequestOptions, type DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import type { DevicePrincipal, MainIdentityProofRequest, MainSignedIdentityProof } from '@foreman-code/contracts/device-identity'
import { randomUUID } from 'node:crypto'
import { DEVICE_PROTOCOL_VERSION, DeviceSessionBindingSchema, type DevicePresence, type DeviceSessionBinding, type DeviceWelcome } from '@foreman-code/contracts/device-connection'
import { DeviceConnectionError, nextFrame, readFrame, sendFrame, withDeviceDeadline, type DeviceSocket } from './deviceWire.js'
import { workerClockReason } from './workerClock.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, MaintenanceReplySchema,
  type WorkerBundleReadiness } from '@foreman-code/contracts/computer-maintenance'
import type { WorkerUpdateStatus } from '@foreman-code/contracts/computer-maintenance'
import { readWorkerBundleReadiness, requireWorkerBundleReady } from '../computers/workerBundleReadiness.js'
import { requiresWorkerBundle } from './workerAdmission.js'
import { isTransientDatabaseOrSocketError } from '@foreman-code/contracts/failure'
import { DomainError } from '../errors.js'
import { DeviceApplicationError, deviceApplicationFailure } from './deviceApplicationError.js'
import { withoutCiDatabasePriority } from '../../infrastructure/ciDatabasePriority.js'
import { deviceRequestTimeoutMs } from './deviceRequestRetry.js'

export type AuthenticatedDevice = DevicePrincipal

export interface DeviceAuthenticator {
  authenticateDevice(token: string, scope: 'connect'): Promise<AuthenticatedDevice>
  revalidateDevice(principal: AuthenticatedDevice, scope: 'heartbeat'): Promise<void>
}
export type { DevicePresence } from '@foreman-code/contracts/device-connection'

const authorizationFailure = (error: unknown) => {
  const code = (error as { code?: string })?.code
  if (code === 'wrong_main') return new DeviceConnectionError('wrong-main')
  if (code === 'forbidden') return new DeviceConnectionError('permission')
  if (code === 'revoked') return new DeviceConnectionError('revoked')
  if (code === 'unauthorized' || code === 'expired') return new DeviceConnectionError('authentication')
  if (isTransientDatabaseOrSocketError(error)) return error
  return error instanceof DeviceConnectionError ? error : new DeviceConnectionError('transport')
}
/** Mount on a separately approved device-only listener, never the browser/MCP server. */
export class DeviceEndpoint {
  private readonly sessions = new Map<string, { epoch: string; authorizationRevision: number; socket: DeviceSocket; abort: AbortController; binding?: DeviceSessionBinding; ready?: true; presence?: DevicePresence }>()
  private closed = false
  private admissionStopped = false
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly allChannels = new Set<DeviceApplicationChannel>()
  private readonly channels = new Map<string, DeviceApplicationChannel>()
  private readonly revoked = new Map<string, number>()
  private readonly tickets = new WeakSet<AuthenticatedDevice>()
  private readonly pending = new Set<AbortController>()
  private readonly bundleReads = new WeakMap<DeviceApplicationChannel, Promise<WorkerBundleReadiness>>()
  private readonly bindingLossFailures: unknown[] = []
  constructor(private readonly options: {
    mainId: string; appVersion: string; auth: DeviceAuthenticator
    signMainIdentityProof(request: MainIdentityProofRequest): Promise<MainSignedIdentityProof>
    reconcile(binding: DeviceSessionBinding, signal: AbortSignal): Promise<void>
    presence(view: DevicePresence): void
    /** Revoke original domain admission synchronously; join() awaits physical
     * cleanup and reports failure. This binding never follows a replacement. */
    onBindingLost?(binding: Readonly<DeviceSessionBinding>): void | Promise<void>
    onBindingReady?(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal): void | Promise<void>
    handshakeMs?: number; heartbeatMs?: number; extensions?: DeviceExtensionRegistration[]
    workerArtifacts?: { directory: string; version: string }
  }) { extensionDescriptors(options.extensions ?? []) }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }
  /** Drain admitted readers and physical auth/domain callbacks before closing their dependencies. */
  async join(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled([...this.tasks])
    if (this.bindingLossFailures.length) throw new AggregateError(this.bindingLossFailures, 'Original device binding cleanup remains incomplete.')
  }
  private bindingLost(binding: Readonly<DeviceSessionBinding>): void {
    if (!this.options.onBindingLost) return
    let cleanup: Promise<void>
    try { cleanup = Promise.resolve(this.options.onBindingLost(binding)) }
    catch (error) { cleanup = Promise.reject(error) }
    void this.track(cleanup).catch(error => { this.bindingLossFailures.push(error) })
  }
  authenticate(headers: { authorization?: string; cookie?: string; origin?: string }): Promise<AuthenticatedDevice> { return this.track(this.authenticateInternal(headers)) }
  private async authenticateInternal(headers: { authorization?: string; cookie?: string; origin?: string }): Promise<AuthenticatedDevice> {
    if (this.pending.size >= 32) throw new DeviceConnectionError('backpressure')
    const abort = new AbortController(); this.pending.add(abort)
    let physicalAuthentication: Promise<AuthenticatedDevice> | undefined
    try {
      if (this.closed || this.admissionStopped || headers.cookie !== undefined || headers.origin !== undefined
        || !headers.authorization?.startsWith('Bearer ')) throw new DeviceConnectionError('authentication')
      let principal: AuthenticatedDevice
      try {
        physicalAuthentication = this.track(this.options.auth.authenticateDevice(headers.authorization.slice(7), 'connect'))
        void physicalAuthentication.then(() => this.pending.delete(abort), () => this.pending.delete(abort))
        principal = await withDeviceDeadline(physicalAuthentication, abort.signal, this.options.handshakeMs ?? 10_000)
      } catch (error) { throw authorizationFailure(error) }
      if (this.closed || this.admissionStopped || abort.signal.aborted) throw new DeviceConnectionError('transport')
      if (principal.audience !== 'graphql-worker' || principal.mainId !== this.options.mainId) throw new DeviceConnectionError('wrong-main')
      if (principal.authorizationRevision <= (this.revoked.get(principal.deviceId) ?? 0)) throw new DeviceConnectionError('revoked')
      this.tickets.add(principal)
      return principal
    } finally { abort.abort(); if (!physicalAuthentication) this.pending.delete(abort) }
  }
  accept(headers: { authorization?: string; cookie?: string; origin?: string }, socket: DeviceSocket): Promise<void> { return this.track(this.acceptInternal(headers, socket)) }
  private async acceptInternal(headers: { authorization?: string; cookie?: string; origin?: string }, socket: DeviceSocket): Promise<void> {
    try {
      const principal = await this.authenticate(headers)
      await this.acceptAuthenticated(principal, socket)
    } catch (error) {
      try { sendFrame(socket, { type: 'blocked', code: error instanceof DeviceConnectionError ? error.code : 'transport' }) } catch { /* ignore: socket unavailable */ }
      socket.close()
    }
  }
  acceptAuthenticated(authenticated: AuthenticatedDevice, socket: DeviceSocket): Promise<void> { return this.track(this.acceptAuthenticatedInternal(authenticated, socket)) }
  private async acceptAuthenticatedInternal(authenticated: AuthenticatedDevice, socket: DeviceSocket): Promise<void> {
    const abort = new AbortController()
    const principal = authenticated
    let binding: DeviceSessionBinding | undefined
    let session: { epoch: string; authorizationRevision: number; socket: DeviceSocket; abort: AbortController; binding?: DeviceSessionBinding; ready?: true; presence?: DevicePresence } | undefined
    try {
      if (this.closed || this.admissionStopped || principal.mainId !== this.options.mainId
        || principal.audience !== 'graphql-worker') throw new DeviceConnectionError('authentication')
      if (!this.tickets.has(principal)) throw new DeviceConnectionError('authentication')
      if (principal.authorizationRevision <= (this.revoked.get(principal.deviceId) ?? 0)) throw new DeviceConnectionError('revoked')
      const previous = this.sessions.get(principal.deviceId)
      previous?.abort.abort(); previous?.socket.close()
      if (previous?.presence) this.options.presence(Object.freeze({ ...previous.presence, phase: 'offline', dispatch: false, transfer: false }))
      const epoch = randomUUID()
      this.sessions.set(principal.deviceId, { epoch, authorizationRevision: principal.authorizationRevision, socket, abort })
      const current = () => !abort.signal.aborted && (!this.admissionStopped || session?.ready)
        && this.sessions.get(principal!.deviceId)?.epoch === epoch
      const iterator = socket.messages[Symbol.asyncIterator]()
      const first = await nextFrame(iterator, abort.signal, this.options.handshakeMs ?? 10_000)
      if (first.done || !current()) throw new DeviceConnectionError('transport')
      const helloSeenAt = new Date().toISOString()
      const hello = readFrame(first.value)
      const workerTime = typeof hello.observedAt === 'string' ? Date.parse(hello.observedAt) : NaN
      const clockSkewMs = Number.isFinite(workerTime) ? workerTime - Date.parse(helloSeenAt) : null
      const clockReason = workerClockReason(Number.isFinite(workerTime) ? workerTime : null, Date.parse(helloSeenAt))
      if (hello.protocolVersion !== DEVICE_PROTOCOL_VERSION) throw new DeviceConnectionError('incompatible-protocol')
      if (hello.type !== 'hello' || typeof hello.bootId !== 'string' || !hello.bootId || typeof hello.connectionEpoch !== 'string' || !hello.connectionEpoch || typeof hello.appVersion !== 'string' || !hello.appVersion || hello.appVersion.length > 128 || typeof hello.nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(hello.nonce) || !Number.isSafeInteger(hello.connectionGeneration) || Number(hello.connectionGeneration) < 1) throw new DeviceConnectionError('malformed-frame')
      for (const key of ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const) if (hello[key] !== principal[key]) throw new DeviceConnectionError('authentication')
      try { binding = Object.freeze(DeviceSessionBindingSchema.parse({ mainId: principal.mainId, deviceId: principal.deviceId, workerInstallationId: principal.workerInstallationId, keyRevision: principal.keyRevision, authorizationRevision: principal.authorizationRevision, bootId: hello.bootId, connectionEpoch: epoch, connectionGeneration: Number(hello.connectionGeneration) })) } catch { throw new DeviceConnectionError('malformed-frame') }
      session = this.sessions.get(principal.deviceId)
      if (session?.abort === abort) {
        session.binding = binding
        const original = binding
        abort.signal.addEventListener('abort', () => this.bindingLost(original), { once: true })
        session.presence = Object.freeze({ binding, phase: 'offline', dispatch: false, transfer: false,
          appVersion: hello.appVersion, protocolVersion: hello.protocolVersion, lastSeenAt: helloSeenAt,
          clockSkewMs, clockReason })
      }
      try { await withDeviceDeadline(this.track(this.options.auth.revalidateDevice(principal, 'heartbeat')), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { throw authorizationFailure(error) }
      if (!current()) throw new DeviceConnectionError('transport')
      let extensions
      try { extensions = negotiateDeviceExtensions(extensionDescriptors(this.options.extensions ?? []), parseExtensionDescriptors(hello.extensions ?? [])) } catch { throw new DeviceConnectionError('malformed-frame') }
      const proofRequest: MainIdentityProofRequest = { audience: 'graphql-worker-main-v1', ...binding, nonce: hello.nonce as string, connectionGeneration: Number(hello.connectionGeneration), connectionEpoch: hello.connectionEpoch as string, mainConnectionEpoch: epoch, protocolVersion: DEVICE_PROTOCOL_VERSION, workerApplicationVersion: hello.appVersion as string, negotiationHash: deviceNegotiationHash(extensions) }
      const mainIdentityProof = await withDeviceDeadline(this.track(this.options.signMainIdentityProof(proofRequest)), abort.signal, this.options.handshakeMs ?? 10_000)
      if (!current()) throw new DeviceConnectionError('transport')
      const welcome: DeviceWelcome = { ...binding, type: 'welcome', protocolVersion: DEVICE_PROTOCOL_VERSION, appVersion: this.options.appVersion, mainIdentityProof, capabilities: { heartbeat: true, dispatch: extensions.some((item) => ['execution-v1', 'job-v1'].includes(item.namespace) && item.mainCanRequest), transfer: extensions.some((item) => item.namespace === 'byte-transfer-v1' && (item.mainCanRequest || item.workerCanRequest)), extensions } }
      welcome.observedAt = new Date().toISOString()
      sendFrame(socket, welcome)
      const acknowledged = await nextFrame(iterator, abort.signal, deviceRequestTimeoutMs)
      if (acknowledged.done || !current()) throw new DeviceConnectionError('transport')
      const readySeenAt = new Date().toISOString()
      const ready = readFrame(acknowledged.value)
      if (ready.type !== 'ready' || ready.connectionEpoch !== epoch) throw new DeviceConnectionError('malformed-frame')
      try { await withDeviceDeadline(this.track(this.options.auth.revalidateDevice(principal, 'heartbeat')), abort.signal, this.options.handshakeMs ?? 10_000) } catch (error) { throw authorizationFailure(error) }
      if (!current()) throw new DeviceConnectionError('transport')
      if (session?.presence) session.presence = Object.freeze({ ...session.presence, lastSeenAt: readySeenAt })
      const channel = new DeviceApplicationChannel({ side: 'main', binding, socket, signal: abort.signal, extensions,
        beforeRequest: async (namespace, payload) => {
          if (this.options.workerArtifacts && requiresWorkerBundle(namespace, payload)) {
            requireWorkerBundleReady(await this.readBundleReadiness(channel))
          }
        },
        onPeerTime: (workerTime, mainTime) => {
          if (!current() || !session?.presence) return
          session.presence = Object.freeze({ ...session.presence,
            clockSkewMs: workerTime === null ? null : workerTime - mainTime,
            clockReason: workerClockReason(workerTime, mainTime) })
        },
        registrations: this.options.extensions ?? [],
        // One read serves every operation on the link, so it never borrows a CI dispatch caller's reserved connections.
        revalidate: async () => { try { await this.track(withoutCiDatabasePriority(() => this.options.auth.revalidateDevice(principal, 'heartbeat'))) } catch (error) { throw authorizationFailure(error) } }, onObservedFrame: (observedAt) => {
        if (!current() || !session?.presence) return
        session.presence = Object.freeze({ ...session.presence, lastSeenAt: observedAt })
        if (session.ready) this.options.presence(session.presence)
      } })
      this.channels.set(principal.deviceId, channel); this.allChannels.add(channel)
      const channelTask = channel.run(iterator, this.options.heartbeatMs ?? 30_000).catch((error: unknown) => { abort.abort(); throw error })
      void channelTask.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
      void this.track(channelTask.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ }).then(() => channel.join()).finally(() => this.allChannels.delete(channel)))
      await withDeviceDeadline(this.track(this.options.reconcile(binding, abort.signal)), abort.signal, deviceRequestTimeoutMs)
      if (!current()) throw new DeviceConnectionError('transport')
      if (!session?.presence || this.sessions.get(principal.deviceId)?.abort !== abort) throw new DeviceConnectionError('transport')
      session.ready = true
      channel.confirmMainReady()
      session.presence = Object.freeze({ ...session.presence, phase: 'ready', dispatch: welcome.capabilities.dispatch, transfer: welcome.capabilities.transfer })
      this.options.presence(session.presence)
      if (this.options.onBindingReady) await this.track(Promise.resolve(this.options.onBindingReady(binding, abort.signal)))
      await channelTask
    } catch (error) {
      try { sendFrame(socket, { type: 'blocked', code: error instanceof DeviceConnectionError ? error.code : 'transport' }) } catch { /* ignore: socket already unavailable */ }
    } finally {
      abort.abort(); socket.close()
      if (principal && this.sessions.get(principal.deviceId)?.abort === abort) {
        this.channels.get(principal.deviceId)?.close(); this.channels.delete(principal.deviceId)
        this.sessions.delete(principal.deviceId)
        const observed = session?.presence
        if (observed) this.options.presence(Object.freeze({ ...observed, phase: 'offline', dispatch: false, transfer: false }))
      }
    }
  }
  /** Namespace callers need synchronized incoming authority; discovery may inspect live authenticated reconciliation. */
  currentBinding(deviceId: string, namespace?: string): Readonly<DeviceSessionBinding> | undefined {
    const session = this.sessions.get(deviceId), channel = this.channels.get(deviceId)
    if (!session?.binding || session.abort.signal.aborted || session.epoch !== session.binding.connectionEpoch || session.authorizationRevision <= (this.revoked.get(deviceId) ?? 0) || !channel || (namespace !== undefined && !session.ready)) return undefined
    try {
      const bound = namespace === undefined ? channel.currentBinding() : channel.currentBindingForIncoming(namespace)
      if (Object.entries(session.binding).some(([key, value]) => bound[key as keyof DeviceSessionBinding] !== value)) return undefined
      return Object.freeze({ ...bound })
    } catch { return undefined }
  }
  /** Capture the actual synchronized channel; this closure never follows a replacement connection. */
  captureRequest(deviceId: string, namespace: string) {
    const session = this.sessions.get(deviceId), channel = this.channels.get(deviceId)
    if (!session?.ready || !channel || !this.currentBinding(deviceId)) return undefined
    try { return channel.captureRequest(namespace) } catch { return undefined }
  }
  request(deviceId: string, namespace: string, payload: unknown, options?: DeviceApplicationRequestOptions) { return this.track(this.requestInternal(deviceId, namespace, payload, options)) }
  private async requestInternal(deviceId: string, namespace: string, payload: unknown, options?: DeviceApplicationRequestOptions) {
    const channel = this.channels.get(deviceId)
    if (!channel) throw new DeviceConnectionError('transport')
    return channel.request(namespace, payload, options)
  }
  capabilities(deviceId: string) { return this.channels.get(deviceId)?.capabilities() ?? [] }
  async workerBundleReadiness(deviceId: string): Promise<WorkerBundleReadiness> {
    const channel = this.channels.get(deviceId)
    if (!channel) throw new DeviceConnectionError('transport')
    return this.readBundleReadiness(channel)
  }
  async assertWorkerBundleReady(deviceId: string): Promise<void> {
    requireWorkerBundleReady(await this.workerBundleReadiness(deviceId).catch((error: unknown) => {
      // Busy Workers keep their DEVICE_BUSY mapping; other transient channel failures get a public retryable code.
      const failure = deviceApplicationFailure(error)
      if (!(error instanceof DeviceApplicationError || error instanceof DeviceConnectionError)
        || failure.class !== 'transient' || ['backpressure', 'DEVICE_BUSY'].includes(failure.code)) throw error
      const unavailable = new DomainError('WORKER_STATUS_UNAVAILABLE',
        `The Worker did not report its running bundle (${failure.code}). Retry shortly.`, 503,
        { retryable: true, reason: failure.code })
      unavailable.cause = error
      throw unavailable
    }))
  }
  private readBundleReadiness(channel: DeviceApplicationChannel): Promise<WorkerBundleReadiness> {
    const pending = this.bundleReads.get(channel)
    if (pending) return pending
    const task = this.track(this.readConnectedBundle(channel).finally(() => this.bundleReads.delete(channel)))
    this.bundleReads.set(channel, task)
    return task
  }
  private async readConnectedBundle(channel: DeviceApplicationChannel): Promise<WorkerBundleReadiness> {
    channel.currentBinding()
    let worker: WorkerUpdateStatus | undefined
    if (channel.capabilities().some(value => value.namespace === COMPUTER_MAINTENANCE_NAMESPACE && value.mainCanRequest)) {
      worker = await this.readWorkerUpdateStatus(channel)
    }
    const options = this.options.workerArtifacts
    if (!options) throw new Error('Worker artifact location is not configured.')
    const readiness = await readWorkerBundleReadiness(options, worker)
    channel.currentBinding()
    return readiness
  }
  /** Only the updater state: the full maintenance status runs version, registry and OS inspections that are slow under load. */
  private async readWorkerUpdateStatus(channel: DeviceApplicationChannel): Promise<WorkerUpdateStatus | undefined> {
    const result = await channel.request(COMPUTER_MAINTENANCE_NAMESPACE, { operation: 'status', scope: 'worker' },
      { priority: 'foreground', timeoutMs: 10_000 }).catch((error: unknown) => {
      // A Worker that predates bundle-only status rejects the request; its running bundle is unknown, so it is not ready.
      if (error instanceof DeviceApplicationError && error.code === 'extension-rejected') return undefined
      throw error
    })
    if (!result) return undefined
    const reply = MaintenanceReplySchema.parse(result.payload)
    if (reply.operation === 'worker') return reply.worker ?? undefined
    return reply.operation === 'status' ? reply.status.worker : undefined
  }
  clockReason(deviceId: string): string | null {
    const presence = this.sessions.get(deviceId)?.presence
    return presence?.clockReason ?? (presence?.clockSkewMs !== undefined && presence.clockSkewMs !== null
      ? null : workerClockReason(null, Date.now()))
  }
  /** True once a committed revoke fences this authorization revision of the device. */
  isRevoked(deviceId: string, authorizationRevision: number): boolean {
    return authorizationRevision <= (this.revoked.get(deviceId) ?? 0)
  }
  /** A committed revoke receipt fences its revision, including lost-response replay. */
  revoke(deviceId: string, authorizationRevision: number) {
    const revision = Math.max(this.revoked.get(deviceId) ?? 0, authorizationRevision)
    this.revoked.set(deviceId, revision)
    const session = this.sessions.get(deviceId)
    if (session && session.authorizationRevision <= revision) {
      try { sendFrame(session.socket, { type: 'blocked', code: 'revoked' }) } catch { /* ignore: socket already unavailable */ }
      this.channels.get(deviceId)?.close(new DeviceConnectionError('revoked'))
      session.abort.abort()
      session.socket.close()
    }
  }
  /** Keep authenticated resident channels available for restart disposition. */
  stopAdmission(): void {
    this.admissionStopped = true
    for (const abort of this.pending) abort.abort()
    for (const session of this.sessions.values()) {
      if (session.ready) continue
      session.abort.abort()
      session.socket.close()
    }
  }
  close(): void {
    this.closed = true
    this.stopAdmission()
    for (const channel of this.allChannels) channel.close()
    for (const session of this.sessions.values()) {
      session.abort.abort()
      session.socket.close()
    }
  }
}
