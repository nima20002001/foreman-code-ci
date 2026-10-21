import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FilePageSchema, FileRetentionSaveInputSchema, FileWithRevisionSchema, applyFileRetention, fileStateAt,
  type FileWithRevision, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { sendOperatorMessage } from '../../shared/api/client'
import { useRetentionSaveMutation } from '../retention-settings/retentionQueries'
import { clearRetentionCommandMemory } from '../retention-settings/retentionCommand'
import { AttachmentDraftProvider } from './AttachmentDraftProvider'
import { attachmentLifecycleQueryKey } from './attachmentLifecycle'
import type { AttachmentClient } from './attachmentClient'
import { useConversationAttachments, type ConversationAttachments } from './useConversationAttachments'

const start = Date.parse('2026-09-28T08:00:00.000Z')
const scope: TemporaryFileScope = { kind: 'temporary', chat: {
  kind: 'operator', ownerPrincipalId: 'owner-a', operatorId: 'operator-a', conversationId: 'chat-a',
} }
let client: QueryClient
let upload: ReturnType<typeof vi.fn<AttachmentClient['upload']>>
let cancel: ReturnType<typeof vi.fn<AttachmentClient['cancel']>>
let row: FileWithRevision
let draft: ConversationAttachments
let save: ReturnType<typeof useRetentionSaveMutation>
let revision: number
let duration: number
let metadataReads: number
let metadataFails: boolean
function Probe() {
  const attachments = useConversationAttachments(scope)
  const mutation = useRetentionSaveMutation()
  useEffect(() => { draft = attachments; save = mutation }, [attachments, mutation])
  return <span>{attachments.items[0]?.statusLabel}</span>
}
function mount() {
  const transport = { upload, cancel }
  const tree = () => <QueryClientProvider client={client}><AttachmentDraftProvider client={transport}>
    <Probe />
  </AttachmentDraftProvider></QueryClientProvider>
  const view = render(tree())
  return { ...view, tick(milliseconds: number) {
    act(() => { vi.setSystemTime(start + milliseconds); view.rerender(tree()) })
  } }
}
async function select() {
  act(() => draft.addFiles([new File(['original bytes'], 'notes.md', { type: 'text/markdown' })]))
  await waitFor(() => expect(draft.items[0]?.statusLabel).toBe('Ready'))
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start)
  window.sessionStorage.clear(); clearRetentionCommandMemory()
  revision = 0; duration = 3600; metadataReads = 0; metadataFails = false
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  upload = vi.fn<AttachmentClient['upload']>(async (input) => {
    const createdAt = new Date().toISOString()
    row = FileWithRevisionSchema.parse({
      file: { fileId: `file-${input.requestId}`, currentRevisionId: `revision-${input.requestId}`,
        scope: input.scope, createdAt, state: 'ready', retentionDurationSeconds: duration,
        expiresAt: new Date(Date.parse(createdAt) + duration * 1000).toISOString() },
      revision: { fileId: `file-${input.requestId}`, revisionId: `revision-${input.requestId}`,
        filename: input.filename, mediaType: input.mediaType, byteSize: input.file.size,
        sha256: 'a'.repeat(64), origin: 'upload', createdAt },
    })
    return row
  })
  cancel = vi.fn<AttachmentClient['cancel']>().mockResolvedValue(undefined)
  server.use(
    http.get('/api/management/file-retention', () => HttpResponse.json({ preference: {
      ownerPrincipalId: 'owner-a', durationSeconds: duration, revision,
    } })),
    http.post('/api/management/file-retention', async ({ request }) => {
      const input = FileRetentionSaveInputSchema.parse(await request.json())
      expect(input.expectedRevision).toBe(revision)
      expect(input.applyToExisting).toBe(true)
      row = { ...row, file: applyFileRetention(row.file, input.durationSeconds, new Date().toISOString()) }
      duration = input.durationSeconds; revision++
      return HttpResponse.json({ value: { preference: { ownerPrincipalId: 'owner-a', durationSeconds: duration, revision },
        updatedFileCount: 1, expiredNowCount: 0 }, replayed: false })
    }),
    http.get('/api/operator/conversations/chat-a/files', ({ request }) => {
      metadataReads++
      if (metadataFails) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Retry' } }, { status: 503 })
      // The selected file need not be on the first page. Discovery may also have
      // advanced its head; neither condition may change the draft's original pin.
      if (!new URL(request.url).searchParams.has('cursor')) return HttpResponse.json({ items: [], pageInfo: { nextCursor: 'next' } })
      const file = { ...row.file, state: fileStateAt(row.file, new Date().toISOString()), currentRevisionId: 'new-head' }
      return HttpResponse.json(FilePageSchema.parse({ items: [{ file, revision: { ...row.revision, revisionId: 'new-head' } }],
        pageInfo: { nextCursor: null } }))
    }),
  )
})
afterEach(async () => {
  cleanup()
  await act(async () => { await Promise.resolve() })
  client.clear(); window.sessionStorage.clear(); clearRetentionCommandMemory(); vi.useRealTimers()
})

describe('ATT-03: live retention readback for selected attachments', () => {
  it('extends an open draft through the original deadline and sends its original revision without uploading again', async () => {
    const view = mount()
    await select()
    const selected = draft.items[0]
    const pin = draft.readyRefs[0]
    view.tick(30 * 60_000)
    await act(async () => {
      await save.mutateAsync({ ownerPrincipalId: 'owner-a',
        input: { commandId: 'extend-retention', expectedRevision: 0, durationSeconds: 7200, applyToExisting: true },
        draft: { amount: '2', unit: 'hours', applyToExisting: true } })
    })
    await waitFor(() => expect(client.getQueryCache().find({ queryKey: attachmentLifecycleQueryKey, exact: false })?.state.data)
      .toMatchObject({ expiresAt: new Date(start + 7_200_000).toISOString() }))
    view.tick(3_600_001)
    expect(draft.items[0].statusLabel).toBe('Ready')
    expect(draft.hasBlockingAttachments).toBe(false)
    expect(draft.items[0].id).toBe(selected.id)
    expect(draft.items[0].requestId).toBe(selected.requestId)
    expect(draft.prepareSend()?.attachments).toEqual([pin])
    const sent = vi.fn()
    server.use(http.post('/api/operator/conversations/chat-a/messages', async ({ request }) => {
      const command = SendOperatorMessageRequestSchema.parse(await request.json())
      sent(command)
      return HttpResponse.json(SendOperatorMessageResponseSchema.parse({ replayed: false, state: {
        conversation: { id: 'chat-a', scope: 'application', agentId: 'operator-a', operatorConfigurationVersionId: 'configuration-a' },
        messages: [{ id: 'accepted-message', conversationId: 'chat-a', requestId: command.requestId,
          role: 'user', content: command.content, attachments: [row] }], turnState: 'idle', revision: 1,
      } }))
    }))
    await sendOperatorMessage('chat-a', { requestId: 'attachment-send', content: '', attachments: [...draft.prepareSend()!.attachments] })
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ attachments: [pin] }))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
    // The immutable upload response is not rewritten to mirror mutable server state.
    await expect(upload.mock.results[0].value).resolves.toMatchObject({ file: { retentionDurationSeconds: 3600 } })
    view.tick(7_200_001)
    await waitFor(() => expect(draft.items[0]?.statusLabel).toBe('Expired'))
    expect(draft.hasBlockingAttachments).toBe(true)
    expect(draft.prepareSend()).toBeNull()
  })

  it('rechecks an externally extended deadline and retries a failed check without a new upload', async () => {
    const view = mount()
    await select()
    const original = draft.items[0]
    const pins = draft.readyRefs
    view.tick(30 * 60_000)
    // Retention changed via another tab/MCP: there is no local save invalidation.
    row = { ...row, file: applyFileRetention(row.file, 7200, new Date().toISOString()) }
    metadataFails = true
    view.tick(3_600_001)
    await waitFor(() => expect(draft.items[0]?.statusLabel).toBe('Check failed'))
    expect(draft.prepareSend()).toBeNull()
    expect(draft.items[0].canRetry).toBe(true)
    metadataFails = false
    act(() => draft.retry(original.id))
    await waitFor(() => expect(draft.items[0]?.statusLabel).toBe('Ready'))
    expect(draft.items[0].requestId).toBe(original.requestId)
    expect(draft.prepareSend()?.attachments).toEqual(pins)
    expect(metadataReads).toBeGreaterThanOrEqual(3)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(cancel).not.toHaveBeenCalled()
  })
})
