import { optionalCommandId } from './commands.js'
import { z } from 'zod'
import { IdSchema } from '../schemaPrimitives.js'

const PluginId = z.string().min(3).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/)
const Revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const CommandId = z.string().uuid()

export const CodexPluginSummarySchema = z.object({
  pluginId: PluginId, name: z.string(), marketplaceName: z.string(), version: z.string().nullable(),
  installed: z.boolean(), enabled: z.boolean(), sourceType: z.enum(['local', 'git', 'git-subdir', 'remote', 'other']),
  installPolicy: z.enum(['NOT_AVAILABLE', 'AVAILABLE', 'INSTALLED_BY_DEFAULT']),
  authPolicy: z.enum(['ON_INSTALL', 'ON_USE']),
  // An unlisted local/configuration record is evidence to inspect, not proof of installation.
  verification: z.enum(['catalog', 'unverified']).optional(),
  unavailableReason: z.string().optional(),
}).strict()
export type CodexPluginSummary = z.infer<typeof CodexPluginSummarySchema>

export const CodexPluginListInputSchema = z.object({
  view: z.enum(['installed', 'available']).default('installed'), query: z.string().trim().max(100).default(''),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(48).default(24),
  refresh: z.preprocess(value => value === 'true' ? true : value, z.boolean().optional()),
}).strict()
export type CodexPluginListInput = z.infer<typeof CodexPluginListInputSchema>
export const CodexPluginListResultSchema = z.object({
  items: z.array(CodexPluginSummarySchema), total: z.number().int().nonnegative(), nextOffset: z.number().int().nonnegative().nullable(),
  revision: Revision, checkedAt: z.string().datetime({ offset: true }),
  catalogStatus: z.enum(['complete', 'partial']).default('partial'),
  inventoryStatus: z.enum(['complete', 'unknown']).default('unknown'),
}).strict()

export const CodexPluginGetInputSchema = z.object({ pluginId: PluginId,
  refresh: z.preprocess(value => value === 'true' ? true : value, z.boolean().optional()),
}).strict()
export const CodexPluginDetailResultSchema = z.object({ plugin: CodexPluginSummarySchema,
  revision: Revision, artifactIdentity: Revision,
  contents: z.discriminatedUnion('status', [
    z.object({ status: z.literal('known'), skills: z.array(z.string()), hooks: z.array(z.string()), mcpServers: z.array(z.string()), apps: z.array(z.string()) }).strict(),
    z.object({ status: z.literal('unknown') }).strict(),
  ]),
}).strict()
export type CodexPluginDetailResult = z.infer<typeof CodexPluginDetailResultSchema>

export const CodexPluginChangeInputSchema = z.object({ pluginId: PluginId, action: z.enum(['install', 'remove']),
  expectedRevision: Revision, artifactIdentity: Revision.optional(), commandId: optionalCommandId(CommandId) }).strict()
export type CodexPluginChangeInput = z.infer<typeof CodexPluginChangeInputSchema>
export const CodexPluginChangeResultSchema = z.object({ pluginId: PluginId, action: z.enum(['install', 'remove']),
  status: z.enum(['applied', 'not_applied', 'reconciled', 'uncertain']), message: z.string(), nativeFailure: z.string().optional(), observedRevision: Revision.optional() }).strict()
export type CodexPluginChangeResult = z.infer<typeof CodexPluginChangeResultSchema>
export const CodexPluginReconcileInputSchema = z.object({ commandId: optionalCommandId(CommandId), requestedBy: IdSchema.optional(),
  expectedRevision: Revision.optional(), acceptObservedState: z.boolean().default(false),
}).strict().refine((input) => !input.acceptObservedState || Boolean(input.expectedRevision), { message: 'Keeping observed state requires its reviewed revision.' })
export type CodexPluginReconcileInput = z.infer<typeof CodexPluginReconcileInputSchema>
const CodexPluginOperationSchema = z.object({
  requestedBy: IdSchema, commandId: CommandId,
  // Receipts created before recovery ownership was added cannot reconstruct the reviewed input.
  input: CodexPluginChangeInputSchema.nullable(), result: CodexPluginChangeResultSchema,
}).strict()
export type CodexPluginOperation = z.infer<typeof CodexPluginOperationSchema>
export const CodexPluginOperationsResultSchema = z.object({ items: z.array(CodexPluginOperationSchema).max(100) }).strict()
