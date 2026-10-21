import { z } from 'zod';
import { IdSchema } from './schemaPrimitives.js';
import { AgentSubjectSchema } from './agentIdentity.js';
import { BrowserControlSchema, BrowserPrepareResultSchema, BrowserReleaseResultSchema } from './browserSessions.js';
import { NodeBrowserSettingsSchema, BrowserProfileSnapshotManifestSchema, BrowserSnapshotIdentitySchema } from './browserProfiles.js';
import { BrowserFrameSchema, BrowserRuntimeViewSchema } from './browserOperations.js';

export const BROWSER_DEVICE_EXTENSION = { namespace: 'browser-v1', version: 1, role: 'duplex',
  maxJsonBytes: 1_048_576, maxBinaryBytes: 262_144 } as const;
export const BROWSER_MEDIA_PATH = '/device/browser-media';
export const BrowserInstallationBindingSchema = z.object({ computerId: IdSchema, installationId: IdSchema,
  connectionId: IdSchema }).strict();
export const BrowserLifecyclePrepareSchema = z.object({ subject: AgentSubjectSchema, browser: NodeBrowserSettingsSchema,
  computerId: IdSchema, commandId: IdSchema }).strict();
export const BrowserLifecycleReleaseSchema = z.object({ sessionId: IdSchema, subject: AgentSubjectSchema,
  commandId: IdSchema, reason: z.enum(['terminal', 'stop', 'conversation_closed', 'runtime_update']) }).strict();
export const BrowserRuntimeStatusSchema = z.object({ computerId: IdSchema, ready: z.boolean(),
  phase: z.string(), reason: z.string().nullable(), runtimeVersion: z.string().optional() }).strict();
export const BrowserPreparedBindingSchema = z.object({ subject: AgentSubjectSchema, browser: NodeBrowserSettingsSchema,
  computerId: IdSchema, readOnly: z.boolean(), availability: z.enum(['ready', 'profile_missing', 'computer_offline',
    'runtime_missing', 'sign_in_required', 'resource_pressure', 'profile_busy']) }).strict();
export const BrowserPrivateCommandSchema = z.object({ kind: z.enum(['profile', 'session']), method: z.string().min(1),
  args: z.array(z.unknown()).max(3), principalId: IdSchema.optional() }).strict();
export const BrowserPrivateEnvelopeSchema = z.object({ authorizationId: z.uuid(),
  kind: z.enum(['command', 'upload', 'download']), value: z.unknown() }).strict();
export const BrowserDeviceRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('command'), envelope: BrowserPrivateEnvelopeSchema }).strict(),
  z.object({ operation: z.literal('authorize'), envelope: BrowserPrivateEnvelopeSchema }).strict(),
  z.object({ operation: z.literal('subject'), subject: AgentSubjectSchema }).strict(),
  z.object({ operation: z.literal('subject-current'), subject: AgentSubjectSchema }).strict(),
  z.object({ operation: z.literal('session-authorize'), principalId: IdSchema, session: z.unknown(), mutate: z.boolean(),
    authorizationId: z.uuid() }).strict(),
  z.object({ operation: z.literal('subject-authorize'), principalId: IdSchema, authorizationId: z.uuid(),
    subject: AgentSubjectSchema, mutate: z.boolean() }).strict(),
  z.object({ operation: z.literal('setup-authorize'), principalId: IdSchema, authorizationId: z.uuid(),
    profileId: IdSchema, computerId: IdSchema, mutate: z.boolean() }).strict(),
  z.object({ operation: z.literal('keys'), input: z.unknown() }).strict(),
  z.object({ operation: z.literal('installation-check'), computerId: IdSchema, installationId: IdSchema }).strict(),
  z.object({ operation: z.literal('runtime-status') }).strict(),
  z.object({ operation: z.literal('runtime-retry') }).strict(),
  z.object({ operation: z.literal('prepare'), input: BrowserLifecyclePrepareSchema }).strict(),
  z.object({ operation: z.literal('release'), input: BrowserLifecycleReleaseSchema }).strict(),
  z.object({ operation: z.literal('upload-open'), transferId: z.uuid(), envelope: BrowserPrivateEnvelopeSchema }).strict(),
  z.object({ operation: z.literal('upload-chunk'), transferId: z.uuid(), offset: z.number().int().nonnegative() }).strict(),
  z.object({ operation: z.literal('upload-finish'), transferId: z.uuid() }).strict(),
  z.object({ operation: z.literal('transfer-close'), transferId: z.uuid() }).strict(),
  z.object({ operation: z.literal('download-open'), transferId: z.uuid(), envelope: BrowserPrivateEnvelopeSchema }).strict(),
  z.object({ operation: z.literal('download-chunk'), transferId: z.uuid(), offset: z.number().int().nonnegative() }).strict(),
]);
export type BrowserDeviceRequest = z.infer<typeof BrowserDeviceRequestSchema>;
export const BrowserLifecycleResultSchema = z.union([BrowserPrepareResultSchema, BrowserReleaseResultSchema]);

export const BrowserViewerHelloSchema = z.object({ viewId: IdSchema, installationId: IdSchema.optional() }).strict();
const frame = { kind: z.literal('frame'), frame: BrowserFrameSchema, offset: z.number().int().nonnegative() };
export const BrowserViewerMessageSchema = z.discriminatedUnion('kind', [
  z.object(frame).strict(), z.object({ kind: z.literal('control'), control: BrowserControlSchema }).strict(),
  z.object({ kind: z.literal('closed') }).strict(),
]);
export const BrowserHostMediaMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('open'), id: IdSchema, ownerId: IdSchema, sessionId: IdSchema, viewId: IdSchema }).strict(),
  z.object({ kind: z.literal('close'), id: IdSchema, disconnected: z.boolean() }).strict(),
  z.object({ kind: z.literal('opened'), id: IdSchema, view: BrowserRuntimeViewSchema }).strict(),
  z.object({ kind: z.literal('snapshot_end'), id: IdSchema }).strict(),
  z.object({ kind: z.literal('control'), id: IdSchema, control: BrowserControlSchema }).strict(),
  z.object({ id: IdSchema, ...frame }).strict(),
  z.object({ kind: z.literal('error'), id: IdSchema, reason: z.string() }).strict(),
]);
export function encodeBrowserBinaryFrame(header: unknown, bytes: Uint8Array): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify(header));
  if (metadata.byteLength > 16_384 || metadata.byteLength + bytes.byteLength + 4 > 262_144) throw new Error('Browser frame chunk exceeds its bound.');
  const result = new Uint8Array(4 + metadata.byteLength + bytes.byteLength);
  new DataView(result.buffer).setUint32(0, metadata.byteLength);
  result.set(metadata, 4); result.set(bytes, 4 + metadata.byteLength);
  return result;
}
export function decodeBrowserBinaryFrame(value: Uint8Array): { header: unknown; bytes: Uint8Array } {
  if (value.byteLength < 4 || value.byteLength > 262_144) throw new Error('Invalid browser frame chunk.');
  const length = new DataView(value.buffer, value.byteOffset, value.byteLength).getUint32(0);
  if (length > 16_384 || length + 4 >= value.byteLength) throw new Error('Invalid browser frame header.');
  return { header: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(value.subarray(4, 4 + length))),
    bytes: value.slice(4 + length) };
}

const transfer = z.object({ snapshot: BrowserSnapshotIdentitySchema, manifest: BrowserProfileSnapshotManifestSchema }).strict()
export const BrowserKeyRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('export'), input: z.object({ profileId: z.string(), publishedRevision: z.number().int().positive(),
    operationId: z.string(), stateHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }).strict(),
  z.object({ kind: z.literal('snapshot'), transfer, jobId: z.string() }).strict(),
])
export const BrowserKeyEnvelopeSchema = z.object({ keyId: z.string(), profileId: z.string(), publishedRevision: z.number().int().positive(),
  operationId: z.string(), source: BrowserInstallationBindingSchema, recipient: BrowserInstallationBindingSchema,
  snapshot: BrowserSnapshotIdentitySchema.nullable(), stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().max(4096) }).strict()
export const BrowserPrivateResultSchema = z.object({ value: z.unknown() }).strict()

