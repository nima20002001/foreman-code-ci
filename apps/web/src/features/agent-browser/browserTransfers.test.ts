import { expect, it, vi } from 'vitest'
import { BrowserUpload, readBrowserDownload } from './transfers'
import { browserRead, deferred } from './testFixtures'
import type { BrowserFileLabel, BrowserFilesPort } from './transferTypes'

function filesFake() {
  const metadata: BrowserFileLabel = { id: 'file', name: 'upload.txt', mimeType: 'text/plain', byteLength: 3, receivedBytes: 0, state: 'uploading', purpose: 'upload' }
  const port: BrowserFilesPort = {
    begin: vi.fn(async () => metadata), write: vi.fn(async () => undefined),
    finish: vi.fn(async () => ({ ...metadata, state: 'ready' as const, receivedBytes: 3 })),
    attach: vi.fn(async () => ({ ...metadata, state: 'attached' as const, receivedBytes: 3 })),
    cancel: vi.fn(async () => ({ ...metadata, state: 'canceled' as const })),
    read: vi.fn(async () => new Uint8Array([1, 2, 3])), remove: vi.fn(async () => undefined),
  }
  return { port, metadata }
}

it('cancels an upload allocated after the user already canceled, without writing or attaching bytes', async () => {
  const { port, metadata } = filesFake(), allocation = deferred<BrowserFileLabel>(), read = browserRead()
  vi.mocked(port.begin).mockReturnValue(allocation.promise)
  const upload = new BrowserUpload(port, read.session, read.tabs[0]!, new File(['abc'], 'upload.txt', { type: 'text/plain' }))
  const sending = upload.send(new AbortController().signal, vi.fn())
  const rejected = expect(sending).rejects.toThrow('canceled')
  await upload.cancel(); allocation.resolve(metadata)
  await rejected
  expect(port.cancel).toHaveBeenCalledWith(read.session, 'file', expect.any(String))
  expect(port.write).not.toHaveBeenCalled(); expect(port.attach).not.toHaveBeenCalled()
})

it('reads exact owned download ranges and rejects bytes beyond the declared length', async () => {
  const { port } = filesFake(), read = browserRead()
  const result = await readBrowserDownload(port, read.session, { id: 'file', byteLength: 3, mimeType: 'text/plain' }, new AbortController().signal)
  expect(result.size).toBe(3)
  expect(port.read).toHaveBeenCalledWith(read.session, 'file', 0, 3, expect.any(AbortSignal))
  await expect(readBrowserDownload(port, read.session, { id: 'file', byteLength: 2, mimeType: 'text/plain' },
    new AbortController().signal)).rejects.toThrow('invalid byte range')
})
