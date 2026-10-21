import { StrictMode, useEffect } from 'react'
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FILE_RETENTION_SECONDS, FileWithRevisionSchema, MAX_FILE_BYTES, MAX_MESSAGE_ATTACHMENTS,
  TemporaryFileScopeSchema, temporaryFileExpiresAt,
  type FileMediaType, type FileWithRevision, type TemporaryFileScope,
} from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { AttachmentDraftProvider } from './AttachmentDraftProvider'
import { ChatAttachmentControl } from './ChatAttachmentControl'
import { createAttachmentHttpClient, type AttachmentClient, type AttachmentUploadInput } from './attachmentClient'
import { ATTACHMENT_ACCEPT, attachmentDraftKey, inspectAttachment } from './attachmentFiles'
import { useConversationAttachments, type ConversationAttachments } from './useConversationAttachments'
import { deferred } from '../../test/deferred'

const paths = {
  upload: '*/files/uploads', bytes: '*/files/uploads/:requestId',
  finalize: '*/files/uploads/:requestId/finalize', cancel: '*/files/uploads/:requestId',
}
const scopeA: TemporaryFileScope = {
  kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner-a', operatorId: 'operator-a', conversationId: 'conversation-a' },
}
const scopeB: TemporaryFileScope = {
  kind: 'temporary', chat: { kind: 'operator', ownerPrincipalId: 'owner-a', operatorId: 'operator-a', conversationId: 'conversation-b' },
}
const agentScope: TemporaryFileScope = {
  kind: 'temporary', chat: { kind: 'agent', workspaceId: 'workspace-a', workflowId: 'workflow-a', agentId: 'agent-a',
    conversationId: 'conversation-a', runId: 'run-a', executionId: 'execution-a' },
}
interface Metadata { requestId: string; filename: string; mediaType: FileMediaType; byteSize: number; sha256: string }
interface UploadRequest extends Metadata { scope: TemporaryFileScope }
let uploads: UploadRequest[]
let byteUploads: string[]
let finalizations: { requestId: string; scope: TemporaryFileScope }[]
let cancellations: { scope: TemporaryFileScope; requestId: string }[]
let staged: Map<string, FileWithRevision>
let clients: QueryClient[]
let createUrl: ReturnType<typeof vi.fn<typeof URL.createObjectURL>>
let revokeUrl: ReturnType<typeof vi.fn<typeof URL.revokeObjectURL>>

function row(input: UploadRequest, state: 'pending' | 'ready' = 'pending'): FileWithRevision {
  const createdAt = new Date().toISOString()
  return FileWithRevisionSchema.parse({
    file: { fileId: `file-${input.requestId}`, currentRevisionId: `revision-${input.requestId}`, scope: input.scope, state, createdAt,
      retentionDurationSeconds: DEFAULT_FILE_RETENTION_SECONDS, expiresAt: temporaryFileExpiresAt(createdAt, DEFAULT_FILE_RETENTION_SECONDS) },
    revision: { fileId: `file-${input.requestId}`, revisionId: `revision-${input.requestId}`, filename: input.filename,
      mediaType: input.mediaType, byteSize: input.byteSize, sha256: input.sha256, origin: 'upload', createdAt },
  })
}
async function receiveUpload(request: Request): Promise<UploadRequest> {
  expect(request.headers.get('accept')).toBe('application/json')
  expect(request.headers.get('content-type')).toMatch(/^application\/json/)
  const metadata = await request.json() as Metadata
  expect(Object.keys(metadata).sort()).toEqual(['byteSize', 'filename', 'mediaType', 'requestId', 'sha256'])
  expect(metadata.sha256).toMatch(/^[a-f0-9]{64}$/)
  const url = new URL(request.url)
  const operator = url.pathname.match(/^\/api\/operator\/conversations\/([^/]+)\/files\/uploads$/)
  const agent = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/agent-chat\/conversations\/([^/]+)\/files\/uploads$/)
  const scope = operator ? [scopeA, scopeB].find((item) => item.chat.conversationId === decodeURIComponent(operator[1]))
    : agent && agentScope.chat.kind === 'agent' && agentScope.chat.workspaceId === decodeURIComponent(agent[1])
      && agentScope.chat.conversationId === decodeURIComponent(agent[2]) ? agentScope : undefined
  if (!scope) throw new Error(`Unexpected allocation path: ${url.pathname}`)
  const value = { ...metadata, scope }
  uploads.push(value)
  return value
}
async function stageUpload(request: Request) {
  const input = await receiveUpload(request)
  const value = staged.get(input.requestId) ?? row(input)
  staged.set(input.requestId, value)
  return HttpResponse.json({ value, replayed: false })
}
async function finalizeUpload(request: Request) {
  expect(await request.json()).toEqual({})
  const requestId = new URL(request.url).pathname.split('/').at(-2)!
  const value = staged.get(requestId)
  if (!value) return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'No allocation.' } }, { status: 404 })
  finalizations.push({ requestId, scope: value.file.scope as TemporaryFileScope })
  return HttpResponse.json({ value: { ...value, file: { ...value.file, state: 'ready' } }, replayed: false })
}

function Probe({ scope, capture }: { scope: TemporaryFileScope | null; capture: (draft: ConversationAttachments) => void }) {
  const draft = useConversationAttachments(scope)
  useEffect(() => capture(draft), [capture, draft])
  return <div style={{ width: 320 }}><ChatAttachmentControl draft={draft} /></div>
}
function mount(scope: TemporaryFileScope | null = scopeA, client: AttachmentClient = createAttachmentHttpClient(), strict = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(queryClient)
  let draft!: ConversationAttachments
  const capture = (value: ConversationAttachments) => { draft = value }
  const tree = (currentScope: TemporaryFileScope | null) => {
    const content = <QueryClientProvider client={queryClient}>
      <AttachmentDraftProvider client={client}><Probe scope={currentScope} capture={capture} /></AttachmentDraftProvider>
    </QueryClientProvider>
    return strict ? <StrictMode>{content}</StrictMode> : content
  }
  const view = render(tree(scope))
  return { ...view, queryClient, get draft() { return draft }, switchTo: (next: TemporaryFileScope | null) => view.rerender(tree(next)) }
}
function file(name = 'notes.md', type = 'text/markdown', content = '# marker') { return new File([content], name, { type }) }
function picker() { return screen.getByLabelText('Choose attachments') as HTMLInputElement }
async function ready(view: ReturnType<typeof mount>, count = 1) {
  await waitFor(() => expect(view.draft.readyRefs).toHaveLength(count))
  expect(view.draft.hasBlockingAttachments).toBe(false)
}

beforeEach(() => {
  uploads = []; byteUploads = []; finalizations = []; cancellations = []; staged = new Map(); clients = []
  createUrl = vi.fn<typeof URL.createObjectURL>((blob) => {
    if (!(blob instanceof Blob)) throw new Error('Expected attachment Blob')
    return `blob:attachment-${blob.size}-${crypto.randomUUID()}`
  })
  revokeUrl = vi.fn<typeof URL.revokeObjectURL>()
  const OriginalURL = globalThis.URL
  vi.stubGlobal('URL', class extends OriginalURL {
    static createObjectURL = createUrl
    static revokeObjectURL = revokeUrl
  })
  vi.stubGlobal('crypto', { ...crypto, subtle: webcrypto.subtle, randomUUID: crypto.randomUUID.bind(crypto) })
  server.use(
    http.post(paths.upload, ({ request }) => stageUpload(request)),
    http.put(paths.bytes, ({ request, params }) => {
      expect(request.headers.get('content-type')).toBe('application/octet-stream')
      const requestId = String(params.requestId)
      const value = staged.get(requestId)
      if (!value) return HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'No allocation.' } }, { status: 404 })
      byteUploads.push(requestId)
      return HttpResponse.json({ value, replayed: false })
    }),
    http.post(paths.finalize, ({ request }) => finalizeUpload(request)),
    http.delete(paths.cancel, async ({ request, params }) => {
      expect(await request.json()).toEqual({})
      const requestId = String(params.requestId)
      const value = staged.get(requestId)!
      cancellations.push({ requestId, scope: value.file.scope as TemporaryFileScope })
      return HttpResponse.json({ value, replayed: false })
    }),
  )
})
afterEach(async () => {
  cleanup()
  await act(async () => { await Promise.resolve() })
  for (const client of clients) client.clear()
  vi.unstubAllGlobals()
})

describe('shared attachment picker and real HTTP boundary', () => {
  it('drops files through the existing upload/finalization and exact send pin pipeline', async () => {
    const view = mount()
    const selected = file('dropped.md')
    fireEvent.drop(view.container.querySelector('.attachment-control')!, { dataTransfer: { types: ['Files'], files: [selected] } })
    await ready(view)
    expect(uploads).toHaveLength(1); expect(uploads[0].filename).toBe('dropped.md')
    expect(byteUploads).toEqual([uploads[0].requestId])
    expect(finalizations).toEqual([{ requestId: uploads[0].requestId, scope: scopeA }])
    expect(view.draft.prepareSend()?.attachments).toEqual(view.draft.readyRefs)
  })

  it('rejects dropped unsupported files and folders and unavailable conversation writes', async () => {
    const view = mount()
    const target = () => view.container.querySelector('.attachment-control')!
    fireEvent.drop(target(), { dataTransfer: { types: ['Files'], files: [file('bad.exe')] } })
    expect(await screen.findByText('Unsupported')).toBeVisible(); expect(uploads).toHaveLength(0)
    fireEvent.drop(target(), { dataTransfer: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } })
    expect(screen.getByRole('alert')).toHaveTextContent('Folders are not supported')
    view.switchTo(null)
    fireEvent.drop(target(), { dataTransfer: { types: ['Files'], files: [file()] } })
    expect(uploads).toHaveLength(0)
  })
  it.each([
    ['photo.png', 'image/png'], ['photo.jpg', 'image/jpeg'], ['photo.jpeg', 'image/jpeg'],
    ['photo.webp', 'image/webp'], ['photo.gif', 'image/gif'], ['paper.pdf', 'application/pdf'],
    ['paper.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['notes.md', 'text/markdown'], ['bundle.zip', 'application/zip'],
  ])('uploads and finalizes %s, retaining it as an unsent draft', async (name, type) => {
    const view = mount()
    await userEvent.setup().upload(picker(), file(name, type))
    await ready(view)
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ filename: name, mediaType: type, byteSize: file(name, type).size, scope: scopeA })
    expect(uploads[0].sha256).toBe(createHash('sha256').update('# marker').digest('hex'))
    expect(byteUploads).toEqual([uploads[0].requestId])
    expect(finalizations).toHaveLength(1)
    expect(view.draft.items[0].statusLabel).toBe('Ready')
    expect(view.draft.hasAttachments).toBe(true)
    expect(screen.queryByText(/^Sent$/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Attach files' })).toHaveAttribute('title', 'Attach files')
    expect(picker()).toHaveAttribute('accept', ATTACHMENT_ACCEPT)
    expect(picker().value).toBe('')
    const snapshot = view.draft.prepareSend()
    expect(snapshot?.attachments).toEqual(view.draft.readyRefs)
    expect(view.draft.items).toHaveLength(1) // Preparing is not acknowledging a send either.
  })

  it.each([['NOTES.MD', ''], ['notes.md', 'text/plain'], ['bundle.zip', 'application/x-zip-compressed']])(
    'canonicalizes browser MIME hints for %s (%s)', async (name, type) => {
      const view = mount()
      await userEvent.setup().upload(picker(), file(name, type, ''))
      await ready(view)
      expect(uploads[0].mediaType).toBe(name.toLowerCase().endsWith('.zip') ? 'application/zip' : 'text/markdown')
      expect(uploads[0].byteSize).toBe(0)
    },
  )

  it('uploads multiple files independently and preserves picker order after out-of-order responses', async () => {
    const first = deferred()
    server.use(http.post(paths.upload, async ({ request }) => {
      const value = await receiveUpload(request)
      if (value.filename === 'first.md') await first.promise
      const result = row(value); staged.set(value.requestId, result)
      return HttpResponse.json({ value: result, replayed: false })
    }))
    const view = mount()
    await userEvent.setup().upload(picker(), [file('first.md'), file('second.md')])
    await waitFor(() => expect(view.draft.readyRefs).toHaveLength(1))
    expect(view.draft.hasBlockingAttachments).toBe(true)
    expect(view.draft.prepareSend()).toBeNull() // Never silently send a ready subset.
    first.resolve()
    await ready(view, 2)
    expect(view.draft.items.map((item) => item.filename)).toEqual(['first.md', 'second.md'])
    const pickerOrder = ['first.md', 'second.md'].map(filename => {
      const upload = uploads.find(upload => upload.filename === filename)
      expect(upload).toBeDefined()
      return `file-${upload!.requestId}`
    })
    expect(view.draft.readyRefs.map((ref) => ref.fileId)).toEqual(pickerOrder)
  })

  it('keeps bytes-complete/finalization-pending files out of readyRefs', async () => {
    const finalization = deferred()
    server.use(http.post(paths.finalize, async ({ request }) => { await finalization.promise; return finalizeUpload(request) }))
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    await waitFor(() => expect(view.draft.items[0]?.statusLabel).toBe('Checking'))
    expect(view.draft.items[0].progress).toBe(100)
    expect(view.draft.prepareSend()).toBeNull()
    finalization.resolve()
    await ready(view)
  })

  it('shows real progress without fabricating a percentage before telemetry arrives', async () => {
    const gate = deferred()
    let input!: AttachmentUploadInput
    const real = createAttachmentHttpClient()
    const client: AttachmentClient = { ...real, async upload(value) { input = value; await gate.promise; return real.upload(value) } }
    const view = mount(scopeA, client)
    await userEvent.setup().upload(picker(), file())
    await waitFor(() => expect(view.draft.items[0]?.statusLabel).toBe('Uploading'))
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
    act(() => input.onProgress({ phase: 'uploading', percent: 42 }))
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('value', '42'))
    expect(view.draft.readyRefs).toEqual([])
    gate.resolve()
    await ready(view)
  })

  it('rejects unsupported, mismatched and oversized selections without making HTTP requests', async () => {
    const view = mount()
    const large = file('large.pdf', 'application/pdf')
    Object.defineProperty(large, 'size', { value: MAX_FILE_BYTES + 1 })
    act(() => view.draft.addFiles([file('script.svg', 'image/svg+xml'), file('false.pdf', 'image/png'), large]))
    await waitFor(() => expect(view.draft.items).toHaveLength(3))
    expect(view.draft.items.map((item) => item.statusLabel)).toEqual(['Unsupported', 'Type mismatch', 'Too large'])
    expect(uploads).toEqual([])
    expect(view.draft.prepareSend()).toBeNull()
    expect(screen.queryByRole('button', { name: /Retry upload/ })).not.toBeInTheDocument()
  })

  it('enforces the shared count limit and lets a removed slot be selected again', async () => {
    const view = mount()
    await userEvent.setup().upload(picker(), Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, (_, i) => file(`${i}.md`)))
    await ready(view, MAX_MESSAGE_ATTACHMENTS)
    expect(uploads).toHaveLength(MAX_MESSAGE_ATTACHMENTS)
    expect(screen.getByRole('alert')).toHaveTextContent(`Up to ${MAX_MESSAGE_ATTACHMENTS} files`)
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove attachment 0.md' }))
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeEnabled()
    await userEvent.setup().upload(picker(), file('0.md'))
    await ready(view, MAX_MESSAGE_ATTACHMENTS)
    expect(uploads[0].requestId).not.toBe(uploads.at(-1)?.requestId)
  })

  it('disables the picker until a real conversation scope exists', () => {
    const view = mount(null)
    expect(screen.getByRole('button', { name: 'Attach files' })).toBeDisabled()
    expect(view.draft.prepareSend()).toBeNull()
  })
})

describe('failure, retry, removal and response validation', () => {
  it.each(['upload', 'finalize'] as const)('retries a failed %s using the original request identity', async (operation) => {
    let fail = true
    server.use(http.post(paths[operation], async ({ request }) => {
      if (fail) {
        fail = false
        if (operation === 'upload') await receiveUpload(request)
        else {
          expect(await request.json()).toEqual({})
          const requestId = new URL(request.url).pathname.split('/').at(-2)!
          finalizations.push({ requestId, scope: staged.get(requestId)!.file.scope as TemporaryFileScope })
        }
        return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Try again.' } }, { status: 503 })
      }
      return operation === 'upload' ? stageUpload(request) : finalizeUpload(request)
    }))
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    const retry = await screen.findByRole('button', { name: 'Retry upload notes.md' })
    expect(view.draft.readyRefs).toEqual([])
    expect(view.draft.prepareSend()).toBeNull()
    await userEvent.setup().click(retry)
    await ready(view)
    expect(uploads).toHaveLength(2)
    expect(uploads[1].requestId).toBe(uploads[0].requestId)
    expect(new Set(finalizations.map((entry) => entry.requestId)).size).toBe(1)
    expect(cancellations).toEqual([])
  })

  it('normalizes network failures and exposes retry', async () => {
    server.use(http.post(paths.upload, () => HttpResponse.error()))
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    await screen.findByRole('button', { name: 'Retry upload notes.md' })
    expect(view.draft.items[0].statusLabel).toBe('Upload failed')
    expect(view.draft.readyRefs).toEqual([])
  })

  it('removes an in-flight upload, aborts it and cancels its original unsent allocation', async () => {
    const gate = deferred()
    server.use(http.post(paths.upload, async ({ request }) => {
      const input = await receiveUpload(request)
      const value = row(input)
      staged.set(input.requestId, value)
      await gate.promise
      return HttpResponse.json({ value, replayed: false })
    }))
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    await waitFor(() => expect(uploads).toHaveLength(1))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove attachment notes.md' }))
    await waitFor(() => expect(cancellations).toEqual([{ requestId: uploads[0].requestId, scope: scopeA }]))
    gate.resolve()
    await act(async () => { await Promise.resolve() })
    expect(view.draft.items).toEqual([])
    expect(finalizations).toEqual([])
    expect(screen.getByRole('button', { name: 'Attach files' })).toHaveFocus()
  })

  it('does not resurrect a removed chip when an adapter ignores cancellation and reports late progress/results', async () => {
    const gate = deferred()
    let input!: AttachmentUploadInput
    let completed = false
    const real = createAttachmentHttpClient()
    const client: AttachmentClient = { ...real, async upload(value) {
      input = value
      const result = await real.upload(value)
      completed = true
      await gate.promise
      value.onProgress({ phase: 'finalizing', percent: 100 })
      return result
    } }
    const view = mount(scopeA, client)
    await userEvent.setup().upload(picker(), file())
    await waitFor(() => expect(completed).toBe(true))
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove attachment notes.md' }))
    expect(input.signal.aborted).toBe(true)
    gate.resolve()
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(view.draft.items).toEqual([])
    expect(view.draft.readyRefs).toEqual([])
  })

  it('keeps local removal honest even if remote cleanup fails', async () => {
    server.use(http.delete(paths.cancel, () => HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Cleanup failed.' } }, { status: 503 })))
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    await ready(view)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove attachment notes.md' }))
    await waitFor(() => expect(view.queryClient.getMutationCache().getAll().some((mutation) => mutation.state.status === 'error')).toBe(true))
    expect(view.draft.items).toEqual([])
  })

  it.each(['foreign scope', 'wrong revision', 'still pending', 'wrong filename', 'malformed'])(
    'rejects %s finalization responses', async (problem) => {
      server.use(http.post(paths.finalize, async ({ request }) => {
        expect(await request.json()).toEqual({})
        const value = staged.get(new URL(request.url).pathname.split('/').at(-2)!)!
        const changed = { file: { ...value.file, state: 'ready' }, revision: { ...value.revision } }
        if (problem === 'foreign scope') changed.file.scope = scopeB
        if (problem === 'wrong revision') {
          changed.file.currentRevisionId = 'different-revision'; changed.revision.revisionId = 'different-revision'
        }
        if (problem === 'still pending') changed.file.state = 'pending'
        if (problem === 'wrong filename') changed.revision.filename = 'different.md'
        return HttpResponse.json({ value: problem === 'malformed' ? { fileId: 'bare-id' } : changed, replayed: false })
      }))
      const view = mount()
      await userEvent.setup().upload(picker(), file())
      await screen.findByRole('button', { name: 'Retry upload notes.md' })
      expect(view.draft.readyRefs).toEqual([])
    },
  )

  it('derives upload roots from the conversation scope', async () => {
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    await ready(view)
    expect(uploads[0].scope).toEqual(scopeA)
  })
})

describe('conversation, send and preview lifetimes', () => {
  it('keeps a mid-upload conversation switch bound to its original scope', async () => {
    const gate = deferred()
    server.use(http.post(paths.upload, async ({ request }) => {
      const input = await receiveUpload(request)
      if (input.scope.chat.conversationId === scopeA.chat.conversationId) await gate.promise
      const value = row(input); staged.set(input.requestId, value)
      return HttpResponse.json({ value, replayed: false })
    }))
    const view = mount()
    await userEvent.setup().upload(picker(), file('a.md'))
    await waitFor(() => expect(uploads).toHaveLength(1))
    view.switchTo(scopeB)
    expect(view.draft.items).toEqual([])
    await userEvent.setup().upload(picker(), file('b.md'))
    await ready(view)
    const bRefs = view.draft.readyRefs
    gate.resolve()
    await waitFor(() => expect(finalizations).toHaveLength(2))
    expect(view.draft.readyRefs).toEqual(bRefs)
    expect(view.draft.items[0].filename).toBe('b.md')
    view.switchTo(scopeA)
    await ready(view)
    expect(view.draft.items[0].filename).toBe('a.md')
    expect(view.draft.readyRefs).not.toEqual(bRefs)
    expect(finalizations.every((entry) => entry.scope.chat.kind === 'operator' && !('workspaceId' in entry.scope.chat))).toBe(true)
  })

  it('binds an already-open native picker to the conversation that opened it', async () => {
    const view = mount()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Attach files' }))
    view.switchTo(scopeB)
    await user.upload(picker(), file('opened-in-a.md'))
    await waitFor(() => expect(finalizations).toHaveLength(1))
    expect(uploads[0].scope).toEqual(scopeA)
    expect(view.draft.items).toEqual([])
    view.switchTo(scopeA)
    await ready(view)
  })

  it('does not collide across Operator and Agent scopes with the same conversation ID', async () => {
    const view = mount()
    await userEvent.setup().upload(picker(), file('operator.md'))
    await ready(view)
    view.switchTo(agentScope)
    expect(view.draft.items).toEqual([])
    await userEvent.setup().upload(picker(), file('agent.md'))
    await ready(view)
    expect(uploads[1].scope).toEqual(agentScope)
    view.switchTo(scopeA)
    await ready(view)
    expect(view.draft.items[0].filename).toBe('operator.md')
    expect(attachmentDraftKey(agentScope)).not.toBe(attachmentDraftKey(scopeA))
    expect(() => TemporaryFileScopeSchema.parse({ ...agentScope, chat: { ...agentScope.chat, executionId: undefined } })).toThrow()
  })

  it('clears only an acknowledged send snapshot, not later additions or another conversation', async () => {
    const view = mount()
    await userEvent.setup().upload(picker(), file('sent.md'))
    await ready(view)
    const snapshot = view.draft.prepareSend()!
    expect(Object.isFrozen(snapshot.attachments)).toBe(true)
    await userEvent.setup().upload(picker(), file('keep.md'))
    await ready(view, 2)
    view.switchTo(scopeB)
    await userEvent.setup().upload(picker(), file('other.md'))
    await ready(view)
    act(() => view.draft.acknowledgeSent(snapshot))
    expect(view.draft.items[0].filename).toBe('other.md')
    view.switchTo(scopeA)
    await ready(view)
    expect(view.draft.items[0].filename).toBe('keep.md')
    expect(cancellations).toEqual([])
    act(() => view.draft.acknowledgeSent(snapshot)) // Idempotent local acknowledgement.
    expect(view.draft.items).toHaveLength(1)
  })

  it('revokes image object URLs on switching, removal and unmount, but not ordinary status updates', async () => {
    const view = mount()
    await userEvent.setup().upload(picker(), file('preview.png', 'image/png'))
    await ready(view)
    expect(createUrl).toHaveBeenCalledTimes(1)
    const first = createUrl.mock.results[0].value
    expect(view.container.querySelector('img')).toHaveAttribute('src', first)
    expect(revokeUrl).not.toHaveBeenCalled()
    view.switchTo(scopeB)
    expect(revokeUrl).toHaveBeenCalledWith(first)
    view.switchTo(scopeA)
    await ready(view)
    expect(createUrl).toHaveBeenCalledTimes(2)
    const second = createUrl.mock.results[1].value
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove attachment preview.png' }))
    expect(revokeUrl).toHaveBeenCalledWith(second)
    await userEvent.setup().upload(picker(), file('other.png', 'image/png'))
    await ready(view)
    const third = createUrl.mock.results[2].value
    view.unmount()
    expect(revokeUrl).toHaveBeenCalledWith(third)
  })

  it('survives StrictMode effect replay and releases all previews on final unmount', async () => {
    const view = mount(scopeA, createAttachmentHttpClient(), true)
    await userEvent.setup().upload(picker(), file('strict.png', 'image/png'))
    await ready(view)
    view.unmount()
    await act(async () => { await Promise.resolve() })
    expect(revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual(createUrl.mock.results.map(({ value }) => value).sort())
    expect(view.queryClient.getMutationCache().getAll()).toEqual([])
  })

  it('drops protected files and aborts uploads at the existing session boundary', async () => {
    const gate = deferred()
    let input!: AttachmentUploadInput
    const real = createAttachmentHttpClient()
    const client: AttachmentClient = { ...real, async upload(value) { input = value; await gate.promise; return real.upload(value) } }
    const view = mount(scopeA, client)
    await userEvent.setup().upload(picker(), file('private.png', 'image/png'))
    await waitFor(() => expect(view.draft.items).toHaveLength(1))
    try {
      act(() => { beginSessionChange() })
      expect(input.signal.aborted).toBe(true)
      expect(view.draft.items).toEqual([])
      expect(view.draft.available).toBe(false)
      expect(revokeUrl).toHaveBeenCalled()
      gate.resolve()
      await act(async () => { await Promise.resolve() })
      expect(uploads).toEqual([])
    } finally { act(() => { finishSessionChange() }) }
  })

  it('retains an image preview across failure/retry and revokes it on send acknowledgement', async () => {
    let fail = true
    server.use(http.post(paths.upload, async ({ request }) => {
      if (fail) {
        fail = false
        await receiveUpload(request)
        return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Try again.' } }, { status: 503 })
      }
      return stageUpload(request)
    }))
    const view = mount()
    await userEvent.setup().upload(picker(), file('retry.png', 'image/png'))
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Retry upload retry.png' }))
    await ready(view)
    expect(createUrl).toHaveBeenCalledTimes(1)
    expect(revokeUrl).not.toHaveBeenCalled()
    const snapshot = view.draft.prepareSend()!
    act(() => view.draft.acknowledgeSent(snapshot))
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0].value)
    expect(cancellations).toEqual([])
  })

  it('rechecks expiry synchronously even when the last rendered refs were ready', async () => {
    const view = mount()
    await userEvent.setup().upload(picker(), file())
    await ready(view)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.now() + (DEFAULT_FILE_RETENTION_SECONDS + 1) * 1000))
      expect(view.draft.prepareSend()).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('aborts and drops an in-flight upload when its provider is actually unmounted', async () => {
    const gate = deferred()
    let input!: AttachmentUploadInput
    const real = createAttachmentHttpClient()
    const client: AttachmentClient = { ...real, async upload(value) { input = value; await gate.promise; return real.upload(value) } }
    const view = mount(scopeA, client)
    await userEvent.setup().upload(picker(), file('closing.png', 'image/png'))
    await waitFor(() => expect(view.draft.items).toHaveLength(1))
    view.unmount()
    await act(async () => { await Promise.resolve() })
    expect(input.signal.aborted).toBe(true)
    expect(revokeUrl).toHaveBeenCalledWith(createUrl.mock.results[0].value)
    gate.resolve()
    await act(async () => { await Promise.resolve() })
    expect(uploads).toEqual([])
    expect(view.queryClient.getMutationCache().getAll()).toEqual([])
  })

  it('uses the frozen file size boundary without reading the file into memory', () => {
    const boundary = file()
    Object.defineProperty(boundary, 'size', { value: MAX_FILE_BYTES })
    expect(inspectAttachment(boundary).ok).toBe(true)
    expect(inspectAttachment(file('../escape.md')).ok).toBe(false)
  })
})
