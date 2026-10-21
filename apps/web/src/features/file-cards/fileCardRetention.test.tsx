import { webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OperatorConversationHistoryPage } from '@foreman-code/contracts/operator-chat'
import { applyFileRetention, fileStateAt, type File as FileMetadata, type FileWithRevision } from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { attachmentLifecycleQueryKey } from '../attachments/attachmentLifecycle'
import { OperatorTranscript } from '../operator-chat/OperatorTranscript'
import { FileCard } from './FileCard'
import { createFileCardHttpClient } from './fileCardClient'
import { fixture, fixtureBytes, TEST_DOWNLOAD_PATH, TEST_HANDLER_PATH } from './testFixtures'

const listPath = '*/api/operator/conversations/conversation-a/files'
const client = createFileCardHttpClient({ download: TEST_DOWNLOAD_PATH })
const clients: QueryClient[] = []
const createUrl = vi.fn<(_: Blob) => string>()
let clicked: string[] = []

function mount(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(queryClient)
  return { ...render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>), queryClient }
}

function soonExpiring() {
  return fixture({ createdAt: new Date(Date.now() - 3_590_000).toISOString(), retentionDurationSeconds: 3600,
    filename: 'earlier.md', revisionId: 'pinned-v1' })
}

function expiry(file: FileMetadata): string {
  if (!('expiresAt' in file)) throw new Error('Expected a temporary file.')
  return file.expiresAt
}

function metadata(queryClient: QueryClient): FileMetadata | undefined {
  return queryClient.getQueriesData<FileMetadata>({ queryKey: attachmentLifecycleQueryKey })[0]?.[1]
}

async function passDeadline(file: FileMetadata) {
  await act(async () => { await vi.advanceTimersByTimeAsync(Date.parse(expiry(file)) - Date.now() + 1) })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
  clicked = []
  createUrl.mockReset().mockReturnValue('blob:retention-download')
  const OriginalURL = globalThis.URL
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = createUrl
    static revokeObjectURL = vi.fn()
  })
  vi.stubGlobal('crypto', webcrypto)
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.download)
  })
})

afterEach(async () => {
  cleanup()
  for (const queryClient of clients.splice(0)) queryClient.clear()
  await act(async () => { await Promise.resolve() })
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  finishSessionChange()
})

describe('R2-7: transcript retention lifecycle', () => {
  it.each(['external change', 'retention-save invalidation'] as const)(
    'refreshes an earlier-history card after %s without refetching history or changing its pin', async (change) => {
      const original = soonExpiring()
      const history: OperatorConversationHistoryPage = {
        conversationId: 'conversation-a', revision: 1, activeRequestId: null, nextCursor: null,
        entries: [{ sequence: '1', receipt: null, message: { id: 'earlier-message', conversationId: 'conversation-a',
          role: 'user', content: 'Earlier attachment', attachments: [original] } }],
      }
      // Discovery returns a different head with different bytes/name; none may replace the message pin.
      let head: FileWithRevision = fixture({ createdAt: original.file.createdAt, retentionDurationSeconds: 3600,
        revisionId: 'head-v2', filename: 'latest.md', bytes: new Uint8Array([1, 2, 3]) })
      let historyRequests = 0
      const listCursors: Array<string | null> = []
      const downloaded: string[] = []
      server.use(
        http.get('*/api/operator/conversations/conversation-a/history', () => {
          historyRequests++
          return HttpResponse.json(history)
        }),
        http.get(listPath, ({ request }) => {
          const cursor = new URL(request.url).searchParams.get('cursor')
          listCursors.push(cursor)
          return HttpResponse.json(cursor === null ? {
            items: [fixture({ fileId: 'other-file' })], pageInfo: { nextCursor: 'older-files' },
          } : {
            items: [{ ...head, file: { ...head.file, state: fileStateAt(head.file, new Date().toISOString()) } }],
            pageInfo: { nextCursor: null },
          })
        }),
        http.get(TEST_HANDLER_PATH, ({ params }) => {
          downloaded.push(String(params.revisionId))
          return new HttpResponse(fixtureBytes(original.revision.mediaType).buffer,
            { headers: { 'Content-Type': original.revision.mediaType } })
        }),
      )
      const view = mount(<OperatorTranscript messages={[]} partialText="" hasEarlierMessages conversationId="conversation-a" />)
      const historyKey = ['operator-chat', 'history', identityEpoch(), 'conversation-a']
      fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
      await act(async () => {
        await vi.waitFor(() => expect(view.queryClient.getQueryState(historyKey)?.status).toBe('success'))
      })
      expect(screen.getByRole('button', { name: 'Download earlier.md' })).toBeEnabled()
      expect(view.container.querySelector('time')).toHaveAttribute('dateTime', expiry(original.file))
      const cachedHistory = view.queryClient.getQueryData(historyKey)
      expect(historyRequests).toBe(1)
      expect(listCursors).toEqual([])

      // The extension happens while still live. The earlier history response remains unchanged.
      head = { ...head, file: applyFileRetention(head.file, 7200, new Date().toISOString()) }
      if (change === 'retention-save invalidation') {
        await act(async () => { await view.queryClient.invalidateQueries({ queryKey: attachmentLifecycleQueryKey }) })
      }
      // No navigation, focus/visibility event, prop replacement or transcript query invalidation.
      await passDeadline(original.file)
      await act(async () => { await vi.waitFor(() => expect(metadata(view.queryClient)).toEqual(head.file)) })
      expect(screen.getByRole('group', { name: 'earlier.md' })).toHaveAttribute('data-state', 'ready')
      expect(screen.queryByText('Expired')).toBeNull()
      const extendedExpiry = expiry(head.file)
      expect(view.container.querySelector('time')).toHaveAttribute('dateTime', extendedExpiry)
      expect(view.container.querySelector('time')).toHaveAttribute('title', `Expiry: ${new Intl.DateTimeFormat(undefined, {
        dateStyle: 'full', timeStyle: 'long',
      }).format(new Date(extendedExpiry))}`)
      expect(listCursors).toEqual([null, 'older-files'])
      expect(view.queryClient.getQueryData(historyKey)).toBe(cachedHistory)
      expect(historyRequests).toBe(1)

      fireEvent.click(screen.getByRole('button', { name: 'Download earlier.md' }))
      await act(async () => { await vi.waitFor(() => expect(clicked).toEqual(['earlier.md'])) })
      expect(downloaded).toEqual(['pinned-v1'])
      expect(createUrl).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('button', { name: 'Download earlier.md' })).toBeEnabled()
      expect(screen.queryByText('Download failed')).toBeNull()
      expect(screen.queryByText('latest.md')).toBeNull()

      // The refreshed deadline is armed too; a confirmed expiry must not trigger a refetch loop.
      await passDeadline(head.file)
      await act(async () => { await vi.waitFor(() => expect(metadata(view.queryClient)?.state).toBe('expired')) })
      expect(screen.getByText('Expired')).toBeVisible()
      expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      expect(listCursors).toEqual([null, 'older-files', null, 'older-files'])
      expect(historyRequests).toBe(1)
    },
  )

  it('keeps a server-confirmed removal terminal after retention invalidation', async () => {
    const original = soonExpiring()
    let requests = 0
    server.use(http.get(listPath, () => {
      requests++
      return HttpResponse.json({ items: [{ ...original, file: { ...original.file, state: 'removed' } }],
        pageInfo: { nextCursor: null } })
    }))
    const view = mount(<FileCard file={original} client={client} />)
    await passDeadline(original.file)
    await act(async () => { await vi.waitFor(() => expect(metadata(view.queryClient)?.state).toBe('removed')) })
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: attachmentLifecycleQueryKey })
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(screen.getByText('Removed')).toBeVisible()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
    expect(requests).toBe(1)
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('rechecks the deadline even if an earlier retention-save refresh failed transiently', async () => {
    const original = soonExpiring()
    const extended = { ...original, file: applyFileRetention(original.file, 7200, new Date().toISOString()) }
    let requests = 0
    server.use(http.get(listPath, () => {
      requests++
      return requests === 1 ? new HttpResponse(null, { status: 503 })
        : HttpResponse.json({ items: [extended], pageInfo: { nextCursor: null } })
    }))
    const view = mount(<FileCard file={original} client={client} />)
    await act(async () => { await view.queryClient.invalidateQueries({ queryKey: attachmentLifecycleQueryKey }) })
    await passDeadline(original.file)
    await act(async () => { await vi.waitFor(() => expect(metadata(view.queryClient)).toEqual(extended.file)) })
    expect(screen.getByRole('button', { name: 'Download earlier.md' })).toBeEnabled()
    expect(view.container.querySelector('time')).toHaveAttribute('dateTime', expiry(extended.file))
    expect(requests).toBe(2)
  })

  it('ignores a late lifecycle extension after the mounted session changes', async () => {
    const original = soonExpiring()
    const extended = { ...original, file: applyFileRetention(original.file, 7200, new Date().toISOString()) }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let requestSignal: AbortSignal | undefined
    let returned = false
    server.use(http.get(listPath, async ({ request }) => {
      requestSignal = request.signal
      await gate
      returned = true
      return HttpResponse.json({ items: [extended], pageInfo: { nextCursor: null } })
    }))
    const view = mount(<FileCard file={original} client={client} />)
    try {
      await passDeadline(original.file)
      await act(async () => { await vi.waitFor(() => expect(requestSignal).toBeDefined()) })
      act(() => { beginSessionChange(); finishSessionChange() })
      expect(requestSignal?.aborted).toBe(true)
      release()
      await act(async () => { await vi.waitFor(() => expect(returned).toBe(true)) })
      expect(screen.getByText('Unavailable')).toBeVisible()
      expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
      expect(metadata(view.queryClient)).toEqual(original.file)
      expect(createUrl).not.toHaveBeenCalled()
    } finally { release() }
  })
})
