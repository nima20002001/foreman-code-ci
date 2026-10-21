import { SourceRootReferenceSchema } from './worktreeSettings.js'
import { SourceWorktreeRequestSchema } from './sourceMaterialization.js'
import { z } from 'zod'
import { DeviceProvisioningHostReferenceSchema, HistoricalDeviceExecutionAdmissionFields, DeviceExecutionAdmissionFields,
  validateHistoricalDeviceExecutionAdmission } from './deviceResources.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import { SourcePinSchema, SourceMaterializationRecordSchema, VerifiedSourceWorkingTreeSchema } from './sourceAdmission.js'
import { GraphIdSchema, IdSchema } from './schemaPrimitives.js'
import { WorkflowArtifactOutputsV1Schema } from './workflowArtifactDeclarations.js'
import { AcceptedProviderAccountBindingSchema } from './providerAccounts.js'
import { ResultProtocolSchema } from './coordinationResult.js'

export const PlacementDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const Revision = z.string().regex(/^[1-9][0-9]*$/)
export const MachineReferenceSchema = DeviceProvisioningHostReferenceSchema
export const SavedNodePlacementSchema = z.object({
  schemaVersion: z.literal(1), hostRef: MachineReferenceSchema,
  rootPolicyId: IdSchema, rootPolicyRevision: Revision, locationRevision: Revision,
  projectRoot: z.string().min(1), cwdPolicy: z.enum(['project-root', 'project-subdirectory']),
  relativeCwd: z.string(), instanceId: IdSchema, instanceRevision: IdSchema,
  harnessInstallationId: IdSchema,
  source: SourcePinSchema.optional(),
  rootBinding: SourceRootReferenceSchema.optional(),
}).strict()
export type SavedNodePlacement = z.infer<typeof SavedNodePlacementSchema>
export const AcceptedDestinationSchema = z.object({
  canonicalProjectRoot: z.string().startsWith('/'), canonicalCwd: z.string().startsWith('/'),
  managedRuntimeRoot: z.string().startsWith('/'), directoryIdentityHash: PlacementDigestSchema,
  rootPolicyId: IdSchema, rootPolicyRevision: Revision, locationRevision: Revision,
  attestationId: IdSchema, attestationHash: PlacementDigestSchema,
}).strict()
const AgentPayload = z.object({
  /** Future result envelope, pinned into the immutable launch binding only at producer cutover. */
  resultProtocol: ResultProtocolSchema.optional(),
  accountBinding: AcceptedProviderAccountBindingSchema.optional(),
  worktree: SourceWorktreeRequestSchema.optional(),
  kind: z.literal('agent'), agentId: IdSchema, agentConfigurationVersionId: IdSchema,
  driverId: IdSchema, driverRevision: IdSchema, instanceId: IdSchema, instanceRevision: IdSchema,
  harnessInstallationId: IdSchema, installationFingerprint: IdSchema,
  runtimeContractVersion: z.literal(1), protocolRevision: IdSchema,
  credentialScopeRefs: z.array(IdSchema),
  /** Exact saved declaration, admitted before the immutable placement hash. */
  artifactOutputs: WorkflowArtifactOutputsV1Schema.optional(),
  profileProofDigest: PlacementDigestSchema.optional(), qualificationDigest: PlacementDigestSchema.optional(),
}).strict()
const JobPayload = z.object({
  kind: z.literal('job'), jobConfigurationVersionId: IdSchema, scriptDigest: PlacementDigestSchema,
  argv: z.array(z.string()), environmentScopeRefs: z.array(IdSchema),
  isolationPolicyId: IdSchema, outputSpecDigest: PlacementDigestSchema,
}).strict()
export const AcceptedNodePlacementSchema = z.object({
  schemaVersion: z.literal(1), mainId: z.uuid(), runId: IdSchema, nodeId: GraphIdSchema,
  hostRef: MachineReferenceSchema, labelAtAcceptance: z.string().min(1).optional(),
  /** null only for original main-local installation; never invent device evidence. */
  registration: z.object({ workerInstallationId: z.uuid(), keyRevision: z.number().int().positive(),
    authorizationRevision: z.number().int().positive() }).strict().nullable(),
  mainInstallationId: IdSchema, destination: AcceptedDestinationSchema,
  source: z.union([z.object({ revisionId: IdSchema, manifestDigest: PlacementDigestSchema,
    materializationId: IdSchema, materializationDigest: PlacementDigestSchema }).strict(),
    z.object({ kind: z.literal('pending'), approvedSourceId: z.uuid(), snapshotId: z.uuid(),
      revisionId: IdSchema, manifestDigest: PlacementDigestSchema, rootId: z.uuid(), bindingRevision: z.number().int().positive(),
      materializationId: z.null(), materializationDigest: z.null() }).strict()]),
  ...HistoricalDeviceExecutionAdmissionFields,
  payload: z.discriminatedUnion('kind', [AgentPayload, JobPayload]), bindingHash: PlacementDigestSchema,
}).strict().superRefine((value, context) => {
  validateHistoricalDeviceExecutionAdmission(value, context)
  if (value.mainId !== value.hostRef.mainId || (value.hostRef.kind === 'device') !== (value.registration !== null)) {
    context.addIssue({ code: 'custom', message: 'Placement main/registration identity mismatch.' })
  }
})
/** New execution entry requires policy and revocable device approval; the base schema is immutable history. */
export const CurrentAcceptedNodePlacementSchema = AcceptedNodePlacementSchema.safeExtend(DeviceExecutionAdmissionFields)
export type AcceptedNodePlacement = z.infer<typeof AcceptedNodePlacementSchema>
export const DispatchIntentSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), mainId: z.uuid(), runId: IdSchema,
  nodeId: GraphIdSchema, executionId: IdSchema, occurrenceId: IdSchema.nullable(),
  occurrenceIndex: z.number().int().nonnegative(), technicalAttempt: z.number().int().positive(), attemptId: IdSchema, operationId: IdSchema,
  ...HistoricalDeviceExecutionAdmissionFields,
  bindingHash: PlacementDigestSchema, inputDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  owner: z.object({ grantId: IdSchema, epoch: Revision }).strict(),
}).strict()
export const CurrentDispatchIntentSchema = DispatchIntentSchema.safeExtend(DeviceExecutionAdmissionFields)
export type DispatchIntent = z.infer<typeof DispatchIntentSchema>
export const WorkerObservationSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), operationId: IdSchema,
  attemptId: IdSchema, executionId: IdSchema, bindingHash: PlacementDigestSchema,
  connection: DeviceConnectionIdentitySchema, workerIncarnationId: z.uuid(), sequence: Revision,
  phase: z.enum(['accepted', 'entered', 'running', 'terminal']),
  native: z.object({ processId: z.number().int().positive().optional(), processStartedAt: z.string().datetime().optional(),
    sessionId: IdSchema.optional(), turnId: IdSchema.optional(), containerId: IdSchema.optional(),
    exitCode: z.number().int().optional() }).strict().optional(),
  resultDigest: PlacementDigestSchema.optional(), artifactDigests: z.array(PlacementDigestSchema),
}).strict()
export type WorkerObservation = z.infer<typeof WorkerObservationSchema>
export const OwnerControlSchema = z.object({
  schemaVersion: z.literal(1), protocolVersion: z.literal(1), commandId: IdSchema,
  operationId: IdSchema, attemptId: IdSchema, executionId: IdSchema, bindingHash: PlacementDigestSchema,
  owner: z.object({ grantId: IdSchema, epoch: Revision }).strict(),
  nativeTarget: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('session'), sessionId: IdSchema, turnId: IdSchema.optional() }).strict(),
    z.object({ kind: z.literal('process'), processId: z.number().int().positive(), processStartedAt: z.string().datetime() }).strict(),
  ]).optional(),
  action: z.discriminatedUnion('kind', [z.object({ kind: z.literal('stop') }).strict(),
    z.object({ kind: z.literal('respond'), interactionId: IdSchema, interactionRevision: Revision,
      nativeInteractionId: IdSchema, response: z.json() }).strict()]),
}).strict()
export type OwnerControl = z.infer<typeof OwnerControlSchema>
/** A read projection never infers observed execution from an accepted placement. */
export const NodePlacementReadbackSchema = z.discriminatedUnion('evidence', [
  z.object({ evidence: z.literal('accepted'), placement: AcceptedNodePlacementSchema,
    nativePlacements: z.array(z.lazy(() => NativeExecutionPlacementSchema)).optional(),
    observations: z.array(WorkerObservationSchema) }).strict(),
  z.object({ evidence: z.literal('legacy_missing'), originalMainInstallationId: IdSchema.nullable() }).strict(),
])
export interface PlacementDispatchPort {
  deliver(intent: DispatchIntent, placement: AcceptedNodePlacement): Promise<void>
  reconcile(intent: DispatchIntent, placement: AcceptedNodePlacement): Promise<WorkerObservation | null>
  control(command: OwnerControl, placement: AcceptedNodePlacement): Promise<void>
}

/** Lazy verified clone; separate from immutable Run root/source pins and native
 * ownership. No accepted-but-unstarted node claims materialization occurred. */
export const NativeExecutionPlacementSchema = z.object({ version: z.literal(1),
  acceptedBindingHash: PlacementDigestSchema, runId: IdSchema, nodeId: GraphIdSchema,
  executionId: IdSchema, attemptId: IdSchema, operationId: IdSchema,
  materialization: SourceMaterializationRecordSchema, workingTree: VerifiedSourceWorkingTreeSchema,
  bindingHash: PlacementDigestSchema,
}).strict()
export type NativeExecutionPlacement = z.infer<typeof NativeExecutionPlacementSchema>
