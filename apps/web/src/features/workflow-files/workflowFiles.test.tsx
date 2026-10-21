import { StrictMode } from 'react'
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { HttpResponse, http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileWithRevisionSchema, type FileMediaType, type FileWithRevision, type PermanentFileScope,
} from '@foreman-code/contracts/files'
import { server } from '../../mocks/server'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import { WorkflowFilesButton } from './WorkflowFilesButton'
import { createWorkflowFilesHttpClient, type WorkflowFilesClient } from './workflowFilesClient'
import {
  inheritedReferenceScope, referenceFilesRoot, referenceScopeKey, workflowReferenceScope, type WorkflowFilesIdentity,
} from './workflowFilesModel'

const A = { workspaceId: 'workspace-a', workflowId: 'workflow-a' }
const B = { workspaceId: 'workspace-a', workflowId: 'workflow-b' }
const OtherWorkspace = { workspaceId: 'workspace-b', workflowId: 'workflow-a' }
const workflowPath = '*/api/workspaces/:workspaceId/workflows/:workflowId/reference-files'
const workspacePath = '*/api/workspaces/:workspaceId/reference-files'
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const bytes = (text: string) => new TextEncoder().encode(text).byteLength
const page = (items: FileWithRevision[], nextCursor: string | null = null) => ({ items, pageInfo: { nextCursor } })
const envelope = (value: FileWithRevision) => ({ value, replayed: false })
const failure = () => HttpResponse.json({ error: { code: 'DENIED', message: 'Request denied.' } }, { status: 403 })
let rows: Map<string, FileWithRevision>
let contents: Map<string, string>
let receipts: Map<string, string>
let calls: { step: string; scope: PermanentFileScope; requestId?: string; commandId?: string; fileId?: string; revisionId?: string; body?: string }[]
let failAt: 'allocate' | 'put' | 'finalize' | 'remove' | undefined
let loseFinalizeAck: boolean
let clients: QueryClient[]
let gates: (() => void)[]
let createUrl: ReturnType<typeof vi.fn<typeof URL.createObjectURL>>
let revokeUrl: ReturnType<typeof vi.fn<typeof URL.revokeObjectURL>>
let anchorClick: ReturnType<typeof vi.fn<() => void>>

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  gates.push(release)
  return { promise, release }
}
function scopeFrom(request: Request): PermanentFileScope {
  const match = new URL(request.url).pathname.match(/^\/api\/workspaces\/([^/]+)(?:\/workflows\/([^/]+))?\/reference-files/)
  if (!match) throw new Error('Unexpected reference root')
  const workspaceId = decodeURIComponent(match[1])
  return match[2] ? { kind: 'workflow_reference', workspaceId, workflowId: decodeURIComponent(match[2]) }
    : { kind: 'workspace_reference', workspaceId }
}
function seed(scope: PermanentFileScope, id: string, filename = `${id}.md`, state: 'ready' | 'pending' | 'removed' = 'ready', text = `# ${id}`) {
  const createdAt = '2026-09-28T00:00:00.000Z'
  const row = FileWithRevisionSchema.parse({
    file: { fileId: id, currentRevisionId: `revision-${id}`, scope, state, createdAt },
    revision: { fileId: id, revisionId: `revision-${id}`, filename, mediaType: 'text/markdown',
      byteSize: bytes(text), sha256: hash(text), origin: 'upload', createdAt },
  })
  rows.set(id, row); contents.set(id, text)
  return row
}
function matching(scope: PermanentFileScope) {
  return [...rows.values()].filter(({ file }) => file.scope.kind !== 'temporary' && file.scope.kind!=='job_execution'
    && referenceScopeKey(file.scope) === referenceScopeKey(scope))
}
interface AllocationBody { requestId: string; filename: string; mediaType: FileMediaType; byteSize: number; sha256: string }
async function allocate(request: Request) {
  const scope = scopeFrom(request)
  const input = await request.json() as AllocationBody
  expect(Object.keys(input).sort()).toEqual(['byteSize', 'filename', 'mediaType', 'requestId', 'sha256'])
  calls.push({ step: 'allocate', scope, requestId: input.requestId })
  if (failAt === 'allocate') return failure()
  const previous = receipts.get(input.requestId)
  if (previous) return HttpResponse.json({ value: rows.get(previous), replayed: true })
  const row = seed(scope, `upload-${input.requestId}`, input.filename, 'pending', '')
  const value = FileWithRevisionSchema.parse({ ...row, revision: { ...row.revision,
    mediaType: input.mediaType, byteSize: input.byteSize, sha256: input.sha256 } })
  rows.set(value.file.fileId, value); receipts.set(input.requestId, value.file.fileId)
  return HttpResponse.json(envelope(value), { status: 201 })
}
async function put(request: Request, requestId: string) {
  const scope = scopeFrom(request)
  expect(request.headers.get('content-type')).toBe('application/octet-stream')
  const text = await request.text()
  calls.push({ step: 'put', scope, requestId, body: text })
  if (failAt === 'put') return failure()
  const id = receipts.get(requestId)!
  const row = rows.get(id)!
  expect(row.revision.byteSize).toBe(bytes(text))
  expect(row.revision.sha256).toBe(hash(text))
  contents.set(id, text)
  return HttpResponse.json(envelope(row))
}
async function finalize(request: Request, requestId: string) {
  expect(await request.json()).toEqual({})
  calls.push({ step: 'finalize', scope: scopeFrom(request), requestId })
  if (failAt === 'finalize') return failure()
  const id = receipts.get(requestId)!
  const row = rows.get(id)!
  const value = { ...row, file: { ...row.file, state: 'ready' as const } }
  rows.set(id, value)
  if (loseFinalizeAck) return failure()
  return HttpResponse.json(envelope(value))
}
function mount(identity: WorkflowFilesIdentity = A, client: WorkflowFilesClient = createWorkflowFilesHttpClient(), readOnly = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  clients.push(queryClient)
  const tree = (current: WorkflowFilesIdentity) => <StrictMode><QueryClientProvider client={queryClient}>
    <div style={{ width: 320 }}><WorkflowFilesButton {...current} client={client} readOnly={readOnly} /></div>
    <button type="button">Elsewhere</button>
  </QueryClientProvider></StrictMode>
  const view = render(tree(identity))
  return { ...view, user: userEvent.setup({ applyAccept: false }), select: (current: WorkflowFilesIdentity) => view.rerender(tree(current)) }
}
async function open(view: ReturnType<typeof mount>) {
  await view.user.click(screen.getByRole('button', { name: 'Files' }))
  return screen.findByRole('dialog', { name: 'Files' })
}
const workflowGroup = () => screen.getByRole('group', { name: 'Workflow files' })
const workspaceGroup = () => screen.getByRole('group', { name: 'Inherited workspace files' })
async function pick(view: ReturnType<typeof mount>, filename = 'new.md', text = '# new') {
  await view.user.upload(screen.getByLabelText('Choose workflow file'), new File([text], filename, { type: 'text/markdown' }))
}

beforeEach(() => {
  rows = new Map(); contents = new Map(); receipts = new Map(); calls = []; clients = []; gates = []
  failAt = undefined; loseFinalizeAck = false
  seed(workflowReferenceScope(A), 'alpha')
  seed(workflowReferenceScope(B), 'beta')
  seed(inheritedReferenceScope(A), 'shared')
  seed(workflowReferenceScope(OtherWorkspace), 'other')
  seed(inheritedReferenceScope(OtherWorkspace), 'other-shared')
  createUrl = vi.fn<typeof URL.createObjectURL>(() => 'blob:reference-file')
  revokeUrl = vi.fn<typeof URL.revokeObjectURL>()
  const OriginalURL = globalThis.URL
  vi.stubGlobal('URL', class extends OriginalURL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl })
  vi.stubGlobal('crypto', { subtle: webcrypto.subtle, randomUUID: crypto.randomUUID.bind(crypto) })
  anchorClick = vi.fn<() => void>()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(anchorClick)
  server.use(
    ...[workflowPath, workspacePath].map((path) => http.get(path, ({ request }) => {
      const scope = scopeFrom(request)
      calls.push({ step: 'list', scope })
      expect(new URL(request.url).searchParams.get('limit')).toBe('25')
      return HttpResponse.json(page(matching(scope)))
    })),
    http.post(`${workflowPath}/uploads`, ({ request }) => allocate(request)),
    http.put(`${workflowPath}/uploads/:requestId`, ({ request, params }) => put(request, String(params.requestId))),
    http.post(`${workflowPath}/uploads/:requestId/finalize`, ({ request, params }) => finalize(request, String(params.requestId))),
    http.delete(`${workflowPath}/:fileId/revisions/:revisionId`, async ({ request, params }) => {
      const { commandId } = await request.json() as { commandId: string }
      calls.push({ step: 'remove', scope: scopeFrom(request), commandId,
        fileId: String(params.fileId), revisionId: String(params.revisionId) })
      if (failAt === 'remove') return failure()
      const row = rows.get(String(params.fileId))!
      const value = { ...row, file: { ...row.file, state: 'removed' as const } }
      rows.set(value.file.fileId, value)
      return HttpResponse.json(envelope(value))
    }),
    ...[workflowPath, workspacePath].map((path) => http.get(`${path}/:fileId/revisions/:revisionId/content`, ({ request, params }) => {
      calls.push({ step: 'download', scope: scopeFrom(request), fileId: String(params.fileId), revisionId: String(params.revisionId) })
      const row = rows.get(String(params.fileId))!
      expect(String(params.revisionId)).toBe(row.revision.revisionId)
      return new HttpResponse(contents.get(row.file.fileId), { headers: { 'Content-Type': row.revision.mediaType,
        'Content-Length': String(row.revision.byteSize) } })
    })),
  )
})
afterEach(async () => {
  cleanup()
  for (const release of gates) release()
  await act(async () => { await Promise.resolve() })
  for (const client of clients) client.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Board workflow reference files (real client + MSW)', () => {
  it('pages past removed inherited references to download the later ready revision', async () => {
    rows.clear()
    const removed = Array.from({ length: 25 }, (_, index) =>
      seed(inheritedReferenceScope(A), `removed-${index}`, `removed-${index}.md`, 'removed'))
    const ready = seed(inheritedReferenceScope(A), 'later', 'later.md')
    const cursors: (string | null)[] = []
    server.use(http.get(workspacePath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      cursors.push(cursor)
      return HttpResponse.json(cursor ? page([ready]) : page(removed, 'after-removed'))
    }))
    const view = mount()
    await open(view)
    const more = await screen.findByRole('button', { name: 'More workspace files' })
    expect(within(workspaceGroup()).queryByText('removed-0.md')).not.toBeInTheDocument()
    await view.user.click(more)
    await view.user.click(await screen.findByRole('button', { name: 'Download later.md' }))
    await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce())
    expect(cursors).toEqual([null, 'after-removed'])
    expect(calls).toContainEqual({ step: 'download', scope: inheritedReferenceScope(A),
      fileId: ready.file.fileId, revisionId: ready.revision.revisionId })
    expect(screen.queryByRole('button', { name: 'More workspace files' })).not.toBeInTheDocument()
  })

  it('does not open a hover popup or fetch files until explicitly selected, including with the keyboard', async () => {
    const view = mount()
    const trigger = screen.getByRole('button', { name: 'Files' })
    await view.user.hover(trigger)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(calls).toHaveLength(0)
    await view.user.unhover(trigger)
    act(() => { trigger.focus() })
    expect(calls).toHaveLength(0)
    await view.user.keyboard('{Enter}')
    await screen.findByText('alpha.md')
    expect(screen.getByRole('dialog', { name: 'Files' })).toBeInTheDocument()
    await view.user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    await view.user.keyboard(' ')
    expect(await screen.findByRole('dialog', { name: 'Files' })).toBeInTheDocument()
  })

  it('uses a plus action for the hidden computer picker without raw chooser or repeated workflow copy', async () => {
    rows.clear()
    const view = mount(); const dialog = await open(view)
    await screen.findByText('Drop a file here')
    expect(within(dialog).queryByText('Workflow')).not.toBeInTheDocument()
    expect(within(dialog).getByText('Choose workflow file')).not.toBeVisible()
    expect(within(dialog).queryByText('No files')).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Drop a file here or use Upload.')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('group', { name: 'Inherited workspace files' })).not.toBeInTheDocument()
    const picker = screen.getByLabelText('Choose workflow file')
    expect(picker).toHaveAttribute('hidden')
    const click = vi.spyOn(picker, 'click')
    const add = within(dialog).getByRole('button', { name: 'Add file' })
    act(() => { add.focus() })
    await view.user.keyboard('{Enter}')
    expect(click).toHaveBeenCalledTimes(1)
    await pick(view, 'computer.md', '# computer picker')
    await within(workflowGroup()).findByText('computer.md')
    expect(within(dialog).queryByText('Drop a file here')).not.toBeInTheDocument()
  })

  it('keeps a drag that starts inside the file area from dismissing the files view', async () => {
    const view = mount(); const dialog = await open(view)
    const outside = screen.getByRole('button', { name: 'Elsewhere' })
    fireEvent.pointerDown(workflowGroup())
    fireEvent.click(outside)
    expect(dialog).toBeInTheDocument()
    fireEvent.pointerDown(outside)
    fireEvent.click(outside)
    expect(screen.queryByRole('dialog', { name: 'Files' })).not.toBeInTheDocument()
  })

  it('accepts a drop anywhere in the workflow file area and exposes removal in the same files view', async () => {
    const view = mount(); await open(view)
    const area = workflowGroup()
    const transfer = { types: ['Files'], files: [new File(['# whole area'], 'area.md', { type: 'text/markdown' })] }
    fireEvent.dragEnter(area, { dataTransfer: transfer })
    expect(area).toHaveAttribute('data-file-dragging', 'true')
    fireEvent.drop(area, { dataTransfer: transfer })
    await within(area).findByRole('button', { name: 'Remove area.md' })
    expect(area).not.toHaveAttribute('data-file-dragging')
    const remove = within(area).getByRole('button', { name: 'Remove area.md' })
    expect(remove).toHaveClass('resource-trash-button')
    await view.user.click(remove)
    const confirmation = await screen.findByRole('alertdialog', { name: 'Remove file?' })
    await view.user.click(within(confirmation).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(within(workflowGroup()).queryByText('area.md')).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: 'Files' })).toBeInTheDocument()
    expect([...rows.values()].find((row) => row.revision.filename === 'area.md')?.file.state).toBe('removed')
  })

  it('drops into workflow scope through allocation, bytes and finalization while keeping inherited files read-only', async () => {
    const view = mount(); await open(view)
    const file = new File(['# dropped'], 'dropped.md', { type: 'text/markdown' })
    const dataTransfer = { types: ['Files'], files: [file] }
    fireEvent.drop(workspaceGroup(), { dataTransfer })
    expect(calls.filter((call) => call.step === 'allocate')).toHaveLength(0)
    fireEvent.drop(workflowGroup(), { dataTransfer })
    await within(workflowGroup()).findByText('dropped.md')
    await waitFor(() => expect(calls.filter((call) => call.step === 'finalize')).toHaveLength(1))
    expect(calls.filter((call) => ['allocate', 'put', 'finalize'].includes(call.step)).map((call) => call.scope)).toEqual(
      [workflowReferenceScope(A), workflowReferenceScope(A), workflowReferenceScope(A)])
    expect(contents.get([...receipts.values()][0])).toBe('# dropped')
  })

  it('rejects multi-file drops rather than losing files and blocks read-only writes', async () => {
    const view = mount(); await open(view)
    const file = new File(['# one'], 'one.md', { type: 'text/markdown' })
    fireEvent.drop(workflowGroup(), { dataTransfer: { types: ['Files'], files: [file, file] } })
    expect(screen.getByRole('alert')).toHaveTextContent('one file at a time')
    expect(calls.filter((call) => call.step === 'allocate')).toHaveLength(0)
    cleanup()
    const readOnly = mount(A, createWorkflowFilesHttpClient(), true); await open(readOnly)
    fireEvent.drop(workflowGroup(), { dataTransfer: { types: ['Files'], files: [file] } })
    expect(calls.filter((call) => call.step === 'allocate')).toHaveLength(0)
  })
  it('is compact, labelled, lazy, and keyboard dismissible with focus return', async () => {
    const view = mount()
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-expanded', 'false')
    expect(calls).toHaveLength(0)
    const dialog = await open(view)
    await screen.findByText('alpha.md')
    expect(screen.getByRole('button', { name: 'Files' })).toHaveAttribute('title', 'Files')
    // The shared positioning helper clamps to 12px viewport gutters at 320px.
    vi.stubGlobal('innerWidth', 320)
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(parseFloat(dialog.style.width)).toBeLessThanOrEqual(296)
    act(() => { dialog.focus() })
    await view.user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Files' })).not.toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Files' })).toHaveFocus()
  })

  it('drops A immediately on A/B switch; a late A result cannot render in loading B', async () => {
    const a = deferred(); const b = deferred()
    let aRead = false; let bRead = false
    const real = createWorkflowFilesHttpClient()
    const client: WorkflowFilesClient = { ...real, list: async (scope, cursor, signal) => {
      const result = await real.list(scope, cursor, signal)
      if (scope.kind === 'workflow_reference') {
        if (scope.workflowId === A.workflowId) { aRead = true; await a.promise }
        else { bRead = true; await b.promise }
      }
      return result // Deliberately ignores an abort after HTTP completion.
    } }
    const view = mount(A, client)
    await open(view)
    await waitFor(() => expect(aRead).toBe(true))
    view.select(B)
    expect(screen.queryByRole('dialog', { name: 'Files' })).not.toBeInTheDocument()
    await open(view)
    await waitFor(() => expect(bRead).toBe(true))
    await act(async () => { a.release(); await a.promise })
    expect(within(workflowGroup()).getByRole('status')).toHaveTextContent('Loading')
    expect(screen.queryByText('alpha.md')).not.toBeInTheDocument()
    await act(async () => { b.release(); await b.promise })
    await screen.findByText('beta.md')
    expect(screen.queryByText('alpha.md')).not.toBeInTheDocument()
  })

  it('also separates workspaces when the workflow ID is the same', async () => {
    const view = mount()
    await open(view); await screen.findByText('alpha.md'); await screen.findByText('shared.md')
    view.select(OtherWorkspace)
    await open(view); await screen.findByText('other.md'); await screen.findByText('other-shared.md')
    expect(screen.queryByText('alpha.md')).not.toBeInTheDocument()
    expect(screen.queryByText('shared.md')).not.toBeInTheDocument()
  })

  it('keeps equal filenames distinct and inherited files strictly download-only', async () => {
    rows.clear()
    const own = seed(workflowReferenceScope(A), 'own', 'same.md', 'ready', '# workflow')
    const inherited = seed(inheritedReferenceScope(A), 'inherited', 'same.md', 'ready', '# workspace')
    const view = mount(); await open(view)
    await waitFor(() => expect(screen.getAllByText('same.md')).toHaveLength(2))
    expect(within(workspaceGroup()).queryByRole('button', { name: /remove|upload|edit|overwrite/i })).not.toBeInTheDocument()
    expect(within(workspaceGroup()).getAllByRole('button')).toHaveLength(1)
    await view.user.click(within(workflowGroup()).getByRole('button', { name: 'Download same.md' }))
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(within(workspaceGroup()).getByRole('button', { name: 'Download same.md' })).toBeEnabled())
    await view.user.click(within(workspaceGroup()).getByRole('button', { name: 'Download same.md' }))
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(2))
    expect(calls.filter((call) => call.step === 'download')).toEqual([
      { step: 'download', scope: own.file.scope, fileId: own.file.fileId, revisionId: own.revision.revisionId },
      { step: 'download', scope: inherited.file.scope, fileId: inherited.file.fileId, revisionId: inherited.revision.revisionId },
    ])
    await waitFor(() => expect(revokeUrl).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/expir|7 days/i)).not.toBeInTheDocument()
  })

  it('does not offer downloads for pending or removed references, or expiry/edit UI', async () => {
    seed(workflowReferenceScope(A), 'pending', 'pending.md', 'pending')
    seed(workflowReferenceScope(A), 'removed', 'removed.md', 'removed')
    const view = mount(); await open(view); await screen.findByText('pending.md')
    expect(screen.queryByRole('button', { name: 'Download pending.md' })).not.toBeInTheDocument()
    expect(screen.queryByText('removed.md')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit|overwrite/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/expir|7 days/i)).not.toBeInTheDocument()
  })

  it.each(['allocate', 'put', 'finalize'] as const)('retries a %s failure with the same request ID and exact raw bytes', async (step) => {
    failAt = step
    const view = mount(); await open(view)
    await pick(view, 'retry.md', '# immutable bytes')
    await screen.findByText('Upload failed')
    expect(screen.queryByRole('button', { name: 'Download retry.md' })).not.toBeInTheDocument()
    failAt = undefined
    await view.user.click(screen.getByRole('button', { name: 'Retry upload' }))
    await screen.findByRole('button', { name: 'Download retry.md' })
    const attempts = calls.filter((call) => call.step === 'allocate')
    expect(attempts).toHaveLength(2)
    expect(attempts[0].requestId).toBe(attempts[1].requestId)
    expect(calls.filter((call) => call.step === 'put').every((call) => call.body === '# immutable bytes')).toBe(true)
    expect(calls.filter((call) => call.step !== 'list').every((call) => referenceScopeKey(call.scope) === referenceScopeKey(workflowReferenceScope(A)))).toBe(true)
    expect(screen.queryByText('Upload failed')).not.toBeInTheDocument()
  })

  it('treats a lost finalize acknowledgement as the same upload, not a duplicate', async () => {
    loseFinalizeAck = true
    const view = mount(); await open(view); await pick(view)
    await screen.findByText('Upload failed')
    loseFinalizeAck = false
    await view.user.click(screen.getByRole('button', { name: 'Retry upload' }))
    await waitFor(() => expect(screen.queryByText('Upload failed')).not.toBeInTheDocument())
    expect(calls.filter((call) => call.step === 'put')).toHaveLength(1)
    expect(calls.filter((call) => call.step === 'finalize')).toHaveLength(1)
    expect(matching(workflowReferenceScope(A)).filter((row) => row.revision.filename === 'new.md')).toHaveLength(1)
  })

  it('waits for finalize before exposing an uploaded download', async () => {
    const gate = deferred()
    server.use(http.post(`${workflowPath}/uploads/:requestId/finalize`, async ({ request, params }) => {
      await gate.promise
      return finalize(request, String(params.requestId))
    }))
    const view = mount(); await open(view); await pick(view)
    await waitFor(() => expect(calls.some((call) => call.step === 'put')).toBe(true))
    expect(screen.getByText('Uploading…')).toHaveAttribute('role', 'status')
    expect(screen.getByRole('button', { name: 'Add file' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Download new.md' })).not.toBeInTheDocument()
    gate.release()
    await screen.findByRole('button', { name: 'Download new.md' })
  })

  it('does not finalize a late A upload or transfer its status into B', async () => {
    const gate = deferred()
    server.use(http.put(`${workflowPath}/uploads/:requestId`, async ({ request, params }) => {
      const response = await put(request, String(params.requestId))
      await gate.promise
      return response
    }))
    const view = mount(); await open(view); await pick(view, 'only-a.md')
    await waitFor(() => expect(calls.some((call) => call.step === 'put')).toBe(true))
    view.select(B); await open(view); await screen.findByText('beta.md')
    await act(async () => { gate.release(); await gate.promise })
    expect(screen.queryByText('only-a.md')).not.toBeInTheDocument()
    expect(screen.queryByText('Upload failed')).not.toBeInTheDocument()
    expect(calls.filter((call) => call.step === 'finalize')).toHaveLength(0)
  })

  it('confirms removal, retains the row on failure, and retries the same pinned command', async () => {
    failAt = 'remove'
    const view = mount(); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'Remove alpha.md' }))
    expect(calls.filter((call) => call.step === 'remove')).toHaveLength(0)
    const confirmation = await screen.findByRole('alertdialog', { name: 'Remove file?' })
    await view.user.click(within(confirmation).getByRole('button', { name: 'Remove' }))
    await within(confirmation).findByText('Remove failed')
    expect(rows.get('alpha')!.file.state).toBe('ready')
    failAt = undefined
    await view.user.click(within(confirmation).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    await waitFor(() => expect(within(workflowGroup()).queryByText('alpha.md')).not.toBeInTheDocument())
    const attempts = calls.filter((call) => call.step === 'remove')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual(attempts[1])
    expect(attempts[0]).toMatchObject({ fileId: 'alpha', revisionId: 'revision-alpha', scope: workflowReferenceScope(A) })
  })

  it('removes only the selected ID when two workflow files have the same name', async () => {
    rows.clear()
    seed(workflowReferenceScope(A), 'one', 'same.md')
    seed(workflowReferenceScope(A), 'two', 'same.md')
    const view = mount(); await open(view)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove same.md' })).toHaveLength(2))
    await view.user.click(screen.getAllByRole('button', { name: 'Remove same.md' })[0])
    const confirm = await screen.findByRole('alertdialog')
    await view.user.click(within(confirm).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(within(workflowGroup()).getAllByText('same.md')).toHaveLength(1)
    expect(rows.get('one')!.file.state).toBe('removed')
    expect(rows.get('two')!.file.state).toBe('ready')
  })

  it('uses shared backdrop confirmation semantics and never removes on cancel', async () => {
    const view = mount(); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'Remove alpha.md' }))
    const dialog = await screen.findByRole('alertdialog')
    await view.user.click(within(dialog).getByText('alpha.md'))
    expect(dialog).toBeInTheDocument()
    await view.user.click(dialog)
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(calls.filter((call) => call.step === 'remove')).toHaveLength(0)
  })

  it('keeps independent paging, including equal names and overlapping pages', async () => {
    const first = seed(workflowReferenceScope(A), 'first', 'same.md')
    const second = seed(workflowReferenceScope(A), 'second', 'same.md')
    const requested: (string | null)[] = []
    server.use(http.get(workflowPath, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor')
      requested.push(cursor)
      return HttpResponse.json(cursor ? page([first, second]) : page([first], 'opaque+/='))
    }))
    const view = mount(); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'More workflow files' }))
    await waitFor(() => expect(within(workflowGroup()).getAllByText('same.md')).toHaveLength(2))
    expect(requested).toEqual([null, 'opaque+/='])
    expect(screen.queryByRole('button', { name: 'More workflow files' })).not.toBeInTheDocument()
    expect(within(workspaceGroup()).getByText('shared.md')).toBeInTheDocument()
  })

  it('isolates read errors and rejects a foreign-scope list response', async () => {
    server.use(http.get(workflowPath, () => HttpResponse.json(page([rows.get('beta')!]))))
    const view = mount(); await open(view)
    await within(workflowGroup()).findByRole('alert')
    expect(screen.queryByText('beta.md')).not.toBeInTheDocument()
    expect(await within(workspaceGroup()).findByText('shared.md')).toBeInTheDocument()
    server.use(http.get(workflowPath, () => HttpResponse.json(page([rows.get('alpha')!]))))
    await view.user.click(screen.getByRole('button', { name: 'Retry workflow files' }))
    await within(workflowGroup()).findByText('alpha.md')
  })

  it('rejects unsupported files before allocating and supports read-only hosts', async () => {
    const view = mount(); await open(view); await pick(view, 'unsafe.svg', '<svg/>')
    await screen.findByText('Unsupported')
    expect(calls.filter((call) => call.step === 'allocate')).toHaveLength(0)
    view.unmount()
    const readOnly = mount(A, createWorkflowFilesHttpClient(), true)
    await open(readOnly); await screen.findByText('alpha.md')
    expect(screen.queryByRole('button', { name: /upload|remove/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Download alpha.md' })).toBeEnabled()
  })

  it('suppresses a download that completes after switching boards, even if the client ignores abort', async () => {
    const gate = deferred(); let downloaded = false
    const real = createWorkflowFilesHttpClient()
    const client: WorkflowFilesClient = { ...real, download: async (input) => {
      const blob = await real.download(input); downloaded = true; await gate.promise; return blob
    } }
    const view = mount(A, client); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'Download alpha.md' }))
    await waitFor(() => expect(downloaded).toBe(true))
    view.select(B); await open(view)
    await act(async () => { gate.release(); await gate.promise })
    await screen.findByText('beta.md')
    expect(anchorClick).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('suppresses a download after an Operator session change', async () => {
    const gate = deferred(); let downloaded = false
    const real = createWorkflowFilesHttpClient()
    const client: WorkflowFilesClient = { ...real, download: async (input) => {
      const blob = await real.download(input); downloaded = true; await gate.promise; return blob
    } }
    const view = mount(A, client); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'Download alpha.md' }))
    await waitFor(() => expect(downloaded).toBe(true))
    try {
      act(() => { beginSessionChange() })
      await act(async () => { gate.release(); await gate.promise })
      expect(anchorClick).not.toHaveBeenCalled()
    } finally { act(() => { finishSessionChange() }) }
  })
})

describe('reference HTTP boundary rejection paths', () => {
  it('rejects a different revision returned by finalize', async () => {
    server.use(http.post(`${workflowPath}/uploads/:requestId/finalize`, ({ params }) => {
      const row = rows.get(receipts.get(String(params.requestId))!)!
      return HttpResponse.json(envelope({ ...row, file: { ...row.file, state: 'ready', currentRevisionId: 'foreign-revision' },
        revision: { ...row.revision, revisionId: 'foreign-revision' } }))
    }))
    const client = createWorkflowFilesHttpClient()
    await expect(client.upload({ scope: workflowReferenceScope(A), requestId: 'upload-pin-test',
      file: new File(['# test'], 'test.md', { type: 'text/markdown' }), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects changed hashes returned by finalize, even with the correct pins', async () => {
    server.use(http.post(`${workflowPath}/uploads/:requestId/finalize`, ({ params }) => {
      const row = rows.get(receipts.get(String(params.requestId))!)!
      return HttpResponse.json(envelope({ ...row, file: { ...row.file, state: 'ready' },
        revision: { ...row.revision, sha256: '0'.repeat(64) } }))
    }))
    await expect(createWorkflowFilesHttpClient().upload({ scope: workflowReferenceScope(A), requestId: 'upload-hash-test',
      file: new File(['# test'], 'test.md', { type: 'text/markdown' }), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('rejects writes to inherited scope at runtime, not only through hidden controls', async () => {
    const client = createWorkflowFilesHttpClient()
    const scope = inheritedReferenceScope(A) as unknown as ReturnType<typeof workflowReferenceScope>
    await expect(client.upload({ scope, requestId: 'inherited-upload', file: new File(['# test'], 'test.md'),
      signal: new AbortController().signal })).rejects.toThrow()
    await expect(client.remove({ scope, commandId: 'inherited-remove', ref: { fileId: 'shared', revisionId: 'revision-shared' },
      signal: new AbortController().signal })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  it('does not make byte requests for pending or foreign-scope rows', async () => {
    const pending = seed(workflowReferenceScope(A), 'pending', 'pending.md', 'pending')
    const client = createWorkflowFilesHttpClient()
    await expect(client.download({ scope: workflowReferenceScope(A), row: pending,
      signal: new AbortController().signal })).rejects.toMatchObject({ code: 'FILE_UNAVAILABLE' })
    await expect(client.download({ scope: workflowReferenceScope(B), row: rows.get('alpha')!,
      signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(calls).toHaveLength(0)
  })

  it('rejects corrupt download bytes rather than saving them', async () => {
    const row = rows.get('alpha')!
    const path = `${referenceFilesRoot(workflowReferenceScope(A))}/alpha/revisions/revision-alpha/content`
    server.use(http.get(`*${path}`, () => new HttpResponse('x'.repeat(row.revision.byteSize), {
      headers: { 'Content-Type': 'text/markdown' },
    })))
    await expect(createWorkflowFilesHttpClient().download({ scope: workflowReferenceScope(A), row,
      signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('reports a revoked/unavailable download without opening or saving content', async () => {
    server.use(http.get(`${workflowPath}/:fileId/revisions/:revisionId/content`, () => failure()))
    const view = mount(); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'Download alpha.md' }))
    await screen.findByText('Download failed')
    expect(anchorClick).not.toHaveBeenCalled()
    expect(createUrl).not.toHaveBeenCalled()
  })

  it('discards an A removal confirmation when the Board switches to B', async () => {
    const view = mount(); await open(view)
    await view.user.click(await screen.findByRole('button', { name: 'Remove alpha.md' }))
    await screen.findByRole('alertdialog')
    view.select(B)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    await open(view); await screen.findByText('beta.md')
    expect(calls.filter((call) => call.step === 'remove')).toHaveLength(0)
  })
})
