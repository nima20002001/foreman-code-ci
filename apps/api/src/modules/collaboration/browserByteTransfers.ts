import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { BrowserInvocation } from './browserDeviceCodecs.js'
import { DomainError } from '../errors.js'

class UploadChunks implements AsyncIterable<Uint8Array> {
  private waiting: ((value: IteratorResult<Uint8Array>) => void) | undefined
  private consumed: (() => void) | undefined
  private pending: Uint8Array | undefined
  private ended = false
  private failure: unknown
  async push(bytes: Uint8Array) {
    if (this.ended || this.failure) throw this.failure ?? new Error('The browser upload is closed.')
    if (this.pending || this.consumed) throw new DomainError('BROWSER_TRANSFER_BUSY', 'The previous browser chunk is still pending.', 409)
    const consumed = new Promise<void>(resolve => { this.consumed = resolve })
    if (this.waiting) { const next = this.waiting; this.waiting = undefined; next({ done: false, value: bytes }) }
    else this.pending = bytes
    await consumed
  }
  close(error?: unknown) {
    this.ended = true
    this.failure = error
    this.consumed?.(); this.consumed = undefined
    this.waiting?.({ done: true, value: undefined }); this.waiting = undefined
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      this.consumed?.(); this.consumed = undefined
      if (this.failure) throw this.failure
      if (this.ended) return
      let result: IteratorResult<Uint8Array>
      if (this.pending) { result = { done: false, value: this.pending }; this.pending = undefined }
      else result = await new Promise(resolve => { this.waiting = resolve })
      if (result.done) { if (this.failure) throw this.failure; return }
      yield result.value
    }
  }
}
interface TransferEndpoint {
  upload(envelope: BrowserInvocation, chunks: AsyncIterable<Uint8Array>): Promise<unknown>
  download(envelope: BrowserInvocation): Promise<AsyncIterable<Uint8Array>>
}
type Upload = { binding: string; inputHash: string; chunks: UploadChunks; result: Promise<unknown>; offset: number;
  last?: { offset: number; bytes: Uint8Array } }
type Download = { binding: string; inputHash: string; source: Promise<AsyncIterator<Uint8Array>>; offset: number;
  last?: { offset: number; bytes?: Uint8Array; done: boolean } }

/** Application chunks retain their original offsets across transport retries and use one bounded chunk at a time. */
export class BrowserByteTransfers {
  private readonly uploads = new Map<string, Upload>()
  private readonly downloads = new Map<string, Download>()
  constructor(private readonly endpoint: () => TransferEndpoint) {}
  async openUpload(binding: string, id: string, envelope: BrowserInvocation) {
    const inputHash = commandInputHash(envelope), existing = this.uploads.get(id)
    if (existing?.binding === binding && existing.inputHash === inputHash) return { opened: true }
    if (existing || this.downloads.has(id)) throw new DomainError('BROWSER_TRANSFER_CONFLICT', 'The browser transfer identity is already in use.', 409)
    const chunks = new UploadChunks()
    const result = this.endpoint().upload(envelope, chunks)
    void result.catch(error => chunks.close(error))
    this.uploads.set(id, { binding, inputHash, chunks, result, offset: 0 })
    return { opened: true }
  }
  private upload(binding: string, id: string) {
    const upload = this.uploads.get(id)
    if (!upload || upload.binding !== binding) throw new DomainError('BROWSER_TRANSFER_SCOPE', 'The browser upload belongs to another connection.', 403)
    return upload
  }
  async write(binding: string, id: string, offset: number, bytes: Uint8Array | undefined) {
    const upload = this.upload(binding, id)
    if (!bytes?.byteLength || bytes.byteLength > 262_144) throw new DomainError('BROWSER_FILE_CHUNK_INVALID', 'Use browser chunks of at most 256 KiB.', 413)
    if (upload.last?.offset === offset && Buffer.from(upload.last.bytes).equals(bytes)) return { offset: upload.offset }
    if (offset !== upload.offset) throw new DomainError('BROWSER_TRANSFER_OFFSET', 'The browser upload offset changed.', 409)
    await upload.chunks.push(bytes)
    upload.offset += bytes.byteLength
    upload.last = { offset, bytes: bytes.slice() }
    return { offset: upload.offset }
  }
  async finish(binding: string, id: string) {
    const upload = this.upload(binding, id)
    upload.chunks.close()
    return upload.result
  }
  async openDownload(binding: string, id: string, envelope: BrowserInvocation) {
    const inputHash = commandInputHash(envelope), existing = this.downloads.get(id)
    if (existing?.binding === binding && existing.inputHash === inputHash) { await existing.source; return { opened: true } }
    if (existing || this.uploads.has(id)) throw new DomainError('BROWSER_TRANSFER_CONFLICT', 'The browser transfer identity is already in use.', 409)
    const source = this.endpoint().download(envelope).then(value => value[Symbol.asyncIterator]())
    const download = { binding, inputHash, source, offset: 0 }
    this.downloads.set(id, download)
    try { await source }
    catch (error) {
      if (this.downloads.get(id) === download) this.downloads.delete(id)
      throw error
    }
    return { opened: true }
  }
  async read(binding: string, id: string, offset: number) {
    const download = this.downloads.get(id)
    if (!download || download.binding !== binding) throw new DomainError('BROWSER_TRANSFER_SCOPE', 'The browser download belongs to another connection.', 403)
    if (download.last?.offset === offset) return download.last
    if (download.offset !== offset) throw new DomainError('BROWSER_TRANSFER_OFFSET', 'The browser download offset changed.', 409)
    const next = await (await download.source).next()
    if (!next.done && (!next.value.byteLength || next.value.byteLength > 262_144)) throw new DomainError('BROWSER_FILE_CHUNK_INVALID', 'The browser download chunk exceeded its bound.', 413)
    download.last = { offset, done: next.done ?? false, ...(!next.done ? { bytes: next.value } : {}) }
    download.offset += next.done ? 0 : next.value.byteLength
    return download.last
  }
  async close(binding: string, id: string) {
    const upload = this.uploads.get(id), download = this.downloads.get(id)
    if (upload && upload.binding !== binding || download && download.binding !== binding) throw new DomainError('BROWSER_TRANSFER_SCOPE', 'The browser transfer belongs to another connection.', 403)
    if (upload) { upload.chunks.close(new Error('The browser upload connection closed.')); await Promise.allSettled([upload.result]); this.uploads.delete(id) }
    if (download) {
      const [opened] = await Promise.allSettled([download.source])
      // A rejected admission has no iterator to close; its caller already received the error.
      if (opened.status === 'fulfilled') await opened.value.return?.()
      if (this.downloads.get(id) === download) this.downloads.delete(id)
    }
  }
  async closeBinding(binding: string) {
    for (const [id, value] of [...this.uploads, ...this.downloads]) if (value.binding === binding) await this.close(binding, id)
  }
  async closeAll() {
    for (const [id, value] of [...this.uploads, ...this.downloads]) await this.close(value.binding, id)
  }
}
