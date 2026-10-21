import type { FastifyInstance } from 'fastify'
import { MemoryBoardMutationSchema } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { invalid } from '../modules/memory-boards/identity.js'
import { MemoryChangesInputSchema, MemoryReadInputSchema } from '../modules/memory-boards/reads.js'
import type { MemoryBoardService } from '../modules/memory-boards/service.js'
import { streamMemoryBoard } from '../modules/memory-boards/stream.js'

function queryFields(input: unknown): Record<string,unknown> {
  if (!input || typeof input!=='object' || Array.isArray(input)) invalid('Invalid memory query.')
  const result: Record<string,unknown>={...input}
  for (const key of ['limit','afterSequence']) if (key in result) result[key]=Number(result[key])
  if ('archived' in result) {
    if (result.archived!=='true' && result.archived!=='false') invalid('Archived must be true or false.')
    result.archived=result.archived==='true'
  }
  if (typeof result.scope==='string') {
    try { result.scope=JSON.parse(result.scope) } catch { invalid('Scope must be encoded JSON.') }
  }
  return result
}
interface Params { boardId:string;cardId?:string;noteId?:string }
export function registerMemoryBoardRoutes(app: FastifyInstance, service: MemoryBoardService): void {
  app.get('/api/memory-boards',async(request,reply)=>{
    reply.header('cache-control','no-store')
    return service.read(requirePrincipal(request),MemoryReadInputSchema.parse(queryFields(request.query)))
  })
  app.get<{Params:Params}>('/api/memory-boards/:boardId/changes',async(request,reply)=>{
    reply.header('cache-control','no-store')
    return service.changes(requirePrincipal(request),MemoryChangesInputSchema.parse({...queryFields(request.query),boardId:request.params.boardId}))
  })
  app.get<{Params:Params}>('/api/memory-boards/:boardId/events',async(request,reply)=>{
    const input=MemoryChangesInputSchema.parse({...queryFields(request.query),boardId:request.params.boardId})
    return streamMemoryBoard(request,reply,service,requirePrincipal(request),input.boardId,input.afterSequence)
  })
  const operations=[['POST','cards','card_create'],['PATCH','cards/:cardId','card_update'],
    ['POST','notes','note_create'],['PATCH','notes/:noteId','note_update'],['POST','notes/:noteId/archive','note_archive']] as const
  for (const [method,path,kind] of operations) app.route<{Params:Params;Body:unknown}>({
    method,url:`/api/memory-boards/:boardId/${path}`,bodyLimit:65536,
    async handler(request,reply) {
      const operation=MemoryBoardMutationSchema.parse(request.body)
      if (operation.kind!==kind || operation.boardId!==request.params.boardId
        || ('cardId' in operation && operation.cardId!==request.params.cardId)
        || ('noteId' in operation && operation.noteId!==request.params.noteId)) invalid('Mutation identity must match the route.')
      reply.header('cache-control','no-store')
      return service.mutate(requirePrincipal(request),operation)
    },
  })
}
