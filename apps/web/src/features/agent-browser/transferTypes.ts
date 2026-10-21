import type { BrowserSession, BrowserTabLease } from './types'

/** In-process byte adapter; C0 owns browser_action/file request wire envelopes. */
export interface BrowserFileLabel {
  id: string; name: string; mimeType: string; byteLength: number; receivedBytes: number
  state: 'uploading' | 'ready' | 'attached' | 'canceled' | 'failed'
  purpose: 'upload' | 'download'
}

export interface BrowserFilesPort {
  begin(session: BrowserSession, tab: BrowserTabLease, file: File, commandId: string): Promise<BrowserFileLabel>
  write(session: BrowserSession, fileId: string, offset: number, bytes: Uint8Array, signal: AbortSignal): Promise<void>
  finish(session: BrowserSession, fileId: string, commandId: string): Promise<BrowserFileLabel>
  attach(session: BrowserSession, tab: BrowserTabLease, fileId: string, selector: string, commandId: string,
    control: { viewerId: string; epoch: number }): Promise<BrowserFileLabel>
  cancel(session: BrowserSession, fileId: string, commandId: string): Promise<BrowserFileLabel>
  read(session: BrowserSession, fileId: string, offset: number, length: number, signal: AbortSignal): Promise<Uint8Array>
  remove(session: BrowserSession, fileId: string, commandId: string): Promise<void>
}
