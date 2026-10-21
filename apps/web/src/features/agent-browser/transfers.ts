import { ownsTab } from './identity'
import type { BrowserFilesPort } from './transferTypes'
import type { BrowserSession, BrowserTabLease } from './types'

const chunkBytes = 262144

/** Retained command/offset identity permits a deliberate retry without another upload. */
export class BrowserUpload {
  private readonly commandId = crypto.randomUUID()
  private fileId: string | undefined
  private offset = 0
  private canceled = false
  constructor(private readonly port: BrowserFilesPort, private readonly session: BrowserSession,
    private readonly tab: BrowserTabLease, private readonly file: File) {
    if (!ownsTab(session, tab)) throw new Error('The upload tab belongs to a different browser session.')
  }

  private async assertActive(signal: AbortSignal): Promise<void> {
    if (!this.canceled && !signal.aborted) return
    this.canceled = true
    if (this.fileId) await this.port.cancel(this.session, this.fileId, `${this.commandId}:cancel`)
    throw new Error('This upload was canceled.')
  }

  async send(signal: AbortSignal, onProgress: (received: number) => void) {
    if (this.canceled) throw new Error('This upload was canceled.')
    signal.throwIfAborted()
    if (!this.fileId) {
      const upload = await this.port.begin(this.session, this.tab, this.file, this.commandId)
      this.fileId = upload.id
      await this.assertActive(signal)
      if (upload.name !== this.file.name || upload.byteLength !== this.file.size
        || !Number.isSafeInteger(upload.receivedBytes) || upload.receivedBytes < 0 || upload.receivedBytes > this.file.size) {
        throw new Error('The upload receipt does not match this file.')
      }
      this.offset = upload.receivedBytes
    }
    while (this.offset < this.file.size) {
      signal.throwIfAborted()
      const bytes = new Uint8Array(await this.file.slice(this.offset, this.offset + chunkBytes).arrayBuffer())
      await this.assertActive(signal)
      await this.port.write(this.session, this.fileId, this.offset, bytes, signal)
      await this.assertActive(signal)
      this.offset += bytes.byteLength
      onProgress(this.offset)
    }
    signal.throwIfAborted()
    const ready = await this.port.finish(this.session, this.fileId, `${this.commandId}:finish`)
    await this.assertActive(signal)
    if (ready.id !== this.fileId || ready.byteLength !== this.file.size || !['ready', 'attached'].includes(ready.state)) {
      throw new Error('The computer has not confirmed a complete upload.')
    }
    return ready
  }

  async attach(selector: string, control: { viewerId: string; epoch: number }) {
    if (!this.fileId || this.canceled) throw new Error('Upload the file before attaching it to the page.')
    return this.port.attach(this.session, this.tab, this.fileId, selector, `${this.commandId}:attach`, control)
  }

  async cancel() {
    this.canceled = true
    if (this.fileId) return this.port.cancel(this.session, this.fileId, `${this.commandId}:cancel`)
  }
}

export async function readBrowserDownload(port: BrowserFilesPort, session: BrowserSession,
  file: { id: string; byteLength: number; mimeType: string }, signal: AbortSignal): Promise<Blob> {
  if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0) throw new Error('The download size is invalid.')
  const chunks: ArrayBuffer[] = []
  let offset = 0
  while (offset < file.byteLength) {
    signal.throwIfAborted()
    const bytes = await port.read(session, file.id, offset, Math.min(chunkBytes, file.byteLength - offset), signal)
    if (!bytes.byteLength || bytes.byteLength > chunkBytes || offset + bytes.byteLength > file.byteLength) {
      throw new Error('The browser download returned an invalid byte range.')
    }
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes); chunks.push(copy.buffer)
    offset += bytes.byteLength
  }
  return new Blob(chunks, { type: file.mimeType || 'application/octet-stream' })
}
