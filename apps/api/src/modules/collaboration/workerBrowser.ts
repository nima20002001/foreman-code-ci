import { createHash } from 'node:crypto'
import WebSocket from 'ws'
import { deviceTlsOptions } from '@foreman-code/contracts/device-tls-node'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { BROWSER_DEVICE_EXTENSION, BROWSER_MEDIA_PATH, BrowserDeviceRequestSchema,
  BrowserPreparedBindingSchema, canonicalJson } from '@foreman-code/contracts'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceConnectionSupervisor } from '../devices/connectionSupervisor.js'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import type { BrowserPairingAuthority } from '../browser-profiles/keys.js'
import type { BrowserHostOptions, createBrowserHost } from '../browser-runtime/hostFactory.js'
import type { BrowserSessionAuthority } from '../browser-runtime/service.js'
import { createBrowserHostKeyRequests } from '../browser-runtime/deviceExtension.js'
import type { BrowserDeviceCodecs } from '../browser-runtime/deviceExtension.js'
import type { BrowserHostMediaCodec } from '../browser-runtime/pairedMedia.js'
import type { BrowserSubjectAuthority } from '../browser-runtime/types.js'
import { browserConnectionBinding, browserWrappingKey } from './browserPairing.js'
import { createBrowserDeviceCodecs } from './browserDeviceCodecs.js'
import { browserHostMediaCodec } from './browserMediaCodecs.js'
import { BrowserByteTransfers } from './browserByteTransfers.js'
import { DomainError } from '../errors.js'

type Host = Awaited<ReturnType<typeof createBrowserHost>>
interface Runtime {
  start(): Promise<unknown>; retry(): Promise<unknown>; close(): Promise<void>
  stop(): Promise<void>; restoreProfiles(checkpointId: string): Promise<unknown>
  status(): { ready: boolean; phase: string; message?: string; runtimeVersion?: string }
  getHost(): Host | null; stopAdmission(): void; resumeAdmission(): Promise<unknown>; drain(): Promise<unknown>
}
interface Extension {
  command(binding: ReturnType<typeof browserConnectionBinding>, payload: unknown): Promise<unknown>
  upload(binding: ReturnType<typeof browserConnectionBinding>, payload: unknown, chunks: AsyncIterable<Uint8Array>): Promise<unknown>
  download(binding: ReturnType<typeof browserConnectionBinding>, payload: unknown): Promise<AsyncIterable<Uint8Array>>
  media(binding: ReturnType<typeof browserConnectionBinding>, socket: WebSocket): Promise<void>
  close(): void
}
export function createInstalledBrowserComposition(options: {
  stateDirectory: string; root: string; facts: unknown; installationId: string; computerId: string
  connection(): Pick<DeviceConnectionSupervisor, 'currentBinding' | 'captureRequest'> | undefined
  readPairing(): Promise<WorkerPairingConfiguration>; assertHostOwnership(): Promise<void>; reportFailure(error: unknown): void
  createRuntime(options: Omit<BrowserHostOptions, 'runtime'> & { root: string; facts: unknown; expected: { protocolVersion: number; identityFormat: number } }): Runtime
  createExtension(options: { runtime: Runtime; pairing: BrowserPairingAuthority; authority: BrowserSessionAuthority<ManagementPrincipal>;
    codecs: BrowserDeviceCodecs<ManagementPrincipal>; mediaCodec: BrowserHostMediaCodec; reportFailure(error: unknown): void }): Extension
}) {
  const current = () => {
    const binding = options.connection()?.currentBinding()
    if (!binding || binding.deviceId !== options.computerId || binding.workerInstallationId !== options.installationId) {
      throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser host has no current Main connection.', 503)
    }
    return binding
  }
  const request = async (payload: unknown) => {
    const original = current(), channel = options.connection()?.captureRequest(BROWSER_DEVICE_EXTENSION.namespace)
    if (!channel || canonicalJson(channel.binding) !== canonicalJson(original)) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser callback connection changed.', 409)
    const reply = await channel.request(payload)
    if (canonicalJson(current()) !== canonicalJson(original)) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser callback connection changed.', 409)
    return reply.payload
  }
  const pairing: BrowserPairingAuthority = {
    current: async computerId => {
      if (computerId !== options.computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'The browser host owns only its installed computer.', 403)
      return browserConnectionBinding(current())
    },
    assertCurrent: async binding => {
      await options.assertHostOwnership()
      if (canonicalJson(binding) !== canonicalJson(browserConnectionBinding(current()))) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser installation connection changed.', 409)
    },
    assertInstallation: async (computerId, installationId) => { await request({ operation: 'installation-check', computerId, installationId }) },
    wrappingKey: async binding => {
      await pairing.assertCurrent(binding)
      const saved = await options.readPairing()
      const now = current()
      if (saved.workerInstallationId !== binding.installationId || saved.keyRevision !== now.keyRevision
        || saved.authorizationRevision !== now.authorizationRevision) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The paired browser credential changed.', 403)
      return browserWrappingKey(createHash('sha256').update(saved.credential).digest(), binding)
    },
  }
  const invocation = new WeakMap<ManagementPrincipal, string>()
  const codecs = createBrowserDeviceCodecs({ issue: () => { throw new DomainError('BROWSER_DEVICE_DIRECTION', 'A Worker cannot issue Main browser commands.', 403) },
    authorize: async (binding, envelope) => {
      await pairing.assertCurrent(binding)
      const result = await request({ operation: 'authorize', envelope }) as { principal: unknown }
      if (result.principal === null) return undefined
      const principal = ManagementPrincipalSchema.parse(result.principal)
      invocation.set(principal, envelope.authorizationId)
      return principal
    } })
  const caller = (principal: ManagementPrincipal) => {
    const authorizationId = invocation.get(principal)
    if (!authorizationId) throw new DomainError('BROWSER_DEVICE_SCOPE', 'The browser caller has no admitted Main request.', 403)
    return { principalId: principal.id, authorizationId }
  }
  const authority: BrowserSessionAuthority<ManagementPrincipal> = {
    callerId: principal => principal.id,
    subject: async (principal, subject, mutate) => { await request({ operation: 'subject-authorize', ...caller(principal), subject, mutate }) },
    setup: async (principal, profileId, computerId, mutate) => { await request({ operation: 'setup-authorize', ...caller(principal), profileId, computerId, mutate }) },
    session: async (principal, session, mutate) => { await request({ operation: 'session-authorize', ...caller(principal), session, mutate }) },
    actor: async principal => principal.audience === 'worker' ? 'agent' : 'viewer',
  }
  const subjectAuthority: BrowserSubjectAuthority = {
    resolve: async subject => BrowserPreparedBindingSchema.parse(await request({ operation: 'subject', subject })),
    assertCurrent: async subject => { await request({ operation: 'subject-current', subject }) },
  }
  const keys = createBrowserHostKeyRequests(async (_binding, input) => request({ operation: 'keys', input }), pairing, codecs)
  const runtime = options.createRuntime({ ...options, expected: { protocolVersion: 1, identityFormat: 1 }, pairing, subjectAuthority, keys })
  const extension = options.createExtension({ runtime, pairing, authority, codecs, mediaCodec: browserHostMediaCodec, reportFailure: options.reportFailure })
  const transfers = new BrowserByteTransfers(() => ({
    upload: (envelope, chunks) => extension.upload(browserConnectionBinding(current()), envelope, chunks),
    download: envelope => extension.download(browserConnectionBinding(current()), envelope),
  }))
  const status = () => {
    const value = runtime.status()
    return { computerId: options.computerId, ready: value.ready, phase: value.phase,
      reason: value.message ?? null, ...(value.runtimeVersion ? { runtimeVersion: value.runtimeVersion } : {}) }
  }
  const registration: DeviceExtensionRegistration = { ...BROWSER_DEVICE_EXTENSION, async handle(raw, context: DeviceExtensionContext) {
    if (canonicalJson(context.binding) !== canonicalJson(current())) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser request belongs to another connection.', 403)
    const input = BrowserDeviceRequestSchema.parse(raw), binding = browserConnectionBinding(context.binding)
    context.signal.throwIfAborted()
    switch (input.operation) {
      case 'runtime-status': return { payload: status() }
      case 'runtime-retry': await runtime.retry(); await connectMedia(); return { payload: status() }
      case 'command': return { payload: await extension.command(binding, input.envelope) }
      case 'prepare': {
        if (!runtime.getHost()) return { payload: { kind: 'unavailable', reason: 'runtime_missing', retryable: true } }
        return { payload: await runtime.getHost()!.broker.prepare(input.input) }
      }
      case 'release': {
        const host = runtime.getHost()
        if (!host) throw new DomainError('BROWSER_RUNTIME_UNAVAILABLE', 'The browser runtime must recover before confirming cleanup.', 503)
        return { payload: await host.broker.release(input.input) }
      }
      case 'upload-open': return { payload: await transfers.openUpload(binding.connectionId, input.transferId, input.envelope) }
      case 'upload-chunk': return { payload: await transfers.write(binding.connectionId, input.transferId, input.offset, context.bytes) }
      case 'upload-finish': return { payload: await transfers.finish(binding.connectionId, input.transferId) }
      case 'download-open': return { payload: await transfers.openDownload(binding.connectionId, input.transferId, input.envelope) }
      case 'download-chunk': {
        const { bytes, ...payload } = await transfers.read(binding.connectionId, input.transferId, input.offset)
        return { payload, ...(bytes ? { bytes } : {}) }
      }
      case 'transfer-close': await transfers.close(binding.connectionId, input.transferId); return { payload: { closed: true } }
      default: throw new DomainError('BROWSER_DEVICE_DIRECTION', 'This browser request must be handled by Main.', 403)
    }
  } }
  let socket: WebSocket | undefined, closed = false, mediaEnabled = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const connectMedia = async () => {
    if (closed || !mediaEnabled || !runtime.getHost()) return
    clearTimeout(retryTimer)
    const binding = browserConnectionBinding(current()), saved = await options.readPairing()
    const url = new URL(saved.endpoint); url.pathname = BROWSER_MEDIA_PATH
    socket?.close(1000, 'Browser connection replaced')
    const next = new WebSocket(url, { headers: { authorization: `Bearer ${saved.credential}`, 'x-browser-connection': binding.connectionId },
      ...deviceTlsOptions(saved.tlsTrust), maxPayload: 262_144, perMessageDeflate: false })
    socket = next
    next.once('open', () => { void extension.media(binding, next).catch(error => { options.reportFailure(error); next.close(1008, 'Browser media failed') }) })
    next.on('error', options.reportFailure)
    next.once('close', () => {
      if (socket !== next || closed || !mediaEnabled) return
      retryTimer = setTimeout(() => { void connectMedia().catch(options.reportFailure) }, 1000)
      retryTimer.unref()
    })
  }
  return { registration, runtime, status,
    async start() { mediaEnabled = true; await runtime.start(); await connectMedia() },
    async bindingLost(binding: DeviceSessionBinding) { mediaEnabled = false; clearTimeout(retryTimer); socket?.close(1001, 'Device connection closed'); await transfers.closeBinding(browserConnectionBinding(binding).connectionId) },
    async retry() { await runtime.retry(); await connectMedia(); return status() },
    stopAdmission: () => runtime.stopAdmission(),
    async drain() { if (runtime.getHost()) await runtime.drain() },
    async resumeAdmission() {
      await runtime.start()
      if (runtime.getHost()) await runtime.resumeAdmission()
      await connectMedia()
    },
    async close() { closed = true; clearTimeout(retryTimer); socket?.close(1001, 'Worker closing'); extension.close(); await transfers.closeAll(); await runtime.close() },
  }
}
