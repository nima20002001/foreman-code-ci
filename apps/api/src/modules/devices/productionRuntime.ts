import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import type { RemoteExecutionRuntimeStatus } from '@foreman-code/contracts/management'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { RuntimeIdentity } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { API_APPLICATION_VERSION } from '../../infrastructure/applicationVersion.js'
import { retryStartupDatabase } from '../../infrastructure/startupDatabase.js'
import { PostgresDeviceAccessService } from './access.js'
import type { DeviceExtensionRegistration } from './deviceApplicationChannel.js'
import { DeviceEndpoint } from './deviceEndpoint.js'
import { loadOrCreateMainDeviceIdentity, signMainIdentityProof, signMainEnrollmentProof } from './mainIdentity.js'
import type { DeviceManagementService } from './management.js'
import type { DeviceListenerConfig } from './productionConfig.js'
import { ProductionDeviceListener } from './productionListener.js'
import { ProductionDevicePresence } from './productionPresence.js'

export interface DeviceDomainComposition {
  browserMedia?(request: IncomingMessage, socket: Duplex, head: Buffer): boolean

  extensions: DeviceExtensionRegistration[]
  workerArtifacts?: { directory: string; version: string }
  reconcile(binding: DeviceSessionBinding, signal: AbortSignal, endpoint: DeviceEndpoint): Promise<void>
  bindingLost?(binding: Readonly<DeviceSessionBinding>): void | Promise<void>
  bindingReady?(binding: Readonly<DeviceSessionBinding>, signal: AbortSignal, endpoint: DeviceEndpoint): void | Promise<void>
}

/** The management facade and device listener delegate to one persisted-main
 * authority. Native/provider credentials never enter device pairing or TLS. */
export class ProductionDeviceRuntime {
  private stopped = false
  private admissionStopped = false
  private readonly startup = new AbortController()
  private initialization: Promise<void> | undefined
  private service: PostgresDeviceAccessService | undefined
  private endpoint: DeviceEndpoint | undefined
  private presence: ProductionDevicePresence | undefined
  private listener: ProductionDeviceListener | undefined
  private listenerStarted = false
  private listenerHttp: ConstructorParameters<typeof ProductionDeviceListener>[2] | undefined
  private readonly pending = new Set<Promise<unknown>>()
  private runtimeIdentity: RuntimeIdentity | undefined
  readonly management: DeviceManagementService = {
    readSetupOptions: (principal) => this.track(() => this.access().readSetupOptions(principal)),
    readMainIdentity: (principal) => this.track(() => this.access().readMainIdentity(principal)),
    list: (principal) => this.track(() => this.access().list(principal)),
    createSetupCode: (principal, input, source) => this.track(() => this.access().createSetupCode(principal, input, source)),
    createPairingGrant: (principal, input, source) => this.track(() => this.access().createPairingGrant(principal, input, source)),
    revoke: (principal, deviceId, revision, commandId, source) => this.track(() => this.access().revoke(principal, deviceId, revision, commandId, source)),
  }
  constructor(private readonly pool: pg.Pool, private listenerConfig: DeviceListenerConfig | undefined = undefined,
    private readonly domains?: DeviceDomainComposition) {
    if (domains?.extensions.length && typeof domains.reconcile !== 'function') throw new Error('Registered device domains require authoritative reconciliation.')
  }
  private access(): PostgresDeviceAccessService {
    this.assertAdmissionOpen()
    if (!this.service) throw new DomainError('DEVICE_RUNTIME_UNAVAILABLE', 'The selected-main device authority has not initialized.', 503)
    return this.service
  }
  private assertOpen(): void {
    if (this.stopped) throw new DomainError('DEVICE_RUNTIME_CLOSING', 'Device access is shutting down.', 503)
  }
  private assertAdmissionOpen(): void {
    this.assertOpen()
    if (this.admissionStopped) throw new DomainError('DEVICE_RUNTIME_CLOSING', 'Device access is shutting down.', 503)
  }
  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new DomainError('DEVICE_RUNTIME_CLOSING', 'Device access is shutting down.', 503))
    const task = Promise.resolve().then(() => { this.assertOpen(); return operation() })
    this.pending.add(task)
    void task.then(() => this.pending.delete(task), () => this.pending.delete(task))
    return task
  }
  initialize(mainId: string): Promise<void> {
    this.assertAdmissionOpen()
    this.initialization ??= this.prepare(mainId)
    return this.initialization
  }
  async initializeFromRuntime(readIdentity: () => Promise<RuntimeIdentity>): Promise<RuntimeIdentity> {
    this.assertAdmissionOpen()
    const identity = this.runtimeIdentity ?? await this.track(readIdentity)
    this.assertAdmissionOpen()
    await this.initialize(identity.installationId)
    this.assertAdmissionOpen()
    this.runtimeIdentity = identity
    return structuredClone(identity)
  }
  private async prepare(mainId: string): Promise<void> {
    const identity = await retryStartupDatabase(() => loadOrCreateMainDeviceIdentity(this.pool, mainId), {
      signal: this.startup.signal,
      check: () => this.assertAdmissionOpen(),
    })
    this.assertAdmissionOpen()
    const presence = new ProductionDevicePresence(mainId)
    const access = new PostgresDeviceAccessService(this.pool, mainId, (deviceId, authorizationRevision) => this.endpoint?.revoke(deviceId, authorizationRevision), () => this.setupOptions())
    const sign = (request: Parameters<typeof signMainIdentityProof>[1]) =>
      this.track(async () => signMainIdentityProof(identity, request, API_APPLICATION_VERSION))
    const signEnrollment = (request: Parameters<typeof signMainEnrollmentProof>[1]) =>
      this.track(async () => signMainEnrollmentProof(identity, request, API_APPLICATION_VERSION))
    const extensions = (this.domains?.extensions ?? []).map((extension) => ({ ...extension,
      ...(extension.handle ? { handle: (payload, context) => this.track(() => extension.handle!(payload, context)) } : {}),
    } satisfies DeviceExtensionRegistration))
    const endpoint: DeviceEndpoint = new DeviceEndpoint({ mainId, appVersion: API_APPLICATION_VERSION,
      ...(this.domains?.workerArtifacts ? { workerArtifacts: this.domains.workerArtifacts } : {}),
      auth: { authenticateDevice: (token, scope) => this.track(() => access.authenticateDevice(token, scope)),
        revalidateDevice: (principal, scope) => this.track(() => access.revalidateDevice(principal, scope)) },
      signMainIdentityProof: sign, extensions,
      reconcile: (binding, signal) => this.track(async () => {
        signal.throwIfAborted()
        if (this.domains) await this.domains.reconcile(binding, signal, endpoint)
        // With no registrations the authenticated W07 handshake already proves
        // connectivity. There is no execution or transfer state to reconcile.
      }),
      presence: (view) => presence.publish(view),
      // Cleanup uses the captured original binding even after request admission
      // closes; Endpoint.join retains failures before runtime ownership release.
      onBindingLost: binding => this.domains?.bindingLost?.(binding),
      onBindingReady: (binding, signal) => this.domains?.bindingReady?.(binding, signal, endpoint),
    })
    this.service = access; this.endpoint = endpoint; this.presence = presence
    this.listenerHttp = {
      mainId, mainPublicKeyFingerprint: identity.publicKeyFingerprint, appVersion: API_APPLICATION_VERSION,
      signMainEnrollmentProof: signEnrollment, pair: (input) => this.track(() => {
        this.assertAdmissionOpen()
        return access.pair(input)
      }),
    }
    if (this.listenerConfig) this.listener = new ProductionDeviceListener(this.listenerConfig, endpoint, this.listenerHttp, this.domains?.browserMedia)
  }
  currentBinding(deviceId: string): DeviceSessionBinding | null { return this.endpoint?.currentBinding(deviceId) ?? null }
  presenceFor(deviceId: string) { return this.presence?.get(deviceId) ?? null }
  endpointForDomains(): DeviceEndpoint {
    this.assertOpen()
    if (!this.endpoint) throw new DomainError('DEVICE_RUNTIME_UNAVAILABLE', 'The selected-main device endpoint has not initialized.', 503)
    return this.endpoint
  }
  private setupOptions(): import('@foreman-code/contracts/device-setup').DeviceSetupOptions {
    if (!this.listenerConfig) return { endpoint: null, available: false, reason: 'listener-unconfigured' }
    const endpoint = this.listenerConfig.advertisedEndpoint ?? null
    if (!endpoint) return { endpoint, available: false, reason: 'endpoint-unconfigured' }
    const tlsTrust = this.listenerStarted ? this.listener?.publicTlsTrust() : undefined
    return { endpoint, available: this.listenerStarted, reason: this.listenerStarted ? null : 'listener-not-started', ...(tlsTrust ? { tlsTrust } : {}) }
  }
  async startListener(): Promise<void> {
    this.assertAdmissionOpen()
    if (!this.service) throw new DomainError('DEVICE_RUNTIME_UNAVAILABLE', 'Device identity must initialize before the dedicated listener.', 503)
    await this.listener?.start()
    this.assertAdmissionOpen()
    this.listenerStarted = Boolean(this.listener)
  }
  listenerStatus(): RemoteExecutionRuntimeStatus {
    return {
      listenerEnabled: this.listenerStarted,
      listenerEndpoint: this.listenerStarted ? this.listenerConfig?.advertisedEndpoint ?? null : null,
      restartRequired: false,
      reason: null,
    }
  }
  configureListener(config: DeviceListenerConfig | undefined): Promise<boolean> {
    return this.track(() => this.applyListenerConfiguration(config))
  }
  private async applyListenerConfiguration(config: DeviceListenerConfig | undefined): Promise<boolean> {
    this.assertAdmissionOpen()
    if (isDeepStrictEqual(config, this.listenerConfig) && (this.listenerStarted || !this.endpoint || !config)) return true
    if (!this.endpoint || !this.listenerHttp) {
      this.listenerConfig = config
      return true
    }
    if (this.listener?.hasConnections()) return false
    this.listenerStarted = false
    await this.listener?.close({ preserveEndpoint: true })
    this.assertAdmissionOpen()
    this.listenerConfig = config
    this.listener = config ? new ProductionDeviceListener(config, this.endpoint, this.listenerHttp) : undefined
    await this.startListener()
    return true
  }
  stopAdmission(): void {
    this.admissionStopped = true
    this.startup.abort(new DomainError('DEVICE_RUNTIME_CLOSING', 'Device access is shutting down.', 503))
    this.listenerStarted = false
    this.endpoint?.stopAdmission()
  }
  stop(): void {
    this.stopAdmission()
    this.stopped = true
    this.endpoint?.close()
    this.presence?.close()
  }
  async drain(): Promise<void> {
    this.stop()
    await this.initialization?.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    const results = await Promise.allSettled([this.listener?.close(), this.endpoint?.join(), ...this.pending])
    const errors = results.slice(0, 2).flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Device transport cleanup was incomplete.')
  }
}
