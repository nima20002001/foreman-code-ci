import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../errors.js'
import type { BrowserInstallationBinding, BrowserPairingAuthority } from '../browser-profiles/keys.js'
import type { BrowserProfileEndpoint } from '../browser-profiles/host.js'
import { createBrowserDeviceTransport, createBrowserHostDeviceEndpoint, type BrowserDeviceCodecs,
  type BrowserDeviceCommand, type BrowserDeviceUpload, type BrowserDeviceDownload, type BrowserDeviceKeyRequest,
  type BrowserDeviceWire } from './deviceExtension.js'
import { runtimeRecoveryFixture, type RecoveryPrincipal } from './recovery.test-support.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

function reference<T>() {
  const values = new Map<string, T>()
  return {
    encode(value: T) { const id = randomUUID(); values.set(id, value); return { reference: id } },
    decode(value: unknown): T {
      if (!value || typeof value !== 'object' || !('reference' in value) || typeof value.reference !== 'string') throw new Error('Invalid fixture reference')
      const found = values.get(value.reference)
      if (!found) throw new Error('Unknown fixture reference')
      return found
    },
  }
}

function privateCodecs(): BrowserDeviceCodecs<RecoveryPrincipal> {
  const command = reference<BrowserDeviceCommand<RecoveryPrincipal>>(), upload = reference<BrowserDeviceUpload<RecoveryPrincipal>>()
  const download = reference<BrowserDeviceDownload<RecoveryPrincipal>>(), key = reference<BrowserDeviceKeyRequest>()
  // Reference-only fakes exercise B's ports without declaring replacement C0 request/response schemas.
  return { descriptor: { fixture: 'private typed ports' }, encodeCommand: command.encode, decodeCommand: async (_binding, value) => command.decode(value),
    encodeResult: (_input, value) => value, decodeResult: (_input, value) => value,
    encodeUpload: upload.encode, decodeUpload: async (_binding, value) => upload.decode(value),
    encodeUploadResult: (_input, value) => value, decodeUploadResult: (_input, value) => value,
    encodeDownload: download.encode, decodeDownload: async (_binding, value) => download.decode(value),
    encodeKey: key.encode, decodeKey: async (_binding, value) => key.decode(value),
    encodeKeyResult: value => value, decodeKeyResult: () => { throw new Error('Unexpected key request') },
  }
}

async function pairedFixture() {
  const f = await runtimeRecoveryFixture(); cleanup.push(f.cleanup)
  const session = await f.prepare(), binding: BrowserInstallationBinding = { computerId: 'worker', installationId: 'installed', connectionId: 'connection' }
  let current = binding
  const pairing: BrowserPairingAuthority = {
    current: async () => current,
    assertCurrent: async candidate => {
      if (candidate.computerId !== current.computerId || candidate.installationId !== current.installationId || candidate.connectionId !== current.connectionId) {
        throw new DomainError('BROWSER_PAIRING_CHANGED', 'The installed connection was replaced.', 403)
      }
    }, wrappingKey: async () => new Uint8Array(32),
    assertInstallation: async (computer, installation) => {
      if (computer !== current.computerId || installation !== current.installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'Another installation.', 403)
    },
  }
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected profile operation in byte fixture') }
  const profileEndpoint: BrowserProfileEndpoint = { status: async () => 'ready', create: unavailable, remove: unavailable,
    export: unavailable, readSnapshot: unavailable, receive: unavailable, apply: unavailable, prune: unavailable, checkOrigin: unavailable }
  const codecs = privateCodecs(), endpoint = createBrowserHostDeviceEndpoint({ host: { broker: f.broker, files: f.files, media: f.media, profileEndpoint },
    binding, pairing, authority: f.authority, codecs, mediaCodec: { encode: () => { throw new Error('Unexpected media socket') },
      decode: () => { throw new Error('Unexpected media socket') } }, reportFailure: f.reportFailure })
  const lengths: number[] = [], stream = { revokeAfterChunk: false }
  const request = vi.fn(async (_binding: BrowserInstallationBinding, envelope: unknown) => endpoint.command(envelope))
  const upload = vi.fn(async (_binding: BrowserInstallationBinding, envelope: unknown, chunks: AsyncIterable<Uint8Array>) => endpoint.upload(envelope, chunks))
  const download = vi.fn(async (_binding: BrowserInstallationBinding, envelope: unknown) => {
    const chunks = await endpoint.download(envelope)
    return (async function* () {
      for await (const bytes of chunks) {
        lengths.push(bytes.length); yield bytes
        if (stream.revokeAfterChunk) current = { ...current, connectionId: 'replacement' }
      }
    })()
  })
  const wire: BrowserDeviceWire = { request, upload, download }, transport = createBrowserDeviceTransport(pairing, wire, codecs)
  const principal: RecoveryPrincipal = { id: 'agent', role: 'agent', sessionId: session.id }
  const actor = { kind: 'agent' as const, epoch: 0, browserGeneration: session.browserGeneration }
  return { ...f, session, binding, codecs, endpoint, transport, request, upload, download, lengths, stream, principal, actor,
    replace: () => { current = { ...current, installationId: 'replacement-installation' } } }
}

it('routes legal screenshots over bounded byte chunks and never consumes an ordinary device command slot', async () => {
  const f = await pairedFixture()
  f.screenshots.bytes = Buffer.alloc(1_048_577, 17)
  const input = { sessionId: f.session.id, tabId: f.session.selectedTabId!, actor: f.actor }
  const image = await f.transport.invoke(f.binding, 'screenshot', f.principal, [input])
  expect(image.bytes).toEqual(f.screenshots.bytes)
  expect(image).toMatchObject({ sessionId: f.session.id, tabId: f.session.selectedTabId, mimeType: 'image/png' })
  expect(f.request).not.toHaveBeenCalled()
  expect(f.lengths).toEqual([262_144, 262_144, 262_144, 262_144, 1])
  await expect(f.endpoint.command(f.codecs.encodeCommand({ kind: 'session', method: 'screenshot', principal: f.principal, args: [input] })))
    .rejects.toMatchObject({ code: 'BROWSER_BYTE_ROUTE_REQUIRED' })
})

it('authenticates the exact file before reading upload bytes and preserves ordered byte write/read semantics', async () => {
  const f = await pairedFixture(), bytes = new Uint8Array([4, 5, 6])
  const owner = { sessionId: f.session.id, tabId: f.session.selectedTabId!, browserGeneration: f.session.browserGeneration }
  const file = await f.files.begin({ ...owner, commandId: 'file', name: 'fixture.bin', mimeType: 'application/octet-stream', byteLength: bytes.length })
  const input = { intent: 'file' as const, phase: 'write' as const, sessionId: f.session.id, fileId: file.id, offset: 0 }
  const readBytes = vi.fn()
  async function* chunk() { readBytes(); yield bytes }
  const envelope = f.codecs.encodeUpload({ kind: 'file', principal: { ...f.principal, readOnly: true }, input, byteLength: bytes.length })
  await expect(f.endpoint.upload(envelope, chunk())).rejects.toMatchObject({ code: 'BROWSER_READ_ONLY' })
  expect(readBytes).not.toHaveBeenCalled()
  const foreign = f.codecs.encodeUpload({ kind: 'file', principal: f.principal,
    input: { ...input, fileId: 'not-an-owned-file' }, byteLength: bytes.length })
  await expect(f.endpoint.upload(foreign, chunk())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect(readBytes).not.toHaveBeenCalled()
  await f.transport.invoke(f.binding, 'perform', f.principal, [{ ...input, bytes }])
  await f.files.finish(file.id, f.session.id)
  const read = { intent: 'file' as const, phase: 'read' as const, sessionId: f.session.id, fileId: file.id, offset: 0, length: 3 }
  expect(await f.transport.invoke(f.binding, 'perform', f.principal, [read])).toEqual(Buffer.from(bytes))
  expect(f.request).not.toHaveBeenCalled()
  const downloads = f.download.mock.calls.length
  await expect(f.transport.invoke(f.binding, 'perform', f.principal, [{ ...read, length: 262_145 }]))
    .rejects.toMatchObject({ code: 'BROWSER_DEVICE_BOUND' })
  expect(f.download).toHaveBeenCalledTimes(downloads)
  f.replace()
  await expect(f.transport.invoke(f.binding, 'perform', f.principal, [read])).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  expect(f.download).toHaveBeenCalledTimes(downloads)
})

it('rejects a binding replaced during a multi-chunk response without returning partial screenshot bytes', async () => {
  const f = await pairedFixture(); f.screenshots.bytes = Buffer.alloc(524_288, 7); f.stream.revokeAfterChunk = true
  await expect(f.transport.invoke(f.binding, 'screenshot', f.principal, [{ sessionId: f.session.id,
    tabId: f.session.selectedTabId!, actor: f.actor }])).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  expect(f.lengths).toEqual([262_144])
  expect(f.request).not.toHaveBeenCalled()
})
