import type { z } from 'zod'
import { MemoryBoardMutationSchema, type MemoryBoardMutation } from '@foreman-code/contracts'
import type { OperatorToolDefinition } from '../definition.js'
import type { MemoryBoardService } from '../../../modules/memory-boards/service.js'
import type { ChangesRequest, MemoryTool, ReadRequest } from '../../../modules/memory-boards/types.js'
import { invalid } from '../../../modules/memory-boards/identity.js'
import { MemoryReadInputSchema, MemoryChangesInputSchema } from '../../../modules/memory-boards/reads.js'
import { hasAction, isAuthorized } from '../../../modules/access/policy.js'
import type { OperatorRequestContext } from '../types.js'
import type { AuthorizedResource } from '../../../modules/access/policy.js'

type MemoryToolContext = Pick<OperatorRequestContext, 'principal'> & { services?: OperatorRequestContext['services'] }
/** The composition layer adds these names to its central Operator catalog. */
export interface MemoryBoardToolDefinition extends Omit<OperatorToolDefinition, 'name' | 'run' | 'handle' | 'discoverable'> {
  name: MemoryTool
  discoverable(context: MemoryToolContext, resource?: AuthorizedResource): boolean
  run(context: MemoryToolContext, input: unknown): Promise<unknown>
}

/** Optional C0 transport adapters use the same canonical mutation variants. */
export interface MemoryBoardMcpSchemas {
  read: z.ZodType<ReadRequest>
  changes: z.ZodType<ChangesRequest>
  cardCreate: z.ZodType<Extract<MemoryBoardMutation,{kind:'card_create'}>>
  cardUpdate: z.ZodType<Extract<MemoryBoardMutation,{kind:'card_update'}>>
  noteCreate: z.ZodType<Extract<MemoryBoardMutation,{kind:'note_create'}>>
  noteUpdate: z.ZodType<Extract<MemoryBoardMutation,{kind:'note_update'}>>
  noteArchive: z.ZodType<Extract<MemoryBoardMutation,{kind:'note_archive'}>>
}
function mutationSchema<Kind extends MemoryBoardMutation['kind']>(kind: Kind): z.ZodType<Extract<MemoryBoardMutation,{kind:Kind}>> {
  const schema=MemoryBoardMutationSchema.options.find(option=>option.shape.kind.value===kind)
  if(!schema)throw new Error(`Missing canonical memory mutation: ${kind}`)
  return schema as unknown as z.ZodType<Extract<MemoryBoardMutation,{kind:Kind}>>
}
export const memoryBoardMcpSchemas: MemoryBoardMcpSchemas={
  read:MemoryReadInputSchema,changes:MemoryChangesInputSchema,
  cardCreate:mutationSchema('card_create'),cardUpdate:mutationSchema('card_update'),
  noteCreate:mutationSchema('note_create'),noteUpdate:mutationSchema('note_update'),noteArchive:mutationSchema('note_archive'),
}
const readAnnotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
const writeAnnotations={...readAnnotations,readOnlyHint:false}
function discover(write: boolean) {
  return (context: MemoryToolContext, resource?: AuthorizedResource) => {
    const workspace=write ? 'workspaces:update' : 'workspaces:read'
    const workflow=write ? 'workflows:update' : 'workflows:read'
    if (resource?.workflowId) return isAuthorized(context.principal,workflow,resource)
    if (resource?.workspaceId) {
      return isAuthorized(context.principal,workspace,resource) || isAuthorized(context.principal,workflow,resource)
    }
    return hasAction(context.principal,workspace) || hasAction(context.principal,workflow)
  }
}
/** No service means no advertised handlers. D mounts these in Operator and the
 * scoped agent registry; every guessed invocation still rechecks the service. */
export function createMemoryBoardTools(service: MemoryBoardService | undefined, schemas: MemoryBoardMcpSchemas = memoryBoardMcpSchemas): MemoryBoardToolDefinition[] {
  if (!service) return []
  return memoryBoardToolDefinitions(() => service, schemas)
}

export function memoryBoardToolDefinitions(
  resolve: (context: MemoryToolContext) => MemoryBoardService,
  schemas: MemoryBoardMcpSchemas = memoryBoardMcpSchemas,
): MemoryBoardToolDefinition[] {
  const tools:MemoryBoardToolDefinition[]=[
    {name:'memory_board_get',requires:[['workspaces:read','resource']],discoverable:discover(false),
      permissionDetail:'Workspace boards require workspaces:read; workflow boards require workflows:read in the exact scope.',
      description:'Read one workspace or workflow Memory board, an independent column page, note page, exact task/history or your command receipt. Card detail bounds its current-work summary and binding/claim pages. Use views bindings and claims with cardId and their independent nextCursor to read retained work. Done is loaded only on request. Unknown command status never proves that a timed-out save did not run.',
      inputSchema:schemas.read,annotations:readAnnotations,run:(context,input)=>resolve(context).read(context.principal,schemas.read.parse(input))},
    {name:'memory_board_changes_read',requires:[['workspaces:read','resource']],discoverable:discover(false),
      permissionDetail:'Workspace boards require workspaces:read; workflow boards require workflows:read in the exact scope.',
      description:'Read a bounded page of committed Memory board changes after a sequence. On resetRequired read the current bounded board snapshot. Closing a board needs no continued reads.',
      inputSchema:schemas.changes,annotations:readAnnotations,run:(context,input)=>resolve(context).changes(context.principal,schemas.changes.parse(input))},
  ]
  const mutations=[
    ['memory_card_create','card_create',schemas.cardCreate,'Create a task or return the existing normalized-title task, including Done. Assignment/display links alone do not bind work. Select exact current work or an explicit one-use Next activation. Use status waiting_for_user with a reason telling the owner what to do when only the owner can act (payment, sign-in, CAPTCHA).'],
    ['memory_card_update','card_update',schemas.cardUpdate,'Patch a task against current state; expectedRevision is optional. Live required work cannot be completed or dropped. Reopen or drop terminal failed work with a reason; historical failure remains intact. Move a task to waiting_for_user with a reason when the owner must act; work results never move it out, only an explicit update does.'],
    ['memory_note_create','note_create',schemas.noteCreate,'Pin a durable note; omitted rank appends once. A source post must be visible in the same board scope.'],
    ['memory_note_update','note_update',schemas.noteUpdate,'Patch note text or rank without rewriting other notes. A no-op keeps the saved revision and produces no event.'],
    ['memory_note_archive','note_archive',schemas.noteArchive,'Archive or restore a note explicitly, retaining its identity and history.'],
  ] as const
  for (const [name,kind,schema,description] of mutations) tools.push({
    name,requires:[['workspaces:update','resource']],discoverable:discover(true),
    permissionDetail:'Workspace boards require workspaces:update; workflow boards require workflows:update in the exact scope. Agent tools also require the saved node tool and writable harness.',
    description:`${description} Keep commandId and input after an uncertain response, and check memory_board_get view command before retrying.`,
    inputSchema:schema,annotations:writeAnnotations,
    run(context,input) {
      const operation=MemoryBoardMutationSchema.parse(input)
      if(operation.kind!==kind)invalid('This mutation kind belongs to another tool.')
      return resolve(context).mutate(context.principal,operation)
    },
  })
  return tools
}
