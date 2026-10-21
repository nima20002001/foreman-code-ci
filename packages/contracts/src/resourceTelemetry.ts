import { z } from 'zod'
import { canonicalJsonLocaleOrderLegacy } from './canonicalJson.js'
import type { DeviceSessionBinding } from './deviceConnection.js'
import { DispatchIntentSchema, MachineReferenceSchema } from './nodePlacement.js'
import { RemoteJobDispatchIntentSchema } from './remoteJobExecution.js'

export const RESOURCE_TELEMETRY_CAPABILITY = 'resource-telemetry/v1' as const
export const TELEMETRY_LIMITS = { intervalMs: 2000, freshMs: 6000, lastKnownMs: 900_000,
  batchBytes: 65_536, rows: 64, devices: 32, cacheBytes: 33_554_432, outstanding: 2, queuedFrames: 2 } as const
const Id = z.string().min(1).max(128).refine(value => new TextEncoder().encode(value).length <= 128)
const TelemetryUIntSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(value => BigInt(value) <= 18_446_744_073_709_551_615n)
const Bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const Time = Bytes
export const TelemetryReasonSchema = z.enum(['not-yet-sampled', 'unsupported', 'source-failure', 'counter-invalid',
  'permission-denied', 'namespace-restricted', 'stale', 'offline', 'ended', 'closed', 'ownership-unavailable',
  'shared-restricted', 'limit', 'evicted', 'clock-discontinuity', 'warmup', 'process-tree-partial',
  'short-lived-unobserved', 'identity-changed', 'escaped-boundary', 'nested-boundary', 'source-missing', 'wall-clock-skew'])
export const TelemetryHostSchema = z.object({ hostRef: MachineReferenceSchema,
  deviceId: z.uuid(), applicationInstallationId: Id, bootId: z.uuid(), runtimeEpoch: Id,
  keyRevision: z.number().int().positive().nullable(), authorizationRevision: z.number().int().positive().nullable(),
  connectionGeneration: z.number().int().positive().nullable(), collectorGeneration: Id,
}).strict().superRefine((host, ctx) => {
  const remote = host.hostRef.kind === 'device'
  if ((remote && host.hostRef.kind === 'device' && host.hostRef.deviceId !== host.deviceId)
    || remote !== (host.keyRevision !== null) || remote !== (host.authorizationRevision !== null)
    || remote !== (host.connectionGeneration !== null))
    ctx.addIssue({ code: 'custom', message: 'Observed main/remote host must retain its real registration evidence.' })
})
export const TelemetryIdentitySchema = z.object({ mainId: z.uuid(), host: TelemetryHostSchema }).strict()
const Attempt = DispatchIntentSchema.pick({ executionId: true, attemptId: true, operationId: true, bindingHash: true, owner: true })
const TelemetryOwnerSchema = z.discriminatedUnion('kind', [
  Attempt.extend({ kind: z.literal('workflow-execution'), workspaceId: Id, workflowId: Id,
    runId: DispatchIntentSchema.shape.runId, nodeId: DispatchIntentSchema.shape.nodeId, agentId: Id }).strict(),
  z.object({ kind: z.literal('ci-job'), subject: RemoteJobDispatchIntentSchema.shape.subject,
    executionId: RemoteJobDispatchIntentSchema.shape.executionId, attemptId: RemoteJobDispatchIntentSchema.shape.attemptId,
    operationId: RemoteJobDispatchIntentSchema.shape.operationId, bindingHash: RemoteJobDispatchIntentSchema.shape.bindingHash,
    owner: RemoteJobDispatchIntentSchema.shape.owner }).strict(),
  z.object({ kind: z.literal('agent-conversation'), workspaceId: Id, workflowId: Id, nodeId: Id,
    agentId: Id, conversationId: Id, leaseId: Id }).strict(),
  z.object({ kind: z.literal('operator-conversation'), conversationId: Id, leaseId: Id }).strict(),
])
export const TelemetrySelectorSchema = z.discriminatedUnion('scope', [
  z.object({ schemaVersion: z.literal(1), scope: z.literal('computer'), mainId: z.uuid(), host: TelemetryHostSchema }).strict(),
  z.object({ schemaVersion: z.literal(1), scope: z.literal('owned'), mainId: z.uuid(), host: TelemetryHostSchema,
    owner: TelemetryOwnerSchema, attributionRef: Id, attributionRevision: Id }).strict(),
]).superRefine((selector, ctx) => {
  if (selector.mainId !== selector.host.hostRef.mainId)
    ctx.addIssue({ code: 'custom', message: 'Selector main and observed host disagree.' })
  const bounded = (value: unknown): boolean => typeof value === 'string'
    ? new TextEncoder().encode(value).length <= 128
    : value !== null && typeof value === 'object' ? Object.values(value).every(bounded) : true
  if (!bounded(selector)) ctx.addIssue({ code: 'custom', message: 'Telemetry identifiers exceed the v1 wire bound.' })
})
export type TelemetrySelector = z.infer<typeof TelemetrySelectorSchema>
export type TelemetryHost = z.infer<typeof TelemetryHostSchema>
export type TelemetryIdentity = z.infer<typeof TelemetryIdentitySchema>
export type TelemetryOwner = z.infer<typeof TelemetryOwnerSchema>
/** Sort every object level so input property order cannot alter selection identity.
 * Persisted selector keys depend on the frozen legacy format. */
export const telemetryCanonical: (value: unknown) => string = canonicalJsonLocaleOrderLegacy
export function telemetrySelectorKey(selector: TelemetrySelector): string {
  return `resource-telemetry/v1:${telemetryCanonical(TelemetrySelectorSchema.parse(selector))}`
}
const TelemetryCoverageSchema = z.object({ boundary: z.enum(['complete-boundary', 'partial']),
  shared: z.boolean(), reasons: z.array(TelemetryReasonSchema).max(16) }).strict()
const TelemetryCpuSchema = z.object({ basis: z.enum(['host-active-ticks', 'cgroup-usage-usec', 'process-utime-stime']),
  normalization: z.literal('whole-host-capacity'), logicalCpuCount: z.number().int().min(1).max(4096),
  hostCapacityPercent: z.number().finite().min(0).max(100), oneCorePercent: z.number().finite().nonnegative().nullable(),
  elapsedNs: TelemetryUIntSchema, cpuDeltaNs: TelemetryUIntSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (BigInt(value.elapsedNs) === 0n || (value.oneCorePercent !== null && value.oneCorePercent > 100 * value.logicalCpuCount))
    ctx.addIssue({ code: 'custom', message: 'Invalid CPU window or capacity.' })
})
const TelemetryMemorySchema = z.object({ kind: z.enum(['host-used-estimate', 'cgroup-current', 'rss-sum']),
  bytes: Bytes, totalBytes: Bytes.nullable(), availableBytes: Bytes.nullable(), sharedPagesMayDoubleCount: z.boolean(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'host-used-estimate' && (value.totalBytes === null || value.availableBytes === null
    || value.availableBytes > value.totalBytes || value.bytes !== value.totalBytes - value.availableBytes))
    ctx.addIssue({ code: 'custom', message: 'Host memory requires MemTotal minus MemAvailable.' })
  if (value.kind === 'rss-sum' && !value.sharedPagesMayDoubleCount)
    ctx.addIssue({ code: 'custom', message: 'RSS must report possible shared-page double counting.' })
})
/** Free space on the filesystem holding the computer's home directory; computer scope only. */
const TelemetryStorageSchema = z.object({ totalBytes: Bytes, availableBytes: Bytes }).strict()
  .refine(value => value.availableBytes <= value.totalBytes, 'Available storage cannot exceed total storage.')
const metric = <T extends z.ZodType>(value: T) => z.discriminatedUnion('state', [
  z.object({ state: z.literal('fresh'), value, reason: z.null(), sampledAtUnixMs: Time, freshUntilUnixMs: Time }).strict(),
  z.object({ state: z.enum(['warmup', 'stale', 'unavailable', 'permission-denied']), value: z.null(),
    reason: TelemetryReasonSchema, sampledAtUnixMs: Time.nullable(), freshUntilUnixMs: Time.nullable() }).strict(),
])
const TelemetryCpuMetricSchema = metric(TelemetryCpuSchema)
const TelemetryMemoryMetricSchema = metric(TelemetryMemorySchema)
const TelemetrySampleSchema = z.object({ schemaVersion: z.literal(1), selector: TelemetrySelectorSchema,
  selectorKey: z.string().max(8192), identity: TelemetryIdentitySchema, sampleId: z.string().max(4096), sequence: TelemetryUIntSchema,
  collectedAtUnixMs: Time, collectionDurationNs: TelemetryUIntSchema, receivedAtUnixMs: Time, serverNowUnixMs: Time,
  ageUpperBoundMs: z.number().finite().nonnegative(), freshUntilUnixMs: Time,
  presence: z.enum(['online', 'offline']), ownershipState: z.enum(['active', 'ended', 'closure-unconfirmed', 'closed']),
  coverage: TelemetryCoverageSchema, diagnostics: z.array(TelemetryReasonSchema).max(16), cpu: TelemetryCpuMetricSchema, memory: TelemetryMemoryMetricSchema,
  /** Present only while the sample is current; older Workers omit it. */
  storage: TelemetryStorageSchema.nullable().optional(),
}).strict().superRefine((sample, ctx) => {
  if (sample.selectorKey !== telemetrySelectorKey(sample.selector) || sample.identity.mainId !== sample.selector.mainId
    || telemetryCanonical(sample.identity.host) !== telemetryCanonical(sample.selector.host))
    ctx.addIssue({ code: 'custom', message: 'Sample belongs to a different full selector.' })
  if ((sample.presence === 'offline' || sample.ownershipState === 'ended' || sample.ownershipState === 'closed'
    || sample.ageUpperBoundMs >= TELEMETRY_LIMITS.freshMs) && (sample.cpu.state === 'fresh' || sample.memory.state === 'fresh' || sample.storage))
    ctx.addIssue({ code: 'custom', message: 'Noncurrent sample cannot expose current values.' })
})
export const TelemetryReadResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sample'), sample: TelemetrySampleSchema, lastKnown: TelemetrySampleSchema.nullable() }).strict(),
  z.object({ kind: z.literal('no-sample'), selector: TelemetrySelectorSchema, selectorKey: z.string().max(8192),
    reason: TelemetryReasonSchema, identity: TelemetryIdentitySchema.nullable() }).strict(),
  z.object({ kind: z.literal('denied'), selectorKey: z.string().max(8192) }).strict(),
]).superRefine((result, ctx) => {
  if (result.kind === 'no-sample' && result.selectorKey !== telemetrySelectorKey(result.selector))
    ctx.addIssue({ code: 'custom', message: 'No-sample response must match the exact requested selector.' })
})
export type TelemetryReason = z.infer<typeof TelemetryReasonSchema>
export type TelemetrySample = z.infer<typeof TelemetrySampleSchema>
export type TelemetryReadResult = z.infer<typeof TelemetryReadResultSchema>
export type TelemetryCpu = z.infer<typeof TelemetryCpuSchema>
export type TelemetryStorage = z.infer<typeof TelemetryStorageSchema>
/** Counter endpoints belong to the actual capture window, never the configured cadence. */
const TelemetryCpuCaptureSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), basis: TelemetryCpuSchema.shape.basis, windowStartMonoNs: TelemetryUIntSchema, windowEndMonoNs: TelemetryUIntSchema,
    previousCounter: TelemetryUIntSchema, currentCounter: TelemetryUIntSchema, previousTotal: TelemetryUIntSchema.nullable(), currentTotal: TelemetryUIntSchema.nullable(),
    /** proc fallback is an interval delta over validated generations, not lifetime sums. */
    intervalDeltaNs: TelemetryUIntSchema.nullable(), baselineRef: Id }).strict(),
  z.object({ state: z.enum(['warmup', 'unavailable', 'permission-denied']), reason: TelemetryReasonSchema }).strict(),
])
const TelemetryMemoryCaptureSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok'), value: TelemetryMemorySchema }).strict(),
  z.object({ state: z.enum(['unavailable', 'permission-denied']), reason: TelemetryReasonSchema }).strict(),
])
const TelemetryCollectedRowSchema = z.object({ selector: TelemetrySelectorSchema, coverage: TelemetryCoverageSchema,
  cpu: TelemetryCpuCaptureSchema, memory: TelemetryMemoryCaptureSchema,
  storage: TelemetryStorageSchema.nullable().optional() }).strict().superRefine((row, ctx) => {
  if (row.memory.state === 'ok' && (row.selector.scope === 'computer') !== (row.memory.value.kind === 'host-used-estimate')
    || row.cpu.state === 'ok' && (row.selector.scope === 'computer') !== (row.cpu.basis === 'host-active-ticks'))
    ctx.addIssue({ code: 'custom', message: 'Computer counters cannot be relabeled as owned-scope counters.' })
  if (row.storage && row.selector.scope !== 'computer')
    ctx.addIssue({ code: 'custom', message: 'Storage belongs to the computer scope only.' })
})
export const CollectionChallengeSchema = z.object({ schemaVersion: z.literal(1), identity: TelemetryIdentitySchema,
  challengeId: Id, issuedAtUnixMs: Time, freshUntilUnixMs: Time }).strict()
export const TelemetryCollectedBatchSchema = z.object({ schemaVersion: z.literal(1), identity: TelemetryIdentitySchema,
  challengeId: Id, sequence: TelemetryUIntSchema, collectedAtUnixMs: Time, challengeReceivedMonoNs: TelemetryUIntSchema,
  captureStartMonoNs: TelemetryUIntSchema, captureEndMonoNs: TelemetryUIntSchema, logicalCpuCount: z.number().int().min(1).max(4096),
  host: TelemetryCollectedRowSchema.nullable(), owned: z.array(TelemetryCollectedRowSchema).max(64),
  diagnostics: z.array(TelemetryReasonSchema).max(16), truncated: z.boolean(),
}).strict().superRefine((batch, ctx) => {
  if (BigInt(batch.captureStartMonoNs) < BigInt(batch.challengeReceivedMonoNs)
    || BigInt(batch.captureEndMonoNs) < BigInt(batch.captureStartMonoNs))
    ctx.addIssue({ code: 'custom', message: 'Capture must start after receipt of its challenge.' })
  if (batch.host?.selector.scope !== undefined && batch.host.selector.scope !== 'computer'
    || batch.owned.some(row => row.selector.scope !== 'owned'))
    ctx.addIssue({ code: 'custom', message: 'Host and owned rows have distinct scopes.' })
})
export type CollectionChallenge = z.infer<typeof CollectionChallengeSchema>
export type TelemetryCollectedBatch = z.infer<typeof TelemetryCollectedBatchSchema>
export type TelemetryCollectedRow = z.infer<typeof TelemetryCollectedRowSchema>
/** Trusted capabilities are injected by W07/HRT, never decoded from telemetry JSON. */
export type TrustedTelemetryContext =
  | { kind: 'remote'; binding: DeviceSessionBinding; capability: typeof RESOURCE_TELEMETRY_CAPABILITY }
  | { kind: 'main-local'; mainId: string; deviceId: string; applicationInstallationId: string;
      bootId: string; runtimeEpoch: string; capability: typeof RESOURCE_TELEMETRY_CAPABILITY }
export interface ResourceCollector {
  offer(challenge: CollectionChallenge): 'accepted' | 'coalesced' | 'rejected'
  samples(signal: AbortSignal): AsyncIterable<TelemetryCollectedBatch>
  close(): Promise<void>
}
export interface TelemetryReadService<Principal> {
  read(principal: Principal, selector: TelemetrySelector, signal: AbortSignal): Promise<TelemetryReadResult>
  changes(principal: Principal, selector: TelemetrySelector, signal: AbortSignal): AsyncIterable<TelemetryReadResult>
}


/** Public domain references only; trusted authorities recover owner/attribution/host generations. */
const TelemetryOwnedTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workflow-execution'), workspaceId: Id, workflowId: Id, runId: Id,
    nodeId: Id, executionId: Id }).strict(),
  z.object({ kind: z.literal('ci-job'), workspaceId: Id, jobExecutionId: Id, attemptId: Id }).strict(),
  z.object({ kind: z.literal('agent-conversation'), workspaceId: Id, workflowId: Id, nodeId: Id,
    agentId: Id, conversationId: Id }).strict(),
  z.object({ kind: z.literal('operator-conversation'), conversationId: Id }).strict(),
])
export const TelemetrySelectorTargetSchema = z.discriminatedUnion('scope', [
  z.object({ schemaVersion: z.literal(1), scope: z.literal('computer'), mainId: z.uuid(),
    hostRef: MachineReferenceSchema }).strict(),
  z.object({ schemaVersion: z.literal(1), scope: z.literal('owned'), mainId: z.uuid(),
    target: TelemetryOwnedTargetSchema }).strict(),
]).superRefine((target, ctx) => {
  if (target.scope === 'computer' && target.mainId !== target.hostRef.mainId)
    ctx.addIssue({ code: 'custom', message: 'Target main and requested host disagree.' })
})
export const TelemetrySelectorResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('selector'), selector: TelemetrySelectorSchema }).strict(),
  z.object({ kind: z.literal('unavailable') }).strict(),
  z.object({ kind: z.literal('denied') }).strict(),
])
export type TelemetrySelectorTarget = z.infer<typeof TelemetrySelectorTargetSchema>
export type TelemetrySelectorResult = z.infer<typeof TelemetrySelectorResultSchema>
export interface TelemetrySelectorService<Principal> {
  resolve(principal: Principal, target: TelemetrySelectorTarget, signal: AbortSignal): Promise<TelemetrySelectorResult>
}
