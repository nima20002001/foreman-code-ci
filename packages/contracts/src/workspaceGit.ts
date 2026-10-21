import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { optionalCommandId, CommandIdSchema, ExpectedRevisionSchema } from './management/commands.js'
import { WorkspaceRepositorySchema } from './workspaceRepository.js'
import { WorkspaceRootSelectionSchema } from './workspaceRootPolicies.js'
import { WorkspaceBoundLocationReadbackSchema } from './workspaceBoundLocation.js'
import { ApprovedSourceSchema } from './sourceAdmission.js'
import { SourceRootReferenceSchema } from './worktreeSettings.js'

export const WorkspaceRepositoryAddInputSchema = z.object({
  workspaceId: IdSchema,
  commandId: optionalCommandId(CommandIdSchema),
  expectedRevision: ExpectedRevisionSchema,
  expectedLocationRevision: WorkspaceRootSelectionSchema.shape.expectedLocationRevision,
  expectedRootPolicyRevision: WorkspaceRootSelectionSchema.shape.expectedRootPolicyRevision,
  expectedBindingRevision: ExpectedRevisionSchema,
  repository: WorkspaceRepositorySchema,
  allowedBaseId: WorkspaceRootSelectionSchema.shape.allowedBaseId,
  configurationRevision: WorkspaceRootSelectionSchema.shape.configurationRevision,
}).strict()
export type WorkspaceRepositoryAddInput = z.infer<typeof WorkspaceRepositoryAddInputSchema>

export const WorkspaceRepositoryGetInputSchema = z.object({
  workspaceId: IdSchema,
  commandId: CommandIdSchema.optional(),
}).strict()
export type WorkspaceRepositoryGetInput = z.infer<typeof WorkspaceRepositoryGetInputSchema>

export const WorkspaceRepositoryImportPhaseSchema = z.enum([
  'reserved', 'cloned', 'published', 'metadata', 'location', 'approved', 'bound', 'ready',
])
export const WorkspaceRepositoryImportOperationSchema = z.object({
  commandId: CommandIdSchema,
  phase: WorkspaceRepositoryImportPhaseSchema,
  retryInput: WorkspaceRepositoryAddInputSchema.optional(),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  failure: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    newCommandRequired: z.boolean(),
  }).strict().optional(),
}).strict()

export const WorkspaceRepositoryReadResultSchema = z.object({
  workspaceId: IdSchema,
  state: z.enum(['unconfigured', 'metadata-only', 'preparing', 'ready', 'failed', 'conflict']),
  repository: WorkspaceRepositorySchema.nullable(),
  revision: ExpectedRevisionSchema,
  operation: WorkspaceRepositoryImportOperationSchema.optional(),
  location: WorkspaceBoundLocationReadbackSchema.optional(),
  approvedSource: ApprovedSourceSchema.optional(),
  rootBinding: SourceRootReferenceSchema.optional(),
}).strict().superRefine((value, context) => {
  const retry = value.operation?.retryInput
  if (retry && (retry.workspaceId !== value.workspaceId || retry.commandId !== value.operation?.commandId)) {
    context.addIssue({ code: 'custom', path: ['operation', 'retryInput'],
      message: 'Repository retry input must match the original workspace and command.' })
  }
  if (value.location && value.location.workspaceId !== value.workspaceId
    || value.approvedSource && value.approvedSource.workspaceId !== value.workspaceId) {
    context.addIssue({ code: 'custom', message: 'Repository results must belong to the requested workspace.' })
  }
  if (value.state === 'ready' && (!value.repository || value.location?.evidence !== 'bound'
    || !value.approvedSource || value.approvedSource.availability !== 'retained' || !value.rootBinding
    || value.approvedSource.manifest.git?.repository !== `${value.repository.owner}/${value.repository.name}`
    || value.location.locationRevision !== value.approvedSource.locationRevision)) {
    context.addIssue({ code: 'custom', message: 'A ready repository requires its saved location, source and root binding.' })
  }
})
export type WorkspaceRepositoryReadResult = z.infer<typeof WorkspaceRepositoryReadResultSchema>

export const WorkspaceRepositoryAddResultSchema = z.object({
  value: WorkspaceRepositoryReadResultSchema,
  replayed: z.boolean(),
}).strict()
