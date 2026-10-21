import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { SourceHashSchema } from './sourceMaterialization.js'
export const WorkspaceRootHostSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
])
const Revision = z.string().regex(/^[1-9][0-9]*$/)
export const RootFilesystemIdentitySchema = z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict()
export const WorkspaceLocationIdentitySchema = z.union([
  RootFilesystemIdentitySchema.pick({ device: true, inode: true }),
  RootFilesystemIdentitySchema.extend({ hostRef: WorkspaceRootHostSchema, applicationInstallationId: z.uuid(),
    directoryIdentityHash: SourceHashSchema }).strict().superRefine((identity, context) => {
    if (identity.hostRef.kind === 'main' && identity.applicationInstallationId !== identity.hostRef.mainId) {
      context.addIssue({ code: 'custom', message: 'The registered Main location must belong to its Main installation.' })
    }
  }),
])
const RootAccessSchema = z.enum(['read-only', 'read-write'])
const FilesystemIdSchema = z.string().regex(/^[a-f0-9]{1,16}$/)
export const ApprovedRootAllowlistSchema = z.object({ schemaVersion: z.literal(1), hostRef: WorkspaceRootHostSchema,
  applicationInstallationId: z.uuid(), configurationRevision: Revision,
  bases: z.array(z.object({ baseId: z.uuid(), canonicalPath: z.string().startsWith('/'), filesystem: RootFilesystemIdentitySchema,
    filesystemId: FilesystemIdSchema.optional(),
    managedBy: z.literal('worker-pairing').optional(),
    accessModes: z.array(RootAccessSchema).min(1).max(2) }).strict()).min(1).max(32),
  managedRuntimeRoot: z.string().startsWith('/'), runtimeFilesystem: RootFilesystemIdentitySchema,
  runtimeFilesystemId: FilesystemIdSchema.optional(),
}).strict()
export type ApprovedRootAllowlist = z.infer<typeof ApprovedRootAllowlistSchema>
export const WorkspaceRootSelectionSchema = z.object({ workspaceId: IdSchema, hostRef: WorkspaceRootHostSchema,
  allowedBaseId: z.uuid(), configurationRevision: Revision, relativePath: z.string().max(1024), accessMode: RootAccessSchema,
  expectedLocationRevision: z.number().int().nonnegative(), expectedRootPolicyRevision: z.number().int().nonnegative(),
}).strict()
export type WorkspaceRootSelection = z.infer<typeof WorkspaceRootSelectionSchema>
export const WorkspaceRootAttestationSchema = z.object({ schemaVersion: z.literal(1), attestationId: z.uuid(),
  requestDigest: SourceHashSchema, hostRef: WorkspaceRootHostSchema, applicationInstallationId: z.uuid(),
  configurationRevision: Revision, allowedBaseId: z.uuid(), relativePath: z.string().max(1024), accessMode: RootAccessSchema,
  canonicalProjectRoot: z.string().startsWith('/'), filesystem: RootFilesystemIdentitySchema, directoryIdentityHash: SourceHashSchema,
  managedRuntimeRoot: z.string().startsWith('/'), runtimeFilesystem: RootFilesystemIdentitySchema, attestationDigest: SourceHashSchema,
}).strict()
export type WorkspaceRootAttestation = z.infer<typeof WorkspaceRootAttestationSchema>
export const WorkspaceRootPolicySchema = z.object({ schemaVersion: z.literal(1), rootPolicyId: z.uuid(), rootPolicyRevision: Revision,
  bindingPurpose: z.literal('ci-enrollment').optional(),
  workspaceId: IdSchema, hostRef: WorkspaceRootHostSchema, applicationInstallationId: z.uuid(),
  registration: z.object({ workerInstallationId: z.uuid(), keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive() }).strict().nullable(),
  locationRevision: z.string().regex(/^(0|[1-9][0-9]*)$/), ownerPrincipalId: IdSchema, allowedBaseId: z.uuid(), configurationRevision: Revision,
  relativePath: z.string().max(1024), accessMode: RootAccessSchema, canonicalProjectRoot: z.string().startsWith('/'),
  filesystem: RootFilesystemIdentitySchema, directoryIdentityHash: SourceHashSchema,
  managedRuntimeRoot: z.string().startsWith('/'), runtimeFilesystem: RootFilesystemIdentitySchema,
  attestationId: z.uuid(), attestationDigest: SourceHashSchema,
}).strict()
export type WorkspaceRootPolicy = z.infer<typeof WorkspaceRootPolicySchema>
export const WorkspaceRootListInputSchema = z.object({ workspaceId: IdSchema }).strict()
export const WorkspaceRootListResultSchema = z.object({ workspaceId: IdSchema, policies: z.array(WorkspaceRootPolicySchema).max(1000),
  allowlists: z.array(ApprovedRootAllowlistSchema).max(1000), readiness: z.literal('metadata-only') }).strict()
export const WorkspaceRootBrowseResultSchema = z.object({ relativePath: z.string().max(1024),
  directories: z.array(z.object({ name: z.string().min(1), relativePath: z.string().max(1024) }).strict()).max(256), truncated: z.boolean() }).strict()
export type WorkspaceRootBrowseResult = z.infer<typeof WorkspaceRootBrowseResultSchema>

export const WorkspaceRootWorkerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ version: z.literal(1), operation: z.literal('workspace-roots.configuration') }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('workspace-roots.attest'), selection: WorkspaceRootSelectionSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('workspace-roots.prepare-managed'), selection: WorkspaceRootSelectionSchema }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('workspace-roots.browse'), selection: WorkspaceRootSelectionSchema, relativePath: z.string().max(1024) }).strict(),
  z.object({ version: z.literal(1), operation: z.literal('workspace-roots.source-namespace'), policy: WorkspaceRootPolicySchema }).strict(),
])
export type WorkspaceRootWorkerRequest = z.infer<typeof WorkspaceRootWorkerRequestSchema>
export const WORKSPACE_ROOT_WORKER_OPERATIONS = ['workspace-roots.configuration', 'workspace-roots.attest', 'workspace-roots.prepare-managed', 'workspace-roots.browse', 'workspace-roots.source-namespace'] as const
export const WORKSPACE_ROOT_EXTENSION = { namespace: 'workspace-roots-v1', version: 1, maxPayloadBytes: 1024 * 1024, maxPending: 8 } as const
