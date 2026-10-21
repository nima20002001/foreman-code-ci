import { http, HttpResponse } from 'msw'
import { MemoryBoardMutationSchema, MemoryBoardScopeSchema } from '@foreman-code/contracts'
import { ApiError } from '../../shared/api/client'
import type { CardFilter, MemoryBoardClient } from './ports'

/** Opt-in test adapter. D registers these only in the existing MSW test setup;
 * the production client always uses HTTP and never imports this module. */
export function createMemoryBoardHandlers(port: MemoryBoardClient) {
  const read = http.get('/api/memory-boards', async ({ request }) => {
    try {
      const query = new URL(request.url).searchParams
      const scoped = query.get('scope')
      const boardId = query.get('boardId') ?? (scoped ? (await port.resolve(MemoryBoardScopeSchema.parse(JSON.parse(scoped)))).id : '')
      if (!boardId) throw new ApiError({ code: 'INVALID_REQUEST', message: 'Choose one memory board.' }, 400)
      const page = { cursor: query.get('cursor') ?? undefined, limit: Number(query.get('limit') ?? 20) }
      switch (query.get('view') ?? 'board') {
        case 'board': return HttpResponse.json(await port.readBoard(boardId))
        case 'cards': return HttpResponse.json(await port.readCards(boardId, { status: query.get('status') as CardFilter['status'],
          query: query.get('query') ?? undefined, completionKind: query.get('completionKind') as CardFilter['completionKind'] || undefined }, page))
        case 'card': return HttpResponse.json(await port.readCard(boardId, query.get('cardId') ?? '', page))
        case 'bindings': return HttpResponse.json(await port.readBindings(boardId, query.get('cardId') ?? '', page))
        case 'claims': return HttpResponse.json(await port.readClaims(boardId, query.get('cardId') ?? '', page))
        case 'notes': return HttpResponse.json(await port.readNotes(boardId, query.get('archived') === 'true', page))
        case 'command': return HttpResponse.json(await port.readCommand(boardId, query.get('commandId') ?? ''))
        default: throw new ApiError({ code: 'INVALID_REQUEST', message: 'Unknown memory view.' }, 400)
      }
    } catch (error) { return failure(error) }
  })
  const mutate = async ({ request }: { request: Request }) => {
    try { return HttpResponse.json(await port.mutate(MemoryBoardMutationSchema.parse(await request.json()))) }
    catch (error) { return failure(error) }
  }
  return [read, http.post('/api/memory-boards/:boardId/cards', mutate), http.patch('/api/memory-boards/:boardId/cards/:cardId', mutate),
    http.post('/api/memory-boards/:boardId/notes', mutate), http.patch('/api/memory-boards/:boardId/notes/:noteId', mutate),
    http.post('/api/memory-boards/:boardId/notes/:noteId/archive', mutate),
    http.get('/api/memory-boards/:boardId/changes', async ({ request, params }) => {
      try {
        const query = new URL(request.url).searchParams
        return HttpResponse.json(await port.readChanges(String(params.boardId), query.has('afterSequence') ? Number(query.get('afterSequence')) : undefined))
      } catch (error) { return failure(error) }
    })]
}
function failure(error: unknown) {
  return HttpResponse.json({ error: { code: ApiError.is(error) ? error.code : 'INVALID_REQUEST', message: error instanceof Error ? error.message : 'Invalid request',
    ...(ApiError.is(error) && error.details ? { details: error.details } : {}) } }, { status: ApiError.is(error) ? error.status || 503 : 400 })
}
