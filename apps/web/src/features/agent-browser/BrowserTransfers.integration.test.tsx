import { StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserTransfers } from './BrowserTransfers'
import { browserRead, deferred } from './testFixtures'
import type { BrowserFileLabel, BrowserFilesPort } from './transferTypes'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function downloadFixture() {
  const file: BrowserFileLabel = { id: 'file', name: 'result.txt', mimeType: 'text/plain', byteLength: 3, receivedBytes: 3, state: 'ready', purpose: 'download' }
  const unsupported = async (): Promise<never> => { throw new Error('Upload not used by this download fixture.') }
  const port: BrowserFilesPort = { begin: unsupported, write: unsupported, finish: unsupported, attach: unsupported,
    cancel: unsupported, read: vi.fn(async () => new Uint8Array([1, 2, 3])), remove: vi.fn(async () => undefined) }
  const read = browserRead()
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const view = render(<StrictMode><QueryClientProvider client={client}><BrowserTransfers port={port}
    session={read.session} tab={read.tabs[0]!} downloads={[file]} onChanged={vi.fn()} /></QueryClientProvider></StrictMode>)
  return { port, view }
}

it('downloads after StrictMode effect replay and never clicks a save link after the view retires', async () => {
  const create = vi.fn(() => 'blob:download'), click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() }))
  const { port, view } = downloadFixture()
  await userEvent.click(screen.getByRole('button', { name: 'Save file' }))
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1))
  const pending = deferred<Uint8Array>()
  vi.mocked(port.read).mockReturnValue(pending.promise)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save file' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Save file' }))
  view.unmount(); pending.resolve(new Uint8Array([1, 2, 3]))
  await pending.promise
  expect(click).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledTimes(1)
})
