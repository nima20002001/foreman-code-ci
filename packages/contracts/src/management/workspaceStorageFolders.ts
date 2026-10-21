import { optionalCommandId } from './commands.js'
import { z } from 'zod'

const Path = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid folder path')
const Identity = z.string().regex(/^sha256:[a-f0-9]{64}$/)

export const WorkspaceStorageFoldersListInputSchema = z.object({
  cursor: z.string().max(4096).optional(), limit: z.number().int().min(1).max(100).default(5),
}).strict()
const WorkspaceStorageFolderSchema = z.object({
  name: z.string(), path: Path, identity: Identity,
  deletion: z.discriminatedUnion('status', [
    z.object({ status: z.literal('available') }).strict(),
    z.object({ status: z.literal('protected'), reason: z.enum(['workspace', 'archived_workspace', 'owned_folder', 'active_run', 'defaults']), message: z.string() }).strict(),
  ]),
}).strict()
export type WorkspaceStorageFolder = z.infer<typeof WorkspaceStorageFolderSchema>
export const WorkspaceStorageFoldersPageSchema = z.object({
  rootPath: Path, items: z.array(WorkspaceStorageFolderSchema),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict()
export const WorkspaceStorageFolderDeleteInputSchema = z.object({
  commandId: optionalCommandId(z.string().uuid()), path: Path,
  expectedIdentity: Identity.describe('Identity returned by workspace_storage_folders_list. A replaced folder is never deleted.'),
}).strict()
export type WorkspaceStorageFolderDeleteInput = z.infer<typeof WorkspaceStorageFolderDeleteInputSchema>
export const WorkspaceStorageFolderDeleteResultSchema = z.object({
  value: z.object({ path: Path }).strict(), replayed: z.boolean(),
}).strict()
