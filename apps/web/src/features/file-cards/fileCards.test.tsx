import { webcrypto } from 'node:crypto'
import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fileStateAt, FileRevisionSchema, type FileWithRevision } from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { FileCard } from './FileCard'
import { MessageFileCards } from './MessageFileCards'
import { createFileCardHttpClient } from './fileCardClient'
import { saveBlob } from './fileCardResources'
import { fixture, fixtureBytes, MIME_CASES, PERMANENT_SCOPES, TEST_DOWNLOAD_PATH, TEST_HANDLER_PATH } from './testFixtures'

const client = createFileCardHttpClient({ download: TEST_DOWNLOAD_PATH })
const clients: QueryClient[] = []
const createUrl = vi.fn<(_: Blob) => string>()
const revokeUrl = vi.fn<(_: string) => void>()
let clicked: Array<{ href: string; filename: string }> = []

function mount(node: ReactNode, strict = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(queryClient)
  function Wrapper({ children }: { children: ReactNode }) {
    const content = <QueryClientProvider client={queryClient}><div style={{ width: 320 }}>{children}</div></QueryClientProvider>
    return strict ? <StrictMode>{content}</StrictMode> : content
  }
  return { ...render(node, { wrapper: Wrapper }), queryClient }
}

function serve(file: FileWithRevision, onRequest?: (revisionId: string) => void) {
  server.use(http.get('*/api/operator/conversations/conversation-a/files', () => HttpResponse.json({
    items: [{ file: { ...file.file, state: fileStateAt(file.file, new Date().toISOString()) },
      revision: { ...file.revision, revisionId: file.file.currentRevisionId } }],
    pageInfo: { nextCursor: null },
  })))
  server.use(http.get(TEST_HANDLER_PATH, ({ params }) => {
    onRequest?.(String(params.revisionId))
    return new HttpResponse(fixtureBytes(FileRevisionSchema.parse(file.revision).mediaType).buffer, { headers: { 'Content-Type': file.revision.mediaType } })
  }))
}

beforeEach(() => {
  clicked = []
  createUrl.mockReset().mockImplementation(() => `blob:fil12-${createUrl.mock.calls.length}`)
  revokeUrl.mockReset()
  const OriginalURL = globalThis.URL
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = createUrl
    static revokeObjectURL = revokeUrl
  })
  vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, filename: this.download })
  })
})
afterEach(async () => {
  cleanup()
  for (const queryClient of clients.splice(0)) queryClient.clear()
  await act(async () => { await Promise.resolve() })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  finishSessionChange()
})

describe('message file cards', () => {
  it.each(MIME_CASES)('renders a compact ready %s card (%s)', async (mediaType, filename) => {
    const file = fixture({ mediaType, filename })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />)
    expect(screen.getByRole('group', { name: filename })).toBeVisible()
    expect(screen.getByRole('button', { name: `Download ${filename}` })).toBeEnabled()
    expect(screen.getByText(filename)).toHaveAttribute('title', filename)
    expect(view.container.querySelector('.file-card__meta')).toHaveTextContent(/B|KB|MB/)
    if (mediaType.startsWith('image/')) {
      await waitFor(() => expect(view.container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('blob:')))
      expect(view.container.querySelector('img')).toHaveAttribute('alt', '')
    } else {
      expect(view.container.querySelector('img')).toBeNull()
      expect(createUrl).not.toHaveBeenCalled()
    }
  })

  it.each(MIME_CASES.flatMap(([mediaType, filename]) => (['pending', 'expired', 'removed'] as const).map((state) => ({ mediaType, filename, state }))))(
    'shows $state for $filename with no download or preview request', async ({ mediaType, filename, state }) => {
      let requests = 0
      const file = fixture({ mediaType, filename, state })
      serve(file, () => { requests++ })
      const view = mount(<FileCard file={file} client={client} />)
      expect(screen.getByText(state[0].toUpperCase() + state.slice(1))).toBeVisible()
      expect(screen.queryByRole('button', { name: /Download/ })).not.toBeInTheDocument()
      await act(async () => { await Promise.resolve() })
      expect(requests).toBe(0)
      expect(view.container.querySelector('img')).toBeNull()
      expect(createUrl).not.toHaveBeenCalled()
    },
  )

  it('uses the actual expiry DTO, with full timestamp details, not a fixed retention label', () => {
    const file = fixture({ retentionDurationSeconds: 91 * 3600 })
    const view = mount(<FileCard file={file} client={client} />)
    const expiresAt = 'expiresAt' in file.file ? file.file.expiresAt : ''
    expect(view.container.querySelector('time')).toHaveAttribute('dateTime', expiresAt)
    expect(view.container.querySelector('time')).toHaveAttribute('title', `Expiry: ${new Intl.DateTimeFormat(undefined, {
      dateStyle: 'full', timeStyle: 'long',
    }).format(new Date(expiresAt))}`)
    expect(view.container.querySelector('time')).toHaveAccessibleName(/^Expires /)
    expect(view.container).not.toHaveTextContent(/7 days|seven days/i)
  })

  it.each(PERMANENT_SCOPES)('shows no expiry for $kind', (scope) => {
    const view = mount(<FileCard file={fixture({ scope })} client={client} />)
    expect(view.container.querySelector('time')).toBeNull()
    expect(view.container).not.toHaveTextContent(/Expires|Expired/)
    expect(screen.getByRole('button', { name: /Download/ })).toBeEnabled()
  })

  it('does not show Download until the authoritative DTO becomes ready', () => {
    const file = fixture({ state: 'pending' })
    const view = mount(<FileCard file={file} client={client} />)
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
    view.rerender(<FileCard file={{ ...file, file: { ...file.file, state: 'ready' } }} client={client} />)
    expect(screen.getByRole('button', { name: /Download/ })).toBeEnabled()
  })

  it('expires a mounted ready card at its real deadline without a history refetch', async () => {
    vi.useFakeTimers()
    const file = fixture({ createdAt: new Date(Date.now() - 3_599_000).toISOString(), retentionDurationSeconds: 3600 })
    serve(file)
    mount(<FileCard file={file} client={client} />)
    expect(screen.getByRole('button', { name: /Download/ })).toBeEnabled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1001) })
    expect(screen.getByText('Expired')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })

  it('rechecks overdue files after a background tab resumes', () => {
    vi.useFakeTimers()
    const file = fixture({ createdAt: new Date(Date.now() - 3_599_000).toISOString(), retentionDurationSeconds: 3600 })
    serve(file)
    mount(<FileCard file={file} client={client} />)
    vi.setSystemTime(Date.now() + 2000)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(screen.getByText('Expired')).toBeVisible()
  })

  it('keeps a removed tombstone Removed even after the expiry deadline', () => {
    const file = fixture({ state: 'removed', createdAt: new Date(Date.now() - 7_200_000).toISOString(), retentionDurationSeconds: 3600 })
    mount(<FileCard file={file} client={client} />)
    expect(screen.getByText('Removed')).toBeVisible()
    expect(screen.queryByText('Expired')).toBeNull()
  })

  it('requests the pinned revision and saves the DTO filename using a temporary object URL', async () => {
    const file = fixture({ revisionId: 'old-revision', currentRevisionId: 'new-revision' })
    const requested: string[] = []
    serve(file, (revisionId) => requested.push(revisionId))
    const view = mount(<FileCard file={file} client={client} />)
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(requested).toEqual(['old-revision'])
    expect(clicked[0]).toEqual({ href: expect.stringContaining('blob:'), filename: 'notes.md' })
    expect(document.querySelector('a[download]')).toBeNull()
    view.unmount()
    expect(revokeUrl).toHaveBeenCalledWith(clicked[0].href)
    expect(revokeUrl.mock.calls.filter(([url]) => url === clicked[0].href)).toHaveLength(1)
  })

  it('does not render downloaded Markdown, HTML, SVG, or server Content-Disposition as content', async () => {
    const file = fixture({ filename: '<img onerror=alert(1)>.md' })
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(fixtureBytes('text/markdown').buffer, {
      headers: { 'Content-Type': 'text/markdown', 'Content-Disposition': 'inline; filename="unsafe.html"' },
    })))
    const view = mount(<FileCard file={file} client={client} />)
    expect(view.container.querySelector('iframe, object, embed, img, script')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(clicked[0].filename).toBe(file.revision.filename)
    expect(view.container.querySelector('iframe, object, embed, img, script')).toBeNull()
    expect(view.container).not.toHaveTextContent('# Notes')
  })

  it.each(['FILE_EXPIRED', 'FILE_REMOVED', 'FILE_NOT_READY'] as const)('honors %s server readback and hides Download', async (code) => {
    server.use(http.get(TEST_HANDLER_PATH, () => HttpResponse.json({ error: { code, message: 'Not available' } }, { status: 409 })))
    mount(<FileCard file={fixture()} client={client} />)
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await screen.findByText(code === 'FILE_EXPIRED' ? 'Expired' : code === 'FILE_REMOVED' ? 'Removed' : 'Pending')
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('offers a manual retry after a transient download error', async () => {
    const file = fixture()
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse(null, { status: 503 })))
    mount(<FileCard file={file} client={client} />)
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await screen.findByText('Download failed')
    serve(file)
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(clicked).toHaveLength(1))
  })

  it('never substitutes a current-head DTO for an unresolved message pin', () => {
    const current = fixture({ revisionId: 'new' })
    mount(<MessageFileCards attachments={[{ fileId: 'file-a', revisionId: 'old' }]} files={[current]} client={client} />)
    expect(screen.getByRole('list', { name: 'Message files' })).toBeVisible()
    expect(screen.getByText('Unavailable')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })

  it('rejects an explicitly mismatched card pin and unsupported metadata', () => {
    const file = fixture()
    const view = mount(<FileCard file={file} attachment={{ fileId: 'other', revisionId: 'revision-a' }} client={client} />)
    expect(screen.getByText('Unavailable')).toBeVisible()
    const invalid = { ...file, revision: { ...file.revision, mediaType: 'image/svg+xml' } } as unknown as FileWithRevision
    view.rerender(<FileCard file={invalid} client={client} />)
    expect(screen.getByText('Unavailable')).toBeVisible()
    expect(createUrl).not.toHaveBeenCalled()
  })
})

describe('browser resource ownership', () => {
  it('releases a saved object URL after the click task, and disposal is idempotent', () => {
    vi.useFakeTimers()
    const dispose = saveBlob(new Blob(['notes'], { type: 'text/markdown' }), 'notes.md')
    expect(clicked).toHaveLength(1)
    expect(revokeUrl).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(1000))
    expect(revokeUrl).toHaveBeenCalledExactlyOnceWith(clicked[0].href)
    dispose()
    dispose()
    expect(revokeUrl).toHaveBeenCalledTimes(1)
  })

  it('does not replace a historical preview when only the current head advances', async () => {
    const file = fixture({ mediaType: 'image/png' })
    const requests: string[] = []
    serve(file, (revisionId) => requests.push(revisionId))
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    const url = view.container.querySelector('img')!.getAttribute('src')!
    view.rerender(<FileCard file={{ ...file, file: { ...file.file, currentRevisionId: 'revision-new' } }} client={client} />)
    expect(view.container.querySelector('img')).toHaveAttribute('src', url)
    expect(revokeUrl).not.toHaveBeenCalledWith(url)
    expect(requests).toEqual(['revision-a'])
  })

  it('removes the existing thumbnail immediately on a different revision pin', async () => {
    const file = fixture({ mediaType: 'image/png' })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    const url = view.container.querySelector('img')!.getAttribute('src')!
    view.rerender(<FileCard file={fixture({ mediaType: 'image/png', revisionId: 'revision-b', state: 'pending' })} client={client} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(revokeUrl).toHaveBeenCalledWith(url)
  })

  it('revokes the thumbnail when a still-ready DTO passes its actual expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const file = fixture({ mediaType: 'image/png', createdAt: new Date(Date.now() - 3_590_000).toISOString(), retentionDurationSeconds: 3600 })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    const url = view.container.querySelector('img')!.getAttribute('src')!
    vi.setSystemTime(Date.now() + 20_000)
    act(() => window.dispatchEvent(new Event('focus')))
    expect(screen.getByText('Expired')).toBeVisible()
    expect(view.container.querySelector('img')).toBeNull()
    expect(revokeUrl).toHaveBeenCalledWith(url)
  })

  it('revokes thumbnail URLs exactly once on unmount, including StrictMode setup replay', async () => {
    const file = fixture({ mediaType: 'image/png' })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />, true)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    view.unmount()
    const urls = createUrl.mock.results.map((result) => result.value)
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) expect(revokeUrl.mock.calls.filter(([value]) => value === url)).toHaveLength(1)
    await waitFor(() => expect(view.queryClient.getQueryCache().getAll()).toHaveLength(0))
  })

  it('revokes a thumbnail when the file expires or is removed', async () => {
    const file = fixture({ mediaType: 'image/png' })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    const url = view.container.querySelector('img')!.getAttribute('src')!
    view.rerender(<FileCard file={{ ...file, file: { ...file.file, state: 'removed' } }} client={client} />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(revokeUrl).toHaveBeenCalledWith(url)
  })

  it('revokes an image URL after decode failure and falls back to an icon', async () => {
    const file = fixture({ mediaType: 'image/png' })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    const image = view.container.querySelector('img')!
    const url = image.getAttribute('src')!
    fireEvent.error(image)
    expect(view.container.querySelector('img')).toBeNull()
    expect(revokeUrl).toHaveBeenCalledWith(url)
    expect(screen.getByRole('button', { name: /Download/ })).toBeEnabled()
  })

  it('never allocates an object URL for a disallowed preview response', async () => {
    server.use(http.get(TEST_HANDLER_PATH, () => new HttpResponse('<svg onload="alert(1)"/>', { headers: { 'Content-Type': 'image/svg+xml' } })))
    const view = mount(<FileCard file={fixture({ mediaType: 'image/png' })} client={client} />)
    await waitFor(() => expect(view.queryClient.getQueryCache().find({ queryKey: ['message-file-preview'], exact: false })?.state.status).toBe('error'))
    expect(view.container.querySelector('img')).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('cleans private previews when the active session changes', async () => {
    const file = fixture({ mediaType: 'image/png' })
    serve(file)
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull())
    const url = view.container.querySelector('img')!.getAttribute('src')!
    act(() => { beginSessionChange(); finishSessionChange() })
    expect(view.container.querySelector('img')).toBeNull()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
    expect(revokeUrl).toHaveBeenCalledWith(url)
  })

  it.each(['unmount', 'new pin', 'removed', 'session'] as const)('ignores a late download after %s', async (change) => {
    const file = fixture()
    let release!: () => void
    let started = false
    let returned = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    server.use(http.get(TEST_HANDLER_PATH, async () => {
      started = true
      await gate
      returned = true
      return new HttpResponse(fixtureBytes('text/markdown').buffer, { headers: { 'Content-Type': 'text/markdown' } })
    }))
    const view = mount(<FileCard file={file} client={client} />)
    await userEvent.click(screen.getByRole('button', { name: /Download/ }))
    await waitFor(() => expect(started).toBe(true))
    if (change === 'unmount') view.unmount()
    else if (change === 'new pin') view.rerender(<FileCard file={fixture({ revisionId: 'revision-b' })} client={client} />)
    else if (change === 'removed') view.rerender(<FileCard file={{ ...file, file: { ...file.file, state: 'removed' } }} client={client} />)
    else act(() => { beginSessionChange(); finishSessionChange() })
    release()
    await waitFor(() => expect(returned).toBe(true))
    await act(async () => { await Promise.resolve() })
    expect(clicked).toHaveLength(0)
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('does not display a late preview from revision A under revision B', async () => {
    const file = fixture({ mediaType: 'image/png' })
    let release!: () => void
    let started = false
    let returned = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    server.use(http.get(TEST_HANDLER_PATH, async () => {
      started = true
      await gate
      returned = true
      return new HttpResponse(fixtureBytes('image/png').buffer, { headers: { 'Content-Type': 'image/png' } })
    }))
    const view = mount(<FileCard file={file} client={client} />)
    await waitFor(() => expect(started).toBe(true))
    view.rerender(<FileCard file={fixture({ mediaType: 'image/png', revisionId: 'revision-b', state: 'pending' })} client={client} />)
    release()
    await waitFor(() => expect(returned).toBe(true))
    expect(view.container.querySelector('img')).toBeNull()
    expect(createUrl).not.toHaveBeenCalled()
  })
})
