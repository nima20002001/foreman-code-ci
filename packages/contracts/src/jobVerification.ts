import { z } from 'zod'
import {
  DeviceDigestSchema, DeviceSafeIntegerSchema, DeviceExecutionAdmissionFields, validateHistoricalDeviceExecutionAdmission,
} from './deviceResources.js'
import {
  AcceptedJobSpecSchema, JobDefinitionSchema, JobDefinitionSpecSchema, JobDefinitionSaveSchema, JobOutputSpecSchema,
  JobProcessStateSchema, JobTargetSchema, ResolvedJobDefinitionSpecSchema, AutoJobDefinitionSpecSchema, JobExecutionSchema,
  PreparedJobSpecSchema, JobAuthoringChoicesSchema, JobPolicySchema, JobPolicyRequirementsSchema,
  validateJobDefinitionPaths,
} from './jobs.js'
import {
  JobResourceRequestSchema, JobVerificationPolicySchema, JobVerificationPolicyRequirementsSchema,
  JobVerificationProfileIdentitySchema,
  JobVerificationLifecycleSchema, verificationJobLifecycle,
  JOB_VERIFICATION_INITIAL_CONCURRENCY, JOB_VERIFICATION_OWNER_CONFIGURATION, qualificationIntegrationShards,
} from './jobVerificationPolicy.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
import { JobDependencyBasisSchema } from './jobVerificationSeed.js'

const JOB_VERIFICATION_SUITES = [
  'install', 'typecheck', 'lint', 'unit', 'build', 'integration', 'browser', 'native-acceptance', 'full-gate-local',
] as const
export const JobVerificationSuiteSchema = z.enum(JOB_VERIFICATION_SUITES)
/** One slice of a suite's integration files: a CI run split across computers runs each slice as its own Job. */
const JobVerificationPartitionSchema = z.object({
  index: DeviceSafeIntegerSchema, count: DeviceSafeIntegerSchema.min(2).max(12),
}).strict().refine(value => value.index < value.count, 'The partition index must be below its count.')
export const JobVerificationParametersSchema = z.object({
  unitWorkers: DeviceSafeIntegerSchema.min(1).max(256),
  integrationShards: DeviceSafeIntegerSchema.min(1).max(64),
  partition: JobVerificationPartitionSchema.optional(),
}).strict()
const JobVerificationOutputSchema = JobOutputSpecSchema.extend({
  kind: z.enum(['suite-summary', 'junit', 'vitest-json', 'logs-archive', 'traces-archive']),
  maxBytes: DeviceSafeIntegerSchema.positive(),
}).strict().superRefine((output, context) => {
  const mediaTypes = {
    'suite-summary': ['application/json'], 'junit': ['application/xml'], 'vitest-json': ['application/json'],
    'logs-archive': ['application/zip', 'application/gzip'], 'traces-archive': ['application/zip', 'application/gzip'],
  }
  if (!mediaTypes[output.kind].includes(output.mediaType)) {
    context.addIssue({ code: 'custom', message: 'Report kind requires its declared media type.' })
  }
})
export const JobVerificationOutputsSchema = z.array(JobVerificationOutputSchema).min(1).max(64)
  .superRefine((outputs, context) => {
    if (new Set(outputs.map(output => output.path)).size !== outputs.length
      || outputs.filter(output => output.kind === 'suite-summary' && output.required).length !== 1) {
      context.addIssue({ code: 'custom', message: 'Declare unique paths and one required suite summary.' })
    }
  })
const JobVerificationRequestSchema = z.object({
  suite: JobVerificationSuiteSchema,
  parameters: JobVerificationParametersSchema,
  resources: JobResourceRequestSchema,
  credentialRefs: z.array(z.object({
    id: IdSchema, version: DeviceSafeIntegerSchema.positive(), scopeDigest: DeviceDigestSchema,
  }).strict()).max(32),
}).strict().superRefine((value, context) => {
  if (value.suite !== 'native-acceptance' && value.suite !== 'full-gate-local' && value.credentialRefs.length) {
    context.addIssue({ code: 'custom', message: 'Ordinary verification cannot receive provider credentials.' })
  }
})

export const JobOrdinaryVerificationSuiteSchema = z.enum(['install', 'typecheck', 'lint', 'unit', 'build', 'integration'])
const JobVerificationTemplateSchema = z.object({
  profileId: IdSchema,
  hostRef: JobTargetSchema.shape.hostRef.optional(),
  profileRevision: DeviceSafeIntegerSchema.positive(),
  suite: JobOrdinaryVerificationSuiteSchema,
  ready: z.boolean(),
  policy: JobVerificationPolicyRequirementsSchema,
  resources: JobResourceRequestSchema,
  parameters: JobVerificationParametersSchema,
  maxUnitWorkers: DeviceSafeIntegerSchema.min(1).max(JOB_VERIFICATION_OWNER_CONFIGURATION.unitWorkers),
  maxIntegrationShards: DeviceSafeIntegerSchema.min(1).max(64).optional(),
  argv: z.tuple([z.literal('node'), z.literal('/opt/graphql-ci/verification/verify-repository.mjs'),
    z.literal('--context'), z.literal('.graphql-job-inputs/verification.json')]),
  outputs: JobVerificationOutputsSchema.nullable(),
  setupIssue: z.literal('report_budget_insufficient').optional(),
}).strict().superRefine((value, context) => {
  const insufficient = value.policy.maxOutputBytes < 4
  if (insufficient !== (value.setupIssue === 'report_budget_insufficient')
    || insufficient !== (value.outputs === null) || (insufficient && value.ready)) {
    context.addIssue({ code: 'custom', message: 'An insufficient report budget retains its setup issue and no report configuration.' })
  }
  if (value.outputs && value.outputs.reduce((bytes, output) => bytes + output.maxBytes, 0) > value.policy.maxOutputBytes) {
    context.addIssue({ code: 'custom', message: 'Template reports must fit the saved output budget.' })
  }
  if (value.parameters.integrationShards > (value.maxIntegrationShards ?? 1)) {
    context.addIssue({ code: 'custom', message: 'Template shards must fit the qualified integration allowance.' })
  }
  if (value.parameters.unitWorkers > value.maxUnitWorkers) {
    context.addIssue({ code: 'custom', message: 'Template parameters must fit the qualified worker allowance.' })
  }
})
type JobVerificationTemplate = z.infer<typeof JobVerificationTemplateSchema>

export function jobVerificationTemplate(input: Omit<JobVerificationTemplate, 'argv' | 'outputs' | 'parameters' | 'setupIssue'>) {
  const reportBytes = Math.floor(input.policy.maxOutputBytes / 4)
  // Qualification measures how many workers the envelope sustains; Jobs use all of them.
  const parameters = { unitWorkers: Math.max(JOB_VERIFICATION_INITIAL_CONCURRENCY.unitWorkers, input.maxUnitWorkers),
    integrationShards: input.suite === 'integration'
      ? Math.min(input.maxIntegrationShards ?? 1, qualificationIntegrationShards(input.resources))
      : JOB_VERIFICATION_INITIAL_CONCURRENCY.integrationShards }
  const argv = ['node', '/opt/graphql-ci/verification/verify-repository.mjs', '--context', '.graphql-job-inputs/verification.json']
  if (!reportBytes) return JobVerificationTemplateSchema.parse({ ...input, ready: false,
    setupIssue: 'report_budget_insufficient', parameters, argv, outputs: null })
  return JobVerificationTemplateSchema.parse({
    ...input, parameters, argv,
    outputs: [
      { path: '.logs/verification/summary.json', kind: 'suite-summary', mediaType: 'application/json' },
      { path: '.logs/verification/junit.xml', kind: 'junit', mediaType: 'application/xml' },
      { path: '.logs/verification/vitest.json', kind: 'vitest-json', mediaType: 'application/json' },
      { path: '.logs/verification/logs.tar.gz', kind: 'logs-archive', mediaType: 'application/gzip' },
    ].map(output => ({ ...output, required: true, maxBytes: reportBytes })),
  })
}

const ResolvedVerificationSpec = z.object({
  ...ResolvedJobDefinitionSpecSchema.shape,
  outputs: JobVerificationOutputsSchema,
  policy: JobVerificationPolicySchema,
  verification: JobVerificationRequestSchema,
}).strict().superRefine(validateJobDefinitionPaths)
const AutoVerificationSpec = z.object({
  ...AutoJobDefinitionSpecSchema.shape,
  outputs: JobVerificationOutputsSchema,
  policy: JobVerificationPolicyRequirementsSchema,
  verification: JobVerificationRequestSchema,
  /** Resolve the image from a reviewed profile at admission; the other policy and resource limits stay saved. */
  runtimeSelection: z.literal('qualified-profile').optional(),
}).strict().superRefine(validateJobDefinitionPaths)
function validateVerificationPolicy(
  value: z.infer<typeof ResolvedVerificationSpec> | z.infer<typeof AutoVerificationSpec>,
  context: z.RefinementCtx,
): void {
  const { verification, policy } = value
  if (policy.network.mode === 'public-egress'
    && verification.suite !== 'native-acceptance' && verification.suite !== 'full-gate-local') {
    context.addIssue({ code: 'custom', path: ['policy', 'network'], message: 'Public egress requires approved acceptance.' })
  }
  if (policy.maxOutputBytes > verification.resources.reportBytes
    || policy.maxWorkerSpoolBytes > verification.resources.spoolBytes
    || value.outputs.reduce((bytes, output) => bytes + output.maxBytes, 0) > policy.maxOutputBytes) {
    context.addIssue({ code: 'custom', message: 'Policy output/spool limits exceed reserved sub-budgets.' })
  }
  if ('limits' in value && JSON.stringify(value.limits) !== JSON.stringify(verification.resources.limits)) {
    context.addIssue({ code: 'custom', path: ['limits'], message: 'Auto placement and verification reserve the same limits.' })
  }
}
export const ResolvedVerificationJobSpecSchema = ResolvedVerificationSpec.superRefine(validateVerificationPolicy)
export const AutoVerificationJobSpecSchema = AutoVerificationSpec.superRefine(validateVerificationPolicy)
const VerificationJobSpecSchema = z.union([
  ResolvedVerificationJobSpecSchema, AutoVerificationJobSpecSchema,
])
export const VerificationJobDefinitionSchema = JobDefinitionSchema.extend({
  schemaVersion: z.literal(2), spec: VerificationJobSpecSchema,
}).strict()
/** Historical build shapes are parsed unchanged and gain no verification permissions or defaults. */
export const JobDefinitionRecordSchema = z.union([JobDefinitionSchema, VerificationJobDefinitionSchema])
export const JobDefinitionSpecRecordSchema = z.union([JobDefinitionSpecSchema, VerificationJobSpecSchema])
export const JobDefinitionSaveRecordSchema = JobDefinitionSaveSchema.extend({ spec: JobDefinitionSpecRecordSchema }).strict()
export const ResolvedJobDefinitionSpecRecordSchema = z.union([
  ResolvedJobDefinitionSpecSchema, ResolvedVerificationJobSpecSchema,
])
const PreparedVerificationJobSpecSchema = z.object({
  ...ResolvedVerificationSpec.shape,
  source: PreparedJobSpecSchema.shape.source,
  computerSelection: PreparedJobSpecSchema.shape.computerSelection,
}).strict().superRefine(validateJobDefinitionPaths).superRefine(validateVerificationPolicy)
export const PreparedJobSpecRecordSchema = z.union([PreparedJobSpecSchema, PreparedVerificationJobSpecSchema])
export const JobAuthoringChoicesRecordSchema = JobAuthoringChoicesSchema.extend({
  policies: z.array(z.union([JobPolicySchema, JobVerificationPolicySchema])),
  autoPolicies: z.array(z.object({
    policy: z.union([JobPolicyRequirementsSchema, JobVerificationPolicyRequirementsSchema]),
    limits: AutoJobDefinitionSpecSchema.shape.limits,
  }).strict()).optional(),
  verificationTemplates: z.array(JobVerificationTemplateSchema).optional(),
}).strict()
export type JobAuthoringChoicesRecord = z.infer<typeof JobAuthoringChoicesRecordSchema>

export const AcceptedVerificationJobSpecSchema = z.object({
  ...AcceptedJobSpecSchema.shape,
  ...DeviceExecutionAdmissionFields,
  schemaVersion: z.literal(2),
  policy: JobVerificationPolicySchema,
  outputs: JobVerificationOutputsSchema,
  verification: JobVerificationRequestSchema,
  profile: JobVerificationProfileIdentitySchema,
  reservationId: z.uuid(),
  lifecycle: JobVerificationLifecycleSchema,
  /** Present when this commit differs from the computer's qualification commit with identical dependency files. */
  dependencyBasis: JobDependencyBasisSchema.optional(),
}).strict().superRefine(validateHistoricalDeviceExecutionAdmission).superRefine((value, context) => {
  validateJobDefinitionPaths(value, context)
  validateVerificationPolicy(value, context)
  const { profile, policy } = value
  if (JSON.stringify(value.lifecycle) !== JSON.stringify(verificationJobLifecycle(value.lifecycle.dispatchAt, policy))) {
    context.addIssue({ code: 'custom', message: 'Verification deadlines retain the original dispatch budget.' })
  }
  if (profile.profileId !== policy.isolationPolicyId || profile.profileRevision !== policy.isolationPolicyRevision
    || profile.imageDigest !== policy.imageDigest || profile.toolchainDigest !== policy.toolchainDigest
    || JSON.stringify(profile.network) !== JSON.stringify(policy.network)) {
    context.addIssue({ code: 'custom', message: 'Accepted execution must retain the qualified policy and image.' })
  }
}).readonly()
export const JobAcceptedSpecRecordSchema = z.union([AcceptedJobSpecSchema, AcceptedVerificationJobSpecSchema])
export const VerificationJobExecutionSchema = z.object({
  ...JobExecutionSchema.shape, schemaVersion: z.literal(2), acceptedSpec: AcceptedVerificationJobSpecSchema,
}).strict()
export const JobExecutionRecordSchema = z.union([JobExecutionSchema, VerificationJobExecutionSchema])
const Counts = z.object({
  total: DeviceSafeIntegerSchema, passed: DeviceSafeIntegerSchema,
  failed: DeviceSafeIntegerSchema, skipped: DeviceSafeIntegerSchema,
}).strict().refine(value => value.total === value.passed + value.failed + value.skipped, 'Case totals must reconcile.')
export const JobVerificationReportSchema = z.object({
  schemaVersion: z.literal(1),
  commit: ResolvedJobDefinitionSpecSchema.shape.source.shape.commit,
  manifestDigest: DeviceDigestSchema,
  definitionVersionId: IdSchema,
  suite: JobVerificationSuiteSchema,
  executionId: IdSchema,
  attemptId: IdSchema,
  target: JobTargetSchema,
  profile: JobVerificationProfileIdentitySchema,
  resources: JobResourceRequestSchema,
  parameters: JobVerificationParametersSchema,
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema,
  totals: Counts,
  firstPassFailed: DeviceSafeIntegerSchema,
  expectedPortions: DeviceSafeIntegerSchema.positive(),
  completedPortions: DeviceSafeIntegerSchema,
  disallowedSkipped: DeviceSafeIntegerSchema,
  completeness: z.enum(['complete', 'partial']),
  outcome: z.enum(['passed', 'failed', 'cancelled', 'timed_out', 'incomplete']),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)
    || value.completedPortions > value.expectedPortions || value.disallowedSkipped > value.totals.skipped) {
    context.addIssue({ code: 'custom', message: 'Report timing, portions and skipped counts must reconcile.' })
  }
  if (value.completeness === 'complete' && value.completedPortions !== value.expectedPortions) {
    context.addIssue({ code: 'custom', message: 'A complete report includes every required portion.' })
  }
  if (value.outcome === 'passed' && (value.completeness !== 'complete' || value.totals.failed
    || value.firstPassFailed || value.disallowedSkipped)) {
    context.addIssue({ code: 'custom', message: 'A pass requires complete first-pass success without disallowed skips.' })
  }
})

const JobVerificationReportIdentitySchema = z.object({
    commit: JobVerificationReportSchema.shape.commit, manifestDigest: DeviceDigestSchema,
    definitionVersionId: IdSchema, suite: JobVerificationSuiteSchema, executionId: IdSchema, attemptId: IdSchema,
    target: JobTargetSchema, profile: JobVerificationProfileIdentitySchema,
    resources: JobResourceRequestSchema, parameters: JobVerificationParametersSchema,
}).strict()
function validateReportIdentity(value: { report: z.infer<typeof JobVerificationReportSchema>;
  expected: z.infer<typeof JobVerificationReportIdentitySchema> }, context: z.RefinementCtx) {
  for (const field of Object.keys(value.expected) as (keyof typeof value.expected)[]) {
    if (JSON.stringify(value.report[field]) !== JSON.stringify(value.expected[field])) {
      context.addIssue({ code: 'custom', path: ['report', field], message: 'Report differs from accepted execution facts.' })
    }
  }
}
export const JobVerificationReportReadSchema = z.object({
  report: JobVerificationReportSchema, expected: JobVerificationReportIdentitySchema,
}).strict().superRefine(validateReportIdentity)

/** Exit zero alone cannot satisfy a suite or a commit gate. */
export const JobVerificationPassSchema = z.object({
  report: JobVerificationReportSchema,
  expected: JobVerificationReportIdentitySchema,
  process: JobProcessStateSchema,
  publication: z.literal('complete'),
  requiredOutputsVerified: z.literal(true),
}).strict().superRefine((value, context) => {
  if (value.process.phase !== 'terminal' || value.process.outcome !== 'succeeded'
    || !value.process.processStopped || value.report.outcome !== 'passed') {
    context.addIssue({ code: 'custom', message: 'Passing verification requires a confirmed closed successful process.' })
  }
  validateReportIdentity(value, context)
})
export type JobVerificationReport = z.infer<typeof JobVerificationReportSchema>
export type AcceptedVerificationJobSpec = z.infer<typeof AcceptedVerificationJobSpecSchema>
export type JobDefinitionRecord = z.infer<typeof JobDefinitionRecordSchema>
export type JobDefinitionSpecRecord = z.infer<typeof JobDefinitionSpecRecordSchema>
export type JobDefinitionSaveRecord = z.infer<typeof JobDefinitionSaveRecordSchema>
export type ResolvedJobDefinitionSpecRecord = z.infer<typeof ResolvedJobDefinitionSpecRecordSchema>
export type PreparedJobSpecRecord = z.infer<typeof PreparedJobSpecRecordSchema>
export type JobExecutionRecord = z.infer<typeof JobExecutionRecordSchema>
export type JobAcceptedSpecRecord = z.infer<typeof JobAcceptedSpecRecordSchema>

export function isAutoJobSpecRecord(spec: JobDefinitionSpecRecord): spec is
  z.infer<typeof AutoJobDefinitionSpecSchema> | z.infer<typeof AutoVerificationJobSpecSchema> {
  return 'kind' in spec.target && spec.target.kind === 'auto'
}

export function jobPolicyRequirementsRecord(policy: AcceptedVerificationJobSpec['policy']):
  z.infer<typeof JobVerificationPolicyRequirementsSchema>
export function jobPolicyRequirementsRecord(policy: z.infer<typeof AcceptedJobSpecSchema>['policy']):
  z.infer<typeof JobPolicyRequirementsSchema>
export function jobPolicyRequirementsRecord(policy: JobAcceptedSpecRecord['policy']):
  z.infer<typeof JobVerificationPolicyRequirementsSchema> | z.infer<typeof JobPolicyRequirementsSchema>
export function jobPolicyRequirementsRecord(policy: JobAcceptedSpecRecord['policy']) {
  const { isolationPolicyId, isolationPolicyRevision, ...requirements } = policy
  void isolationPolicyId
  void isolationPolicyRevision
  return requirements
}

const WorkflowJobCursorSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.string().min(1),
}).strict()
export const WorkflowJobListInputSchema = z.object({
  limit: z.number().int().min(1).max(50).default(50),
  cursor: WorkflowJobCursorSchema.optional(),
}).strict()
export const WorkflowJobPageSchema = z.object({
  workspaceId: z.string().min(1),
  workflowId: z.string().min(1),
  items: z.array(z.object({ name: z.string().min(1), execution: JobExecutionRecordSchema }).strict()).max(50),
  nextCursor: WorkflowJobCursorSchema.nullable(),
}).strict()
export type WorkflowJobListInput = z.input<typeof WorkflowJobListInputSchema>
export type WorkflowJobPage = z.infer<typeof WorkflowJobPageSchema>
