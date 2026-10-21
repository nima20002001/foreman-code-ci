import { z } from 'zod'
import { BuildComputerAllowanceSchema } from './buildComputers.js'
import { circleCreditsShape, circleSchedulingShape } from './circleCredits.js'
import { CI_LOG_MAX_BYTES, CI_MAX_RUN_TICKETS, CiCachedFileSchema, CiCollectionSchema, CiComputerRefSchema, CiActivitySchema, CiRunRecordSchema, CiSuiteSchema, CiScopeSchema, CiSelectedFilesSchema,
  CiTestResultsSchema, CiPrioritySchema, CiPriorityReasonSchema,
  CiTestStatusSchema, CiTestSummarySchema, CiUserSystemdSchema, validCiSelection } from './ciHost.js'
import { CiSelectionSchema } from './ciHost.js'
import { IdSchema } from './schemaPrimitives.js'
import { JobResourceRequestSchema } from './jobVerificationPolicy.js'
import { SourceRootRecordSchema } from './sourceAdmission.js'
import { SourceManifestSchema } from './sourceMaterialization.js'

const CiRunInputObjectSchema = z.object({
  smokeComputer: CiComputerRefSchema.optional().describe('Operator-only deployment smoke target. Requires unit or integration, '
    + 'affected scope, an explicit commit and exactly one test file. Uses normal CI grants, setup and execution; '
    + 'never falls back to a different computer.'),
  gate: z.boolean().optional().describe('Operator/orchestrator only. With suite=integration and scope=full, '
    + 'queue typecheck, lint, unit and duration-balanced integration as one gate. Gates run one at a time. '
    + 'A failed part cancels the gate’s remaining queued and running parts.'),
  priority: CiPrioritySchema.optional().describe('Defaults to normal. Callers authorized for ci can request high priority. '
    + 'Commits changing only CI infrastructure are automatically high priority.'),
  suite: CiSuiteSchema.describe('Repositories with the CI suite hook queue unit, lint, typecheck and build parts; '
    + 'other repositories run their package script for the suite as one job. Install runs one job.'),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional()
    .describe('Optional full SHA for runner-selected affected scope. Compare against this ancestor of the resolved '
      + 'commit; an unavailable or non-ancestor base falls back to the full suite with a reason.'),
  commandId: IdSchema.optional().describe('Optional retry identity; generated server-side when omitted.'),
  noSupersede: z.boolean().optional().describe('Keep this request’s tickets when newer commits arrive. '
    + 'By default, newer descendant commits supersede active tickets of the same suite and requester '
    + 'on the same branch or Agent execution. Main tickets are always kept.'),
  /** Split integration when the repository supplies its CI hook and file selector. */
  partitions: z.number().int().min(2).max(64).describe('Optional integration partition limit (2–64); otherwise sized automatically '
    + 'from measured durations and eligible fleet capacity. '
    + 'Requires scripts/ci-suite.sh and scripts/ci-files.mjs. User-systemd files use separate systemd-capable slices; '
    + 'mixed explicit selections split even when this is omitted. Other repositories run integration as one job.').optional(),
  scope: CiScopeSchema.optional().describe('Defaults to affected; full runs the complete suite. '
    + 'Affected integration uses ancestor execution coverage when usable, otherwise static import reachability; '
    + 'shared CI infrastructure changes require full scope. Read ci_get run.selection for the reason. '
    + 'Repositories without affected selection default to full only when scope and files are omitted; '
    + 'explicit affected scope or files fails with CI_SELECTION_UNSUPPORTED. Request full and omit files.'),
  files: CiSelectedFilesSchema.optional().describe('Optional affected selection of safe repository-relative paths '
    + 'with an explicit commit; no file-count cap or repository-root restriction. Omit to select '
    + 'on the runner against baseCommit or the workspace default branch; an empty list runs no tests. '
    + 'Unit and integration files whose inputs match an earlier passed ticket are skipped and listed in cachedFiles; '
    + 'full scope, gates and smoke runs always run every file.'),
}).strict()
const partitionedSuite = (value: { suite: string; partitions?: number | undefined }) =>
  value.partitions === undefined || value.suite === 'integration'
const partitionIssue = { message: 'Only the integration suite can be partitioned.', path: ['partitions'] }
const selectionIssue = { message: 'Selected files require an explicit commit, affected scope and a supported suite.', path: ['scope'] }
const selectedSuite = (value: z.infer<typeof CiRunInputObjectSchema>) => validCiSelection(value)
  && ((value.scope ?? 'affected') !== 'affected' || value.files === undefined || value.commit !== undefined)
const validGate = (value: z.infer<typeof CiRunInputObjectSchema>) => !value.gate
  || (value.suite === 'integration' && value.scope === 'full' && value.files === undefined && value.partitions === undefined)
const validSmoke = (value: z.infer<typeof CiRunInputObjectSchema>) => !value.smokeComputer
  || (['unit', 'integration'].includes(value.suite) && value.scope === 'affected' && value.commit !== undefined
    && value.files?.length === 1 && !value.gate && value.partitions === undefined)
const smokeIssue = { message: 'Computer smoke requires unit/integration, affected scope, commit and one file.', path: ['smokeComputer'] }
const gateIssue = { message: 'A gate requires integration, full scope, and no files or partition limit.', path: ['gate'] }
export const CiRunInputSchema = CiRunInputObjectSchema.refine(partitionedSuite, partitionIssue)
  .refine(selectedSuite, selectionIssue)
  .refine(validGate, gateIssue)
  .refine(validSmoke, smokeIssue)
export const OperatorCiRunInputSchema = CiRunInputObjectSchema.extend({ workspaceId: IdSchema }).strict()
  .refine(partitionedSuite, partitionIssue)
  .refine(selectedSuite, selectionIssue)
  .refine(validGate, gateIssue)
  .refine(validSmoke, smokeIssue)
const CiRunTicketSchema = z.object({ ticketId: IdSchema }).strict()
/** `partitions` lists every part or integration partition; the first is also `ticketId`. Poll each with ci_get. */
/** `cachedFiles` lists selected files skipped because an earlier passed ticket ran them with identical inputs. */
/** `joined` marks a request that joined an identical active request of the same workspace instead of queueing tickets;
 * `sharedWith` counts the other requesters still attached to that group. */
export const CiRunOutputSchema = CiRunTicketSchema.extend({ partitions: z.array(CiRunTicketSchema).min(2).max(CI_MAX_RUN_TICKETS).optional(),
  selection: CiSelectionSchema.optional().describe('Initial scope and selection reason. Runner-derived choices, '
    + 'including coverage map commits and static/full fallbacks, are reported in ci_get run.selection.'),
  cachedFiles: z.array(CiCachedFileSchema).optional(), joined: z.literal(true).optional(),
  sharedWith: z.number().int().nonnegative().optional() }).strict()
export type CiRunOutput = z.infer<typeof CiRunOutputSchema>
export const CI_SHARING_REQUESTERS_LIMIT = 100
/** Every requester of a shared ticket group: the initiator and each identical request that joined it. */
export const CiSharingSchema = z.object({ requesters: z.array(z.object({
  principalId: IdSchema, executionId: IdSchema.nullable(), initiator: z.boolean(), active: z.boolean(),
}).strict()).max(CI_SHARING_REQUESTERS_LIMIT) }).strict()
export type CiSharing = z.infer<typeof CiSharingSchema>
const CiTicketInputSchema = z.object({ ticketId: IdSchema }).strict()
/** Statuses to include; the results' summary always counts every test. */
export const CiTestStatusFilterSchema = z.array(CiTestStatusSchema).min(1).max(3)
/** Longest requested ci_get wait budget; the bridge also caps each call below the client tool deadline. */
export const CI_WAIT_MAX_SECONDS = 1800
export const CiGetInputSchema = CiTicketInputSchema.extend({
  waitSeconds: z.number().min(0).max(CI_WAIT_MAX_SECONDS).optional().describe('Defaults to 0. With waitUntil, the whole '
    + 'group wait budget (up to 1800 seconds). Without it, waits at most 60 seconds per call for this ticket’s state or '
    + 'step to change; terminal tickets return immediately. The wait ends when the MCP request is canceled.'),
  waitUntil: z.literal('group-terminal').optional().describe('Wait until every ticket of this ticket’s group is terminal '
    + 'and its test results are collected. Returns wait.status settled, or still-running with the ticket counts when the '
    + 'budget ends or the client tool deadline approaches; then call again with the same ticketId. Use one such call instead of polling.'),
  logTail: z.boolean().optional().describe('Defaults to true. Set false to omit the 32 KiB log tail while waiting; '
    + 'read logs once at the end with ci_logs_read.'),
  testStatus: CiTestStatusFilterSchema.optional().describe('Include the ticket’s structured test results, limited to '
    + 'tests with these statuses (passed, failed, skipped). tests is null until a finished unit or integration run reports them.'),
}).strict()
export type CiGetInput = z.infer<typeof CiGetInputSchema>
export const CI_FAILURE_HISTORY_LIMITS = { entries: 50, runs: 20, days: 14 } as const
export const CiFailureHistorySchema = z.object({ file: z.string().min(1), test: z.string().min(1).nullable(),
  failedRuns: z.number().int().nonnegative(), runs: z.number().int().nonnegative() }).strict()
export type CiFailureHistory = z.infer<typeof CiFailureHistorySchema>
export const OperatorCiGetInputSchema = CiGetInputSchema.extend({ workspaceId: IdSchema }).strict()
export const CiGetOutputSchema = z.object({
  run: CiRunRecordSchema,
  partitions: z.array(CiRunRecordSchema).optional().describe('Run records ordered by suite, part and numeric shard index.'),
  logTail: z.string().optional(),
  queue: z.object({ position: z.number().int().positive(), reason: z.string() }).strict().nullable().optional(),
  group: z.object({ groupId: CiRunRecordSchema.shape.groupId, state: CiRunRecordSchema.shape.state }).strict().optional(),
  /** Present when identical requests share this ticket's group. */
  sharing: CiSharingSchema.optional(),
  tests: CiTestResultsSchema.nullable().optional(),
  /** Present for waitUntil: settled when every group ticket is terminal with collection settled; otherwise still-running. */
  wait: z.object({ until: z.literal('group-terminal'), status: z.enum(['settled', 'still-running']),
    tickets: z.number().int().positive(), settledTickets: z.number().int().nonnegative() }).strict().optional(),
  /** For a failed ticket: how often each failed test (or a failed file without failed tests, test null) failed in
   * recent gate runs that ran its file, so a known flake is recognized instead of root-caused again. It never changes
   * the ticket's result. */
  failureHistory: z.array(CiFailureHistorySchema).max(CI_FAILURE_HISTORY_LIMITS.entries).optional(),
  failedFiles: CiSelectedFilesSchema.optional().describe('For a failed group, deduplicated reported failed test files '
    + 'across its parts, independent of testStatus. Pass as ci_run files with scope=affected, the same suite and an '
    + 'explicit commit; separate files by suite for multi-suite gates. Empty when no failed files were reported; '
    + 'setup failures may have no test results.'),
  gate: z.object({
    computers: z.array(z.object({ key: z.string(), ticketIds: z.array(IdSchema),
      expectedDurationMs: z.number().nonnegative(), actualDurationMs: z.number().nonnegative().nullable() }).strict()),
    suites: z.array(z.object({ suite: CiSuiteSchema, expectedDurationMs: z.number().nonnegative(),
      actualDurationMs: z.number().nonnegative().nullable() }).strict()),
    criticalPath: z.object({ computerKey: z.string().nullable(), expectedDurationMs: z.number().nonnegative(),
      actualDurationMs: z.number().nonnegative().nullable() }).strict(),
    wallTimeMs: z.number().nonnegative().nullable(),
  }).strict().optional(),
}).strict()
export type CiRunInput = z.infer<typeof CiRunInputSchema>
export const CiCancelInputSchema = CiTicketInputSchema.extend({
  commandId: IdSchema.optional().describe('Optional caller request identity recorded with cancellation; generated when omitted.'),
}).strict()
export const OperatorCiCancelInputSchema = CiCancelInputSchema.extend({ workspaceId: IdSchema }).strict()
/** `detached`: the caller left a group other requesters still share, so its tickets keep running for them. */
export const CiCancelOutputSchema = z.object({ run: CiRunRecordSchema,
  detached: z.object({ remainingRequesters: z.number().int().positive() }).strict().optional() }).strict()
export const CiTestsOutputSchema = z.object({ ticketId: IdSchema, tests: CiTestResultsSchema.nullable() }).strict()

/** Where a CI job ran: this computer fleet's Host CI, GitHub Actions or CircleCI. */
const CiPlacementSchema = z.enum(['host', 'github', 'circleci'])
export type CiPlacement = z.infer<typeof CiPlacementSchema>
/** One CI ticket an Agent of a Run requested, with that Agent's Run node. */
const CiRunJobSchema = z.object({
  ticketId: IdSchema, ci: CiActivitySchema, scope: CiScopeSchema, placement: CiPlacementSchema.nullable(),
  message: z.string().max(2000).nullable(),
  requester: z.object({ executionId: IdSchema, agentId: IdSchema, nodeId: z.string().min(1).max(200),
    nodeName: z.string().min(1).max(200) }).strict(),
  tests: CiTestSummarySchema.nullable(),
  /** `pending` while a finished ticket's logs and test results are still being collected. */
  collection: CiCollectionSchema.optional(),
}).strict()
export type CiRunJob = z.infer<typeof CiRunJobSchema>
export const CI_RUN_JOBS_LIMIT = 500
export const OperatorCiListInputSchema = z.object({
  workspaceId: IdSchema, runId: IdSchema,
  /** Filter before applying the ticket limit so other executions cannot hide this execution's jobs. */
  executionId: IdSchema.optional(),
}).strict()
export type OperatorCiListInput = z.infer<typeof OperatorCiListInputSchema>
export const CiListOutputSchema = z.object({ runId: IdSchema, jobs: z.array(CiRunJobSchema).max(CI_RUN_JOBS_LIMIT),
  /** Older tickets beyond the limit were left out. */
  truncated: z.boolean() }).strict()
export type CiListOutput = z.infer<typeof CiListOutputSchema>
export const CiLogsInputSchema = CiTicketInputSchema.extend({
  /** Omit to read the last maxBytes; continue with nextOffset. Offsets inside UTF-8 characters skip their remainder. */
  afterOffset: z.number().int().nonnegative().optional()
    .describe('Byte cursor; offsets inside UTF-8 characters skip to the next character. Continue with nextOffset.'),
  maxBytes: z.number().int().min(1).optional()
    .describe(`Defaults to ${CI_LOG_MAX_BYTES} bytes; larger values are clamped. Only complete UTF-8 characters are returned; `
      + 'increase the budget if the next character does not fit. Group reads divide this total, allowing zero-byte parts.'),
  /** Include a bounded page from every part, with a separate cursor for each ticket. */
  group: z.boolean().optional(),
}).strict()
export const OperatorCiLogsInputSchema = CiLogsInputSchema.extend({ workspaceId: IdSchema }).strict()
const CiLogSourceSchema = z.literal('saved-tail').optional().describe(
  'Previously collected output retained on Main. Byte cursors and logBytes refer to this labeled snapshot, '
  + 'not the executor log. Restart at offset 0 when the source changes.')
export const CiLogsOutputSchema = z.object({ text: z.string(), nextOffset: z.number().int().nonnegative(),
  source: CiLogSourceSchema,
  logBytes: z.number().int().nonnegative(),
  maxBytes: z.number().int().min(1).max(CI_LOG_MAX_BYTES),
  parts: z.array(z.object({ run: CiRunRecordSchema, text: z.string(), nextOffset: z.number().int().nonnegative(),
    source: CiLogSourceSchema,
    logBytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative().max(CI_LOG_MAX_BYTES) }).strict()).optional(),
}).strict()
export const CiQueueEntrySchema = z.object({
  ticketId: IdSchema, priority: CiPrioritySchema, priorityReason: CiPriorityReasonSchema,
  position: z.number().int().positive(), reason: z.string(),
}).strict()
export const CiComputersOutputSchema = z.object({
  queue: z.array(CiQueueEntrySchema).optional(), queueTruncated: z.boolean().optional(),
  computers: z.array(z.object({
  label: z.string(), hostRef: CiRunRecordSchema.shape.computer.unwrap().shape.hostRef,
  priority: z.number().int(), ready: z.boolean(), reasons: z.array(z.string()),
  buildAllowancePercent: BuildComputerAllowanceSchema.optional(),
  allowedCpuCount: z.number().int().positive().optional(),
  cpuCount: z.number().int().positive().optional(), memoryBytes: z.number().int().positive().optional(),
  availableMemoryBytes: z.number().int().nonnegative().optional(),
  userSystemd: CiUserSystemdSchema.optional(),
  slotsUsed: z.number().int().nonnegative(), slotsTotal: z.number().int().nonnegative(),
  running: z.array(z.string()).optional(),
  /** CircleCI accounts only: estimated monthly credits left. */
  ...circleCreditsShape,
  ...circleSchedulingShape,
}).strict()) }).strict()

export * from './ciEnrollment.js'
import { CiInstalledStorageSchema, CiManagedSetupSchema } from './ciEnrollment.js'

const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const AbsolutePathSchema = z.string().min(2).max(4096).startsWith('/')
/** Build computers prepare their own CI runtime for a commit: offline seed, image and qualification source. */
export const CI_RUNTIME_NAMESPACE = 'ci-runtime-v1'
const CiPreparationLimitsSchema = z.object({
  cpuCount: z.number().positive(), memoryBytes: z.number().int().positive(),
}).strict()
export type CiPreparationLimits = z.infer<typeof CiPreparationLimitsSchema>
export const CiCacheStatusSchema = z.object({
  status: z.enum(['hit', 'miss', 'invalid']), lastError: z.string().max(500).nullable(),
  missCount: z.number().int().nonnegative(), rebuildCount: z.number().int().nonnegative(),
}).strict()
export type CiCacheStatus = z.infer<typeof CiCacheStatusSchema>
export const PreparedCiRuntimeSchema = z.object({
  commit: CommitSchema, imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/), imageManifestDigest: z.string().min(1).max(200),
  seedReceiptPath: AbsolutePathSchema, contextReceiptPath: AbsolutePathSchema, qualificationSource: AbsolutePathSchema,
  reusedImage: z.boolean().optional(),
  cache: CiCacheStatusSchema.optional(),
  unitCodex: z.object({ executable: AbsolutePathSchema, sourceExecutable: AbsolutePathSchema, version: z.string().min(1).max(200),
    binarySha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional(),
}).strict()
export const CiRuntimeRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('prepare'), operationId: z.uuid(), repository: z.string().min(3).max(140), commit: CommitSchema,
    review: z.object({ reviewedByPrincipalId: IdSchema, decisionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    keepImages: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(64) }).strict(),
  z.object({ operation: z.literal('status') }).strict(),
  /** `resources` are the verification profile's: the refreshed runtime reserves exactly what the profile requests. */
  z.object({ operation: z.literal('refresh'), operationId: z.uuid(), commit: CommitSchema, root: SourceRootRecordSchema, manifest: SourceManifestSchema,
    resources: JobResourceRequestSchema }).strict(),
])
export const CiRuntimeWorkerStateSchema = z.object({
  cache: CiCacheStatusSchema.optional(),
  managedSetup: CiManagedSetupSchema.optional(),
  preparationLimits: CiPreparationLimitsSchema.optional(),
  installedStorage: CiInstalledStorageSchema.nullable().optional(),
  operationId: z.uuid().nullable(),
  state: z.enum(['idle', 'preparing', 'prepared', 'failed', 'refreshing']),
  commit: CommitSchema.nullable(), stage: z.string().max(80).nullable(), prepared: PreparedCiRuntimeSchema.nullable(),
  message: z.string().max(2000).nullable(), updatedAt: z.string().datetime(),
}).strict()
export const BuildComputerPrepareInputSchema = z.object({ workspaceId: IdSchema, profileId: IdSchema,
  commit: CommitSchema.optional(),
  commandId: IdSchema.optional().describe('Optional retry identity; generated server-side when omitted.'),
}).strict()
export const BuildComputerPrepareGetInputSchema = z.object({ workspaceId: IdSchema, profileId: IdSchema }).strict()
export const BuildComputerPrepareStatusSchema = z.object({
  cache: CiCacheStatusSchema.optional(),
  preparationLimits: CiPreparationLimitsSchema.optional(),
  failureCount: z.number().int().nonnegative().optional(), retryAt: z.string().datetime().optional(),
  profileId: IdSchema, deviceId: IdSchema.nullable(),
  state: z.enum(['idle', 'approving', 'preparing', 'binding', 'refreshing', 'qualifying', 'qualified', 'failed']),
  commit: CommitSchema.nullable(), stage: z.string().max(80).nullable(), message: z.string().max(2000).nullable(),
  reuse: z.object({ image: z.boolean(), qualification: z.boolean(),
    qualificationSourceCommit: CommitSchema.nullable() }).strict().optional(),
  profiles: z.array(z.object({ profileId: IdSchema, revision: z.number().int().positive(), status: z.string().max(40) }).strict()).max(20),
  startedAt: z.string().datetime().nullable(), updatedAt: z.string().datetime().nullable(),
}).strict()
export type PreparedCiRuntime = z.infer<typeof PreparedCiRuntimeSchema>
export type CiRuntimeRequest = z.infer<typeof CiRuntimeRequestSchema>
export type CiRuntimeWorkerState = z.infer<typeof CiRuntimeWorkerStateSchema>
export type BuildComputerPrepareInput = z.infer<typeof BuildComputerPrepareInputSchema>
export type BuildComputerPrepareStatus = z.infer<typeof BuildComputerPrepareStatusSchema>
