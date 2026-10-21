import { z } from 'zod'

export const SessionModeSchema = z.enum(['regular', 'plan'])
export type SessionMode = z.infer<typeof SessionModeSchema>
export const SessionPreferencesSchema = z.object({
  autoCompact: z.enum(['default', 'on', 'off']).default('default'),
  autoCompactTokens: z.number().int().min(100000).max(1000000).nullable().default(null),
  contextBudget: z.number().int().positive().nullable().default(null),
  contextProfile: z.string().min(1).nullable().default(null),
}).strict()
export type SessionPreferences = z.infer<typeof SessionPreferencesSchema>
const CapabilitySchema = z.object({ supported: z.boolean(), reason: z.string().nullable() }).strict()
export const SessionControlCapabilitiesSchema = z.object({
  compact: CapabilitySchema,
  plan: CapabilitySchema,
  autoCompact: CapabilitySchema,
  autoCompactBudget: CapabilitySchema,
  contextBudgetReason: z.string().nullable().optional(),
  contextBudgets: z.array(z.number().int().positive()),
  contextProfiles: z.array(z.object({ id: z.string(), label: z.string(), capacity: z.number().int().positive() }).strict()),
  modelCapacity: z.number().int().positive().nullable(),
  nativeDefaultCapacity: z.number().int().positive().nullable().optional(),
  model: z.string().nullable(),
  profileKey: z.string(),
}).strict()
export type SessionControlCapabilities = z.infer<typeof SessionControlCapabilitiesSchema>
export const ContextSnapshotSchema = z.object({
  nativeSessionId: z.string().min(1),
  model: z.string().nullable(),
  generation: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  observedAt: z.string().datetime(),
  source: z.enum(['codex', 'claude', 'opencode']),
  accuracy: z.enum(['native', 'estimated']),
  usedTokens: z.number().nonnegative().nullable(),
  capacityTokens: z.number().positive().nullable(),
  lifetimeTokens: z.number().nonnegative().nullable(),
  cost: z.number().nonnegative().nullable(),
  stale: z.boolean(),
}).strict()
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>
export const CompactionStateSchema = z.object({
  requestId: z.string(),
  principalId: z.string().optional(),
  nativeSessionId: z.string().nullable(),
  nativeOperationId: z.string().nullable(),
  baselineTurnId: z.string().nullable().optional(),
  dispatchPhase: z.enum(['reserved', 'preflight', 'dispatched']).optional(),
  reservationOwner: z.string().optional(),
  nativeRequestId: z.string().optional(),
  claudeSession: z.object({ deviceId: z.string(), profilePath: z.string(), configRevision: z.string(),
    cwd: z.string() }).strict().optional(),
  claudeCursor: z.object({ identity: z.string(), offset: z.number().int().nonnegative(), scope: z.string() }).strict().optional(),
  status: z.enum(['accepted', 'running', 'completed', 'no-op', 'failed', 'uncertain']),
  message: z.string(),
  beforeTokens: z.number().nonnegative().nullable(),
  observedAt: z.string().datetime(),
}).strict()
export type CompactionState = z.infer<typeof CompactionStateSchema>
export const SessionControlStateSchema = z.object({
  conversationId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  lastRequestId: z.string().optional(),
  // Successful command responses identify the receipt even when a later writer changed settings.
  completedRequestId: z.string().optional(),
  lastRequestPrincipalId: z.string().optional(),
  profileKey: z.string(),
  desiredMode: SessionModeSchema,
  appliedMode: SessionModeSchema.nullable(),
  defaults: SessionPreferencesSchema,
  desired: SessionPreferencesSchema,
  applied: SessionPreferencesSchema.nullable(),
  applicability: z.enum(['applied', 'next-turn', 'safe-resume', 'new-session']),
  capabilities: SessionControlCapabilitiesSchema,
  context: ContextSnapshotSchema.nullable(),
  nativeSessionId: z.string().nullable(),
  nativeProviderVersion: z.string().nullable(),
  nativeStatus: z.enum(['loaded', 'resume-required', 'not-started']).optional(),
  compaction: CompactionStateSchema.nullable(),
  compactions: z.array(CompactionStateSchema),
  busyReason: z.string().nullable(),
}).strict()
export type SessionControlState = z.infer<typeof SessionControlStateSchema>
const RequestFields = { requestId: z.string().min(8).max(200), expectedRevision: z.number().int().nonnegative() }
export const SessionControlRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...RequestFields, kind: z.literal('compact') }).strict(),
  z.object({ ...RequestFields, kind: z.literal('mode'), mode: SessionModeSchema }).strict(),
  z.object({ ...RequestFields, kind: z.literal('preferences'), preferences: SessionPreferencesSchema }).strict(),
  z.object({ ...RequestFields, kind: z.literal('save-default'), preferences: SessionPreferencesSchema }).strict(),
])
export type SessionControlRequest = z.infer<typeof SessionControlRequestSchema>

export function unavailableSessionControls(profileKey: string, reason = 'Send a message to discover this native session’s controls.'): SessionControlCapabilities {
  const unavailable = { supported: false, reason }
  return { compact: unavailable, plan: unavailable, autoCompact: unavailable, autoCompactBudget: unavailable,
    contextBudgets: [], contextProfiles: [], modelCapacity: null, model: null, profileKey }
}

export function compactionBlocksSend(compaction: CompactionState | null): boolean {
  return !!compaction && ['accepted', 'running', 'uncertain'].includes(compaction.status)
}
