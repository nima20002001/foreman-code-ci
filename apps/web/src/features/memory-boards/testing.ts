import {
  MemoryBoardSchema, MemoryCardSchema, MemoryNoteSchema, type MemoryBoardMutation,
  type MemoryCard, type MemoryNote, type MemoryBoardScope,
} from '@foreman-code/contracts'
import { ApiError } from '../../shared/api/client'
import type {
  CardFilter, MemoryBoardClient, MemoryBoardView, MemoryCardDetail, MemoryChange,
  MemoryCommandRead, MemoryPage, MemoryReceipt, MemoryStreamListeners, PageOptions,
} from './ports'

export const memoryTestIds = {
  board: '48ebd9c6-319f-4ea0-a4e7-209a0089fb30', workspace: '72e0009a-c2c2-4ed0-a0e4-41994e09884d',
  workflow: '85476e9c-4ed0-4c3b-bfa6-b143d77302dc', card: '447d5dc6-6770-4ac0-b98d-d4178d2cfd79',
  note: '2c2ca7bc-84dc-4384-9de8-6904c7ea5be7',
}
export const memoryTestTime = '2026-10-20T20:00:00.000Z'
export function memoryTestCard(overrides: Partial<MemoryCard> = {}): MemoryCard {
  return MemoryCardSchema.parse({ id: memoryTestIds.card, boardId: memoryTestIds.board, title: 'Prepare release notes', body: '',
    status: 'todo', completionKind: null, reason: null, assignee: null, linkedNodes: [], revision: 1,
    createdAt: memoryTestTime, updatedAt: memoryTestTime, ...overrides })
}
export function memoryTestNote(overrides: Partial<MemoryNote> = {}): MemoryNote {
  return MemoryNoteSchema.parse({ id: memoryTestIds.note, boardId: memoryTestIds.board, text: 'Keep the public API stable.', rank: 0,
    archived: false, revision: 1, updatedAt: memoryTestTime, ...overrides })
}
function page<T>(items: T[], revision: number, options?: PageOptions): MemoryPage<T> {
  const offset = options?.cursor ? Number(options.cursor) : 0, limit = options?.limit ?? 20
  return { items: items.slice(offset, offset + limit), hasMore: items.length > offset + limit,
    nextCursor: items.length > offset + limit ? String(offset + limit) : null, revision }
}
/** Typed in-memory peer, used only to drive rendered client behavior. Domain
 * rules and real persistence are verified by the API owner's public tests. */
export function createMemoryTestPort(initial: { cards?: MemoryCard[]; notes?: MemoryNote[]; scope?: MemoryBoardScope } = {}) {
  const board = MemoryBoardSchema.parse({ id: memoryTestIds.board,
    scope: initial.scope ?? { kind: 'workspace', workspaceId: memoryTestIds.workspace }, revision: 1 })
  const cards = new Map((initial.cards ?? []).map((item) => [item.id, item]))
  const notes = new Map((initial.notes ?? []).map((item) => [item.id, item]))
  const commands = new Map<string, MemoryCommandRead>()
  const subscribers = new Set<MemoryStreamListeners>()
  const calls: Array<{ method: string; value?: unknown }> = []
  const control: {
    write?: (command: MemoryBoardMutation) => Promise<MemoryReceipt>
    lookup?: (commandId: string) => Promise<MemoryCommandRead>
    snapshot?: () => Promise<MemoryBoardView>
    start?: (listeners: MemoryStreamListeners) => void
    history: MemoryChange[]
    bindings: MemoryCardDetail['bindings']
    claims: MemoryCardDetail['claims']
  } = { history: [], bindings: [], claims: [] }
  const snapshot = (): MemoryBoardView => {
    const all = [...cards.values()], activeNotes = [...notes.values()].filter((item) => !item.archived)
    return { board: structuredClone(board), sequence: board.revision,
      openColumns: (['todo', 'doing', 'waiting_for_user', 'blocked'] as const).map((status) => ({ status, ...page(all.filter((card) => card.status === status), board.revision) })),
      notes: page(activeNotes, board.revision), counts: { todo: all.filter((item) => item.status === 'todo').length,
        doing: all.filter((item) => item.status === 'doing').length,
        waiting_for_user: all.filter((item) => item.status === 'waiting_for_user').length, blocked: all.filter((item) => item.status === 'blocked').length,
        done: all.filter((item) => item.status === 'done').length, completed: all.filter((item) => item.completionKind === 'completed').length,
        dropped: all.filter((item) => item.completionKind === 'dropped').length, notes: activeNotes.length } }
  }
  const port: MemoryBoardClient = {
    resolve: async (scope) => { calls.push({ method: 'resolve', value: scope }); return { ...board, scope } },
    readBoard: async () => { calls.push({ method: 'board' }); return control.snapshot ? control.snapshot() : snapshot() },
    readCards: async (_id, filter: CardFilter, options) => {
      calls.push({ method: 'cards', value: { filter, options } })
      return page([...cards.values()].filter((card) => card.status === filter.status && (!filter.completionKind || card.completionKind === filter.completionKind)
        && (!filter.query || card.title.toLowerCase().startsWith(filter.query.toLowerCase()))), board.revision, options)
    },
    readCard: async (_id, cardId, options) => {
      calls.push({ method: 'card', value: cardId })
      const card = cards.get(cardId)
      if (!card) throw new ApiError({ code: 'NOT_FOUND', message: 'This card is unavailable.' }, 404)
      const { items: bindings, ...bindingPage } = page(structuredClone(control.bindings), board.revision, { limit: options?.limit })
      const { items: claims, ...claimPage } = page(structuredClone(control.claims), board.revision, { limit: options?.limit })
      return { card: structuredClone(card), bindings, claims,
        bindingPage, claimPage,
        workSummary: { activeBindings: control.bindings.filter(binding => ['queued','running','waiting_children','awaiting_acceptance','blocked'].includes(binding.state)).length,
          unresolvedFailures: control.bindings.filter(binding => !binding.resolution && ['failed','canceled'].includes(binding.state)).length,
          armedClaims: control.claims.filter(claim => claim.state === 'armed').length }, history: page(control.history, board.revision, options) }
    },
    readBindings: async (_boardId, _cardId, options) => page(control.bindings, board.revision, options),
    readClaims: async (_boardId, _cardId, options) => page(control.claims, board.revision, options),
    readNotes: async (_id, archived, options) => { calls.push({ method: 'notes', value: archived }); return page([...notes.values()].filter((item) => item.archived === archived), board.revision, options) },
    readCommand: async (_id, commandId) => { calls.push({ method: 'command', value: commandId }); return control.lookup ? control.lookup(commandId) : commands.get(commandId) ?? { commandId, state: 'unknown' } },
    readChanges: async () => ({ ...page([], board.revision), watermark: board.revision, resetRequired: false }),
    mutate: async (command) => {
      calls.push({ method: 'mutate', value: structuredClone(command) })
      if (control.write) return control.write(command)
      const receipt: MemoryReceipt = { commandId: command.commandId ?? crypto.randomUUID(), outcome: command.kind.endsWith('create') ? 'created' : 'updated',
        bindings: [], claims: [], boardRevision: ++board.revision }
      if (command.kind === 'card_create') {
        receipt.card = memoryTestCard({ ...command.card, id: crypto.randomUUID(), sourcePostId: command.sourcePostId, revision: board.revision })
        cards.set(receipt.card.id, receipt.card)
      } else if (command.kind === 'card_update') {
        receipt.card = MemoryCardSchema.parse({ ...cards.get(command.cardId), ...command.patch, revision: board.revision })
        cards.set(receipt.card.id, receipt.card)
      } else if (command.kind === 'note_create') {
        receipt.note = memoryTestNote({ id: crypto.randomUUID(), text: command.text, rank: command.rank ?? notes.size, sourcePostId: command.sourcePostId, revision: board.revision })
        notes.set(receipt.note.id, receipt.note)
      } else {
        receipt.note = MemoryNoteSchema.parse({ ...notes.get(command.noteId), ...(command.kind === 'note_update' ? command.patch : { archived: command.archived }), revision: board.revision })
        notes.set(receipt.note.id, receipt.note)
      }
      commands.set(receipt.commandId, { commandId: receipt.commandId, state: 'known', receipt })
      return structuredClone(receipt)
    },
    subscribe: (_id, listeners) => {
      calls.push({ method: 'subscribe' }); subscribers.add(listeners)
      if (control.start) control.start(listeners)
      else { listeners.ready(); listeners.connection('connected') }
      return () => { calls.push({ method: 'unsubscribe' }); subscribers.delete(listeners) }
    },
  }
  return { port, board, cards, notes, commands, calls, control, snapshot,
    emit: (event: MemoryChange) => subscribers.forEach((listener) => listener.change(event)),
    connection: (state: Parameters<MemoryStreamListeners['connection']>[0]) => subscribers.forEach((listener) => listener.connection(state)),
  }
}
