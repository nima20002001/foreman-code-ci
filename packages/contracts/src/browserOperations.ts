import { z } from 'zod';
import { IdSchema } from './schemaPrimitives.js';
import { AgentSubjectSchema } from './agentIdentity.js';
import { BrowserProfileSchema, BrowserProfileReplicaSchema, BrowserProfileSyncPageSchema, BrowserProfileSyncJobSchema,
  BrowserProfileOriginSchema, NodeBrowserSettingsSchema } from './browserProfiles.js';
import { BrowserControlSchema, BrowserSessionSchema, BrowserTabLeaseSchema, BrowserPrepareResultSchema,
  BrowserReleaseResultSchema, BrowserSessionReadbackSchema } from './browserSessions.js';

const id = IdSchema;
const command = { commandId: id.optional(), expectedRevision: z.number().int().nonnegative().optional() };
const page = { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional() };
const generation = z.number().int().positive();
const epoch = z.number().int().nonnegative();
export const BrowserActorSchema = z.object({ kind: z.enum(['agent', 'viewer']), viewerId: id.optional(),
  epoch, browserGeneration: generation }).strict().refine(value => value.kind !== 'viewer' || !!value.viewerId,
  { message: 'A viewer action requires its viewer identity.' });
export const BrowserPageGestureSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pointer'), phase: z.enum(['move', 'down', 'up']), x: z.number(), y: z.number(),
    button: z.number().int(), buttons: z.number().int() }).strict(),
  z.object({ kind: z.literal('wheel'), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number() }).strict(),
  z.object({ kind: z.literal('key'), phase: z.enum(['down', 'up']), key: z.string(), code: z.string(),
    alt: z.boolean(), control: z.boolean(), meta: z.boolean(), shift: z.boolean(), repeat: z.boolean() }).strict(),
  z.object({ kind: z.literal('composition'), phase: z.enum(['start', 'update', 'end']), text: z.string() }).strict(),
]);
export const BrowserHostActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('navigate'), url: z.string().url() }).strict(),
  z.object({ kind: z.enum(['back', 'forward', 'reload']) }).strict(),
  z.object({ kind: z.literal('click'), x: z.number(), y: z.number(), button: z.enum(['left', 'right', 'middle']).optional() }).strict(),
  z.object({ kind: z.literal('type'), text: z.string() }).strict(),
  z.object({ kind: z.literal('scroll'), x: z.number(), y: z.number(), deltaX: z.number(), deltaY: z.number() }).strict(),
  z.object({ kind: z.literal('key'), key: z.string(), modifiers: z.number().int().optional() }).strict(),
  z.object({ kind: z.literal('dialog'), accept: z.boolean(), promptText: z.string().optional() }).strict(),
  z.object({ kind: z.literal('upload'), fileId: id, selector: z.string() }).strict(),
  z.object({ kind: z.literal('download'), downloadId: id, intent: z.enum(['read', 'delete']) }).strict(),
]);
const actor = { sessionId: id, actor: BrowserActorSchema };
const tab = { ...actor, tabId: id };
const profileComputer = { profileId: id, computerId: id };
const file = { intent: z.literal('file'), sessionId: id, fileId: id };
export const BrowserActionRequestSchema = z.union([
  z.object({ ...tab, commandId: id.optional(), intent: z.literal('action').optional(), action: BrowserHostActionSchema }).strict(),
  z.object({ intent: z.literal('file'), phase: z.literal('begin'), sessionId: id, tabId: id, browserGeneration: generation,
    commandId: id.optional(), name: z.string().min(1), mimeType: z.string(), byteLength: z.number().int().nonnegative() }).strict(),
  z.object({ ...file, phase: z.literal('write'), offset: z.number().int().nonnegative(),
    contentBase64: z.string().max(349528) }).strict(),
  z.object({ ...file, phase: z.enum(['finish', 'cancel', 'remove', 'metadata']), commandId: id.optional() }).strict(),
  z.object({ ...file, phase: z.literal('read'), offset: z.number().int().nonnegative(),
    length: z.number().int().min(1).max(262144) }).strict(),
  z.object({ ...file, phase: z.literal('attach'), ...tab, commandId: id.optional(), selector: z.string() }).strict(),
]);
export const BrowserOperationRequestSchemas = {
  browser_profiles_list: z.object({ ...page, computerId: id.optional() }).strict(),
  browser_profile_get: z.object({ profileId: id }).strict(),
  browser_profile_create: z.union([
    z.object({ ...command, intent: z.literal('create').optional(), name: BrowserProfileSchema.shape.name,
      computerId: id, distribution: BrowserProfileSchema.shape.distribution.optional() }).strict(),
    z.object({ ...command, intent: z.literal('add_existing'), ...profileComputer }).strict(),
  ]),
  browser_profile_update: z.discriminatedUnion('intent', [
    z.object({ ...command, intent: z.literal('metadata'), profileId: id,
      patch: BrowserProfileSchema.pick({ name: true, sourceComputerId: true, distribution: true }).partial() }).strict(),
    z.object({ ...command, intent: z.literal('local_override'), ...profileComputer, localOverride: z.boolean() }).strict(),
    z.object({ ...command, intent: z.literal('confirm_login'), ...profileComputer, origin: BrowserProfileOriginSchema,
      state: z.enum(['signed_in', 'sign_in_required']) }).strict(),
    z.object({ ...command, intent: z.literal('check_origin'), ...profileComputer, origin: BrowserProfileOriginSchema }).strict(),
  ]),
  browser_profile_remove: z.object({ ...command, profileId: id, computerId: id.optional() }).strict(),
  browser_profiles_sync: z.object({ ...command, profileIds: z.array(id).optional() }).strict(),
  browser_profile_sync_get: z.object({ jobId: id, profileCursor: z.string().optional(), targetCursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional() }).strict(),
  browser_session_open: z.discriminatedUnion('intent', [
    z.object({ intent: z.literal('prepare'), request: z.object({ subject: AgentSubjectSchema, browser: NodeBrowserSettingsSchema,
      computerId: id, commandId: id.optional() }).strict() }).strict(),
    z.object({ intent: z.literal('setup'), ...profileComputer, commandId: id.optional() }).strict(),
    z.object({ intent: z.literal('native_window'), ...tab, commandId: id.optional() }).strict(),
    z.object({ intent: z.literal('reconnect'), sessionId: id, commandId: id.optional() }).strict(),
  ]),
  browser_sessions_list: z.object({ ...page, subject: AgentSubjectSchema.optional(), setupForProfileId: id.optional(), computerId: id.optional() }).strict(),
  browser_session_get: z.object({ sessionId: id }).strict(),
  browser_session_close: z.object({ sessionId: id, commandId: id.optional() }).strict(),
  browser_tabs_list: z.object({ sessionId: id }).strict(),
  browser_tab_create: z.object({ ...actor, commandId: id.optional() }).strict(),
  browser_tab_select: z.object({ ...tab, commandId: id.optional() }).strict(),
  browser_tab_close: z.object({ ...tab, commandId: id.optional() }).strict(),
  browser_state_read: z.object(tab).strict(),
  browser_screenshot: z.object(tab).strict(),
  browser_action: BrowserActionRequestSchema,
  browser_view_open: z.object({ sessionId: id, tabId: id, viewerId: id, browserGeneration: generation,
    commandId: id.optional() }).strict(),
  browser_view_read: z.object({ viewId: id, after: z.number().int().nonnegative().optional() }).strict(),
  browser_view_close: z.object({ viewId: id }).strict(),
  browser_control_acquire: z.object({ sessionId: id, viewerId: id, browserGeneration: generation, commandId: id.optional() }).strict(),
  browser_control_release: z.object({ sessionId: id, viewerId: id, epoch, commandId: id.optional(),
    intent: z.enum(['resume', 'pause']).optional() }).strict(),
  browser_input: z.union([
    z.object({ ...tab, intent: z.literal('gestures').optional(), firstSequence: z.number().int().nonnegative(),
      gestures: z.array(BrowserPageGestureSchema).max(100) }).strict(),
    z.object({ ...actor, intent: z.literal('release_pressed') }).strict(),
  ]),
} as const;
export type BrowserOperationName = keyof typeof BrowserOperationRequestSchemas;

export const BrowserProfileOperationSchema = z.object({ id, profileId: id, computerId: id,
  revision: z.number().int().nonnegative(), installationId: id, operation: z.enum(['create', 'remove', 'sync']),
  state: z.enum(['queued', 'running', 'completed', 'failed']), reason: z.string().nullable(),
  claimId: id.optional(), claimUntil: z.number().optional() }).strict();
export const BrowserProfileCatalogSchema = z.object({ profiles: z.array(BrowserProfileSchema), replicas: z.array(BrowserProfileReplicaSchema),
  presentReplicas: z.array(z.object(profileComputer).strict()), pendingReplicas: z.array(z.object({ ...profileComputer,
    operation: z.enum(['create', 'remove', 'sync']), state: z.enum(['queued', 'running']), reason: z.string().nullable() }).strict()),
  nextCursor: z.string().nullable(), revision: z.number().int().nonnegative() }).strict();
export const BrowserFileSchema = z.object({ id, name: z.string(), mimeType: z.string(),
  byteLength: z.number().int().nonnegative(), receivedBytes: z.number().int().nonnegative(),
  state: z.enum(['uploading', 'ready', 'attached', 'canceled', 'failed']),
  sha256: z.string().nullable(), purpose: z.enum(['upload', 'download']) }).strict();
const dialog = z.object({ type: z.enum(['alert', 'confirm', 'prompt']), message: z.string(), defaultPrompt: z.string().optional() }).strict();
export const BrowserSessionDetailsSchema = BrowserSessionReadbackSchema.safeExtend({ uploadChooser: z.object({ tabId: id, selector: z.string() }).strict().nullable(),
  dialog: dialog.extend({ tabId: id }).nullable(), files: z.array(BrowserFileSchema), createdTabId: id.optional() }).strict();
export const BrowserRuntimeViewSchema = z.object({ id, sessionId: id, tabId: id, browserGeneration: generation }).strict();
export const BrowserFrameSchema = z.object({ sessionId: id, tabId: id, browserGeneration: generation,
  sequence: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive(),
  viewportOffsetTop: z.number(), capturedAt: z.string(), mimeType: z.enum(['image/jpeg', 'image/png']),
  byteLength: z.number().int().min(0).max(2097152) }).strict();
export const BrowserProfileAddResultSchema = z.object({ state: z.enum(['ready', 'queued', 'first_snapshot_pending']), replica: BrowserProfileReplicaSchema }).strict();
const receipt = <T extends z.ZodType>(value: T) => z.object({ commandId: id, value, replayed: z.boolean() }).strict();
const bytes = z.object({ contentBase64: z.string() }).strict();
export const BrowserOperationResponseSchemas = {
  browser_profiles_list: BrowserProfileCatalogSchema,
  browser_profile_get: z.object({ profile: BrowserProfileSchema, replicas: z.array(BrowserProfileReplicaSchema),
    operations: z.array(BrowserProfileOperationSchema) }).strict(),
  browser_profile_create: receipt(z.union([BrowserProfileSchema, BrowserProfileAddResultSchema])),
  browser_profile_update: receipt(z.union([BrowserProfileSchema, BrowserProfileReplicaSchema])),
  browser_profile_remove: receipt(z.array(BrowserProfileOperationSchema)),
  browser_profiles_sync: receipt(BrowserProfileSyncJobSchema),
  browser_profile_sync_get: BrowserProfileSyncPageSchema,
  browser_session_open: z.union([BrowserPrepareResultSchema, BrowserSessionDetailsSchema,
    BrowserSessionReadbackSchema.safeExtend({ kind: z.literal('ready') }), BrowserControlSchema]),
  browser_sessions_list: z.object({ sessions: z.array(BrowserSessionSchema), nextCursor: z.string().nullable() }).strict(),
  browser_session_get: BrowserSessionDetailsSchema,
  browser_session_close: BrowserReleaseResultSchema,
  browser_tabs_list: z.array(BrowserTabLeaseSchema),
  browser_tab_create: BrowserSessionDetailsSchema,
  browser_tab_select: BrowserSessionDetailsSchema,
  browser_tab_close: BrowserSessionDetailsSchema,
  browser_state_read: z.object({ title: z.string(), url: z.string(), text: z.string(), dialog: dialog.nullable() }).strict(),
  browser_screenshot: z.object({ sessionId: id, tabId: id, browserGeneration: generation, mimeType: z.literal('image/png'), contentBase64: z.string() }).strict(),
  browser_action: z.union([z.object({ state: z.literal('completed'), result: z.unknown() }).strict(), BrowserFileSchema, bytes, z.null()]),
  browser_view_open: BrowserRuntimeViewSchema,
  browser_view_read: z.object({ view: BrowserRuntimeViewSchema, frame: BrowserFrameSchema.extend({ contentBase64: z.string() }).nullable() }).strict(),
  browser_view_close: z.object({ closed: z.boolean() }).strict(),
  browser_control_acquire: BrowserControlSchema,
  browser_control_release: BrowserControlSchema,
  browser_input: z.null(),
} as const;
