import { StrictMode } from 'react'
import { createHash, randomUUID, webcrypto } from 'node:crypto'
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileRowSchema, MAX_FILE_BYTES, type FileRevision, type FileRow } from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { ProjectFilesSection } from './ProjectFilesSection'
import { projectFilesClient } from './projectFilesClient'
import { readUploadBytes } from './projectFilesBytes'
import { projectFilesKeys } from './projectFilesQueries'

it.each(['panel', 'heading', 'toolbar', 'Upload', 'hint', 'empty', 'list', 'row'])(
  'drops on the %s through one workspace upload and persisted list readback', async (surface) => {
    if (surface === 'list' || surface === 'row') rows.set(A, [fixture('existing')])
    const view = mount()
    await screen.findByText(surface === 'list' || surface === 'row' ? 'existing.md' : 'No files.')
    const panel = screen.getByRole('region', { name: 'Project files' })
    const targets: Record<string, Element> = {
      panel, heading: screen.getByRole('heading', { name: 'Project files' }),
      toolbar: panel.querySelector('header')!, Upload: screen.getByRole('button', { name: 'Upload' }),
      hint: screen.getByRole('button', { name: 'About Project files' }),
      empty: screen.queryByText('No files.') ?? panel,
      list: screen.queryByRole('list', { name: 'Project files' }) ?? panel,
      row: screen.queryByText('existing.md') ?? panel,
    }
    expect(view.container.querySelector('.workspace-detail-content')!.firstElementChild).toBe(panel)
    expect(Object.values(targets).every((target) => panel.contains(target))).toBe(true)
    const selected = file('dropped-project.md', '# exact dropped bytes')
    const event = createEvent.drop(targets[surface], { dataTransfer: { types: ['Files'], files: [selected] } })
    fireEvent(targets[surface], event)
    expect(event.defaultPrevented).toBe(true)
    await screen.findByRole('button', { name: 'Download dropped-project.md' })
    expect(calls.filter((call) => ['allocate', 'bytes', 'finalize'].includes(call.phase)).map((call) => call.phase))
      .toEqual(['allocate', 'bytes', 'finalize'])
    expect(calls.filter((call) => ['allocate', 'bytes', 'finalize'].includes(call.phase)).map((call) => call.workspaceId)).toEqual([A, A, A])
    expect(calls.slice(calls.findIndex((call) => call.phase === 'finalize') + 1))
      .toContainEqual({ phase: 'list', workspaceId: A })
    const stored = rows.get(A)!.find((row) => row.revision.filename === 'dropped-project.md')!
    expect(stored.file.state).toBe('ready')
    expect(stored.revision.sha256).toBe(hash(new TextEncoder().encode('# exact dropped bytes')))
  },
)

it('keeps whole-panel feedback stable across children and ignores text, URLs and ordinary clicks', async () => {
  mount()
  const panel = screen.getByRole('region', { name: 'Project files' })
  const heading = screen.getByRole('heading', { name: 'Project files' })
  const upload = screen.getByRole('button', { name: 'Upload' })
  const dataTransfer = { types: ['Files'], files: [file()], dropEffect: 'none' }
  fireEvent.dragEnter(panel, { dataTransfer })
  fireEvent.dragEnter(heading, { dataTransfer })
  fireEvent.dragLeave(heading, { dataTransfer })
  fireEvent.dragEnter(upload, { dataTransfer })
  fireEvent.dragLeave(upload, { dataTransfer })
  expect(panel).toHaveAttribute('data-file-dragging', 'true')
  expect(screen.getByText('Drop to upload')).toBeVisible()
  fireEvent.dragLeave(panel, { dataTransfer })
  expect(panel).not.toHaveAttribute('data-file-dragging')
  for (const type of ['text/plain', 'text/uri-list']) {
    const transfer = { types: [type], files: [] }
    const enter = createEvent.dragEnter(heading, { dataTransfer: transfer })
    const drop = createEvent.drop(upload, { dataTransfer: transfer })
    fireEvent(heading, enter); fireEvent(upload, drop)
    expect(enter.defaultPrevented).toBe(false); expect(drop.defaultPrevented).toBe(false)
  }
  fireEvent.click(heading); fireEvent.click(panel); fireEvent.click(upload)
  expect(calls.filter((call) => call.phase === 'allocate')).toHaveLength(0)
})

it('blocks drops anywhere in the panel while an upload or removal dialog is pending', async () => {
  const gate = deferred()
  server.use(http.post(paths.finalize, async ({ request, params }) => {
    await gate.promise
    return finalize(request, String(params.workspaceId), String(params.requestId))
  }))
  mount()
  const panel = screen.getByRole('region', { name: 'Project files' })
  const upload = screen.getByRole('button', { name: 'Upload' })
  fireEvent.drop(panel, { dataTransfer: { types: ['Files'], files: [file()] } })
  await screen.findByRole('status', { name: 'Uploading notes.md' })
  expect(upload).toBeDisabled()
  const transfer = { types: ['Files'], files: [file('blocked.md')], dropEffect: 'copy' }
  fireEvent.dragEnter(panel, { dataTransfer: transfer })
  fireEvent.dragOver(upload, { dataTransfer: transfer })
  expect(panel).not.toHaveAttribute('data-file-dragging')
  expect(transfer.dropEffect).toBe('none')
  const drop = createEvent.drop(upload, { dataTransfer: transfer }); fireEvent(upload, drop)
  expect(drop.defaultPrevented).toBe(true)
  await act(async () => gate.resolve())
  await screen.findByRole('button', { name: 'Download notes.md' })
  await userEvent.click(screen.getByRole('button', { name: 'Remove notes.md' }))
  const lockedDrop = createEvent.drop(panel, { dataTransfer: transfer }); fireEvent(panel, lockedDrop)
  expect(lockedDrop.defaultPrevented).toBe(true)
  expect(calls.filter((call) => call.phase === 'allocate')).toHaveLength(1)
  expect(calls.filter((call) => call.phase === 'finalize')).toHaveLength(1)
  expect(rows.get(A)!.map((row) => row.revision.filename)).toEqual(['notes.md'])
})

it('retains server write denial for a file dropped on the heading', async () => {
  server.use(http.post(paths.allocate, () => failure(403)))
  mount()
  await screen.findByText('No files.')
  fireEvent.drop(screen.getByRole('heading', { name: 'Project files' }), {
    dataTransfer: { types: ['Files'], files: [file('denied.md')] },
  })
  expect(await screen.findByRole('alert')).toHaveTextContent('Upload failed')
  expect(calls.filter((call) => ['bytes', 'finalize'].includes(call.phase))).toHaveLength(0)
  expect(rows.get(A)).toEqual([])
  expect(screen.queryByRole('button', { name: 'Download denied.md' })).not.toBeInTheDocument()
})

it('reports unsupported multi-file/directory drops and keeps existing file validation', async () => {
  const view = mount(), target = view.container.querySelector('.project-files')!
  fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [file(), file()] } })
  expect(screen.getByRole('alert')).toHaveTextContent('one file at a time')
  fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [], items: [{ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true }) }] } })
  expect(screen.getByRole('alert')).toHaveTextContent('Folders are not supported')
  fireEvent.drop(target, { dataTransfer: { types: ['Files'], files: [file('unsupported.exe')] } })
  expect(screen.getByRole('alert')).toHaveTextContent('Unsupported')
  expect(calls.filter((call) => call.phase === 'allocate')).toHaveLength(0)
})

const A = 'workspace-a'
const B = 'workspace-b'
const root = '*/api/workspaces/:workspaceId/reference-files'
const paths = { list: root, allocate: `${root}/uploads`, bytes: `${root}/uploads/:requestId`,
  finalize: `${root}/uploads/:requestId/finalize`, remove: `${root}/:fileId/revisions/:revisionId`,
  content: `${root}/:fileId/revisions/:revisionId/content` }
const contents = new TextEncoder().encode('# project fixture\n')
const hash = (bytes: Uint8Array | ArrayBuffer) => createHash('sha256').update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).digest('hex')
type Metadata = Pick<FileRevision, 'filename' | 'mediaType' | 'byteSize' | 'sha256'> & { requestId: string }
interface Allocation { workspaceId: string; row: FileRow; bytes?: ArrayBuffer }
let rows: Map<string, FileRow[]>
let allocations: Map<string, Allocation>
let calls: { phase: string; workspaceId: string; requestId?: string; body?: unknown }[]
let commandIds: string[]
let clients: QueryClient[]
let createUrl: ReturnType<typeof vi.fn<typeof URL.createObjectURL>>
let revokeUrl: ReturnType<typeof vi.fn<typeof URL.revokeObjectURL>>
let clicked: { href: string; filename: string }[]
let gates: (() => void)[]

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  gates.push(resolve)
  return { promise, resolve }
}
function fixture(id: string, workspaceId = A, state: 'pending' | 'ready' | 'removed' = 'ready', filename = `${id}.md`): FileRow {
  const createdAt = '2026-09-01T12:00:00.000Z'
  return FileRowSchema.parse({
    file: { fileId: `file-${id}`, currentRevisionId: `revision-${id}`, createdAt, state,
      scope: { kind: 'workspace_reference', workspaceId } },
    revision: { fileId: `file-${id}`, revisionId: `revision-${id}`, createdAt, filename, mediaType: 'text/markdown',
      byteSize: contents.byteLength, sha256: hash(contents), origin: 'upload' },
  })
}
function store(workspaceId: string, row: FileRow) {
  rows.set(workspaceId, [...(rows.get(workspaceId) ?? []).filter((entry) => entry.file.fileId !== row.file.fileId), row])
}
function page(workspaceId: string) { return { items: rows.get(workspaceId) ?? [], pageInfo: { nextCursor: null } } }
function failure(status = 503) { return HttpResponse.json({ error: { code: 'FILE_TEST_ERROR', message: 'Fixture failure.' } }, { status }) }
function envelope(value: FileRow, replayed = false) { return HttpResponse.json({ value, replayed }) }
async function allocate(request: Request, workspaceId: string) {
  const input = await request.json() as Metadata
  expect(Object.keys(input).sort()).toEqual(['byteSize', 'filename', 'mediaType', 'requestId', 'sha256'])
  calls.push({ phase: 'allocate', workspaceId, requestId: input.requestId, body: input })
  const previous = allocations.get(input.requestId)
  if (previous) {
    expect(previous.workspaceId).toBe(workspaceId)
    expect(previous.row.revision.sha256).toBe(input.sha256)
    return envelope(previous.row, true)
  }
  const base = fixture(input.requestId, workspaceId, 'pending', input.filename)
  const row = FileRowSchema.parse({ ...base, revision: { ...base.revision,
    filename: input.filename, mediaType: input.mediaType, byteSize: input.byteSize, sha256: input.sha256 } })
  allocations.set(input.requestId, { workspaceId, row })
  store(workspaceId, row)
  return envelope(row)
}
async function putBytes(request: Request, workspaceId: string, requestId: string) {
  const allocation = allocations.get(requestId)!
  expect(allocation.workspaceId).toBe(workspaceId)
  expect(request.headers.get('content-type')).toBe('application/octet-stream')
  const bytes = await request.arrayBuffer()
  expect(bytes.byteLength).toBe(allocation.row.revision.byteSize)
  expect(hash(bytes)).toBe(allocation.row.revision.sha256)
  allocation.bytes = bytes
  calls.push({ phase: 'bytes', workspaceId, requestId, body: bytes })
  return envelope(allocation.row)
}
async function finalize(request: Request, workspaceId: string, requestId: string) {
  expect(await request.json()).toEqual({})
  const allocation = allocations.get(requestId)!
  expect(allocation.workspaceId).toBe(workspaceId)
  expect(allocation.bytes).toBeDefined()
  calls.push({ phase: 'finalize', workspaceId, requestId })
  allocation.row = FileRowSchema.parse({ ...allocation.row, file: { ...allocation.row.file, state: 'ready' } })
  store(workspaceId, allocation.row)
  return envelope(allocation.row)
}
async function remove(request: Request, workspaceId: string, fileId: string, revisionId: string) {
  const input = await request.json() as { commandId: string }
  expect(Object.keys(input)).toEqual(['commandId'])
  expect(input.commandId.length).toBeGreaterThanOrEqual(8)
  commandIds.push(input.commandId)
  const row = rows.get(workspaceId)!.find((entry) => entry.file.fileId === fileId && entry.revision.revisionId === revisionId)!
  const removed = FileRowSchema.parse({ ...row, file: { ...row.file, state: 'removed' } })
  store(workspaceId, removed)
  calls.push({ phase: 'remove', workspaceId, body: { fileId, revisionId, commandId: input.commandId } })
  return envelope(removed, row.file.state === 'removed')
}
function content(workspaceId: string, fileId: string, revisionId: string) {
  calls.push({ phase: 'download', workspaceId, body: { fileId, revisionId } })
  const row = rows.get(workspaceId)?.find((entry) => entry.file.fileId === fileId && entry.revision.revisionId === revisionId)
  if (!row) return failure(404)
  if (row.file.state !== 'ready') return failure(row.file.state === 'removed' ? 410 : 409)
  const bytes = Array.from(allocations.values()).find((entry) => entry.row.file.fileId === fileId)?.bytes ?? contents
  return new HttpResponse(bytes, { headers: { 'Content-Type': row.revision.mediaType, 'Content-Disposition': 'attachment' } })
}
function file(name = 'notes.md', value = '# marker\n') { return new File([value], name, { type: 'text/markdown' }) }
function picker() { return screen.getByLabelText('Choose project file') as HTMLInputElement }
function mount(workspaceId = A) {
  const queryClient = new QueryClient({ defaultOptions: {
    queries: { retry: false, gcTime: Infinity, placeholderData: (previous: unknown) => previous },
    mutations: { retry: false },
  } })
  clients.push(queryClient)
  const tree = (id: string) => <StrictMode><QueryClientProvider client={queryClient}>
    <div className="settings-editor-content workspace-detail-content" style={{ width: 390 }}><ProjectFilesSection workspaceId={id} /></div>
  </QueryClientProvider></StrictMode>
  const view = render(tree(workspaceId))
  return { ...view, queryClient, switchTo: (id: string) => view.rerender(tree(id)) }
}

beforeEach(() => {
  rows = new Map([[A, []], [B, []]])
  allocations = new Map(); calls = []; commandIds = []; clients = []; clicked = []; gates = []
  createUrl = vi.fn<typeof URL.createObjectURL>(() => `blob:project-${randomUUID()}`)
  revokeUrl = vi.fn<typeof URL.revokeObjectURL>()
  const NativeURL = globalThis.URL
  vi.stubGlobal('URL', class extends NativeURL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl })
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID,
    getRandomValues: webcrypto.getRandomValues.bind(webcrypto) })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, filename: this.download })
  })
  server.use(
    http.get(paths.list, ({ request, params }) => {
      expect(new URL(request.url).searchParams.get('limit')).toBe('50')
      calls.push({ phase: 'list', workspaceId: String(params.workspaceId) })
      return HttpResponse.json(page(String(params.workspaceId)))
    }),
    http.post(paths.allocate, ({ request, params }) => allocate(request, String(params.workspaceId))),
    http.put(paths.bytes, ({ request, params }) => putBytes(request, String(params.workspaceId), String(params.requestId))),
    http.post(paths.finalize, ({ request, params }) => finalize(request, String(params.workspaceId), String(params.requestId))),
    http.delete(paths.remove, ({ request, params }) => remove(request, String(params.workspaceId), String(params.fileId), String(params.revisionId))),
    http.get(paths.content, ({ params }) => content(String(params.workspaceId), String(params.fileId), String(params.revisionId))),
  )
})
afterEach(async () => {
  cleanup()
  await act(async () => { gates.forEach((release) => release()); await Promise.resolve() })
  clients.forEach((client) => client.clear())
  vi.unstubAllGlobals()
})

describe('Project files section through the real HTTP client and MSW', () => {
  it('lists only this workspace, hides tombstones, and has no expiry/edit controls at 390px', async () => {
    rows.set(A, [fixture('ready'), fixture('waiting', A, 'pending'), fixture('gone', A, 'removed')])
    rows.set(B, [fixture('foreign', B)])
    const view = mount()
    expect(await screen.findByRole('button', { name: 'Download ready.md' })).toHaveAttribute('title', 'Download ready.md')
    expect(screen.getAllByText(`${contents.byteLength} B`)).toHaveLength(2)
    expect(screen.getByText('waiting.md')).toBeVisible()
    expect(screen.getByText('Upload pending')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Download waiting.md' })).not.toBeInTheDocument()
    expect(screen.queryByText('gone.md')).not.toBeInTheDocument()
    expect(screen.queryByText('foreign.md')).not.toBeInTheDocument()
    expect(view.container).not.toHaveTextContent(/expir|7 days|edit|overwrite/i)
    expect(screen.getByRole('region', { name: 'Project files' })).toBeVisible()
  })

  it('allocates, PUTs exact raw bytes, and offers download only after finalize', async () => {
    const gate = deferred()
    server.use(http.post(paths.finalize, async ({ request, params }) => {
      await gate.promise
      return finalize(request, String(params.workspaceId), String(params.requestId))
    }))
    mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file())
    await waitFor(() => expect(calls.some((call) => call.phase === 'bytes')).toBe(true))
    expect(screen.getByRole('status', { name: 'Uploading notes.md' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Download notes.md' })).not.toBeInTheDocument()
    await act(async () => gate.resolve())
    expect(await screen.findByRole('button', { name: 'Download notes.md' })).toBeEnabled()
    expect(calls.filter((call) => ['allocate', 'bytes', 'finalize'].includes(call.phase)).map((call) => call.phase))
      .toEqual(['allocate', 'bytes', 'finalize'])
    const upload = Array.from(allocations.values())[0]
    expect(new TextDecoder().decode(upload.bytes)).toBe('# marker\n')
    expect(upload.row.file.scope).toEqual({ kind: 'workspace_reference', workspaceId: A })
    expect(upload.row.file).not.toHaveProperty('expiresAt')
  })

  it.each([
    ['Markdown contains binary control characters.', 'Remove them in a text editor'],
    ['Markdown must use valid UTF-8.', 'Save it as UTF-8 in a text editor'],
    ['Unrecognized private parser detail', 'Check or re-export the file'],
  ])('gives bounded content recovery without retrying rejected bytes: %s', async (message, guidance) => {
    server.use(http.put(paths.bytes, () => HttpResponse.json({ error: { code: 'FILE_TYPE_INVALID', message } }, { status: 415 })))
    mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file('invalid.md', '# text\0binary\n'))
    expect(await screen.findByRole('alert')).toHaveTextContent(guidance)
    expect(screen.queryByText('Unrecognized private parser detail')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry upload invalid.md' })).not.toBeInTheDocument()
    expect(await screen.findByText('Upload pending')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Remove invalid.md' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Download invalid.md' })).not.toBeInTheDocument()
  })

  it('retains honest pending recovery after reload and allows removal then corrected upload', async () => {
    server.use(http.put(paths.bytes, async ({ request, params }) => {
      const bytes = await request.clone().arrayBuffer()
      if (new Uint8Array(bytes).includes(0)) return HttpResponse.json({ error: {
        code: 'FILE_TYPE_INVALID', message: 'Markdown contains binary control characters.',
      } }, { status: 415 })
      return putBytes(request, String(params.workspaceId), String(params.requestId))
    }))
    const view = mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file('correctable.md', '# text\0binary\n'))
    await screen.findByRole('alert')
    await screen.findByText('Upload pending')
    view.unmount()
    mount() // A fresh QueryClient has no previous browser mutation or File variables.
    expect(await screen.findByText('Upload pending')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Check upload status' })).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument() // No invented persisted reason.
    expect(screen.queryByRole('button', { name: 'Retry upload correctable.md' })).not.toBeInTheDocument()
    const listCalls = calls.filter((call) => call.phase === 'list').length
    await waitFor(() => expect(calls.filter((call) => call.phase === 'list').length).toBeGreaterThan(listCalls), { timeout: 4000 })
    expect(screen.getByText('Upload pending')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Remove correctable.md' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /^Remove$/ }))
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file('correctable.md', '# corrected 🙂\r\n'))
    expect(await screen.findByRole('button', { name: 'Download correctable.md' })).toBeEnabled()
    expect(screen.queryByText('Upload pending')).not.toBeInTheDocument()
    expect(rows.get(A)!.map((row) => row.file.state)).toEqual(['removed', 'ready'])
    expect(allocations.size).toBe(2)
  })

  it('checks persisted upload status without allocating another file', async () => {
    rows.set(A, [fixture('waiting', A, 'pending')])
    mount()
    await screen.findByText('Upload pending')
    rows.set(A, [fixture('waiting')])
    expect(await screen.findByRole('button', { name: 'Download waiting.md' }, { timeout: 4000 })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Check upload status' })).not.toBeInTheDocument()
    expect(calls.every((call) => call.phase === 'list')).toBe(true)
  })

  it('confirms removal, supports Cancel and backdrop dismissal, and retains the server tombstone', async () => {
    rows.set(A, [fixture('ready')])
    mount()
    const trigger = await screen.findByRole('button', { name: 'Remove ready.md' })
    await userEvent.click(trigger)
    let dialog = screen.getByRole('alertdialog', { name: 'Remove file?' })
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(commandIds).toHaveLength(0)
    await userEvent.click(trigger)
    dialog = screen.getByRole('alertdialog')
    fireEvent.pointerDown(within(dialog).getByText('ready.md'))
    fireEvent.click(dialog) // A drag starting inside is not a backdrop dismissal.
    expect(dialog).toBeVisible()
    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await userEvent.click(trigger)
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /^Remove$/ }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(await screen.findByText('No files.')).toBeVisible()
    expect(rows.get(A)![0].file.state).toBe('removed')
    expect(commandIds).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^Upload$/ })).toHaveFocus()
  })

  it('locks the removal dialog while its request is pending', async () => {
    const gate = deferred()
    rows.set(A, [fixture('ready')])
    server.use(http.delete(paths.remove, async ({ request, params }) => {
      await gate.promise
      return remove(request, String(params.workspaceId), String(params.fileId), String(params.revisionId))
    }))
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove ready.md' }))
    const dialog = screen.getByRole('alertdialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^Remove$/ }))
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    fireEvent.pointerDown(dialog); fireEvent.click(dialog)
    expect(dialog).toBeVisible()
    await act(async () => gate.resolve())
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
  })

  it('downloads the exact pinned revision as an object URL and revokes it', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80, 0xc3, 0x28])
    const base = fixture('ready')
    const row = FileRowSchema.parse({ ...base, revision: { ...base.revision,
      filename: 'archive.zip', mediaType: 'application/zip', byteSize: bytes.byteLength, sha256: hash(bytes) } })
    rows.set(A, [row])
    server.use(http.get(paths.content, () => {
      calls.push({ phase: 'download', workspaceId: A,
        body: { fileId: row.file.fileId, revisionId: row.revision.revisionId } })
      return new HttpResponse(bytes, { headers: { 'Content-Type': row.revision.mediaType } })
    }))
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Download archive.zip' }))
    await waitFor(() => expect(clicked).toHaveLength(1))
    expect(clicked[0].filename).toBe('archive.zip')
    expect(clicked[0].href).toMatch(/^blob:/)
    expect(calls.find((call) => call.phase === 'download')).toEqual({ phase: 'download', workspaceId: A,
      body: { fileId: row.file.fileId, revisionId: row.revision.revisionId } })
    const downloaded = createUrl.mock.calls[0][0]
    expect(downloaded).toBeInstanceOf(Blob)
    if (!(downloaded instanceof Blob)) throw new Error('Expected downloaded Blob')
    expect(new Uint8Array(await readUploadBytes(downloaded, new AbortController().signal))).toEqual(bytes)
    expect(downloaded.size).toBe(bytes.byteLength)
    expect(downloaded.type).toBe('application/octet-stream')
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith(clicked[0].href))
    expect(document.querySelector('a[download]')).toBeNull()
  })

  it.each(['bytes', 'finalize'] as const)('keeps a finishing %s operation in A after navigating to B', async (phase) => {
    const gate = deferred()
    let entered = false
    rows.set(B, [fixture('b-only', B)])
    server.use(phase === 'bytes'
      ? http.put(paths.bytes, async ({ request, params }) => {
        entered = true; await gate.promise
        return putBytes(request, String(params.workspaceId), String(params.requestId))
      })
      : http.post(paths.finalize, async ({ request, params }) => {
        entered = true; await gate.promise
        return finalize(request, String(params.workspaceId), String(params.requestId))
      }))
    const view = mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file('a-upload.md'))
    await waitFor(() => expect(entered).toBe(true))
    view.switchTo(B)
    await screen.findByRole('button', { name: 'Download b-only.md' })
    expect(screen.queryByText('a-upload.md')).not.toBeInTheDocument()
    expect(screen.queryByText('Uploading…')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Upload$/ })).toBeEnabled()
    await act(async () => gate.resolve())
    await waitFor(() => expect(view.queryClient.isMutating()).toBe(0))
    expect(rows.get(A)![0].file.state).toBe('ready')
    expect(rows.get(B)).toHaveLength(1)
    expect(calls.filter((call) => ['allocate', 'bytes', 'finalize'].includes(call.phase)).every((call) => call.workspaceId === A)).toBe(true)
    expect(screen.queryByRole('button', { name: 'Download a-upload.md' })).not.toBeInTheDocument()
    expect(view.queryClient.getQueryData(projectFilesKeys.list(B))).toMatchObject({ pages: [{ items: [fixture('b-only', B)] }] })
    view.switchTo(A)
    expect(await screen.findByRole('button', { name: 'Download a-upload.md' })).toBeVisible()
  })

  it('shows the original pending upload on A → B → A without starting another upload', async () => {
    const gate = deferred()
    let entered = false
    server.use(http.put(paths.bytes, async ({ request, params }) => {
      entered = true; await gate.promise
      return putBytes(request, String(params.workspaceId), String(params.requestId))
    }))
    const view = mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file())
    await waitFor(() => expect(entered).toBe(true))
    view.switchTo(B)
    await screen.findByText('No files.')
    view.switchTo(A)
    expect(await screen.findByRole('status', { name: 'Uploading notes.md' })).toBeVisible()
    expect(screen.getByRole('button', { name: /^Upload$/ })).toBeDisabled()
    await act(async () => gate.resolve())
    await screen.findByRole('button', { name: 'Download notes.md' })
    expect(allocations.size).toBe(1)
  })

  it('does not render a late A list or an A confirmation while B is selected', async () => {
    const gate = deferred()
    let entered = false
    rows.set(A, [fixture('a-only')]); rows.set(B, [fixture('b-only', B)])
    const view = mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove a-only.md' }))
    expect(screen.getByRole('alertdialog')).toBeVisible()
    server.use(http.get(paths.list, async ({ params }) => {
      const workspaceId = String(params.workspaceId)
      if (workspaceId === A) { entered = true; await gate.promise }
      return HttpResponse.json(page(workspaceId))
    }))
    void view.queryClient.invalidateQueries({ queryKey: projectFilesKeys.list(A) })
    await waitFor(() => expect(entered).toBe(true))
    view.switchTo(B)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await screen.findByRole('button', { name: 'Download b-only.md' })
    await act(async () => gate.resolve())
    expect(screen.queryByText('a-only.md')).not.toBeInTheDocument()
    expect(commandIds).toHaveLength(0)
  })

  it('does not retarget a file picker opened in A to B', async () => {
    const view = mount()
    await screen.findByText('No files.')
    const oldInput = picker()
    await userEvent.click(screen.getByRole('button', { name: /^Upload$/ }))
    view.switchTo(B)
    await screen.findByText('No files.')
    fireEvent.change(oldInput, { target: { files: [file('old-picker.md')] } })
    await act(async () => { await Promise.resolve() })
    expect(calls.filter((call) => call.phase === 'allocate' && call.workspaceId === B)).toHaveLength(0)
  })

  it('suppresses a late download after workspace navigation', async () => {
    const gate = deferred()
    let entered = false
    rows.set(A, [fixture('ready')])
    server.use(http.get(paths.content, async ({ params }) => {
      entered = true; await gate.promise
      return content(String(params.workspaceId), String(params.fileId), String(params.revisionId))
    }))
    const view = mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Download ready.md' }))
    await waitFor(() => expect(entered).toBe(true))
    view.switchTo(B)
    await screen.findByText('No files.')
    await act(async () => gate.resolve())
    await waitFor(() => expect(view.queryClient.isMutating()).toBe(0))
    expect(createUrl).not.toHaveBeenCalled()
    expect(clicked).toHaveLength(0)
  })

  it.each(['allocate', 'bytes', 'finalize'] as const)('retries a lost %s acknowledgement with the original request ID', async (phase) => {
    let fail = true
    const intercept = async (result: Promise<Response>) => {
      const response = await result
      if (fail) { fail = false; return failure() }
      return response
    }
    server.use(phase === 'allocate'
      ? http.post(paths.allocate, ({ request, params }) => intercept(allocate(request, String(params.workspaceId))))
      : phase === 'bytes'
        ? http.put(paths.bytes, ({ request, params }) => intercept(putBytes(request, String(params.workspaceId), String(params.requestId))))
        : http.post(paths.finalize, ({ request, params }) => intercept(finalize(request, String(params.workspaceId), String(params.requestId)))))
    const view = mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file())
    expect(await screen.findByText('Upload failed.')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Retry upload notes.md' }))
    await screen.findByRole('button', { name: 'Download notes.md' })
    await waitFor(() => expect(screen.queryByText('Upload failed.')).not.toBeInTheDocument())
    await waitFor(() => expect(view.queryClient.isMutating()).toBe(0))
    const ids = calls.filter((call) => call.phase === 'allocate').map((call) => call.requestId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(1)
    expect(allocations.size).toBe(1)
  })

  it('handles list denial, retry, and download failure without creating an object URL', async () => {
    let fail = true
    rows.set(A, [fixture('ready')])
    server.use(http.get(paths.list, () => fail ? failure(403) : HttpResponse.json(page(A))))
    mount()
    expect(await screen.findByText('Couldn’t load files.')).toBeVisible()
    fail = false
    await userEvent.click(screen.getByRole('button', { name: 'Retry loading project files' }))
    server.use(http.get(paths.content, () => failure(410)))
    await userEvent.click(await screen.findByRole('button', { name: 'Download ready.md' }))
    expect(await screen.findByText('Download failed.')).toBeVisible()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('keeps the command ID and lock after a lost removal acknowledgement', async () => {
    rows.set(A, [fixture('ready')])
    let fail = true
    server.use(http.delete(paths.remove, async ({ request, params }) => {
      const response = await remove(request, String(params.workspaceId), String(params.fileId), String(params.revisionId))
      if (fail) { fail = false; return failure() }
      return response
    }))
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove ready.md' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /^Remove$/ }))
    await screen.findByText('Couldn’t remove file.')
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'Retry removal' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(commandIds).toHaveLength(2)
    expect(commandIds[0]).toBe(commandIds[1])
  })

  it('does not remove B’s same-name file when an A removal finishes after navigation', async () => {
    const gate = deferred()
    let entered = false
    const a = fixture('a', A, 'ready', 'shared.md')
    const b = fixture('b', B, 'ready', 'shared.md')
    rows.set(A, [a]); rows.set(B, [b])
    server.use(http.delete(paths.remove, async ({ request, params }) => {
      entered = true; await gate.promise
      return remove(request, String(params.workspaceId), String(params.fileId), String(params.revisionId))
    }))
    const view = mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Remove shared.md' }))
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /^Remove$/ }))
    await waitFor(() => expect(entered).toBe(true))
    view.switchTo(B)
    await screen.findByRole('button', { name: 'Download shared.md' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await act(async () => gate.resolve())
    await waitFor(() => expect(view.queryClient.isMutating()).toBe(0))
    expect(rows.get(A)![0].file.state).toBe('removed')
    expect(rows.get(B)![0]).toEqual(b)
    expect(calls.filter((call) => call.phase === 'remove')).toHaveLength(1)
    expect(calls.find((call) => call.phase === 'remove')!.workspaceId).toBe(A)
    expect(screen.getByRole('button', { name: 'Download shared.md' })).toBeEnabled()
  })

  it('keeps an upload error in its original workspace, including retry after returning', async () => {
    const gate = deferred()
    let entered = false
    let fail = true
    server.use(http.post(paths.finalize, async ({ request, params }) => {
      entered = true; await gate.promise
      if (fail) { fail = false; return failure() }
      return finalize(request, String(params.workspaceId), String(params.requestId))
    }))
    const view = mount()
    await screen.findByText('No files.')
    await userEvent.upload(picker(), file())
    await waitFor(() => expect(entered).toBe(true))
    view.switchTo(B)
    await screen.findByText('No files.')
    await act(async () => gate.resolve())
    await waitFor(() => expect(view.queryClient.isMutating()).toBe(0))
    expect(screen.queryByText('Upload failed.')).not.toBeInTheDocument()
    view.switchTo(A)
    expect(await screen.findByText('Upload failed.')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Retry upload notes.md' }))
    await screen.findByRole('button', { name: 'Download notes.md' })
    expect(allocations.size).toBe(1)
    expect(calls.filter((call) => call.phase === 'finalize').every((call) => call.workspaceId === A)).toBe(true)
  })

  it('uses bounded pages and accessible full filenames', async () => {
    const longName = `${'project-'.repeat(25)}.md`
    const first = fixture('one', A, 'ready', longName)
    const second = fixture('two')
    server.use(http.get(paths.list, ({ request }) => HttpResponse.json(new URL(request.url).searchParams.has('cursor')
      ? { items: [second], pageInfo: { nextCursor: null } }
      : { items: [first], pageInfo: { nextCursor: 'next-page' } })))
    mount()
    expect(await screen.findByRole('button', { name: `Download ${longName}` })).toBeVisible()
    expect(screen.getByText(longName)).toHaveAttribute('title', longName)
    await userEvent.click(screen.getByRole('button', { name: 'More' }))
    await screen.findByRole('button', { name: 'Download two.md' })
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  it('rejects unsupported and oversized selections before allocation', async () => {
    mount()
    await screen.findByText('No files.')
    const user = userEvent.setup({ applyAccept: false })
    await user.upload(picker(), new File(['<svg/>'], 'active.svg', { type: 'image/svg+xml' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported')
    expect(screen.getByRole('alert')).toHaveTextContent('Choose PNG, JPEG, WebP, GIF, PDF, DOCX, Markdown or ZIP.')
    await user.upload(picker(), new File(['notes'], 'notes.txt', { type: 'text/plain' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported. Choose PNG, JPEG, WebP, GIF, PDF, DOCX, Markdown or ZIP.')
    await user.upload(picker(), new File([new Uint8Array(MAX_FILE_BYTES + 1)], 'large.md', { type: 'text/markdown' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Too large')
    expect(screen.getByRole('alert')).toHaveTextContent('Files must be at most 25 MiB.')
    expect(allocations.size).toBe(0)
  })
})

describe('response identity and immutable-byte validation', () => {
  it('uploads and downloads empty Markdown without treating a zero-byte PUT as a GET', async () => {
    const uploaded = await projectFilesClient.upload({ workspaceId: A, requestId: 'empty-upload-123', file: file('empty.md', '') })
    expect(uploaded.file.state).toBe('ready')
    expect(uploaded.revision.byteSize).toBe(0)
    expect(calls.filter((call) => call.phase === 'bytes')).toHaveLength(1)
    const downloaded = await projectFilesClient.download(A, FileRowSchema.parse(uploaded), new AbortController().signal)
    expect(downloaded.size).toBe(0)
  })

  it.each(['foreign-workspace', 'workflow'] as const)('rejects a %s list instead of displaying it', async (kind) => {
    const row = fixture('foreign', B)
    const scope = kind === 'workflow' ? { kind: 'workflow_reference', workspaceId: A, workflowId: 'workflow-a' } : row.file.scope
    server.use(http.get(paths.list, () => HttpResponse.json({ items: [{ ...row, file: { ...row.file, scope } }], pageInfo: { nextCursor: null } })))
    await expect(projectFilesClient.list(A)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it.each(['bytes', 'finalize'] as const)('rejects substituted revision pins from %s', async (phase) => {
    const swapped = (allocation: Allocation) => envelope(FileRowSchema.parse({ ...allocation.row,
      file: { ...allocation.row.file, currentRevisionId: 'revision-substituted', state: phase === 'finalize' ? 'ready' : 'pending' },
      revision: { ...allocation.row.revision, revisionId: 'revision-substituted' },
    }))
    server.use(phase === 'bytes'
      ? http.put(paths.bytes, async ({ request, params }) => {
        await putBytes(request, String(params.workspaceId), String(params.requestId))
        return swapped(allocations.get(String(params.requestId))!)
      })
      : http.post(paths.finalize, ({ params }) => swapped(allocations.get(String(params.requestId))!)))
    await expect(projectFilesClient.upload({ workspaceId: A, requestId: 'upload-pinned-123', file: file() }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a foreign allocation before transmitting file bytes', async () => {
    server.use(http.post(paths.allocate, async ({ request }) => {
      const input = await request.json() as Metadata
      const foreign = fixture(input.requestId, B, 'pending', input.filename)
      return envelope(FileRowSchema.parse({ ...foreign, revision: { ...foreign.revision,
        byteSize: input.byteSize, sha256: input.sha256 } }))
    }))
    await expect(projectFilesClient.upload({ workspaceId: A, requestId: 'foreign-upload-123', file: file() }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(calls.some((call) => call.phase === 'bytes')).toBe(false)
  })

  it('rejects finalize metadata with a changed hash or non-ready state', async () => {
    for (const mismatch of ['hash', 'pending']) {
      server.use(http.post(paths.finalize, ({ params }) => {
        const row = allocations.get(String(params.requestId))!.row
        return envelope(FileRowSchema.parse({ ...row,
          file: { ...row.file, state: mismatch === 'pending' ? 'pending' : 'ready' },
          revision: { ...row.revision, sha256: mismatch === 'hash' ? '0'.repeat(64) : row.revision.sha256 },
        }))
      }))
      await expect(projectFilesClient.upload({ workspaceId: A, requestId: `bad-finalize-${mismatch}`, file: file() }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })

  it('rejects a download requested with the wrong workspace, non-ready state, or corrupt bytes', async () => {
    const row = fixture('ready')
    rows.set(A, [row])
    const signal = new AbortController().signal
    await expect(projectFilesClient.download(B, row, signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(projectFilesClient.download(A, fixture('pending', A, 'pending'), signal)).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
    expect(calls).toHaveLength(0)
    server.use(http.get(paths.content, () => new HttpResponse(new Uint8Array(contents.byteLength), { headers: { 'Content-Type': 'text/markdown' } })))
    await expect(projectFilesClient.download(A, row, signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects a removal acknowledgement for another revision', async () => {
    const row = fixture('ready')
    server.use(http.delete(paths.remove, () => envelope(fixture('other', A, 'removed'))))
    await expect(projectFilesClient.remove({ workspaceId: A, row, commandId: 'remove-command-123' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('fences an upload after the authenticated session changes, without finalizing in the new session', async () => {
    const gate = deferred()
    let entered = false
    server.use(http.put(paths.bytes, async ({ request, params }) => {
      entered = true; await gate.promise
      return putBytes(request, String(params.workspaceId), String(params.requestId))
    }))
    const outcome = projectFilesClient.upload({ workspaceId: A, requestId: 'session-upload-123', file: file() }).catch((error: unknown) => error)
    await waitFor(() => expect(entered).toBe(true))
    beginSessionChange()
    finishSessionChange()
    gate.resolve()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(calls.some((call) => call.phase === 'finalize')).toBe(false)
  })
})

it('offers idle upload guidance on hover and preserves the empty state', async () => {
  mount()
  expect(await screen.findByText('No files.')).toBeVisible()
  expect(screen.queryByText('Drop a file here or use Upload.')).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Project files' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Drop a file here or use Upload.')
})
