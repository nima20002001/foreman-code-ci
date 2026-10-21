import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { ExecutionLocationSchema } from './executionLocation.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { WorkspaceRootSelectionSchema, WorkspaceRootPolicySchema, WorkspaceRootAttestationSchema, WorkspaceRootBrowseResultSchema, WorkspaceRootHostSchema, ApprovedRootAllowlistSchema } from './workspaceRootPolicies.js'

export const WorkspaceBoundLocationGetInputSchema = z.object({ workspaceId: IdSchema }).strict()
export const WorkspaceBoundLocationValidateInputSchema = WorkspaceRootSelectionSchema
export const WorkspaceBoundLocationBrowseInputSchema = WorkspaceRootSelectionSchema
export const WorkspaceBoundLocationSetInputSchema = WorkspaceRootSelectionSchema.extend({ commandId: optionalCommandId(z.string().min(8).max(200)) }).strict()
export const WorkspaceBoundLocationValidationSchema = z.object({ workspaceId: IdSchema,
  selection: WorkspaceRootSelectionSchema, attestation: WorkspaceRootAttestationSchema, checkedAt: TimestampSchema }).strict()
export const WorkspaceBoundLocationBrowseResultSchema = z.object({ workspaceId: IdSchema,
  selection: WorkspaceRootSelectionSchema, browse: WorkspaceRootBrowseResultSchema }).strict()
export const WorkspaceBoundLocationReadbackSchema = z.discriminatedUnion('evidence', [
  z.object({ evidence: z.literal('bound'), workspaceId: IdSchema, locationRevision: z.number().int().nonnegative(),
    executionLocation: ExecutionLocationSchema, binding: WorkspaceRootPolicySchema }).strict(),
  z.object({ evidence: z.literal('legacy_missing'), workspaceId: IdSchema, locationRevision: z.number().int().nonnegative(),
    executionLocation: ExecutionLocationSchema }).strict(),
  z.object({ evidence: z.literal('unconfigured'), workspaceId: IdSchema, locationRevision: z.number().int().nonnegative(),
    executionLocation: z.null() }).strict(),
])
/** Set returns the selected root. Device roots preserve the primary location revision; get reads the primary location. */
export const WorkspaceBoundLocationSetResultSchema = z.object({ value: WorkspaceBoundLocationReadbackSchema, replayed: z.boolean() }).strict()
export type WorkspaceBoundLocationReadback = z.infer<typeof WorkspaceBoundLocationReadbackSchema>
export type WorkspaceBoundLocationSetInput = z.infer<typeof WorkspaceBoundLocationSetInputSchema>

/** Audited adoption of an existing protected host configuration; never caller-selected paths. */
export const WorkspaceRootConfigurationAdoptSchema = z.object({
  workspaceId: IdSchema, commandId: WorkspaceBoundLocationSetInputSchema.shape.commandId, hostRef: WorkspaceRootHostSchema,
}).strict()
export const WorkspaceRootConfigurationAdoptResultSchema = z.object({ value: ApprovedRootAllowlistSchema, replayed: z.boolean() }).strict()
