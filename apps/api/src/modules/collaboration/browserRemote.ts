import { definedProperties } from '../definedProperties.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { WebSocketServer } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { BROWSER_DEVICE_EXTENSION, BROWSER_MEDIA_PATH, BrowserDeviceRequestSchema,
  BrowserSessionSchema, BrowserPrepareResultSchema, BrowserReleaseResultSchema, BrowserRuntimeStatusSchema,
  BrowserPrivateEnvelopeSchema, canonicalJson } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { readChatPrincipal } from '../access/conversationCredentials.js'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { DeviceExtensionContext } from '../devices/deviceApplicationChannel.js'
import { createBrowserDeviceTransport, createBrowserDeviceKeyEndpoint } from '../browser-runtime/deviceExtension.js'
import { BrowserPairedMediaHub } from '../browser-runtime/pairedMedia.js'
import type { BrowserInstallationBinding } from '../browser-profiles/keys.js'
import type { MainBrowserPairing } from './browserPairing.js'
import { browserConnectionBinding } from './browserPairing.js'
import type { BrowserAuthority } from './browserAuthority.js'
import type { createProductionBrowser } from './browserComposition.js'
import { createBrowserDeviceCodecs, type BrowserInvocation } from './browserDeviceCodecs.js'
import { browserHostMediaCodec } from './browserMediaCodecs.js'
import { DomainError } from '../errors.js'

export function createMainBrowserRemote(options: {
  pool: pg.Pool; pairing: MainBrowserPairing; authority: BrowserAuthority
  endpoint(): DeviceEndpoint; browser(): ReturnType<typeof createProductionBrowser>
  reportFailure(error: unknown): void
}) {
  const invocations = new Map<string, { envelope: BrowserInvocation; principal?: ManagementPrincipal; binding?: BrowserInstallationBinding }>()
  const issue = (kind: BrowserInvocation['kind'], value: unknown, principal?: ManagementPrincipal) => {
    const envelope = BrowserPrivateEnvelopeSchema.parse({ authorizationId: randomUUID(), kind, value })
    invocations.set(envelope.authorizationId, { envelope, ...(principal ? { principal } : {}) })
    return envelope
  }
  const codecs = createBrowserDeviceCodecs({ issue, authorize: async () => {
    throw new DomainError('BROWSER_DEVICE_DIRECTION', 'Main does not execute peer-supplied browser commands.', 403)
  } })
  const capture = async (binding: BrowserInstallationBinding) => {
    await options.pairing.assertCurrent(binding)
    const channel = options.endpoint().captureRequest(binding.computerId, BROWSER_DEVICE_EXTENSION.namespace)
    if (!channel || canonicalJson(browserConnectionBinding(channel.binding)) !== canonicalJson(binding)) {
      throw new DomainError('BROWSER_COMPUTER_OFFLINE', 'The paired browser computer is unavailable.', 503)
    }
    return channel
  }
  const begin = (binding: BrowserInstallationBinding, raw: unknown) => {
    const envelope = BrowserPrivateEnvelopeSchema.parse(raw)
    const entry = invocations.get(envelope.authorizationId)
    if (!entry || canonicalJson(entry.envelope) !== canonicalJson(envelope)) throw new DomainError('BROWSER_DEVICE_SCOPE', 'The browser dispatch was not issued by Main.', 403)
    entry.binding = binding
    return envelope
  }
  const closeTransfer = async (binding: BrowserInstallationBinding, transferId: string) => {
    try { await (await capture(binding)).request({ operation: 'transfer-close', transferId }) }
    catch (error) { options.reportFailure(error) }
  }
  const transport = createBrowserDeviceTransport(options.pairing, {
    async request(binding, raw) {
      const envelope = begin(binding, raw)
      try { return (await (await capture(binding)).request({ operation: 'command', envelope })).payload }
      finally { invocations.delete(envelope.authorizationId) }
    },
    async upload(binding, raw, chunks) {
      const envelope = begin(binding, raw), transferId = randomUUID()
      try {
        await (await capture(binding)).request({ operation: 'upload-open', transferId, envelope })
        let offset = 0
        for await (const bytes of chunks) {
          await (await capture(binding)).request({ operation: 'upload-chunk', transferId, offset }, { bytes })
          offset += bytes.byteLength
        }
        return (await (await capture(binding)).request({ operation: 'upload-finish', transferId })).payload
      } finally { await closeTransfer(binding, transferId); invocations.delete(envelope.authorizationId) }
    },
    async download(binding, raw) {
      const envelope = begin(binding, raw), transferId = randomUUID()
      try { await (await capture(binding)).request({ operation: 'download-open', transferId, envelope }) }
      catch (error) { invocations.delete(envelope.authorizationId); throw error }
      return (async function* () {
        let offset = 0
        try {
          for (;;) {
            const reply = await (await capture(binding)).request({ operation: 'download-chunk', transferId, offset })
            const metadata = reply.payload as { done?: boolean; offset?: number }
            if (metadata.offset !== offset || typeof metadata.done !== 'boolean') throw new DomainError('BROWSER_TRANSFER_OFFSET', 'The browser download did not retain its offset.', 409)
            if (metadata.done) return
            if (!reply.bytes?.byteLength || reply.bytes.byteLength > 262_144) throw new DomainError('BROWSER_FILE_CHUNK_INVALID', 'Invalid browser download chunk.', 413)
            yield reply.bytes
            offset += reply.bytes.byteLength
          }
        } finally { await closeTransfer(binding, transferId); invocations.delete(envelope.authorizationId) }
      })()
    },
  }, codecs)
  const caller = async (binding: BrowserInstallationBinding, authorizationId: string, principalId?: string) => {
    const entry = invocations.get(authorizationId)
    if (!entry?.binding || canonicalJson(entry.binding) !== canonicalJson(binding)
      || !entry.principal || principalId && entry.principal.id !== principalId) {
      throw new DomainError('BROWSER_DEVICE_SCOPE', 'The browser callback does not belong to an admitted Main request.', 403)
    }
    return readChatPrincipal(options.pool, entry.principal.id)
  }
  const hub = new BrowserPairedMediaHub<ManagementPrincipal>(options.pairing, browserHostMediaCodec, principal => principal.id,
    async (principal, sessionId) => {
      const session = await options.browser().locations.session(sessionId)
      if (!session) throw new DomainError('BROWSER_NOT_FOUND', 'The browser session is unavailable.', 404)
      await options.authority.session(principal, session.session, false)
    }, options.reportFailure)
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 262_144, perMessageDeflate: false })
  return {
    profiles: transport, sessions: transport, media: (binding: BrowserInstallationBinding) => hub.source(binding),
    async ready(computerId: string) {
      const binding = await options.pairing.current(computerId)
      if (binding.connectionId.startsWith('offline:')) return false
      const response = await (await capture(binding)).request({ operation: 'runtime-status' })
      return BrowserRuntimeStatusSchema.parse(response.payload).ready
    },
    async prepare(input: Parameters<ReturnType<typeof createProductionBrowser>['lifecycle']['prepare']>[0]) {
      const response = await (await capture(await options.pairing.current(input.computerId))).request({ operation: 'prepare', input })
      return BrowserPrepareResultSchema.parse(response.payload)
    },
    async release(input: Parameters<ReturnType<typeof createProductionBrowser>['lifecycle']['release']>[0]) {
      const saved = await options.browser().locations.session(input.sessionId)
      if (!saved) throw new DomainError('BROWSER_NOT_FOUND', 'The retained browser session is unavailable.', 404)
      await options.pairing.assertInstallation(saved.session.computerId, saved.installationId)
      const response = await (await capture(await options.pairing.current(saved.session.computerId))).request({ operation: 'release', input })
      return BrowserReleaseResultSchema.parse(response.payload)
    },
    async handle(raw: unknown, context: DeviceExtensionContext) {
      const request = BrowserDeviceRequestSchema.parse(raw), binding = browserConnectionBinding(context.binding)
      await options.pairing.assertCurrent(binding)
      context.signal.throwIfAborted()
      if (request.operation === 'authorize') {
        const entry = invocations.get(request.envelope.authorizationId)
        if (!entry?.binding || canonicalJson(entry.binding) !== canonicalJson(binding)
          || canonicalJson(entry.envelope) !== canonicalJson(request.envelope)) throw new DomainError('BROWSER_DEVICE_SCOPE', 'Unknown browser request authority.', 403)
        return { payload: { principal: entry.principal ? await caller(binding, request.envelope.authorizationId) : null } }
      }
      if (request.operation === 'subject') {
        return { payload: await options.authority.resolve(request.subject, { readyComputerId: binding.computerId }) }
      }
      if (request.operation === 'subject-current') {
        await options.authority.assertCurrent(request.subject,
          definedProperties({ computerId: binding.computerId, profileId: request.profileId }))
        return { payload: { current: true } }
      }
      if (request.operation === 'session-authorize') {
        const principal = await caller(binding, request.authorizationId, request.principalId)
        const session = BrowserSessionSchema.parse(request.session)
        if (session.computerId !== binding.computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'The session belongs to another computer.', 403)
        await options.authority.session(principal, session, request.mutate)
        return { payload: { allowed: true } }
      }
      if (request.operation === 'subject-authorize') {
        const principal = await caller(binding, request.authorizationId, request.principalId)
        if ((await options.authority.details(request.subject)).computerId !== binding.computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'This subject belongs to another computer.', 403)
        await options.authority.subject(principal, request.subject, request.mutate)
        return { payload: { allowed: true } }
      }
      if (request.operation === 'setup-authorize') {
        const principal = await caller(binding, request.authorizationId, request.principalId)
        if (request.computerId !== binding.computerId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'This setup belongs to another computer.', 403)
        await options.authority.setup(principal, request.profileId, request.computerId, request.mutate)
        return { payload: { allowed: true } }
      }
      if (request.operation === 'installation-check') {
        await options.pairing.assertInstallation(request.computerId, request.installationId)
        return { payload: { valid: true } }
      }
      if (request.operation === 'keys') return { payload: await createBrowserDeviceKeyEndpoint(options.browser().profiles.keyService, options.pairing, codecs)(binding, request.input) }
      throw new DomainError('BROWSER_DEVICE_DIRECTION', 'This browser request is not a Main callback.', 403)
    },
    mediaUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
      if (new URL(request.url ?? '/', 'https://browser.invalid').pathname !== BROWSER_MEDIA_PATH) return false
      void (async () => {
        const authenticated = await options.endpoint().authenticate(definedProperties({ authorization: request.headers.authorization,
          cookie: request.headers.cookie, origin: request.headers.origin }))
        const current = options.endpoint().currentBinding(authenticated.deviceId)
        if (!current || browserConnectionBinding(current).connectionId !== request.headers['x-browser-connection']) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser media connection is stale.', 403)
        const binding = browserConnectionBinding(current)
        await options.pairing.assertCurrent(binding)
        sockets.handleUpgrade(request, socket, head, client => {
          void hub.attach(binding, client).then(() => options.browser().profiles.wake()).catch(error => { options.reportFailure(error); client.close(1008, 'Browser media authorization failed') })
        })
      })().catch(error => { options.reportFailure(error); socket.destroy() })
      return true
    },
    close() { for (const socket of sockets.clients) socket.close(1001, 'Browser runtime closing'); sockets.close(); invocations.clear() },
  }
}
