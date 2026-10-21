import { optionalCommandId } from './management/commands.js'
import { SourceRootReferenceSchema } from './worktreeSettings.js'
import { z } from 'zod'
import { IdSchema } from './schemaPrimitives.js'
import { SourceManifestSchema, SourceHashSchema, RootBindingSchema, MaterializationReceiptSchema } from './sourceMaterialization.js'
import { RootFilesystemIdentitySchema } from './workspaceRootPolicies.js'

export type SourceAction =
  | 'sources:read'
  | 'sources:reconcile'
  | 'source_roots:read'
  | 'source_roots:bind'
export const SourcePinSchema = z.object({ approvedSourceId: z.uuid(), snapshotId: z.uuid(), manifestDigest: SourceHashSchema }).strict()
export type ApprovedSourcePin = z.infer<typeof SourcePinSchema>
export const SourceApproveInputSchema = z.object({ workspaceId: IdSchema, commandId: optionalCommandId(z.string().min(8).max(200)),
  expectedLocationRevision: z.number().int().nonnegative(), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  executablePolicy: z.enum(['strip', 'preserve-approved']),
}).strict()
export const ApprovedSourceSchema = z.object({ version: z.literal(1), workspaceId: IdSchema, ownerPrincipalId: IdSchema,
  approvedByPrincipalId: IdSchema, locationRevision: z.number().int().nonnegative(),
  mainId: z.uuid(), originIdentityHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  manifest: SourceManifestSchema, approvedAt: z.string().datetime(), availability: z.enum(['retained', 'unavailable']),
}).strict()
export type ApprovedSource = z.infer<typeof ApprovedSourceSchema>
export const SourceApproveResultSchema = z.object({ value: ApprovedSourceSchema, replayed: z.boolean() }).strict()
export const SourceGetInputSchema = z.object({ workspaceId: IdSchema, ...SourcePinSchema.shape }).strict()
export const SourceListInputSchema = z.object({ workspaceId: IdSchema, limit: z.number().int().positive().max(100).default(100),
  afterSnapshotId: z.uuid().optional() }).strict()
export const SourceListResultSchema = z.object({ items: z.array(ApprovedSourceSchema).max(100), nextSnapshotId: z.uuid().nullable() }).strict()
const SourceHostSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
])
const SourceRootSelectionSchema = z.object({ hostRef: SourceHostSchema, rootPolicyId: IdSchema,
  rootPolicyRevision: z.string().regex(/^[1-9][0-9]*$/), locationRevision: z.string().regex(/^[1-9][0-9]*$/),
}).strict()
export type SourceRootSelection = z.infer<typeof SourceRootSelectionSchema>
export const SourceRootBindInputSchema = z.object({ workspaceId: IdSchema, commandId: optionalCommandId(z.string().min(8).max(200)),
  source: SourcePinSchema, selection: SourceRootSelectionSchema,
  expectedBindingRevision: z.number().int().nonnegative(), accessMode: z.enum(['read-only', 'exclusive-write']),
}).strict()
export const SourceRootRecordSchema = z.object({ version: z.literal(1), source: SourcePinSchema,
  selection: SourceRootSelectionSchema, binding: RootBindingSchema, ownerPrincipalId: IdSchema,
  authorizedByPrincipalId: IdSchema, registration: z.object({ workerInstallationId: z.uuid(), keyRevision: z.number().int().positive(), authorizationRevision: z.number().int().positive() }).strict().nullable(), attestationId: IdSchema, attestationDigest: SourceHashSchema,
  boundAt: z.string().datetime(),
}).strict().superRefine((record, context) => {
  const binding = record.binding, selected = record.selection.hostRef
  if (binding.mainId !== selected.mainId || binding.snapshotId !== record.source.snapshotId || binding.manifestDigest !== record.source.manifestDigest
    || binding.locationRevision !== Number(record.selection.locationRevision)
    || (selected.kind === 'main' ? binding.deviceId !== null || binding.workerInstallationId !== null || record.registration !== null
      : binding.deviceId !== selected.deviceId || record.registration === null || binding.workerInstallationId !== record.registration.workerInstallationId))
    context.addIssue({ code: 'custom', message: 'Source root facts must match the exact source, host and real registration.' })
})
export type SourceRootRecord = z.infer<typeof SourceRootRecordSchema>
export const SourceRootBindResultSchema = z.object({ value: SourceRootRecordSchema, replayed: z.boolean() }).strict()
export const SourceRootGetInputSchema = z.object({ workspaceId: IdSchema, ...SourceRootReferenceSchema.shape }).strict()
export const SourceMaterializationRecordSchema = z.object({ receipt: MaterializationReceiptSchema,
  rootPolicyId: IdSchema, rootPolicyRevision: z.string().regex(/^[1-9][0-9]*$/), operationId: IdSchema,
  reservationId: z.uuid(), sourceBindingHash: SourceHashSchema, finalDispatchBindingHash: SourceHashSchema.nullable(), state: z.enum(['prepared', 'running', 'uncertain', 'closed']),
}).strict()
export type SourceMaterializationRecord = z.infer<typeof SourceMaterializationRecordSchema>

export const SourcePreparationGetInputSchema = z.object({ workspaceId: IdSchema, operationId: z.uuid().optional(),
  startCommandId: z.string().min(8).max(200).optional() }).strict().refine(input => (input.operationId !== undefined) !== (input.startCommandId !== undefined),
  { message: 'Supply exactly one original operationId or Job Start commandId.' })
export const SourcePreparationReconcileInputSchema = z.object({ workspaceId: IdSchema, operationId: z.uuid(), commandId: optionalCommandId(z.string().min(8).max(200)) }).strict()
/** Closure of an expired, never-admitted Job preparation, observed on its exact
 * worker. Retained source/transfer evidence is never deleted by reconciliation. */
export const SourcePreparationClosureSchema = z.object({ version: z.literal(1), reconciliationId: z.uuid(),
  operationId: z.uuid(), executionId: IdSchema, attemptId: IdSchema, rootId: z.uuid(), bindingRevision: z.number().int().positive(),
  materializationId: z.uuid().nullable(), mainId: z.uuid(), deviceId: z.uuid().nullable(), workerInstallationId: z.uuid().nullable(),
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable(),
  filesystem: RootFilesystemIdentitySchema, admissionClosed: z.literal(true), childrenClosed: z.literal(true),
  claimReleased: z.literal(true), evidencePreserved: z.literal(true), quotaReclaimed: z.literal(true).optional(), observedAt: z.string().datetime(),
}).strict()
export type SourcePreparationClosure = z.infer<typeof SourcePreparationClosureSchema>
export const SourcePreparationSchema = z.object({ workspaceId: IdSchema, operationId: z.uuid(), executionId: IdSchema, attemptId: IdSchema,
  hostRef: SourceHostSchema,
  reservationId: z.uuid(), reservationState: z.enum(['preparing', 'owned', 'uncertain', 'retained', 'reclaimed']),
  reservedBytes: z.number().int().nonnegative(), materializationId: z.uuid().nullable(), closure: SourcePreparationClosureSchema.nullable(),
}).strict()
export const SourcePreparationReconcileResultSchema = z.object({ value: SourcePreparationSchema, replayed: z.boolean() }).strict()

export const SourceRootListInputSchema = z.object({ workspaceId: IdSchema, limit: z.number().int().positive().max(100).default(100) }).strict()
export const SourceRootListResultSchema = z.object({ items: z.array(SourceRootRecordSchema).max(100), readiness: z.literal('metadata-only') }).strict()

export const SourceCwdAttestationSchema = z.object({ version: z.literal(1), materializationId: z.uuid(),
  executionId: IdSchema, attemptId: IdSchema, operationId: IdSchema, sourceBindingHash: SourceHashSchema,
  relativeCwd: z.string().max(1024), canonicalCwd: z.string().startsWith('/'), filesystem: RootFilesystemIdentitySchema,
  directoryIdentityHash: SourceHashSchema, accessMode: z.enum(['read-only', 'exclusive-write']), attestationDigest: SourceHashSchema,
}).strict()

export const VerifiedSourceWorkingTreeSchema = z.object({ materializationId: z.uuid(), materializationDigest: SourceHashSchema,
  canonicalProjectRoot: z.string().startsWith('/'), canonicalCwd: z.string().startsWith('/'), directoryIdentityHash: SourceHashSchema,
  filesystem: z.object({ device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/), mountId: z.string().regex(/^\d+$/) }).strict(),
  accessMode: z.enum(['read-only', 'exclusive-write']),
  cwdAttestation: SourceCwdAttestationSchema.optional(),
  privateGit: z.object({ gitDirectory: z.string().startsWith('/'), generatedCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/), sourceCommit: z.string().nullable() }).strict().nullable(),
}).strict()
export type VerifiedSourceWorkingTree = z.infer<typeof VerifiedSourceWorkingTreeSchema>
