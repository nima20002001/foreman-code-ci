import { BrowserRuntimeStatusSchema } from './browserTransport.js'
import { ReadObservationSchema } from './readObservation.js'
import { OperationalFailureSchema } from './operationalFailures.js'
import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { HarnessMcpArgumentSchema, HarnessMcpEndpointSchema, HarnessMcpPresetStatus } from './management/harnessSettings.js'
import { ComputerAccountsSchema } from './computerAccounts.js'
import { PluginMarketplaceSourceSchema } from './management/claudePlugins.js'
import { WorkerUpdateStatusSchema, WorkerReleasePublicationSchema, WorkerBundleReadinessSchema } from './workerUpdate.js'
export * from './workerUpdate.js'

/** Device channel namespace: Main asks a paired computer for maintenance status and starts maintenance tasks. */
export const COMPUTER_MAINTENANCE_NAMESPACE = 'computer-maintenance-v2'
export const COMPUTER_MAINTENANCE_VERSION = 2

/** Harnesses kept installed and current on every computer: Codex and Claude. */
const MaintainedHarnessSchema = z.enum(['codex', 'claude'])
export type MaintainedHarness = z.infer<typeof MaintainedHarnessSchema>
const HarnessSelectionSchema = z.array(MaintainedHarnessSchema).min(1).max(2)
  .refine(harnesses => new Set(harnesses).size === harnesses.length, 'Choose each harness once.')

const MaintenanceTaskKindSchema = z.enum([
  'update-harnesses', 'update-worker', 'update-system', 'restart', 'sync-mcp', 'sync-plugins', 'repair-browser',
])

/** A user-level MCP server definition. Secret values are never copied: only environment variable names and URLs. */
export const SyncedMcpServerSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), name: z.string().min(1).max(100), command: z.string().min(1).max(4096),
    args: z.array(HarnessMcpArgumentSchema).max(100),
    // The native add commands used by fleet sync cannot restore environment-name references.
    envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)).max(0) }).strict(),
  z.object({ transport: z.literal('http'), name: z.string().min(1).max(100), url: HarnessMcpEndpointSchema,
    bearerTokenEnvVar: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).nullable() }).strict(),
])
export type SyncedMcpServer = z.infer<typeof SyncedMcpServerSchema>

export const SyncedMarketplaceSchema = z.object({
  name: z.string().regex(/^[^\s@]+$/u).max(100), source: PluginMarketplaceSourceSchema,
}).strict()
export type SyncedMarketplace = z.infer<typeof SyncedMarketplaceSchema>

export const SyncedPluginSchema = z.object({
  pluginId: z.string().regex(/^[^\s@]+@[^\s@]+$/u), version: z.string().min(1).max(256).nullable(),
}).strict()
export type SyncedPlugin = z.infer<typeof SyncedPluginSchema>

export const MaintenanceTaskStartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('update-harnesses'), harnesses: HarnessSelectionSchema }).strict(),
  // Automatic convergence preserves the updater's failure guard; explicit Retry defaults to true.
  z.object({ kind: z.literal('update-worker'), retry: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('update-system') }).strict(),
  z.object({ kind: z.literal('repair-browser') }).strict(),
  z.object({ kind: z.literal('restart') }).strict(),
  // An omitted harness is unavailable; an empty list is a successfully read empty catalog.
  z.object({ kind: z.literal('sync-mcp'), servers: z.object({ codex: z.array(SyncedMcpServerSchema).max(100).optional(),
    claude: z.array(SyncedMcpServerSchema).max(100).optional() }).strict()
    .refine(servers => servers.codex !== undefined || servers.claude !== undefined, 'Include an available MCP catalog.'),
    /** Definitions still present on Main but unsupported for copying; preserve their existing Worker entries. */
    skippedServers: z.object({ codex: z.array(z.string().min(1).max(100)).max(100).optional(),
      claude: z.array(z.string().min(1).max(100)).max(100).optional() }).strict().optional(),
    warnings: z.array(z.string().max(300)).max(202).optional() }).strict(),
  z.object({ kind: z.literal('sync-plugins'), plugins: z.array(z.string().regex(/^[^\s@]+@[^\s@]+$/u)).max(200).optional(),
    pluginVersions: z.record(z.string().regex(/^[^\s@]+@[^\s@]+$/u), z.string().min(1).max(256)).optional(),
    /** Main's Git plugin marketplaces; a computer adds the ones it lacks before installing plugins from them. */
    marketplaces: z.array(SyncedMarketplaceSchema).max(50).optional(),
    claudePlugins: z.array(SyncedPluginSchema.omit({ version: true }).extend({
      enabled: z.boolean(), version: z.string().min(1).max(256).optional(),
    }).strict()).max(200).optional(),
    claudeMarketplaces: z.array(SyncedMarketplaceSchema).max(50).optional(),
    warnings: z.array(z.string().max(300)).max(202).optional() }).strict().refine(task =>
      (task.plugins !== undefined || task.claudePlugins !== undefined)
      && (task.plugins === undefined) === (task.marketplaces === undefined)
      && (task.claudePlugins === undefined) === (task.claudeMarketplaces === undefined),
    'Include plugins and marketplaces together for each available harness.'),
])
export type MaintenanceTaskStart = z.infer<typeof MaintenanceTaskStartSchema>

export const MaintenanceRequestSchema = z.discriminatedUnion('operation', [
  /** scope 'worker' reads only the Worker update state, without the slow harness, registry and OS inspections. */
  z.object({ operation: z.literal('status'), scope: z.literal('worker').optional() }).strict(),
  z.object({ operation: z.literal('start'), commandId: z.uuid(), task: MaintenanceTaskStartSchema }).strict(),
])

export const MaintenanceTaskSchema = z.object({
  id: z.uuid(),
  kind: MaintenanceTaskKindSchema,
  /** The release that must reconnect before an update task can complete. */
  workerTargetVersion: z.string().min(1).max(128).optional(),
  /** Identifies the requested sync payload, independently of either computer's clock. */
  sourceFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/u).optional(),
  state: z.enum(['running', 'succeeded', 'failed']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  /** Short readable outcome, e.g. "Codex 0.161.0 → 0.162.0" or the failing step. */
  summary: z.string().max(2000),
  /** Last lines of the task output for diagnosis. */
  outputTail: z.string().max(8000),
}).strict()
export type MaintenanceTask = z.infer<typeof MaintenanceTaskSchema>

/** Receiver receipt kept separately from the bounded recent-task list. */
export const MaintenanceCommandRecordSchema = z.object({
  requestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  task: MaintenanceTaskSchema,
}).strict()

/** Main saves the selected computers and source catalogs before dispatching a command. */
export const ComputerMaintenanceDispatchSchema = z.object({
  targets: z.array(DeviceProvisioningTargetSchema).max(101),
  task: MaintenanceTaskStartSchema,
}).strict()

const HarnessVersionSchema = z.object({
  harness: MaintainedHarnessSchema,
  installed: z.boolean(),
  version: z.string().max(100).nullable(),
  /** Latest published version, or null when it could not be checked. */
  latest: z.string().max(100).nullable(),
}).strict()

/** One background loop or unit of this process. Stalled: in flight past its deadline, or past its next due time. */
export const ServiceHealthSchema = z.object({
  name: z.string().min(1).max(80),
  status: z.enum(['ok', 'idle', 'failing', 'stalled']),
  lastStartedAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastError: z.string().max(500).nullable(),
  nextDueAt: z.string().datetime().nullable(),
  inFlightSince: z.string().datetime().nullable(),
}).strict()
export type ServiceHealth = z.infer<typeof ServiceHealthSchema>

export const MaintenanceStatusSchema = z.object({
  operationalFailures: z.array(OperationalFailureSchema).optional(),
  services: z.array(ServiceHealthSchema).max(50).optional(),
  worker: WorkerUpdateStatusSchema.optional(),
  browserRuntime: BrowserRuntimeStatusSchema.optional(),
  harnesses: z.array(HarnessVersionSchema).max(2),
  system: z.object({
    /** Pending OS upgrades, including APT-held and phased updates; null when the count cannot be verified. */
    packageUpdates: z.number().int().nonnegative().nullable(),
    rebootRequired: z.boolean(),
    /** Passwordless sudo is available for OS updates and restarts. */
    sudo: z.boolean(),
    disk: z.object({ path: z.string(), freeBytes: z.number().nonnegative(), totalBytes: z.number().nonnegative() }).strict().nullable(),
  }).strict(),
  tasks: z.array(MaintenanceTaskSchema).max(20),
  observedAt: z.string().datetime(),
}).strict()
export type MaintenanceStatus = z.infer<typeof MaintenanceStatusSchema>

/**
 * Sign-in and Foreman Code MCP facts next to the maintenance facts, so one readback shows every chip of a computer.
 * accounts: Codex, Claude and GitHub CLI install and sign-in state (null when the computer did not answer).
 * mcp: the Foreman Code MCP preset per harness (null when that harness's MCP configuration could not be read).
 */
export const ComputerConnectionsSchema = z.object({
  accounts: ComputerAccountsSchema.nullable(),
  mcp: z.object({ codex: HarnessMcpPresetStatus.nullable(), claude: HarnessMcpPresetStatus.nullable() }).strict(),
}).strict()
export type ComputerConnections = z.infer<typeof ComputerConnectionsSchema>

export const DEFAULT_MAINTENANCE_TASK_LIMIT = 5
const MaintenanceTaskLimitSchema = z.number().int().min(1).max(50)

export const MaintenanceReplySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), status: MaintenanceStatusSchema }).strict(),
  z.object({ operation: z.literal('worker'), worker: WorkerUpdateStatusSchema.nullable() }).strict(),
  z.object({ operation: z.literal('start'), task: MaintenanceTaskSchema }).strict(),
])

/** Main-side readback across computers; observation explains unavailable status. */
export const ComputerMaintenanceListSchema = z.object({
  computers: z.array(z.object({ target: DeviceProvisioningTargetSchema, status: MaintenanceStatusSchema.nullable(),
    observation: ReadObservationSchema.optional(),
    workerPublication: WorkerReleasePublicationSchema.optional(),
    workerReadiness: WorkerBundleReadinessSchema.optional(),
    connections: ComputerConnectionsSchema.optional(),
    tasksOmitted: z.number().int().nonnegative().default(0) }).strict()).max(101),
}).strict()
export type ComputerMaintenanceList = z.infer<typeof ComputerMaintenanceListSchema>
export const ComputerMaintenanceListInputSchema = z.object({
  refresh: z.boolean().optional(), target: DeviceProvisioningTargetSchema.optional(),
  taskLimit: MaintenanceTaskLimitSchema.optional(),
}).strict()
/** Operator summaries omit diagnostic output; full reads use the same history selection with diagnostic output. */
const MaintenanceTaskSummarySchema = MaintenanceTaskSchema.omit({ outputTail: true }).extend({
  summary: z.string().max(300),
})
const CompactMaintenanceStatusSchema = MaintenanceStatusSchema.extend({
  tasks: z.array(MaintenanceTaskSummarySchema).max(20),
})
export const ComputerMaintenanceOperatorListSchema = z.object({
  computers: z.array(z.object({
    target: DeviceProvisioningTargetSchema,
    status: z.union([MaintenanceStatusSchema, CompactMaintenanceStatusSchema]).nullable(),
    observation: ReadObservationSchema.optional(),
    workerPublication: WorkerReleasePublicationSchema.optional(),
    workerReadiness: WorkerBundleReadinessSchema.optional(),
    connections: ComputerConnectionsSchema.optional(),
    tasksOmitted: z.number().int().nonnegative().default(0),
  }).strict()).max(101),
}).strict()
export type ComputerMaintenanceOperatorList = z.infer<typeof ComputerMaintenanceOperatorListSchema>
export const ComputerMaintenanceOperatorListInputSchema = ComputerMaintenanceListInputSchema.extend({
  detail: z.enum(['compact', 'full']).optional(),
  taskId: z.uuid().optional(),
}).refine(input => input.taskId === undefined || input.detail === 'full', {
  message: 'taskId requires detail: "full".', path: ['taskId'],
})
export type ComputerMaintenanceOperatorListInput = z.infer<typeof ComputerMaintenanceOperatorListInputSchema>

export const ComputerMaintenanceReadInputSchema = z.object({
  target: DeviceProvisioningTargetSchema, refresh: z.boolean().optional(),
  taskLimit: MaintenanceTaskLimitSchema.optional(),
}).strict()

/** Start one maintenance task on the selected computers (all paired computers and Main when omitted). */
export const ComputerMaintenanceStartInputSchema = z.object({
  commandId: optionalCommandId(z.uuid()),
  task: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('update-harnesses'), harnesses: HarnessSelectionSchema }).strict(),
    z.object({ kind: z.literal('update-worker') }).strict(),
    z.object({ kind: z.literal('update-system') }).strict(),
  z.object({ kind: z.literal('repair-browser') }).strict(),
    z.object({ kind: z.literal('restart') }).strict(),
    z.object({ kind: z.literal('sync-mcp') }).strict(),
    z.object({ kind: z.literal('sync-plugins') }).strict(),
  ]),
  targets: z.array(DeviceProvisioningTargetSchema).min(1).max(101).optional(),
}).strict()
export type ComputerMaintenanceStartInput = z.infer<typeof ComputerMaintenanceStartInputSchema>

export const ComputerMaintenanceStartResultSchema = z.object({
  computers: z.array(z.object({ target: DeviceProvisioningTargetSchema, task: MaintenanceTaskSchema.nullable(),
    error: z.string().max(2000).nullable() }).strict()).max(101),
}).strict()
export type ComputerMaintenanceStartResult = z.infer<typeof ComputerMaintenanceStartResultSchema>
