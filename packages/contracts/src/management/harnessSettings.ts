import { optionalCommandId } from './commands.js'
import { z } from 'zod'
import { DeviceProvisioningHostReferenceSchema } from '../deviceResources.js'

// This module deliberately has no runtime import from management/index.ts.
const Harness = z.enum(['codex'])
const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/, 'Use letters, numbers, hyphens or underscores.')
const CommandId = z.string().trim().min(8).max(200)
const Revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const Path = z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'A path cannot contain NUL.')
const EnvironmentName = z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
  .refine((name) => !/^(?:GRAPHQL_|FOREMAN_CODE_|OPERATOR_|DATABASE_URL$|TEST_DATABASE_URL$|PG|LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$)/.test(name),
    'Application credentials and process-control variables cannot be delegated to MCP servers.')
export const HarnessMcpEndpointSchema = z.string().max(2048).url().superRefine((value, ctx) => {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) ctx.addIssue({ code: 'custom', message: 'Use an endpoint without credentials, a query string or a fragment.' })
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    ctx.addIssue({ code: 'custom', message: 'Use HTTPS, or HTTP on loopback for a local server.' })
  }
})
const inlineCredential = /(?:bearer\s|(?:token|password|passwd|secret|api[-_]?key)\s*[=:])/i
const credentialOption = /(?:^|\s)--?(?:[\w-]+-)?(?:token|password|passwd|secret|api[-_]?key)(?:\s|$)/i
export const HarnessMcpArgumentSchema = z.string().max(2048)
  .refine((value) => !value.includes('\0') && !/[\r\n]/.test(value), 'Arguments must be single lines.')
  .refine((value) => !inlineCredential.test(value) && !credentialOption.test(value),
    'Use an environment-variable reference, not an inline credential.')
export const HarnessMcpConnectionSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('remote'), url: HarnessMcpEndpointSchema, bearerTokenEnvironmentVariable: EnvironmentName.optional() }).strict(),
  z.object({ transport: z.literal('stdio'), executable: Path.refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value), 'Choose an already installed executable by its absolute path.'),
    arguments: z.array(HarnessMcpArgumentSchema).max(64).default([]), environmentVariables: z.array(EnvironmentName).max(32).default([]) }).strict(),
])
export type HarnessMcpConnection = z.infer<typeof HarnessMcpConnectionSchema>
export const HarnessMcpChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), name: Name, connection: HarnessMcpConnectionSchema }).strict(),
  z.object({ kind: z.literal('remove'), name: Name }).strict(),
  z.object({ kind: z.literal('enable'), name: Name, enabled: z.boolean() }).strict(),
])
export type HarnessMcpChange = z.infer<typeof HarnessMcpChangeSchema>
/** `graphql` is the one app connection for every role; the credential decides what a caller may use. */
const HarnessMcpManagedPresetSchema = z.enum(['graphql', 'linear'])
export type HarnessMcpManagedPreset = z.infer<typeof HarnessMcpManagedPresetSchema>
/** Plan history keeps the pre-unification `operator` and `worker` presets readable. */
const HarnessMcpPlanPresetSchema = z.enum(['graphql', 'linear', 'operator', 'worker'])
/** `legacy`: old graphql-app/graphql-operator entries remain; applying the preset replaces them. */
export const HarnessMcpPresetStatus = z.enum(['missing', 'installed', 'disabled', 'mismatch', 'inherited', 'legacy'])
const ManagedHarness = z.enum(['codex', 'claude'])
const HostRef = DeviceProvisioningHostReferenceSchema.optional()
const HarnessMcpManagedBase = z.object({ harness: ManagedHarness, hostRef: HostRef, preset: HarnessMcpManagedPresetSchema,
  commandId: optionalCommandId(CommandId), expectedRevision: Revision.optional().describe('Omit for last write wins; supply to reject a stale revision.') })
export const HarnessMcpManagedInputSchema = z.union([
  HarnessMcpManagedBase.extend({ installed: z.boolean() }).strict(),
  HarnessMcpManagedBase.extend({ enabled: z.boolean() }).strict(),
])
export type HarnessMcpManagedInput = z.infer<typeof HarnessMcpManagedInputSchema>
export const HarnessMcpListInputSchema = z.object({ harness: ManagedHarness, hostRef: HostRef }).strict()
const HarnessMcpServerSummarySchema = z.object({
  name: z.string(), transport: z.enum(['remote', 'stdio', 'unknown']), label: z.string(), enabled: z.boolean(),
  endpoint: z.string().url().optional(),
  origin: z.enum(['user', 'inherited']), protected: z.boolean(), editable: z.boolean(),
}).strict()
export const HarnessMcpListResultSchema = z.object({
  harness: ManagedHarness, hostRef: HostRef, revision: Revision, servers: z.array(HarnessMcpServerSummarySchema),
  presets: z.object({ graphql: HarnessMcpPresetStatus, linear: HarnessMcpPresetStatus.exclude(['legacy']) }).strict().optional(),
  checkedAt: z.string().datetime({ offset: true }), scope: z.literal('native-user'),
}).strict()
export type HarnessMcpList = z.infer<typeof HarnessMcpListResultSchema>
export const HarnessMcpPlanInputSchema = z.object({ harness: Harness, commandId: optionalCommandId(CommandId), expectedRevision: Revision.optional().describe('Omit for last write wins; supply to reject a stale revision.'), change: HarnessMcpChangeSchema }).strict()
export type HarnessMcpPlanInput = z.infer<typeof HarnessMcpPlanInputSchema>
export const HarnessMcpPlanSchema = z.object({
  id: z.string().uuid(), harness: z.enum(['codex', 'claude', 'opencode']), hostRef: HostRef, revision: Revision, change: HarnessMcpChangeSchema,
  managedPreset: HarnessMcpPlanPresetSchema.nullable().optional(),
  requestedBy: z.string(), status: z.enum(['pending', 'submitting', 'applied', 'rejected', 'failed', 'uncertain', 'reconciled']),
  createdAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }),
  error: z.string().nullable(), retirementMessage: z.string().optional(),
}).strict()
export type HarnessMcpPlan = z.infer<typeof HarnessMcpPlanSchema>
export const HarnessMcpPlanResultSchema = z.object({ value: HarnessMcpPlanSchema, replayed: z.boolean() }).strict()
export const HarnessMcpPlansResultSchema = z.object({ items: z.array(HarnessMcpPlanSchema) }).strict()
export const HarnessMcpPlanGetInputSchema = z.object({ planId: z.string().uuid() }).strict()
export const HarnessMcpDecisionInputSchema = z.object({ planId: z.string().uuid(), approve: z.boolean() }).strict()
/** Reconciliation reads native state without repeating the write. */
export const HarnessMcpReconcileInputSchema = z.object({
  planId: z.string().uuid(), commandId: optionalCommandId(CommandId), expectedRevision: Revision.optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  acceptObservedState: z.boolean().default(false),
}).strict()
export type HarnessMcpReconcileInput = z.infer<typeof HarnessMcpReconcileInputSchema>
export const HarnessDirectoryBrowseInputSchema = z.object({ rootId: z.string().min(1).optional(), path: Path.optional(),
  cursor: z.string().max(4096).optional() }).strict()
export const HarnessDirectoryBrowseResultSchema = z.object({
  roots: z.array(z.object({ id: z.string(), label: z.string(), path: z.string() }).strict()),
  rootId: z.string().nullable(), path: z.string().nullable(), parent: z.string().nullable(),
  directories: z.array(z.object({ name: z.string(), path: z.string() }).strict()), nextCursor: z.string().nullable(),
  truncated: z.boolean().optional().describe('True when scanning stopped after 20,000 entries; cursor pages cover only the scanned subset.'),
}).strict()

export const WorkspaceFolderNameSchema = z.string().trim().min(1).max(200)
  .refine((name) => name !== "." && name !== ".." && !name.startsWith(".")
    && !name.includes("/") && !name.includes("\\")
    && !Array.from(name).some((character) => character.charCodeAt(0) < 32),
  "Use a folder name without slashes, a leading dot, or control characters.")
export const WorkspaceFolderCreateInputSchema = z.object({
  parentPath: Path,
  name: WorkspaceFolderNameSchema.optional().describe("Omit to create an available New folder name automatically."),
  commandId: optionalCommandId(CommandId),
}).strict()
export type WorkspaceFolderCreateInput = z.infer<typeof WorkspaceFolderCreateInputSchema>
export const WorkspaceFolderCreateResultSchema = z.object({
  value: z.object({ path: Path, name: z.string() }).strict(), replayed: z.boolean(),
}).strict()
export const WorkspaceFolderRenameInputSchema = z.object({
  creationCommandId: CommandId.optional(),
  path: Path.optional(),
  name: WorkspaceFolderNameSchema,
  commandId: optionalCommandId(CommandId),
}).strict().refine((value) => Boolean(value.creationCommandId) !== Boolean(value.path), 'Provide a creation command or a folder path.')
export type WorkspaceFolderRenameInput = z.infer<typeof WorkspaceFolderRenameInputSchema>
export const WorkspaceFolderRenameResultSchema = WorkspaceFolderCreateResultSchema

export const WorkspaceFolderUndoInputSchema = z.object({
  creationCommandId: CommandId,
  commandId: optionalCommandId(CommandId),
}).strict()
export type WorkspaceFolderUndoInput = z.infer<typeof WorkspaceFolderUndoInputSchema>
export const WorkspaceFolderUndoResultSchema = z.object({
  value: z.object({ path: Path }).strict(), replayed: z.boolean(),
}).strict()

export const WorkspaceFolderDeleteInputSchema = z.object({
  paths: z.array(Path).min(1).max(100).refine((paths) => new Set(paths).size === paths.length, 'Choose each folder once.'),
  commandId: optionalCommandId(CommandId),
}).strict()
export type WorkspaceFolderDeleteInput = z.infer<typeof WorkspaceFolderDeleteInputSchema>
export const WorkspaceFolderDeleteResultSchema = z.object({
  value: z.object({
    deleted: z.array(Path),
    failed: z.array(z.object({ path: Path, message: z.string() }).strict()),
  }).strict(), replayed: z.boolean(),
}).strict()
