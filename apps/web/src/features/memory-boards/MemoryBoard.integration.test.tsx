// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { useState, type ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemoryBoardMutation, MemoryCardWorkBinding, AgentNodeRef } from '@foreman-code/contracts'
import { ApiError } from '../../shared/api/client'
import { MemoryBoard, type MemoryBoardProps } from './MemoryBoard'
import { MemoryBoardDialog } from './MemoryBoardDialog'
import { MemoryBoardAccessField } from './MemoryBoardAccessField'
import { useMemoryDrafts } from './drafts'
import { memoryToolNames } from './access'
import { createMemoryTestPort, memoryTestCard, memoryTestIds, memoryTestNote, memoryTestTime } from './testing'
import type { MemoryChange, MemoryFilters, MemoryNodeOption, MemoryReceipt } from './ports'

let cache: QueryClient
let fixture: ReturnType<typeof createMemoryTestPort>
let originalLocks: PropertyDescriptor | undefined
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={cache}>{children}</QueryClientProvider> }
function Harness({ initialCardId, ...overrides }: Partial<MemoryBoardProps> & { initialCardId?: string }) {
  const [filters, setFilters] = useState<MemoryFilters>({ query: '', doneOpen: false })
  const [cardId, setCardId] = useState(initialCardId)
  return <MemoryBoard client={fixture.port} scope={fixture.board.scope} scopeName="Design workspace" canWrite nodes={[]}
    filters={filters} onFiltersChange={setFilters} selectedCardId={cardId} onSelectCard={setCardId} onOpenWork={() => undefined} {...overrides} />
}
function mutationCalls(): MemoryBoardMutation[] {
  return fixture.calls.filter((call) => call.method === 'mutate').map((call) => call.value as MemoryBoardMutation)
}
async function ready() { await waitFor(() => expect(screen.getByRole('button', { name: 'Add card' })).toBeEnabled()) }
beforeEach(() => {
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } })
  fixture = createMemoryTestPort()
  vi.stubGlobal('crypto', webcrypto)
  originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, callback: () => unknown) => callback() } })
  localStorage.clear()
  useMemoryDrafts.setState({ entries: {} })
})
afterEach(() => {
  cleanup(); cache.clear(); localStorage.clear()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})

describe('visible memory boards and editing', () => {
  it('does no memory work while hidden and releases its one visible stream when closed', async () => {
    const view = render(<Harness visible={false} />, { wrapper })
    expect(fixture.calls).toEqual([])
    view.rerender(<Harness />)
    await ready()
    expect(fixture.calls.filter((call) => call.method === 'subscribe')).toHaveLength(1)
    const subscribe = fixture.calls.findIndex((call) => call.method === 'subscribe')
    expect(fixture.calls.findIndex((call) => call.method === 'board')).toBeGreaterThan(subscribe)
    view.rerender(<Harness visible={false} />)
    expect(fixture.calls.filter((call) => call.method === 'unsubscribe')).toHaveLength(1)
  })
  it('keeps all five columns visible and fetches Done only after it is requested', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ status: 'done', completionKind: 'dropped', reason: 'Superseded by the release plan.' })] })
    const user = userEvent.setup()
    render(<Harness />, { wrapper }); await ready()
    for (const label of ['Todo', 'Doing', 'Waiting for user', 'Blocked', 'Done']) expect(screen.getByRole('region', { name: label })).toBeInTheDocument()
    expect(fixture.calls.filter((call) => call.method === 'cards')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Show Done' }))
    const card = await within(screen.getByRole('region', { name: 'Done' })).findByRole('article')
    expect(within(card).getByText('Dropped')).toBeInTheDocument()
    expect(screen.getByText('Superseded by the release plan.')).toBeInTheDocument()
    expect(fixture.calls.filter((call) => call.method === 'cards')).toHaveLength(1)
  })
  it('shows a card waiting for the user in its own column with what the user must do, and lets the owner move it on', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ title: 'Buy the domain', status: 'waiting_for_user', reason: 'Pay on the checkout page.' })] })
    const user = userEvent.setup()
    render(<Harness />, { wrapper }); await ready()
    const column = screen.getByRole('region', { name: 'Waiting for user' })
    const card = await within(column).findByRole('article')
    expect(within(card).getByText('Needs you')).toBeVisible()
    expect(within(card).getByText('Pay on the checkout page.')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Todo' })).queryByRole('article')).not.toBeInTheDocument()
    await user.click(within(card).getByRole('button', { name: 'Buy the domain' }))
    expect(await screen.findByText('What you need to do:')).toBeVisible()
  })
  it('requires a user instruction before moving a card to Waiting for user', async () => {
    fixture = createMemoryTestPort({ cards: [] })
    const user = userEvent.setup()
    render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Approve the purchase')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Move to…' }), 'waiting_for_user')
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    expect(mutationCalls()).toHaveLength(0)
    await user.type(screen.getByRole('textbox', { name: 'What does the user need to do?' }), 'Confirm the card payment.')
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    await waitFor(() => expect(mutationCalls()).toMatchObject([{ kind: 'card_create',
      card: { title: 'Approve the purchase', status: 'waiting_for_user', reason: 'Confirm the card payment.' } }]))
  })
  it('appends deliberately requested pages beyond five and resets a live refresh to one bounded page', async () => {
    fixture = createMemoryTestPort({ cards: Array.from({ length: 121 }, (_, index) => memoryTestCard({ id: `card-${index}`, title: `Page task ${index}` })) })
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    const column = within(screen.getByRole('region', { name: 'Todo' }))
    for (let page = 0; page < 6; page++) {
      await user.click(column.getByRole('button', { name: 'Load more Todo' }))
      await waitFor(() => expect(column.getAllByRole('button', { name: /^Page task / })).toHaveLength(Math.min(121, (page + 2) * 20)))
    }
    expect(column.getByRole('button', { name: 'Page task 0' })).toBeInTheDocument()
    expect(column.getByRole('button', { name: 'Page task 120' })).toBeInTheDocument()
    const before = fixture.calls.filter((call) => call.method === 'cards').length
    fixture.board.revision = 2
    act(() => fixture.emit({ id: 'changed', boardId: fixture.board.id, sequence: 2, boardRevision: 2, entity: 'card', entityId: 'card-0', entityRevision: 2,
      actor: { kind: 'operator', id: 'operator', displayName: 'Operator' }, occurredAt: memoryTestTime }))
    await waitFor(() => expect(fixture.calls.filter((call) => call.method === 'cards').length).toBeGreaterThan(before))
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    const reads = fixture.calls.filter((call) => call.method === 'cards').slice(before)
    // One bounded first page per open column: Todo, Doing, Waiting for user and Blocked.
    expect(reads).toHaveLength(4)
    expect(reads.every((call) => !(call.value as { options?: { cursor?: string } }).options?.cursor)).toBe(true)
  })
  it('creates a card through the public client and renders its confirmed details', async () => {
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Review accessibility')
    await user.type(screen.getByLabelText('Details'), 'Check keyboard movement.')
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    expect(await screen.findByRole('heading', { name: 'Review accessibility' })).toBeInTheDocument()
    expect(screen.getByText('Check keyboard movement.')).toBeInTheDocument()
    expect(mutationCalls()).toHaveLength(1)
    expect(mutationCalls()[0]).toMatchObject({ kind: 'card_create', card: { title: 'Review accessibility', status: 'todo' }, commandId: expect.any(String) })
  })
  it('opens a returned Done duplicate automatically while preserving the intended draft', async () => {
    const existing = memoryTestCard({ title: 'Review accessibility', body: 'Already accepted work.', status: 'done', completionKind: 'completed' })
    fixture = createMemoryTestPort({ cards: [existing] })
    fixture.control.write = async (command) => ({ commandId: command.commandId!, outcome: 'existing', card: existing, bindings: [], claims: [], boardRevision: 1 })
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Review accessibility')
    await user.type(screen.getByLabelText('Details'), 'My intended new details')
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    expect(await screen.findByRole('heading', { name: 'Review accessibility' })).toBeInTheDocument()
    expect(screen.getByText((_, element) => element?.tagName === 'P' && element.textContent === 'Done · Completed')).toBeInTheDocument()
    expect(screen.getByText('Already accepted work.')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Review accessibility')
    expect(screen.getByLabelText('Details')).toHaveValue('My intended new details')
    expect(mutationCalls()).toHaveLength(1)
    expect(fixture.cards.get(existing.id)).toEqual(existing)
  })
  it('uses the original note identity when archiving and restoring', async () => {
    fixture = createMemoryTestPort({ notes: [memoryTestNote()] })
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Archive note' }))
    await waitFor(() => expect(screen.queryByText('Keep the public API stable.')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Archived notes' }))
    expect(await screen.findByText('Keep the public API stable.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Restore' }))
    await waitFor(() => expect(mutationCalls()).toHaveLength(2))
    expect(mutationCalls().map((command) => command.kind === 'note_archive' ? [command.noteId, command.archived] : null))
      .toEqual([[memoryTestIds.note, true], [memoryTestIds.note, false]])
  })
  it('preserves text and the exact pending identity after an unknown save across unmount', async () => {
    fixture.control.write = async () => { throw new ApiError({ code: 'NETWORK_ERROR', message: 'Connection lost after dispatch.' }) }
    const user = userEvent.setup(); const view = render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Do not duplicate this task')
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    expect(await screen.findByRole('heading', { name: 'One save needs confirmation' })).toBeInTheDocument()
    const original = mutationCalls()[0]
    view.unmount(); render(<Harness />, { wrapper })
    expect(await screen.findByRole('heading', { name: 'One save needs confirmation' })).toBeInTheDocument()
    expect(mutationCalls()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await waitFor(() => expect(fixture.calls.filter((call) => call.method === 'command')).toHaveLength(1))
    expect(mutationCalls()).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Retry original save' }))
    await waitFor(() => expect(mutationCalls()).toHaveLength(2))
    expect(mutationCalls()[1]).toEqual(original)
  })
  it('does not erase an unknown save when Check status itself is denied', async () => {
    fixture.control.write = async () => { throw new ApiError({ code: 'NETWORK_ERROR', message: 'Lost response.' }) }
    fixture.control.lookup = async () => { throw new ApiError({ code: 'FORBIDDEN', message: 'Receipt lookup denied.' }, 403) }
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Retained task')
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    await screen.findByRole('heading', { name: 'One save needs confirmation' })
    await user.click(screen.getByRole('button', { name: 'Check status' }))
    await screen.findByText(/Receipt lookup denied/)
    expect(screen.getByRole('heading', { name: 'One save needs confirmation' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Retained task')
    expect(mutationCalls()).toHaveLength(1)
  })
  it.each(['check', 'retry'] as const)('finishes the submitted note editor after %s confirms an unknown save', async (recovery) => {
    let receipt: MemoryReceipt | undefined
    fixture.control.write = async (command) => {
      if (receipt) return receipt
      if (command.kind !== 'note_create') throw new Error('Expected the public note create command.')
      const note = memoryTestNote({ text: command.text, revision: 2 })
      receipt = { commandId: command.commandId!, outcome: 'created', note, bindings: [], claims: [], boardRevision: 2 }
      fixture.notes.set(note.id, note); fixture.board.revision = 2
      fixture.commands.set(receipt.commandId, { commandId: receipt.commandId, state: 'known', receipt })
      throw new ApiError({ code: 'NETWORK_ERROR', message: 'Committed response was lost.' })
    }
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add note' }))
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'A note that must be saved once')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    await screen.findByRole('heading', { name: 'One save needs confirmation' })
    await user.click(screen.getByRole('button', { name: recovery === 'check' ? 'Check status' : 'Retry original save' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Save note' })).not.toBeInTheDocument())
    expect(await screen.findByText('A note that must be saved once')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'One save needs confirmation' })).not.toBeInTheDocument()
    expect(mutationCalls()).toHaveLength(recovery === 'check' ? 1 : 2)
    if (recovery === 'retry') expect(mutationCalls()[1]).toEqual(mutationCalls()[0])
    await user.click(screen.getByRole('button', { name: 'Add note' }))
    expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('')
  })
  it('shows a confirmed new note when returning from its editor without a stream event', async () => {
    const user = userEvent.setup()
    render(<Harness />, { wrapper })
    await ready()
    await user.click(screen.getByRole('button', { name: 'Add note' }))
    await user.type(screen.getByRole('textbox', { name: 'Note' }), 'Remember the release decision')
    await user.click(screen.getByRole('button', { name: 'Save note' }))
    expect(await screen.findByText('Remember the release decision')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save note' })).not.toBeInTheDocument()
    expect(mutationCalls()).toHaveLength(1)
  })
  it('reads the saved card when returning from its editor without a stream event', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard()] })
    const user = userEvent.setup()
    render(<Harness initialCardId={memoryTestIds.card} />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox', { name: 'Title' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Reviewed release notes')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByRole('heading', { name: 'Reviewed release notes' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument()
    expect(mutationCalls()).toHaveLength(1)
  })
  it('rebases only the reviewed card delta after a revision conflict', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ body: 'Earlier details' })] })
    const latest = memoryTestCard({ body: 'Details changed by another actor', revision: 2 })
    fixture.control.write = async () => { throw new ApiError({ code: 'REVISION_CONFLICT', message: 'This card changed.', details: { current: latest } }, 409) }
    const user = userEvent.setup(); render(<Harness initialCardId={memoryTestIds.card} />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    await user.clear(screen.getByRole('textbox', { name: 'Title' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'My revised title')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('region', { name: 'Edit conflict' })
    expect(screen.getByLabelText('Your draft')).toHaveValue('My revised title\nEarlier details\n')
    await user.click(screen.getByRole('button', { name: 'Keep editing my draft' }))
    expect(screen.getByLabelText('Details')).toHaveValue('Details changed by another actor')
    fixture.cards.set(latest.id, latest); fixture.control.write = undefined
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    await screen.findByRole('heading', { name: 'My revised title' })
    expect(mutationCalls()[1]).toMatchObject({ expectedRevision: 2, patch: { title: 'My revised title' } })
    if (mutationCalls()[1].kind === 'card_update') expect(mutationCalls()[1]).not.toHaveProperty('patch.body')
  })
  it('retains confirmed board content while the visible stream is unavailable', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard()] })
    fixture.control.start = (listener) => { listener.connection('reconnecting'); listener.ready() }
    render(<Harness />, { wrapper }); await ready()
    expect(await screen.findByRole('button', { name: 'Prepare release notes' })).toBeInTheDocument()
    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument()
  })
  it('shows bounded readable memory with an offline label when initial stream registration is offline', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard()] })
    fixture.control.start = (listener) => { listener.connection('offline'); listener.ready() }
    render(<Harness />, { wrapper })
    expect(await screen.findByRole('button', { name: 'Prepare release notes' })).toBeInTheDocument()
    expect(screen.getByText(/Offline · Last updated/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add card' })).toBeDisabled()
    expect(fixture.calls.filter((call) => call.method === 'board')).toHaveLength(1)
  })
  it('does not rewind a newer card after a stale snapshot and page response', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ revision: 8, title: 'Newer confirmed title' })] })
    fixture.board.revision = 8
    render(<Harness />, { wrapper }); await ready()
    expect(screen.getByRole('button', { name: 'Newer confirmed title' })).toBeInTheDocument()
    fixture.board.revision = 3
    fixture.cards.set(memoryTestIds.card, memoryTestCard({ revision: 3, title: 'Old response title' }))
    act(() => fixture.emit({ id: 'later', boardId: fixture.board.id, sequence: 9, boardRevision: 9, entity: 'card', entityId: memoryTestIds.card,
      entityRevision: 9, actor: { kind: 'operator', id: 'operator', displayName: 'Operator' }, occurredAt: memoryTestTime }))
    await waitFor(() => expect(fixture.calls.filter((call) => call.method === 'board').length).toBeGreaterThan(1))
    await waitFor(() => expect(cache.isFetching()).toBe(0))
    expect(screen.getByRole('button', { name: 'Newer confirmed title' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Old response title' })).not.toBeInTheDocument()
  })
  it('keeps draft fields through live refresh and makes no automatic write on reconnect', async () => {
    const user = userEvent.setup(); render(<Harness />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Unsaved words')
    act(() => { fixture.connection('offline'); fixture.connection('connected') })
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Unsaved words')
    expect(mutationCalls()).toHaveLength(0)
  })
})

describe('exact work identity, access and one modal', () => {
  const node: AgentNodeRef = { workspaceId: memoryTestIds.workspace, workflowId: memoryTestIds.workflow, workflowNodeId: 'writer', agentId: 'original-agent' }
  it('keeps unsent work obligations visible and removable after their display link is removed', async () => {
    const nodes: MemoryNodeOption[] = [{ node, label: 'Writer', available: true, currentWork: [] }]
    const user = userEvent.setup(); render(<Harness nodes={nodes} />, { wrapper }); await ready()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Track next task')
    await user.click(screen.getByRole('checkbox', { name: 'Writer' }))
    await user.click(screen.getByRole('checkbox', { name: 'Writer' }))
    expect(screen.getByText('1 new work obligation selected.')).toBeInTheDocument()
    expect(screen.getByText('Next activation · Writer')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove work selection' }))
    expect(screen.queryByText('1 new work obligation selected.')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create card' }))
    await screen.findByRole('heading', { name: 'Track next task' })
    const submitted = mutationCalls()[0]
    expect(submitted).toMatchObject({ card: { linkedNodes: [] } })
    expect(submitted.kind === 'card_create' ? submitted.workSelections ?? [] : undefined).toEqual([])
  })
  it('shows historical reason edits and opens the exact recorded work provenance', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard()] })
    const entry: MemoryChange = { id: 'old-change', boardId: fixture.board.id, sequence: 1, boardRevision: 1,
      entity: 'card', entityId: memoryTestIds.card, entityRevision: 1, actor: { kind: 'operator', id: 'operator', displayName: 'Operator' }, occurredAt: memoryTestTime,
      changes: { reason: { before: 'Waiting for assets', after: 'Assets received' } },
      provenance: { work: { kind: 'slot', runId: 'original-run', workflowVersionId: 'original-version', slotId: 'original-slot' },
        execution: { runId: 'original-run', workflowVersionId: 'original-version', executionId: 'original-execution', attempt: 1 } } }
    fixture.control.history = [entry]
    const open = vi.fn(), user = userEvent.setup()
    render(<Harness initialCardId={memoryTestIds.card} onOpenHistoryWork={open} />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'History' }))
    await user.click(screen.getByText('reason changed'))
    expect(screen.getByText('Previously: Waiting for assets')).toBeVisible()
    expect(screen.getByText('Saved: Assets received')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Open recorded work' }))
    expect(open).toHaveBeenCalledWith(entry)
    expect(mutationCalls()).toHaveLength(0)
  })
  it('does not substitute a replacement agent at the same node for a saved owner', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ assignee: node })] })
    const nodes: MemoryNodeOption[] = [{ node: { ...node, agentId: 'replacement-agent' }, label: 'Replacement agent', available: true, currentWork: [] }]
    render(<Harness nodes={nodes} />, { wrapper }); await ready()
    expect(screen.getByText(/This agent\/workflow is no longer available/)).toBeInTheDocument()
    expect(screen.queryByText('Replacement agent')).not.toBeInTheDocument()
  })
  it('keeps unrelated tools when selecting memory inheritance', async () => {
    const changed = vi.fn()
    render(<MemoryBoardAccessField value={['run_get', 'memory_card_create']} agentDefaultTools={['workspace_list', 'memory_board_get', 'memory_board_changes_read']}
      readOnly={false} onChange={changed} />)
    fireEvent.change(screen.getByLabelText('Memory access'), { target: { value: 'inherit' } })
    expect(changed).toHaveBeenCalledWith(['run_get', 'memory_board_get', 'memory_board_changes_read'])
  })
  it('preserves legacy None, labels custom subsets and shows read-only limits', () => {
    const view = render(<MemoryBoardAccessField value={undefined} agentDefaultTools={['run_get']} readOnly={false} onChange={() => undefined} />)
    expect(screen.getByText(/Effective memory access: none/)).toBeInTheDocument()
    view.rerender(<MemoryBoardAccessField value={['memory_card_create']} agentDefaultTools={[]} readOnly onChange={() => undefined} />)
    expect(screen.getByRole('option', { name: 'Custom' })).toBeInTheDocument()
    expect(screen.getByText('Read-only agent: board changes are unavailable.')).toBeInTheDocument()
    view.rerender(<MemoryBoardAccessField value={[...memoryToolNames]} agentDefaultTools={[]} readOnly onChange={() => undefined} />)
    expect(screen.getByText(/Read-only restrictions apply/)).toBeInTheDocument()
  })
  it('opens exactly the saved work binding and displays unconfirmed computer state without changing the card', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ status: 'doing' })] })
    const binding: MemoryCardWorkBinding = { id: 'binding', cardId: memoryTestIds.card, node,
      work: { kind: 'activation', runId: 'old-run', workflowVersionId: 'saved-version', activationId: 'activation' },
      currentExecutionId: 'saved-attempt', state: 'waiting_children', reason: null, revision: 1 }
    fixture.control.bindings = [binding]
    const open = vi.fn(), user = userEvent.setup()
    render(<Harness initialCardId={memoryTestIds.card} onOpenWork={open} health={[{ bindingId: binding.id, state: 'offline', lastSeenAt: memoryTestTime }]} />, { wrapper })
    await screen.findByText(/Waiting for child reports/)
    expect(screen.getByText(/Computer offline/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open work' }))
    expect(open).toHaveBeenCalledWith(binding)
    expect(mutationCalls()).toHaveLength(0)
  })
  it('uses one shared dialog and guards an unsaved draft on Escape', async () => {
    const changed = vi.fn(), user = userEvent.setup()
    render(<MemoryBoardDialog client={fixture.port} scope={fixture.board.scope} scopeName="Workflow" canWrite nodes={[]}
      open onOpenChange={changed} filters={{ query: '', doneOpen: false }} onFiltersChange={() => undefined} onSelectCard={() => undefined}
      onOpenWork={() => undefined} historicalRun browserReleaseState="pending" />, { wrapper })
    await ready()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByText('Showing current memory, not this run’s past state.')).toBeInTheDocument()
    expect(screen.getByText('Returning browser control…')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add card' }))
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Keep this draft')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(await screen.findByRole('heading', { name: 'Discard unsaved changes?' })).toBeInTheDocument()
    expect(changed).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('Keep this draft')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })
  it('shows the exact active-work rejection and keeps the requested draft', async () => {
    fixture = createMemoryTestPort({ cards: [memoryTestCard({ status: 'doing' })] })
    const binding: MemoryCardWorkBinding = { id: 'binding', cardId: memoryTestIds.card, node,
      work: { kind: 'slot', runId: 'live-run', workflowVersionId: 'version', slotId: 'slot' }, currentExecutionId: 'attempt', state: 'running', reason: null, revision: 1 }
    fixture.control.write = async () => { throw new ApiError({ code: 'ACTIVE_WORK_UNRESOLVED', message: 'Linked work is still active.', details: { bindings: [binding] } }, 409) }
    const user = userEvent.setup(); render(<Harness initialCardId={memoryTestIds.card} />, { wrapper })
    await user.click(await screen.findByRole('button', { name: 'Drop card' }))
    await user.type(screen.getByLabelText('Why is this no longer needed?'), 'Task replaced')
    await user.click(screen.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText(/This card still has unfinished work/)).toBeInTheDocument()
    expect(screen.getByLabelText('Why is this no longer needed?')).toHaveValue('Task replaced')
    expect(screen.getByRole('button', { name: 'Open work' })).toBeInTheDocument()
  })
})
