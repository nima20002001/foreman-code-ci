import { z } from 'zod'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'
export { integrationPartition, requiresUserSystemd } from './ciPartition.mjs'
export { userSystemdIntegrationFiles, exclusiveIntegrationFiles, integrationCpuCost } from './integrationScheduling.mjs'
import { WorkspaceRepositorySchema } from './workspaceRepository.js'
import { CircleAccountIdSchema } from './circleCredits.js'
import { BuildComputerAllowanceSchema } from './buildComputers.js'
import { isIntegrationCoverage, type IntegrationCoverage } from './ciCoverage.mjs'

/** Host CI: a build computer runs a suite directly in a git worktree of the commit, like a self-hosted runner.
 * It fetches with its own GitHub CLI login and installs packages normally; a systemd unit caps CPU and memory. */
export const CI_HOST_NAMESPACE = 'ci-host-v1'
export const CI_HOST_START_PROTOCOL_VERSION = 3
export const CI_LOG_MAX_BYTES = 65_536
export const CI_UNIT_SHARD_LIMIT = 32
export const CI_HEAVY_WEB_SHARDS = 2
export const CI_MAX_RUN_TICKETS = 256

export const CiSuiteSchema = z.enum(['install', 'typecheck', 'lint', 'unit', 'build', 'integration'])
export type CiSuite = z.infer<typeof CiSuiteSchema>
const CiPartSchema = z.enum(['unit-api', 'unit-web', 'unit-web-heavy', 'unit-other',
  'lint-api', 'lint-other', 'typecheck-api', 'typecheck-other', 'build-api', 'build-other'])
export type CiPart = z.infer<typeof CiPartSchema>
export type CiExecutionSuite = CiSuite | CiPart
function validCiPart(value: { suite: CiSuite; part?: CiPart | null | undefined; partition?: CiPartition | null | undefined }) {
  if (!value.part) return !value.partition || value.suite === 'integration'
  if (!value.part.startsWith(`${value.suite}-`)) return false
  return !value.partition || value.part === 'unit-api' || value.part === 'unit-web' || value.part === 'unit-web-heavy'
}
export const CiScopeSchema = z.enum(['affected', 'full'])
export const CiIntegrationCoverageSchema = z.custom<IntegrationCoverage>(isIntegrationCoverage)
export type { IntegrationCoverage } from './ciCoverage.mjs'
/** Gzip keeps per-file dependency sets within the device channel's message budget. Artifacts stay plain JSON. */
export const CiCoverageSelectionSchema = z.object({ map: z.string().max(700_000).optional(),
  changedFiles: z.array(z.string()), reason: z.string().max(500).optional() }).strict()
export type CiCoverageSelection = z.infer<typeof CiCoverageSelectionSchema>
export type CiScope = z.infer<typeof CiScopeSchema>
export const CiSelectedFilesSchema = z.array(z.string().min(1)
  .regex(/^(?!\/|[A-Za-z]:)[^\\\0]+$/)
  .refine(file => !file.split('/').some(part => part === '..' || part === '.' || part === '')))
export const CiSelectionSchema = z.object({ scope: CiScopeSchema, files: CiSelectedFilesSchema,
  reason: z.string().max(2000), staticFallbackFiles: CiSelectedFilesSchema.optional()
    .describe('Selected integration files that used static imports because their coverage record is missing.') }).strict()

export function validCiSelection(value: { suite: CiSuite; scope?: CiScope | undefined; files?: string[] | undefined }) {
  if (value.scope === 'full') return !value.files?.length
  if (value.files === undefined) return true
  if (!['unit', 'integration', 'typecheck', 'lint'].includes(value.suite)) return false
  if (value.suite === 'integration') return value.files.every(file => /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file))
  if (value.suite === 'unit') return value.files.every(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
    && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file)))
  return value.files.every(file => /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('scripts/'))
}
const CommitSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const CiRepositorySchema = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/)
/** `weights` gives each slice's relative speed (its computer's measured throughput), so slices finish together. */
export const CiPartitionSchema = z.object({ index: z.number().int().nonnegative(),
  count: z.number().int().min(1).max(CI_MAX_RUN_TICKETS),
  /** Slow files wait for the rest of the request; affected requests require those parts to pass. */
  tier: z.enum(['fast', 'slow']).optional(),
  slowFiles: z.array(z.string().min(1).max(300)).max(300).optional(),
  /** Keep files at or above this measured duration alone when capacity permits. */
  targetDurationMs: z.number().positive().finite().optional(),
  weights: z.array(z.number().positive().finite()).optional(),
  /** User-systemd files require these capable slices; ordinary files can fill remaining capacity in any slice. */
  hostIndexes: z.array(z.number().int().nonnegative()).min(1).max(CI_MAX_RUN_TICKETS).optional() }).strict()
  .refine(value => value.index < value.count, 'The partition index must be below its count.')
  .refine(value => !value.weights || value.weights.length === value.count, 'Give one weight per partition.')
  .refine(value => !value.hostIndexes || (new Set(value.hostIndexes).size === value.hostIndexes.length
    && value.hostIndexes.every(index => index < value.count)), 'Host indexes must be unique partition indexes.')
export type CiPartition = z.infer<typeof CiPartitionSchema>

/** Test file -> wall milliseconds. Bounded so a start request or read reply stays far below the device
 * channel's 1 MiB message limit. */
export const CiDurationsSchema = z.record(z.string().min(1).max(300), z.number().positive().finite().max(24 * 3_600_000))
  .refine(value => Object.keys(value).length <= 1000, 'Give at most 1000 file durations.')
export type CiDurations = z.infer<typeof CiDurationsSchema>

/** Structured per-test results a finished test run reports with its measured durations. Bounded with the durations
 * so one read reply stays far below the device channel's 1 MiB message limit: failed tests are kept first, then
 * skipped, then passed; `summary` always counts every test. */
export const CI_TEST_RESULT_LIMITS = { tests: 600, files: 300, name: 200, file: 200, message: 240, location: 240 } as const
export const CiTestStatusSchema = z.enum(['passed', 'failed', 'skipped'])
export type CiTestStatus = z.infer<typeof CiTestStatusSchema>
const CiTestDurationSchema = z.number().nonnegative().finite().max(24 * 3_600_000).nullable()
const CiTestCaseSchema = z.object({ name: z.string().min(1).max(CI_TEST_RESULT_LIMITS.name), status: CiTestStatusSchema,
  durationMs: CiTestDurationSchema, message: z.string().max(CI_TEST_RESULT_LIMITS.message).optional(),
  /** A failure's `path:line:column` in the repository, read from its full stack. */
  location: z.string().max(CI_TEST_RESULT_LIMITS.location).optional() }).strict()
const CiTestFileSchema = z.object({ file: z.string().min(1).max(CI_TEST_RESULT_LIMITS.file), status: CiTestStatusSchema,
  durationMs: CiTestDurationSchema, tests: z.array(CiTestCaseSchema).max(CI_TEST_RESULT_LIMITS.tests) }).strict()
export const CiTestSummarySchema = z.object({ passed: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative() }).strict()
export const CiTestResultsSchema = z.object({ summary: CiTestSummarySchema,
  files: z.array(CiTestFileSchema).max(CI_TEST_RESULT_LIMITS.files),
  /** Some tests or files were left out to stay within the bounds. */
  truncated: z.boolean() }).strict()
  .refine(value => value.files.reduce((count, file) => count + file.tests.length, 0) <= CI_TEST_RESULT_LIMITS.tests,
    `Give at most ${CI_TEST_RESULT_LIMITS.tests} tests.`)
export type CiTestResults = z.infer<typeof CiTestResultsSchema>

/** A selected test file a non-gate affected run did not execute: an earlier passed ticket ran it with identical inputs
 * (its content, transitive imports, lockfile, manifests, CI runner scripts, suite and part). */
export const CiCachedFileSchema = z.object({ file: z.string().min(1).max(300), ticketId: z.uuid(), commit: CommitSchema }).strict()
export type CiCachedFile = z.infer<typeof CiCachedFileSchema>

export const CiWatchdogFailureSchema = z.object({
  message: z.string().max(2000), testsStarted: z.boolean().optional(),
}).strict()

export const CiMirrorRepairSchema = z.object({
  count: z.number().int().positive(), reason: z.string(), repository: CiRepositorySchema,
  sourceCommit: CommitSchema, elapsedMs: z.number().nonnegative(),
}).strict()
export type CiMirrorRepair = z.infer<typeof CiMirrorRepairSchema>
export const CiMirrorPublicationSchema = z.object({
  state: z.enum(['pending', 'ready', 'failed']),
  startedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  snapshotCommit: CommitSchema.optional(),
  reusedSnapshot: CommitSchema.optional(),
  repair: CiMirrorRepairSchema.optional(),
  timings: z.object({ queueMs: z.number().nonnegative(), sourceMs: z.number().nonnegative(), fetchMs: z.number().nonnegative(),
    guardMs: z.number().nonnegative(), snapshotMs: z.number().nonnegative(),
    pushMs: z.number().nonnegative(), totalMs: z.number().nonnegative() }).strict().optional(),
}).strict()

const CiHostRunIdSchema = z.uuid()
/** `durations` are Main's learned integration file durations; the commit's committed durations fill the gaps. */
const CiHostStartSchema = z.object({
  operation: z.literal('start'), runId: CiHostRunIdSchema, repository: CiRepositorySchema, commit: CommitSchema,
  workspaceId: IdSchema.optional(),
  /** Publication destination approved in this ticket's workspace at admission; null disables cloud publication. */
  ciMirror: CiRepositorySchema.nullable().optional(),
  /** Main can record cloud ownership before publishing its checked snapshot. */
  deferMirror: z.boolean().optional(),
  suite: CiSuiteSchema, part: CiPartSchema.optional(), partition: CiPartitionSchema.optional(), durations: CiDurationsSchema.optional(),
  scope: CiScopeSchema.optional(), files: CiSelectedFilesSchema.optional(),
  integrationCoverage: CiCoverageSelectionSchema.optional(),
  expectedDurationMs: z.number().nonnegative().finite().optional(),
  buildAllowancePercent: BuildComputerAllowanceSchema.optional(),
  /** Idle preparation reuses a persistent checkout without reserving CI capacity. */
  warmup: z.boolean().optional(),
  gate: z.boolean().optional(), integrationShards: z.number().int().min(1).max(64).optional(),
  defaultBranch: WorkspaceRepositorySchema.shape.defaultBranch.optional(),
  baseCommit: CommitSchema.optional(),
  /** Printed at the top of the run log, such as the selected files the result cache skipped. */
  notice: z.string().max(CI_LOG_MAX_BYTES).optional(),
}).strip().refine(value => value.gate
  ? value.suite === 'integration' && value.scope === 'full' && !!value.files?.length && !value.partition && !value.part
    && value.integrationShards !== undefined && value.files.every(file => /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file))
  : validCiSelection(value) && value.integrationShards === undefined,
  'Gate jobs require full integration scope, assigned files and a shard count; other selections require affected scope.')
  .refine(validCiPart, 'The part and partition must belong to the requested suite.')
  .refine(value => !value.warmup || value.suite === 'install' && !value.gate && !value.part && !value.partition,
    'Warm-ups only prepare dependencies.')
export const CiHostRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'),
    buildAllowancePercent: BuildComputerAllowanceSchema.optional(),
    /** Main selects expired terminal directories from persisted tickets. */
    cleanupRunIds: z.array(CiHostRunIdSchema).max(1000).optional() }).strict(),
  CiHostStartSchema,
  // `durations: true` asks a finished test run for the file durations it measured, `testResults: true` for its
  // test results. Results are opt-in so a Worker never sends them to a Main whose reply schema predates them.
  z.object({ operation: z.literal('read'), runId: CiHostRunIdSchema, afterOffset: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative().max(CI_LOG_MAX_BYTES), durations: z.boolean().optional(), testResults: z.boolean().optional(),
    integrationCoverage: z.boolean().optional(),
    // Main sets `reassign` while another computer has a free slot; a cloud executor cancels a provider-queued workflow only then.
    reassign: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('cancel'), runId: CiHostRunIdSchema }).strict(),
])
export type CiHostRequest = z.infer<typeof CiHostRequestSchema>

const CiHostRunStateSchema = z.enum(['queued', 'starting', 'running', 'passed', 'failed', 'canceled', 'lost'])
/** Collection is independent of outcome: unreadable or invalid reports stay pending; unsupported records absent reporting;
 * failed records required reports that never arrived before the collection deadline. */
export const CiCollectionSchema = z.enum(['pending', 'complete', 'unsupported', 'failed'])
export const CiProvenanceSchema = z.object({
  sourceCommit: CommitSchema, workflowCommit: CommitSchema, workflowRef: z.string().min(1).max(200),
}).strict()
export const CiObservationSchema = z.object({
  status: z.enum(['available', 'unavailable']), lastSuccessAt: TimestampSchema.nullable(),
  lastError: z.string().max(300).nullable(), consecutiveFailures: z.number().int().nonnegative(),
  nextAttemptAt: TimestampSchema.nullable(),
  /** Continuous transport failure of the executor observation, reset when the executor answers. */
  transportUnavailableSince: TimestampSchema.optional(),
}).strict()
export const CiTransportSchema = z.object({
  source: z.enum(['rest', 'cli']), reason: z.string().max(300).nullable(),
  lastError: z.string().max(300).nullable(), fallbackCount: z.number().int().nonnegative(),
}).strict()
const CiHostRunSchema = z.object({
  /** Accepted provider attempts still retain this executor after the ticket outcome is known. */
  executorCleanupPending: z.boolean().optional(),
  selection: CiSelectionSchema.optional(),
  runId: CiHostRunIdSchema, state: CiHostRunStateSchema, step: z.string().max(80).nullable(),
  warmup: z.boolean().optional(),
  exitCode: z.number().int().nullable(), startedAt: TimestampSchema, finishedAt: TimestampSchema.nullable(),
  logBytes: z.number().int().nonnegative(), message: z.string().max(2000).nullable(),
  collection: CiCollectionSchema.optional(), provenance: CiProvenanceSchema.optional(),
  transport: CiTransportSchema.optional(),
  mirrorPublication: CiMirrorPublicationSchema.optional(),
  /** Absent when the executor cannot establish whether a test case ran. */
  testsStarted: z.boolean().optional(),
}).strict()
export type CiHostRun = z.infer<typeof CiHostRunSchema>
export const CiUserSystemdSchema = z.object({ supported: z.boolean(), reason: z.string().max(300).nullable() }).strict()
export type CiUserSystemd = z.infer<typeof CiUserSystemdSchema>
export const CiHostStatusSchema = z.object({
  operation: z.literal('status'), ready: z.boolean(), reasons: z.array(z.string().max(300)).max(10),
  /** CPU and memory counts already include this allowance when present. */
  buildAllowancePercent: BuildComputerAllowanceSchema.optional(),
  /** Start protocol 3 enforces the saved CPU and memory build allowance on host starts. */
  startProtocolVersion: z.number().int().positive().optional(),
  /** Supports bounded directory cleanup selected from Main's persisted terminal tickets. */
  cleanupSupported: z.boolean().optional(),
  prewarmSupported: z.boolean().optional(),
  removedRunIds: z.array(CiHostRunIdSchema).max(1000).optional(),
  cpuCount: z.number().int().positive(), memoryBytes: z.number().int().positive(),
  availableMemoryBytes: z.number().int().nonnegative().optional(),
  slotsUsed: z.number().int().nonnegative().optional(), slotsTotal: z.number().int().nonnegative().optional(),
  userSystemd: CiUserSystemdSchema.optional(),
  runs: z.array(CiHostRunSchema).max(50),
}).strict()
export type CiHostStatus = z.infer<typeof CiHostStatusSchema>
export const CiHostReplySchema = z.discriminatedUnion('operation', [
  CiHostStatusSchema,
  z.object({ operation: z.literal('start'), run: CiHostRunSchema }).strict(),
  z.object({ operation: z.literal('read'), run: CiHostRunSchema, text: z.string(), nextOffset: z.number().int().nonnegative(),
    durations: CiDurationsSchema.optional(), testResults: CiTestResultsSchema.optional(),
    integrationCoverage: z.string().max(700_000).optional() }).strict(),
  z.object({ operation: z.literal('cancel'), run: CiHostRunSchema }).strict(),
])
export type CiHostReply = z.infer<typeof CiHostReplySchema>

/** What an Agent or the Operator sees for one CI run. */
export const CiPrioritySchema = z.enum(['normal', 'high'])
export const CiPriorityReasonSchema = z.enum(['normal', 'requested', 'ci-infrastructure', 'gate'])
export const CiCancellationSchema = z.object({
  principalId: IdSchema, source: z.enum(['http', 'mcp']), commandId: IdSchema,
  runId: IdSchema.optional(), reason: z.enum(['direct', 'run_stop', 'superseded', 'gate_failed']),
}).strict()
export type CiCancellation = z.infer<typeof CiCancellationSchema>
export const CiComputerRefSchema = z.object({ kind: z.enum(['main', 'device', 'cloud']), mainId: z.string(), deviceId: z.string().optional(),
    provider: z.enum(['github', 'circleci']).optional(),
    /** The GitHub owner of the CircleCI org a cloud slot belongs to; absent for the workspace mirror's own owner. */
    account: z.string().min(1).optional(), circleAccountId: CircleAccountIdSchema.optional(), slot: z.number().int().nonnegative().optional() }).strict().refine(
      value => value.circleAccountId === undefined || value.kind === 'cloud' && value.provider === 'circleci',
      'CircleCI login identity is only valid for CircleCI cloud computers.')

export const CiRunRecordSchema = z.object({
  /** Retains the assigned slot while accepted provider attempts still need confirmed termination. */
  executorCleanupPending: z.boolean().optional(),
  id: CiHostRunIdSchema, workspaceId: IdSchema, suite: CiSuiteSchema, commit: CommitSchema, repository: CiRepositorySchema,
  ciMirror: CiRepositorySchema.nullable().optional(),
  /** Unacknowledged host starts stay on the same computer so late delivery cannot launch a second run. */
  dispatchHostKey: z.string().optional(),
  dispatchAttempts: z.number().int().nonnegative().optional(),
  dispatchedAt: TimestampSchema.optional(),
  /** Kept until the assigned executor confirms start; retries use this same request and executor. */
  dispatchRequest: CiHostStartSchema.optional(),
  /** Kept until the assigned executor confirms cancellation or another terminal result. */
  cancellation: CiCancellationSchema.optional(),
  observation: CiObservationSchema.optional(),
  /** A phase outlived its maximum age. A retained executor keeps its slot until it confirms the run stopped. */
  deadlineExceeded: z.object({
    code: z.enum(['CI_QUEUE_DEADLINE_EXCEEDED', 'CI_START_DEADLINE_EXCEEDED', 'CI_RUN_DEADLINE_EXCEEDED',
      'CI_COLLECTION_DEADLINE_EXCEEDED']),
    phase: z.enum(['queued', 'starting', 'running', 'collection']),
    enteredAt: TimestampSchema, deadlineAt: TimestampSchema, detectedAt: TimestampSchema,
    cause: z.string().max(2000),
    executor: z.enum(['none', 'retained', 'released']),
  }).strict().optional(),
  reassignment: z.object({ count: z.number().int().positive(), previousHostKey: z.string(),
    lastError: z.string(), at: TimestampSchema }).strict().optional(),
  providerMessage: z.string().max(2000).nullable().optional(),
  messageHistory: z.array(z.string().max(2000)).max(8).optional(),
  scope: CiScopeSchema.default('full'), files: CiSelectedFilesSchema.default([]),
  selection: CiSelectionSchema.optional(),
  priority: CiPrioritySchema.default('normal'), priorityReason: CiPriorityReasonSchema.default('normal'),
  gate: z.boolean().optional(), integrationShards: z.number().int().min(1).max(64).optional(),
  /** An omitted caller selection is computed on the runner; an explicit empty list is already complete. */
  deriveFiles: z.boolean().optional(), defaultBranch: WorkspaceRepositorySchema.shape.defaultBranch.optional(),
  baseCommit: CommitSchema.optional(),
  /** On a request's first ticket: selected files skipped because an earlier passed ticket proved identical inputs. */
  cachedFiles: z.array(CiCachedFileSchema).optional(),
  branch: WorkspaceRepositorySchema.shape.defaultBranch.nullable().optional(),
  noSupersede: z.boolean().optional(),
  supersededBy: CiHostRunIdSchema.optional(),
  partition: CiPartitionSchema.nullable(), groupId: CiHostRunIdSchema,
  part: CiPartSchema.nullable().default(null),
  state: z.enum(['queued', 'starting', 'running', 'passed', 'failed', 'canceled', 'lost']),
  computer: z.object({ hostRef: CiComputerRefSchema,
    label: z.string() }).strict().nullable(),
  step: z.string().nullable(), exitCode: z.number().int().nullable(), message: z.string().nullable(),
  collection: CiCollectionSchema.optional(), provenance: CiProvenanceSchema.optional(),
  transport: CiTransportSchema.optional(),
  mirrorPublication: CiMirrorPublicationSchema.optional(),
  queuedAt: TimestampSchema, startedAt: TimestampSchema.nullable(), finishedAt: TimestampSchema.nullable(),
  initiator: z.object({ principalId: IdSchema, executionId: IdSchema.nullable() }).strict(),
  /** The computer a weighted partition was sized for; another free computer may still take it. */
  plannedHostKey: z.string().nullable().optional(),
  smokeComputer: CiComputerRefSchema.optional(),
  /** Measured test time plus a fixed setup allowance; runner-derived selections use a full-suite upper estimate. */
  expectedDurationMs: z.number().nonnegative().finite().optional(),
  /** The learned executor slowdown applied to expectedDurationMs, so later estimates measure the executor itself. */
  speedFactor: z.number().positive().finite().optional(),
  /** The planned slice contains files requiring a build computer. */
  requiresBuildComputer: z.boolean().optional(),
  /** Providers that accepted a dispatch but exhausted retries without creating work. */
  unstartedProviders: z.array(z.enum(['github', 'circleci'])).max(2).optional(),
  /** A fresh executor identity after reassignment; the ticket keeps its ID. */
  executionRunId: CiHostRunIdSchema.optional(),
  /** Abandoned executions retain their slots independently of the replacement's outcome. */
  retainedExecutions: z.array(z.object({
    runId: CiHostRunIdSchema, hostKey: z.string(),
    computer: z.object({ hostRef: CiComputerRefSchema, label: z.string() }).strict(),
    executor: z.enum(['retained', 'released']), nextAttemptAt: TimestampSchema,
  }).strict()).optional(),
  /** Earlier execution directories and the computers that own them. */
  executionHistory: z.array(z.object({ runId: CiHostRunIdSchema, hostRef: CiComputerRefSchema }).strict()).optional(),
  /** One fresh executor attempt after a cloud failure before its first test case. */
  setupRetry: z.object({
    runId: CiHostRunIdSchema, failedComputer: CiComputerRefSchema, reason: z.string().max(2000),
  }).strict().optional(),
}).strict().refine(validCiPart, 'The part and partition must belong to the requested suite.')
export type CiRunRecord = z.infer<typeof CiRunRecordSchema>

/** Bounded lifecycle facts shared by Run history and activity snapshots. */
export const CiActivitySchema = z.object(CiRunRecordSchema.shape).pick({
  id: true, groupId: true, suite: true, part: true, partition: true, state: true,
  queuedAt: true, startedAt: true, finishedAt: true, exitCode: true,
}).extend({
  computer: CiRunRecordSchema.shape.computer.unwrap().extend({ label: z.string().max(100) }).nullable(),
  step: z.string().max(80).nullable(),
}).strict().refine(validCiPart, 'The part and partition must belong to the requested suite.')
export type CiActivity = z.infer<typeof CiActivitySchema>
