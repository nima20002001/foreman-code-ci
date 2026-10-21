import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { FileWithRevisionSchema, type TemporaryFileScope } from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { settingsExperienceKeys } from '../../shared/api/settingsExperience'
import { finishSessionChange, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import type { AttachmentClient, AttachmentUploadInput } from '../attachments/attachmentClient'
import { useConversationAttachments, type ConversationAttachments } from '../attachments/useConversationAttachments'
import { AppConnectionBoundary } from '../../app/AppConnectionBoundary'

const transport = vi.hoisted(() => ({ upload: vi.fn<AttachmentClient['upload']>(), cancel: vi.fn<AttachmentClient['cancel']>() }))
const navigate = vi.hoisted(() => vi.fn())
vi.mock('../attachments/attachmentClient', async (original) => ({
  ...await original<typeof import('../attachments/attachmentClient')>(),
  createAttachmentHttpClient: () => transport,
}))
vi.mock('@tanstack/react-router', async (original) => ({
  ...await original<typeof import('@tanstack/react-router')>(),
  useNavigate: () => navigate, useLocation: () => ({ href: '/' }),
}))

const identity = { installationId: '10000000-0000-4000-8000-000000000001', checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) }
const session = LocalHumanAccessSchema.parse({ principal: {
  id: 'owner-a', name: 'Test browser', expiresAt: '2099-01-01T00:00:00Z',
  grants: [{ actions: ['settings:read', 'harnesses:read'], scope: {} }],
} })
const scope = (conversationId: string): TemporaryFileScope => ({ kind: 'temporary',
  chat: { kind: 'operator', conversationId, ownerPrincipalId: 'owner-a', operatorId: 'operator-a' } })
const scopes = [scope('chat-a'), scope('chat-b')]
function uploaded(input: AttachmentUploadInput) {
  const createdAt = new Date().toISOString()
  return FileWithRevisionSchema.parse({
    file: { fileId: `file-${input.requestId}`, currentRevisionId: `revision-${input.requestId}`, scope: input.scope,
      state: 'ready', createdAt, retentionDurationSeconds: 3600, expiresAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString() },
    revision: { fileId: `file-${input.requestId}`, revisionId: `revision-${input.requestId}`, filename: input.filename,
      mediaType: input.mediaType, byteSize: input.file.size, sha256: 'a'.repeat(64), origin: 'upload', createdAt },
  })
}
const drafts = new Map<string, ConversationAttachments>()
function Probe({ value }: { value: TemporaryFileScope }) {
  const draft = useConversationAttachments(value)
  useEffect(() => { drafts.set(value.chat.conversationId, draft) }, [value, draft])
  return <span data-testid={value.chat.conversationId}>{draft.items.length}</span>
}
let queryClient: QueryClient
let failure: number | 'network' | undefined
let release: () => void
let pendingInput: AttachmentUploadInput

beforeEach(() => {
  drafts.clear(); vi.clearAllMocks(); failure = undefined
  window.localStorage.setItem('graphql.chat-instance-binding', `${identity.checkoutId}:${identity.installationId}`)
  const gate = new Promise<void>((resolve) => { release = resolve })
  transport.upload.mockImplementation(async (input) => {
    if (input.filename === 'uploading.md') { pendingInput = input; await gate }
    return uploaded(input)
  })
  transport.cancel.mockResolvedValue(undefined)
  server.use(
    http.get('/api/local-human', () => failure === 'network' ? HttpResponse.error() : failure
      ? HttpResponse.json({ error: { code: 'SESSION_CHECK_FAILED', message: 'Unavailable' } }, { status: failure })
      : HttpResponse.json(session)),
    http.get('/api/runtime/identity', () => HttpResponse.json(identity)),
  )
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
})
afterEach(async () => {
  cleanup(); release()
  await act(async () => { await Promise.resolve() })
  queryClient.clear()
  if (sessionIsSwitching()) finishSessionChange()
})
async function mountDrafts() {
  render(<QueryClientProvider client={queryClient}><AppConnectionBoundary>
    {scopes.map((value) => <Probe key={value.chat.conversationId} value={value} />)}
  </AppConnectionBoundary></QueryClientProvider>)
  await screen.findByTestId('chat-a')
  await waitFor(() => {
    expect(drafts.get('chat-a')).toBeDefined()
    expect(drafts.get('chat-b')).toBeDefined()
  })
  act(() => {
    drafts.get('chat-a')!.addFiles([new File(['a'], 'ready.md'), new File(['b'], 'uploading.md')])
    drafts.get('chat-b')!.addFiles([new File(['c'], 'other.md')])
  })
  await waitFor(() => {
    expect(drafts.get('chat-a')!.items.map((item) => item.status)).toEqual(['ready', 'uploading'])
    expect(drafts.get('chat-b')!.items[0]?.status).toBe('ready')
  })
}

describe('attachment lifetime during local API failures', () => {
  it.each([503, 'network'] as const)('preserves all drafts and the running upload through a %s connection check', async (error) => {
    await mountDrafts()
    const generation = sessionGeneration()
    const selections = scopes.map((value) => drafts.get(value.chat.conversationId)!.items.map(({ id, requestId, file }) => ({ id, requestId, file })))
    const mutations = queryClient.getMutationCache().getAll()
    const signal = pendingInput.signal
    failure = error
    await act(async () => { await queryClient.invalidateQueries({ queryKey: settingsExperienceKeys.access(), exact: true }) })
    expect(await screen.findByRole('alert', { name: 'Server connection' })).toBeInTheDocument()
    expect(screen.getByTestId('chat-a')).toBeInTheDocument()
    await act(async () => { await Promise.resolve() }) // Include provider's deferred disposal.
    expect(signal.aborted).toBe(false)
    expect(queryClient.getMutationCache().getAll()).toEqual(mutations)
    failure = undefined
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await screen.findByTestId('chat-a')
    expect(sessionGeneration()).toBe(generation)
    scopes.forEach((value, index) => {
      const items = drafts.get(value.chat.conversationId)!.items
      expect(items.map(({ id, requestId, file }) => ({ id, requestId, file }))).toEqual(selections[index])
      items.forEach((item, itemIndex) => expect(item.file).toBe(selections[index][itemIndex].file))
    })
    expect(drafts.get('chat-a')!.isUploading).toBe(true)
    expect(pendingInput.signal).toBe(signal)
    release()
    await waitFor(() => expect(drafts.get('chat-a')!.readyRefs).toHaveLength(2))
    expect(transport.upload).toHaveBeenCalledTimes(3)
    expect(transport.cancel).not.toHaveBeenCalled()
    expect(drafts.get('chat-b')!.items[0].filename).toBe('other.md')
  })

  it.each([401, 403])('still disposes protected drafts on a definite %s denial', async (status) => {
    await mountDrafts()
    failure = status
    await act(async () => { await queryClient.invalidateQueries({ queryKey: settingsExperienceKeys.access(), exact: true }) })
    await waitFor(() => expect(pendingInput.signal.aborted).toBe(true))
    expect(queryClient.getMutationCache().getAll()).toEqual([])
    expect(screen.queryByTestId('chat-a')).not.toBeInTheDocument()
  })
})
