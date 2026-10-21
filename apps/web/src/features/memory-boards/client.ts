import { MemoryBoardMutationSchema, type MemoryBoardMutation, type MemoryBoardScope } from '@foreman-code/contracts'
import { apiClient, ApiError, type ApiClient } from '../../shared/api/client'
import { subscribeMemoryBoard } from './stream'
import type { MemoryBoardClient, MemoryWireSchemas, PageOptions } from './ports'

const root = '/api/memory-boards'
const segment = encodeURIComponent
function readPath(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value))
  }
  return `${root}?${query.toString()}`
}
function pageFields(options?: PageOptions) {
  return { cursor: options?.cursor, limit: options?.limit ?? 20 }
}
function mutationPath(command: MemoryBoardMutation): { path: string; method: 'POST' | 'PATCH' } {
  const base = `${root}/${segment(command.boardId)}`
  switch (command.kind) {
    case 'card_create': return { path: `${base}/cards`, method: 'POST' }
    case 'card_update': return { path: `${base}/cards/${segment(command.cardId)}`, method: 'PATCH' }
    case 'note_create': return { path: `${base}/notes`, method: 'POST' }
    case 'note_update': return { path: `${base}/notes/${segment(command.noteId)}`, method: 'PATCH' }
    case 'note_archive': return { path: `${base}/notes/${segment(command.noteId)}/archive`, method: 'POST' }
  }
}
function matchesScope(actual: MemoryBoardScope, expected: MemoryBoardScope): boolean {
  return actual.kind === expected.kind && actual.workspaceId === expected.workspaceId
    && (actual.kind !== 'workflow' || (expected.kind === 'workflow' && actual.workflowId === expected.workflowId))
}
/** D supplies C0's authoritative read validators. All requests use the existing
 * installation/session boundary; the browser never falls back to a fake. */
export function createMemoryBoardClient(schemas: MemoryWireSchemas, http: ApiClient = apiClient): MemoryBoardClient {
  return {
    async resolve(scope, signal) {
      const view = await http.request(readPath({ scope: JSON.stringify(scope), view: 'board' }), schemas.board, { signal })
      if (!matchesScope(view.board.scope, scope)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Memory belongs to another scope.' })
      // Resolve identity only. The visible snapshot is read after the stream is registered.
      return view.board
    },
    readBoard: (boardId, signal) => http.request(readPath({ boardId, view: 'board' }), schemas.board, { signal }),
    readCards: (boardId, filter, options) => http.request(readPath({ boardId, view: 'cards', ...filter, ...pageFields(options) }), schemas.cards, { signal: options?.signal }),
    readCard: (boardId, cardId, options) => http.request(readPath({ boardId, view: 'card', cardId, ...pageFields(options) }), schemas.card, { signal: options?.signal }),
    readBindings: (boardId, cardId, options) => http.request(readPath({ boardId, view: 'bindings', cardId, ...pageFields(options) }), schemas.bindings, { signal: options?.signal }),
    readClaims: (boardId, cardId, options) => http.request(readPath({ boardId, view: 'claims', cardId, ...pageFields(options) }), schemas.claims, { signal: options?.signal }),
    readNotes: (boardId, archived, options) => http.request(readPath({ boardId, view: 'notes', archived, ...pageFields(options) }), schemas.notes, { signal: options?.signal }),
    readCommand: (boardId, commandId, signal) => http.request(readPath({ boardId, view: 'command', commandId }), schemas.command, { signal }),
    readChanges: (boardId, afterSequence, options) => {
      const query = new URLSearchParams()
      if (afterSequence !== undefined) query.set('afterSequence', String(afterSequence))
      if (options?.cursor) query.set('cursor', options.cursor)
      query.set('limit', String(options?.limit ?? 50))
      return http.request(`${root}/${segment(boardId)}/changes?${query.toString()}`, schemas.changes, { signal: options?.signal })
    },
    async mutate(input) {
      const parsed = MemoryBoardMutationSchema.safeParse(input)
      if (!parsed.success) throw new ApiError({ code: 'INVALID_REQUEST', message: parsed.error.issues[0]?.message ?? 'Check the memory changes.' }, 400)
      const command = parsed.data
      if (new TextEncoder().encode(JSON.stringify(command)).byteLength > 65_536) {
        throw new ApiError({ code: 'INVALID_REQUEST', message: 'Save fewer changes at a time (64 KiB maximum).' }, 400)
      }
      const route = mutationPath(command)
      const receipt = await http.request(route.path, schemas.receipt, { method: route.method, body: command, timeoutMs: 30_000 })
      if (command.commandId && receipt.commandId !== command.commandId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The save receipt has a different command identity.' })
      }
      if (receipt.card?.boardId && receipt.card.boardId !== command.boardId
        || receipt.note?.boardId && receipt.note.boardId !== command.boardId) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The save receipt belongs to another board.' })
      }
      return receipt
    },
    subscribe: (boardId, listeners) => subscribeMemoryBoard(boardId, schemas.change, listeners),
  }
}
