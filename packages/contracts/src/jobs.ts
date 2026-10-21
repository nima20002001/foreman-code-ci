import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { HistoricalDeviceExecutionAdmissionFields, DeviceExecutionAdmissionFields, validateHistoricalDeviceExecutionAdmission } from './deviceResources.js'
import { AcceptedNodePlacementSchema, PlacementDigestSchema } from './nodePlacement.js'
import { JobArtifactMediaTypeSchema, JobArtifactRetentionSchema } from './jobArtifacts.js'
import { IdSchema, TimestampSchema, RunInputSchema } from './schemaPrimitives.js'

const Revision = z.number().int().positive()
const RelativePath = z.string().min(1).max(1024).refine(path =>
  !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.' || part === '') && !path.includes('\\') && !path.includes('\0'), 'Expected a bounded relative path.')
export function validateJobDefinitionPaths(
  spec: { inputs: { path: string }[]; outputs: { path: string }[] },
  context: z.RefinementCtx,
): void {
  if (new Set(spec.inputs.map(input => input.path)).size !== spec.inputs.length) {
    context.addIssue({ code: 'custom', path: ['inputs'], message: 'Immutable input paths must be unique.' })
  }
  if (new Set(spec.outputs.map(output => output.path)).size !== spec.outputs.length) {
    context.addIssue({ code: 'custom', path: ['outputs'], message: 'Accepted output paths must be unique.' })
  }
}
export const JobDefinitionSourceSchema = z.object({
  approvedSourceId: z.uuid(), snapshotId: z.uuid(), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  manifestDigest: PlacementDigestSchema,
}).strict()
const JobSourceSchema=JobDefinitionSourceSchema.extend({materializationId:z.uuid(),materializationDigest:PlacementDigestSchema}).strict()
export const JobInputRevisionSchema = z.object({
  path:RelativePath, fileId: IdSchema, revisionId: IdSchema, sha256: PlacementDigestSchema, byteSize: z.number().int().nonnegative(),
}).strict()
export const JobPolicySchema = z.object({
  isolationPolicyId: IdSchema, isolationPolicyRevision: Revision, imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  toolchainDigest: PlacementDigestSchema, environmentScopeRefs: z.array(IdSchema).max(32),
  network: z.enum(['none', 'approved-dependency-fetch']),
  queueTimeoutMs: z.number().int().positive(), preparationTimeoutMs: z.number().int().positive(), executionTimeoutMs: z.number().int().positive(),
  cancellationGraceMs: z.number().int().nonnegative(), maxLogChunkBytes: z.number().int().positive().max(65536),
  maxLogBytes: z.number().int().positive(), maxWorkerSpoolBytes: z.number().int().positive(),
  logOverflow: z.enum(['stop', 'explicit-truncation']), maxOutputBytes: z.number().int().positive(), retentionSeconds: JobArtifactRetentionSchema,
}).strict()
export const JobPolicyRequirementsSchema = JobPolicySchema.omit({
  isolationPolicyId: true, isolationPolicyRevision: true,
})
export function jobPolicyRequirements(policy: z.infer<typeof JobPolicySchema>): z.infer<typeof JobPolicyRequirementsSchema> {
  return JobPolicyRequirementsSchema.parse(Object.fromEntries(Object.entries(policy).filter(
    ([key]) => key !== 'isolationPolicyId' && key !== 'isolationPolicyRevision',
  )))
}
export const JobRuntimeLimitsSchema = z.object({
  cpuLimit: z.number().positive().max(256), memoryBytes: z.number().int().positive(),
  pidsLimit: z.number().int().positive(), diskBytes: z.number().int().positive(),
}).strict()
export const JobOutputSpecSchema = z.object({
  path: RelativePath, required: z.boolean(), mediaType: JobArtifactMediaTypeSchema,
}).strict()
/** Job targets reuse W08 identity/root binding without inventing a Run or Agent. */
const placement = AcceptedNodePlacementSchema.shape
export const JobTargetSchema = z.object({
  schemaVersion: placement.schemaVersion, mainId: placement.mainId, hostRef: placement.hostRef,
  labelAtAcceptance: placement.labelAtAcceptance, registration: placement.registration,
  mainInstallationId: placement.mainInstallationId, destination: placement.destination,
}).strict().superRefine((value, context) => {
  if (value.mainId !== value.hostRef.mainId || (value.hostRef.kind === 'device') !== (value.registration !== null)) {
    context.addIssue({code:'custom',message:'Job target main/registration identity mismatch.'})
  }
})
export const ResolvedJobDefinitionSpecSchema = z.object({
  source: JobDefinitionSourceSchema, target: JobTargetSchema, argv: z.array(z.string().max(8192)).min(1).max(128),
  relativeCwd: RelativePath.optional(), inputs: z.array(JobInputRevisionSchema).max(128),
  policy: JobPolicySchema, outputs: z.array(JobOutputSpecSchema).max(64),
}).strict().superRefine(validateJobDefinitionPaths)
export const AutoJobDefinitionSpecSchema = z.object({
  ...ResolvedJobDefinitionSpecSchema.shape,
  target: z.object({ kind: z.literal('auto') }).strict(),
  policy: JobPolicyRequirementsSchema,
  limits: JobRuntimeLimitsSchema,
}).strict().superRefine(validateJobDefinitionPaths)
export const JobDefinitionSpecSchema = z.union([ResolvedJobDefinitionSpecSchema, AutoJobDefinitionSpecSchema])
export type ResolvedJobDefinitionSpec = z.infer<typeof ResolvedJobDefinitionSpecSchema>
type AutoJobDefinitionSpec = z.infer<typeof AutoJobDefinitionSpecSchema>
export function isAutoJobSpec(spec: JobDefinitionSpec): spec is AutoJobDefinitionSpec {
  return 'kind' in spec.target && spec.target.kind === 'auto'
}
export const JobComputerSelectionSchema = z.object({
  mode: z.enum(['auto', 'fixed']), buildPriority: z.number().int().min(0).max(100),
  settingsRevision: z.number().int().nonnegative(),
}).strict()
export const JobDefinitionSchema = z.object({
  schemaVersion: z.literal(1), id: IdSchema, workspaceId: IdSchema, name: z.string().trim().min(1).max(200),
  revision: Revision, versionId: IdSchema, spec: JobDefinitionSpecSchema, createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict()
export const JobDefinitionSaveSchema = z.object({
  commandId: optionalCommandId(IdSchema), id: IdSchema.optional(), expectedRevision: Revision.nullable(), name: z.string().trim().min(1).max(200), spec: JobDefinitionSpecSchema,
}).strict()
export const JobStartSchema = z.object({ commandId: IdSchema, definitionId: IdSchema, expectedRevision: Revision }).strict()
export const PreparedJobSpecSchema=ResolvedJobDefinitionSpecSchema.safeExtend({
  source:JobSourceSchema, computerSelection: JobComputerSelectionSchema.optional(),
}).strict()
export type PreparedJobSpec=z.infer<typeof PreparedJobSpecSchema>
export const AcceptedJobSpecSchema = PreparedJobSpecSchema.safeExtend({
  ...HistoricalDeviceExecutionAdmissionFields,
  workflowInput:RunInputSchema.nullable(),
  definitionId: IdSchema, definitionRevision: Revision, definitionVersionId: IdSchema,
  scriptDigest: PlacementDigestSchema, outputSpecDigest: PlacementDigestSchema, specDigest: PlacementDigestSchema, bindingHash: PlacementDigestSchema,
}).strict().superRefine(validateHistoricalDeviceExecutionAdmission)
export const CurrentAcceptedJobSpecSchema = AcceptedJobSpecSchema.safeExtend(DeviceExecutionAdmissionFields)
export const JobProcessStateSchema = z.object({
  phase: z.enum(['queued', 'preparing', 'running', 'terminal']),
  outcome: z.enum(['succeeded', 'build_failed', 'cancelled', 'timed_out', 'preparation_failed', 'spawn_failed']).nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().nullable(), processStopped: z.boolean(),
}).strict().superRefine((process,context)=>{
  if((process.phase==='terminal') !== (process.outcome!==null) || (process.phase!=='terminal' && (process.exitCode!==null || process.signal!==null || process.processStopped))) {
    context.addIssue({code:'custom',message:'Process evidence does not match its phase.'})
  }
  if(process.outcome==='succeeded' && (process.exitCode!==0 || process.signal!==null)) context.addIssue({code:'custom',message:'Successful process evidence requires exit zero and no signal.'})
})
/** CI origin is separate from membership in a workflow's job graph. Set by the bound Agent service. */
export const JobInitiatingAgentSchema = z.object({
  workflowId: IdSchema,
  runId: IdSchema,
  agentId: IdSchema,
  executionId: IdSchema,
}).strict()
export type JobInitiatingAgent = z.infer<typeof JobInitiatingAgentSchema>

export const JobExecutionSchema = z.object({
  schemaVersion: z.literal(1), id: IdSchema, workspaceId: IdSchema, acceptedSpec: AcceptedJobSpecSchema,
  operationId: IdSchema, attemptId: IdSchema, owner: z.object({ grantId: IdSchema, epoch: z.string().regex(/^[1-9][0-9]*$/) }).strict(),
  workflow: z.object({ workflowId: IdSchema, runId: IdSchema, nodeId: IdSchema, nodeExecutionId: IdSchema }).strict().nullable(),
  initiatingAgent: JobInitiatingAgentSchema.optional(),
  process: JobProcessStateSchema, transport: z.enum(['connected', 'offline', 'unknown']),
  publication: z.enum(['pending', 'collecting', 'complete', 'failed', 'expired']),
  startedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(), lastSeenAt: TimestampSchema.nullable(),
  resultIssue: z.enum(['missing_output', 'corrupt_output', 'publication_failed', 'log_overflow', 'log_delivery_unknown']).nullable(),
  launchIssue: z.literal('build_disabled').optional(),
  cancelRequestedAt: TimestampSchema.nullable(), createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict()
export const CurrentJobExecutionSchema = JobExecutionSchema.safeExtend({ acceptedSpec: CurrentAcceptedJobSpecSchema })
export const JobLogChunkSchema = z.object({
  executionId: IdSchema, attemptId: IdSchema, sequence: z.number().int().positive(), stream: z.enum(['stdout', 'stderr']),
  text: z.string().max(65536), byteSize: z.number().int().nonnegative().max(65536), createdAt: TimestampSchema,
}).strict()
export const JobLogPageSchema = z.object({
  chunks: z.array(JobLogChunkSchema), nextCursor: z.number().int().nonnegative(),
  truncated: z.boolean(), gap: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }).strict().nullable(),
}).strict()
export const JobArtifactSchema = JobInputRevisionSchema.extend({
  executionId: IdSchema, publicationId: IdSchema, path: RelativePath, mediaType: z.string(), state: z.enum(['available', 'expired', 'tombstoned']),
  expiresAt: TimestampSchema,
}).strict()
export const JobArtifactReadInputSchema = z.object({
  fileId: IdSchema,
  revisionId: IdSchema,
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(1024 * 1024).default(1024 * 1024),
}).strict()
export const JobArtifactReadOutputSchema = z.object({
  artifact: JobArtifactSchema,
  encoding: z.literal('base64'),
  content: z.string(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
}).strict()
export const JobValidationSchema = z.object({ valid: z.boolean(), reasons: z.array(z.string()), sideEffects: z.literal(false) }).strict()
export type JobDefinition = z.infer<typeof JobDefinitionSchema>
export type JobDefinitionSpec = z.infer<typeof JobDefinitionSpecSchema>
export type JobStart = z.infer<typeof JobStartSchema>
export type AcceptedJobSpec = z.infer<typeof AcceptedJobSpecSchema>
export type JobExecution = z.infer<typeof JobExecutionSchema>
export type JobLogChunk = z.infer<typeof JobLogChunkSchema>
export type JobLogPage = z.infer<typeof JobLogPageSchema>
export type JobArtifact = z.infer<typeof JobArtifactSchema>
export type JobValidation = z.infer<typeof JobValidationSchema>
export const JobAuthoringChoicesSchema = z.object({
  targets: z.array(z.object({id:IdSchema,label:z.string(),target:JobTargetSchema,ready:z.boolean(),reasons:z.array(z.string())}).strict()),
  sources: z.array(JobDefinitionSourceSchema), policies: z.array(JobPolicySchema),
  autoPolicies: z.array(z.object({ policy: JobPolicyRequirementsSchema, limits: JobRuntimeLimitsSchema }).strict()).optional(),
}).strict()
