import { DomainError } from '../errors.js'
import type { BrowserProfileEndpoint, BrowserProfileTransport } from '../browser-profiles/host.js'
import type { BrowserInstallationBinding, BrowserPairingAuthority } from '../browser-profiles/keys.js'
import type { BrowserSnapshotKeyService } from '../browser-profiles/keyService.js'
import type { BrowserHostKeyRequests } from './hostFactory.js'
import { BrowserSessionService, type BrowserFileAction, type BrowserSessionAuthority, type BrowserSessionPort } from './service.js'
import type { BrowserSessionTransport } from './sessionRouter.js'
import type { BrowserBroker } from './broker.js'
import type { BrowserFileStore } from './files.js'
import type { BrowserMediaService } from './media.js'
import { attachBrowserHostMedia, type BrowserHostMediaCodec } from './pairedMedia.js'
import type { WebSocket } from 'ws'

type Tail<T extends readonly unknown[]> = T extends readonly [unknown, ...infer Rest] ? Rest : never
type SessionMethod = keyof BrowserSessionPort<unknown>
type ProfileMethod = Exclude<keyof BrowserProfileEndpoint, 'receive' | 'readSnapshot'>
type SessionCommand<Principal> = { [Name in SessionMethod]: {
  kind: 'session'; method: Name; principal: Principal; args: Tail<Parameters<BrowserSessionPort<Principal>[Name]>>
} }[SessionMethod]
type ProfileCommand = { [Name in ProfileMethod]: {
  kind: 'profile'; method: Name; args: Parameters<BrowserProfileEndpoint[Name]>
} }[ProfileMethod]
export type BrowserDeviceCommand<Principal> = SessionCommand<Principal> | ProfileCommand
type ReceiveInput = Parameters<BrowserProfileEndpoint['receive']>[0]
type FileWrite = Extract<BrowserFileAction, { phase: 'write' }>
type FileRead = Extract<BrowserFileAction, { phase: 'read' }>
export type BrowserDeviceUpload<Principal> = { kind: 'snapshot'; input: ReceiveInput }
  | { kind: 'file'; principal: Principal; input: Omit<FileWrite, 'bytes'>; byteLength: number }
export type BrowserDeviceDownload<Principal> = { kind: 'snapshot'; transfer: Parameters<BrowserProfileEndpoint['readSnapshot']>[0]; offset: number }
  | { kind: 'file'; principal: Principal; input: FileRead }
  | { kind: 'screenshot'; principal: Principal; input: Parameters<BrowserSessionPort<Principal>['screenshot']>[1] }
export type BrowserDeviceKeyRequest = { kind: 'export'; input: Parameters<BrowserHostKeyRequests['exportKey']>[1] }
  | { kind: 'snapshot'; transfer: Parameters<BrowserHostKeyRequests['snapshotKey']>[1]; jobId: string }

/** C0 owns the negotiated envelopes. These projections are private and never become replacement wire schemas.
 * decode* authenticates the existing installed credential and resolves Principal; it never trusts a caller's JSON principal.
 */
export interface BrowserDeviceCodecs<Principal> {
  descriptor: unknown
  encodeCommand(input: BrowserDeviceCommand<Principal>): unknown
  decodeCommand(binding: BrowserInstallationBinding, envelope: unknown): Promise<BrowserDeviceCommand<Principal>>
  encodeResult(input: BrowserDeviceCommand<Principal>, value: unknown): unknown
  decodeResult(input: BrowserDeviceCommand<Principal>, value: unknown): unknown
  encodeUpload(input: BrowserDeviceUpload<Principal>): unknown
  decodeUpload(binding: BrowserInstallationBinding, envelope: unknown): Promise<BrowserDeviceUpload<Principal>>
  encodeUploadResult(input: BrowserDeviceUpload<Principal>, value: unknown): unknown
  decodeUploadResult(input: BrowserDeviceUpload<Principal>, value: unknown): unknown
  encodeDownload(input: BrowserDeviceDownload<Principal>): unknown
  decodeDownload(binding: BrowserInstallationBinding, envelope: unknown): Promise<BrowserDeviceDownload<Principal>>
  encodeKey(input: BrowserDeviceKeyRequest): unknown
  decodeKey(binding: BrowserInstallationBinding, envelope: unknown): Promise<BrowserDeviceKeyRequest>
  encodeKeyResult(value: Awaited<ReturnType<BrowserHostKeyRequests['exportKey']>>): unknown
  decodeKeyResult(value: unknown): Awaited<ReturnType<BrowserHostKeyRequests['exportKey']>>
}

/** D binds existing paired command/byte mechanics; browser media has its own socket and backpressure. */
export interface BrowserDeviceWire {
  request(binding: BrowserInstallationBinding, envelope: unknown): Promise<unknown>
  upload(binding: BrowserInstallationBinding, envelope: unknown, chunks: AsyncIterable<Uint8Array>): Promise<unknown>
  download(binding: BrowserInstallationBinding, envelope: unknown): Promise<AsyncIterable<Uint8Array>>
}

function metadata(value: unknown): unknown {
  const encoded = JSON.stringify(value)
  if (!encoded || Buffer.byteLength(encoded) > 16_384) throw new DomainError('BROWSER_DEVICE_BOUND', 'Browser command metadata exceeds its bounded envelope.', 413)
  return value
}
async function* bounded(chunks: AsyncIterable<Uint8Array>, assertCurrent: () => Promise<void>, length: number) {
  let received = 0
  for await (const bytes of chunks) {
    await assertCurrent()
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 262_144 || received + bytes.length > length) {
      throw new DomainError('BROWSER_DEVICE_BOUND', 'The browser byte stream exceeded its admitted length.', 413)
    }
    received += bytes.length; yield bytes
  }
  await assertCurrent()
  if (received !== length) throw new DomainError('BROWSER_DEVICE_INCOMPLETE', 'The browser byte stream ended before its admitted length.', 409)
}
async function collect(chunks: AsyncIterable<Uint8Array>, assertCurrent: () => Promise<void>, length: number) {
  if (!Number.isSafeInteger(length) || length < 0 || length > 262_144) throw new DomainError('BROWSER_DEVICE_BOUND', 'A browser file request is limited to 256 KiB.', 413)
  const result: Buffer[] = []
  for await (const bytes of bounded(chunks, assertCurrent, length)) result.push(Buffer.from(bytes))
  return Buffer.concat(result, length)
}
async function* single(bytes: Uint8Array) { for (let offset = 0; offset < bytes.length; offset += 262_144) yield bytes.subarray(offset, offset + 262_144) }
async function collectRange(chunks: AsyncIterable<Uint8Array>, assertCurrent: () => Promise<void>, maxLength: number) {
  const result: Buffer[] = []; let length = 0
  for await (const bytes of chunks) {
    await assertCurrent()
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 262_144 || length + bytes.length > maxLength) throw new DomainError('BROWSER_DEVICE_BOUND', 'The browser byte response exceeded its requested bound.', 413)
    length += bytes.length; result.push(Buffer.from(bytes))
  }
  await assertCurrent(); return Buffer.concat(result, length)
}
function response(value: unknown): unknown {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > 1_048_576) throw new DomainError('BROWSER_DEVICE_BOUND', 'The browser metadata response exceeded the device message bound.', 413)
  return value
}

/** Concrete Main adapters for selected-computer routing and immutable encrypted snapshot transfer. */
export function createBrowserDeviceTransport<Principal>(pairing: BrowserPairingAuthority, wire: BrowserDeviceWire,
  codecs: BrowserDeviceCodecs<Principal>): BrowserProfileTransport & BrowserSessionTransport<Principal> {
  const call = async (binding: BrowserInstallationBinding, command: BrowserDeviceCommand<Principal>) => {
    await pairing.assertCurrent(binding)
    const value = await wire.request(binding, metadata(codecs.encodeCommand(command)))
    await pairing.assertCurrent(binding); return codecs.decodeResult(command, value)
  }
  const upload = async (binding: BrowserInstallationBinding, input: BrowserDeviceUpload<Principal>, chunks: AsyncIterable<Uint8Array>) => {
    await pairing.assertCurrent(binding)
    const length = input.kind === 'snapshot' ? input.input.transfer.manifest.byteLength : input.byteLength
    const value = await wire.upload(binding, metadata(codecs.encodeUpload(input)), bounded(chunks, () => pairing.assertCurrent(binding), length))
    await pairing.assertCurrent(binding); return codecs.decodeUploadResult(input, value)
  }
  const download = async (binding: BrowserInstallationBinding, input: BrowserDeviceDownload<Principal>, length: number) => {
    await pairing.assertCurrent(binding)
    const chunks = await wire.download(binding, metadata(codecs.encodeDownload(input)))
    return collect(chunks, () => pairing.assertCurrent(binding), length)
  }
  return {
    async endpoint(binding) {
      await pairing.assertCurrent(binding)
      const profile = <Name extends ProfileMethod>(method: Name, args: Parameters<BrowserProfileEndpoint[Name]>) =>
        call(binding, { kind: 'profile', method, args } as ProfileCommand) as Promise<Awaited<ReturnType<BrowserProfileEndpoint[Name]>>>
      return {
        status: profileId => profile('status', [profileId]), create: input => profile('create', [input]), remove: input => profile('remove', [input]),
        export: input => profile('export', [input]), apply: input => profile('apply', [input]), prune: input => profile('prune', [input]),
        checkOrigin: input => profile('checkOrigin', [input]),
        readSnapshot: (transfer, offset) => download(binding, { kind: 'snapshot', transfer, offset }, Math.min(262_144, transfer.manifest.byteLength - offset)),
        receive: async (input, chunks) => { await upload(binding, { kind: 'snapshot', input }, chunks) },
      }
    },
    async invoke<Name extends SessionMethod>(binding: BrowserInstallationBinding, method: Name, principal: Principal,
      args: Tail<Parameters<BrowserSessionPort<Principal>[Name]>>): Promise<Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>> {
      const input = args[0] as BrowserFileAction | undefined
      let value: unknown
      if (method === 'perform' && input?.intent === 'file' && input.phase === 'write') {
        const { bytes, ...file } = input
        value = await upload(binding, { kind: 'file', principal, input: file, byteLength: bytes.byteLength }, single(bytes))
      } else if (method === 'perform' && input?.intent === 'file' && input.phase === 'read') {
        // The selected host returns a bounded raw chunk; length is supplied by its authenticated byte response.
        await pairing.assertCurrent(binding)
        if (!Number.isSafeInteger(input.length) || input.length < 1 || input.length > 262_144) throw new DomainError('BROWSER_DEVICE_BOUND', 'A browser file read is limited to 256 KiB.', 413)
        const chunks = await wire.download(binding, metadata(codecs.encodeDownload({ kind: 'file', principal, input })))
        value = await collectRange(chunks, () => pairing.assertCurrent(binding), input.length)
      } else if (method === 'screenshot') {
        await pairing.assertCurrent(binding)
        const screenshot = args[0] as Parameters<BrowserSessionPort<Principal>['screenshot']>[1]
        const chunks = await wire.download(binding, metadata(codecs.encodeDownload({ kind: 'screenshot', principal, input: screenshot })))
        const bytes = await collectRange(chunks, () => pairing.assertCurrent(binding), 2 * 1024 * 1024)
        if (!bytes.length) throw new DomainError('BROWSER_DEVICE_INCOMPLETE', 'The browser screenshot returned no bytes.', 409)
        value = { sessionId: screenshot.sessionId, tabId: screenshot.tabId, browserGeneration: screenshot.actor.browserGeneration,
          mimeType: 'image/png', bytes }
      } else value = await call(binding, { kind: 'session', method, principal, args } as SessionCommand<Principal>)
      await pairing.assertCurrent(binding)
      return value as Awaited<ReturnType<BrowserSessionPort<Principal>[Name]>>
    },
  }
}

export interface BrowserDeviceHost { broker: BrowserBroker; files: BrowserFileStore; media: BrowserMediaService; profileEndpoint: BrowserProfileEndpoint }

/** Host implementation: all authority and native semantics remain in the same service used locally. */
export function createBrowserHostDeviceEndpoint<Principal>(options: {
  host: BrowserDeviceHost; binding: BrowserInstallationBinding; pairing: BrowserPairingAuthority
  authority: BrowserSessionAuthority<Principal>; codecs: BrowserDeviceCodecs<Principal>; mediaCodec: BrowserHostMediaCodec
  reportFailure(error: unknown): void
}) {
  const { host, binding, pairing, codecs } = options
  const sessions = new BrowserSessionService(host.broker, host.media, host.files, options.authority)
  const assertCurrent = () => pairing.assertCurrent(binding)
  return {
    descriptor: codecs.descriptor,
    async command(envelope: unknown) {
      await assertCurrent()
      const command = await codecs.decodeCommand(binding, metadata(envelope))
      let result: unknown
      if (command.kind === 'profile') result = await Reflect.apply(host.profileEndpoint[command.method], host.profileEndpoint, command.args)
      else {
        const file = command.args[0] as BrowserFileAction | undefined
        if (command.method === 'screenshot' || command.method === 'perform' && file?.intent === 'file' && ['read', 'write'].includes(file.phase)) throw new DomainError('BROWSER_BYTE_ROUTE_REQUIRED', 'Browser files and screenshot bytes use the dedicated authenticated byte path.', 400)
        result = await Reflect.apply(sessions[command.method], sessions, [command.principal, ...command.args])
      }
      await assertCurrent(); return response(codecs.encodeResult(command, result))
    },
    async upload(envelope: unknown, chunks: AsyncIterable<Uint8Array>) {
      await assertCurrent()
      const input = await codecs.decodeUpload(binding, metadata(envelope))
      if (input.kind === 'file') await sessions.authorizeUpload(input.principal, input.input.sessionId, input.input.fileId)
      const result = input.kind === 'snapshot'
        ? await host.profileEndpoint.receive(input.input, bounded(chunks, assertCurrent, input.input.transfer.manifest.byteLength))
        : await sessions.perform(input.principal, { ...input.input, bytes: await collect(chunks, assertCurrent, input.byteLength) })
      await assertCurrent(); return codecs.encodeUploadResult(input, result)
    },
    async download(envelope: unknown): Promise<AsyncIterable<Uint8Array>> {
      await assertCurrent()
      const input = await codecs.decodeDownload(binding, metadata(envelope))
      const result = input.kind === 'snapshot' ? await host.profileEndpoint.readSnapshot(input.transfer, input.offset)
        : input.kind === 'screenshot' ? (await sessions.screenshot(input.principal, input.input)).bytes : await sessions.perform(input.principal, input.input)
      if (!(result instanceof Uint8Array) || result.length > (input.kind === 'screenshot' ? 2 * 1024 * 1024 : 262_144)) throw new DomainError('BROWSER_DEVICE_BOUND', 'Invalid browser byte response.', 413)
      await assertCurrent(); return bounded(single(result), assertCurrent, result.length)
    },
    media: (socket: WebSocket) => attachBrowserHostMedia(socket, binding, pairing, options.mediaCodec, host.media, host.broker, options.reportFailure),
  }
}

export function createBrowserDeviceKeyEndpoint<Principal>(keys: BrowserSnapshotKeyService, pairing: BrowserPairingAuthority, codecs: BrowserDeviceCodecs<Principal>) {
  return async (binding: BrowserInstallationBinding, envelope: unknown) => {
    await pairing.assertCurrent(binding)
    const input = await codecs.decodeKey(binding, metadata(envelope))
    const value = input.kind === 'export' ? await keys.exportKey(binding, input.input) : await keys.snapshotKey(binding, input.transfer, input.jobId)
    await pairing.assertCurrent(binding); return codecs.encodeKeyResult(value)
  }
}

export function createBrowserHostKeyRequests<Principal>(requestMain: BrowserDeviceWire['request'], pairing: BrowserPairingAuthority,
  codecs: BrowserDeviceCodecs<Principal>): BrowserHostKeyRequests {
  const request = async (binding: BrowserInstallationBinding, input: BrowserDeviceKeyRequest) => {
    await pairing.assertCurrent(binding)
    const value = await requestMain(binding, metadata(codecs.encodeKey(input)))
    await pairing.assertCurrent(binding); return codecs.decodeKeyResult(value)
  }
  return { exportKey: (binding, input) => request(binding, { kind: 'export', input }),
    snapshotKey: (binding, transfer, jobId) => request(binding, { kind: 'snapshot', transfer, jobId }) }
}
