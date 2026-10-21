import { z } from 'zod';
import { IdSchema, TimestampSchema } from './schemaPrimitives.js';

export const BrowserProfileOriginSchema = z.string().url().refine((origin) => {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.origin === origin;
  } catch { return false; }
}, 'Use a normalized HTTP(S) origin without a path, credentials, query or fragment.');

export const NodeBrowserSettingsSchema = z.object({
  enabled: z.boolean(), profileId: IdSchema.optional(),
}).strict(); // enabled requires profileId on executable save.
export const ExecutableNodeBrowserSettingsSchema = NodeBrowserSettingsSchema.refine((settings) => !settings.enabled || settings.profileId !== undefined, {
  path: ['profileId'], message: 'Choose a profile before enabling this browser.',
});
export const BrowserProfileSchema = z.object({
  id: IdSchema, name: z.string().trim().min(1).max(120),
  sourceComputerId: IdSchema,
  distribution: z.enum(['shared','local_only']),
  revision: z.number().int().nonnegative(),
  publishedRevision: z.number().int().nonnegative(),
}).strict();
export const BrowserSnapshotIdentitySchema = z.object({
  profileId: IdSchema, publishedRevision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  format: z.literal('cookies-localstorage-v1'),
}).strict(); // Hash of immutable encrypted transfer bytes; never cookie text.
export const BrowserProfileSnapshotManifestSchema = z.object({
  snapshot: BrowserSnapshotIdentitySchema, sourceComputerId: IdSchema,
  createdAt: TimestampSchema, byteLength: z.number().int().nonnegative(),
  origins: z.array(BrowserProfileOriginSchema),
  unsupportedState: z.array(z.object({ origin: BrowserProfileOriginSchema,
    reason: z.string().trim().min(1) }).strict()),
}).strict().refine((manifest) => new Set(manifest.origins).size === manifest.origins.length
  && manifest.unsupportedState.every((entry) => manifest.origins.includes(entry.origin)), {
  message: 'Manifest origins must be unique and include each unsupported-state origin.',
});
export const BrowserLoginEvidenceSchema = z.object({
  origin: BrowserProfileOriginSchema,
  state: z.enum(['not_checked','signed_in','sign_in_required','unknown']),
  checkedAt: TimestampSchema.nullable(),
  evidence: z.enum(['none','user_confirmed','site_probe']),
  reason: z.string().nullable(),
}).strict().superRefine((login, context) => {
  if (login.state === 'not_checked') {
    if (login.checkedAt !== null || login.evidence !== 'none') context.addIssue({ code: 'custom', message: 'Unchecked login cannot contain a check or evidence.' });
  } else {
    if (login.checkedAt === null) context.addIssue({ code: 'custom', path: ['checkedAt'], message: 'A login verdict requires its check time.' });
    if (login.state !== 'unknown' && login.evidence === 'none') context.addIssue({ code: 'custom', path: ['evidence'], message: 'A login verdict requires a probe or user confirmation.' });
  }
});
export const BrowserProfileReplicaSchema = z.object({
  profileId: IdSchema, computerId: IdSchema,
  desiredSnapshot: BrowserSnapshotIdentitySchema.nullable(),
  receivedSnapshot: BrowserSnapshotIdentitySchema.nullable(),
  appliedSnapshot: BrowserSnapshotIdentitySchema.nullable(),
  transfer: z.enum(['missing','update_available','queued','applying','up_to_date','failed','offline','local_only']),
  loginEvidence: z.array(BrowserLoginEvidenceSchema),
  localOverride: z.boolean(), lastSeenAt: TimestampSchema.nullable(),
  reason: z.string().nullable(),
}).strict().superRefine((replica, context) => {
  const snapshots = [replica.desiredSnapshot, replica.receivedSnapshot, replica.appliedSnapshot].filter((snapshot) => snapshot !== null);
  if (snapshots.some((snapshot) => snapshot.profileId !== replica.profileId)) context.addIssue({ code: 'custom', message: 'Replica snapshots must identify the same profile.' });
  for (const snapshot of snapshots) {
    if (snapshots.some((other) => other.publishedRevision === snapshot.publishedRevision && !sameBrowserSnapshot(snapshot, other))) {
      context.addIssue({ code: 'custom', message: 'One published revision has one immutable snapshot identity.' });
      break;
    }
  }
  if (replica.transfer === 'up_to_date' && (!replica.desiredSnapshot || !replica.appliedSnapshot
    || !sameBrowserSnapshot(replica.desiredSnapshot, replica.appliedSnapshot))) {
    context.addIssue({ code: 'custom', path: ['transfer'], message: 'Up-to-date requires the exact desired snapshot to be applied.' });
  }
  if (new Set(replica.loginEvidence.map((entry) => entry.origin)).size !== replica.loginEvidence.length) context.addIssue({ code: 'custom', path: ['loginEvidence'], message: 'One login check per origin is allowed.' });
  if (replica.transfer === 'failed' && !replica.reason?.trim()) context.addIssue({ code: 'custom', path: ['reason'], message: 'Failed transfer requires a cause.' });
});
export const BrowserProfileSyncTargetSchema = z.object({
  profileId: IdSchema, computerId: IdSchema,
  snapshot: BrowserSnapshotIdentitySchema.nullable(),
  state: z.enum(['queued','transferring','waiting_idle','applying','up_to_date',
    'failed','offline','excluded']),
  exclusion: z.enum(['local_only','local_override','source']).nullable(),
  reason: z.string().nullable(), updatedAt: TimestampSchema,
}).strict().superRefine((target, context) => {
  if (target.snapshot && target.snapshot.profileId !== target.profileId) context.addIssue({ code: 'custom', path: ['snapshot'], message: 'Snapshot must identify this profile.' });
  if (target.state === 'up_to_date' && !target.snapshot) context.addIssue({ code: 'custom', path: ['snapshot'], message: 'Applied targets retain their snapshot identity.' });
  if ((target.state === 'excluded') !== (target.exclusion !== null)) context.addIssue({ code: 'custom', path: ['exclusion'], message: 'Only excluded targets carry an exclusion.' });
  if ((target.state === 'failed' || target.state === 'excluded') && !target.reason?.trim()) context.addIssue({ code: 'custom', path: ['reason'], message: 'Failure and exclusion require an explanation.' });
});
export const BrowserProfileSyncJobSchema = z.object({
  id: IdSchema, commandId: IdSchema,
  state: z.enum(['queued','running','completed','partial','failed']),
  profiles: z.array(z.object({ profileId: IdSchema, sourceComputerId: IdSchema,
    state: z.enum(['queued','exporting','published','offline','excluded','failed']),
    manifest: BrowserProfileSnapshotManifestSchema.nullable(),
    reason: z.string().nullable() }).strict()),
  targets: z.array(BrowserProfileSyncTargetSchema),
  revision: z.number().int().nonnegative(),
  createdAt: TimestampSchema, updatedAt: TimestampSchema,
}).strict().superRefine((job, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  const profiles = new Map(job.profiles.map((profile) => [profile.profileId, profile]));
  if (profiles.size !== job.profiles.length) fail('Sync profiles must be unique.');
  const targets = new Set<string>();
  for (const profile of job.profiles) {
    if (profile.manifest && (profile.manifest.snapshot.profileId !== profile.profileId || profile.manifest.sourceComputerId !== profile.sourceComputerId)) fail('Manifest must match its profile and designated source.');
    if (profile.state === 'published' && !profile.manifest) fail('Published profiles require a manifest.');
    if ((profile.state === 'failed' || profile.state === 'excluded') && !profile.reason?.trim()) fail('Failed or excluded profiles require an explanation.');
  }
  for (const target of job.targets) {
    const key = `${target.profileId}\u0000${target.computerId}`;
    if (targets.has(key)) fail('Sync targets must be unique by profile and computer.');
    targets.add(key);
    const profile = profiles.get(target.profileId);
    if (!profile) fail('Every target must belong to a selected profile.');
    if (target.snapshot && (!profile?.manifest || !sameBrowserSnapshot(target.snapshot, profile.manifest.snapshot))) fail('Target and manifest must identify the exact same snapshot.');
    if (target.exclusion === 'source' && target.computerId !== profile?.sourceComputerId) fail('Source exclusion must identify the designated source.');
  }
  const eligible = job.targets.filter((target) => target.state !== 'excluded');
  if (job.state === 'completed' && (eligible.some((target) => target.state !== 'up_to_date')
    || job.profiles.some((profile) => profile.state !== 'published' && profile.state !== 'excluded'))) fail('Completed jobs require every eligible profile and target to finish.');
  if (job.state === 'partial' && (!eligible.some((target) => target.state === 'failed') || !eligible.some((target) => target.state === 'up_to_date'))) fail('Partial jobs require both a failed and a completed eligible target.');
}); // Read endpoints page profiles/targets; do not fetch all on computer lists.


export type NodeBrowserSettings = z.infer<typeof NodeBrowserSettingsSchema>;
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;
export type BrowserSnapshotIdentity = z.infer<typeof BrowserSnapshotIdentitySchema>;
export type BrowserProfileSnapshotManifest = z.infer<typeof BrowserProfileSnapshotManifestSchema>;
export type BrowserLoginEvidence = z.infer<typeof BrowserLoginEvidenceSchema>;
export type BrowserProfileReplica = z.infer<typeof BrowserProfileReplicaSchema>;
export type BrowserProfileSyncTarget = z.infer<typeof BrowserProfileSyncTargetSchema>;
export type BrowserProfileSyncJob = z.infer<typeof BrowserProfileSyncJobSchema>;

export function sameBrowserSnapshot(left: BrowserSnapshotIdentity, right: BrowserSnapshotIdentity): boolean {
  return left.profileId === right.profileId && left.publishedRevision === right.publishedRevision
    && left.sha256 === right.sha256 && left.format === right.format;
}
