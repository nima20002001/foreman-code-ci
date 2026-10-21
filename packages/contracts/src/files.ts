import { optionalCommandId } from './management/commands.js'
import { z } from "zod";
import { FileNameSchema } from "./filePrimitives.js";
export { FileNameSchema } from "./filePrimitives.js";
import { JobExecutionFileScopeSchema, JobArtifactFileSchema, JobArtifactFileRevisionSchema } from "./jobArtifacts.js";
import { IdSchema, TimestampSchema } from "./schemaPrimitives.js";

/** FIL-02 / FEAT-03. Metadata contracts only; never proof of authorization or byte validation. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILE_READ_BYTES = 64 * 1024;
export const MAX_MESSAGE_ATTACHMENTS = 10;
export const MAX_FILE_PAGE_SIZE = 100;
export const MIN_FILE_RETENTION_SECONDS = 60 * 60;
export const DEFAULT_FILE_RETENTION_SECONDS = 7 * 24 * 60 * 60;
export const MAX_FILE_RETENTION_SECONDS = 365 * 24 * 60 * 60;

export const FILE_MEDIA_TYPES = [
  "image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/markdown", "application/zip",
] as const;
export const FileMediaTypeSchema = z.enum(FILE_MEDIA_TYPES);
export type FileMediaType = z.infer<typeof FileMediaTypeSchema>;
export const FILE_EXTENSIONS_BY_MEDIA_TYPE: Readonly<Record<FileMediaType, readonly string[]>> = Object.freeze({
  "image/png": Object.freeze(["png"]),
  "image/jpeg": Object.freeze(["jpg", "jpeg"]),
  "image/webp": Object.freeze(["webp"]),
  "image/gif": Object.freeze(["gif"]),
  "application/pdf": Object.freeze(["pdf"]),
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": Object.freeze(["docx"]),
  "text/markdown": Object.freeze(["md"]),
  "application/zip": Object.freeze(["zip"]),
});
export const FileSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const FileOriginSchema = z.enum(["upload", "agent_output", "agent_copy"]);
const FileStateSchema = z.enum(["pending", "ready", "expired", "removed"]);
export type FileState = z.infer<typeof FileStateSchema>;
export const FileRetentionDurationSchema = z.number().int()
  .min(MIN_FILE_RETENTION_SECONDS).max(MAX_FILE_RETENTION_SECONDS);
const Revision = z.number().int().nonnegative();
const Command = z.string().trim().min(8).max(200);
const UtcTimestamp = z.string().datetime();
const Page = {
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_FILE_PAGE_SIZE).default(50),
};
const PageInfo = z.object({ nextCursor: z.string().min(1).nullable() }).strict();

const OperatorFileChatScopeSchema = z.object({
  kind: z.literal("operator"),
  ownerPrincipalId: IdSchema, operatorId: IdSchema, conversationId: IdSchema,
}).strict();
const AgentFileChatScopeSchema = z.object({
  kind: z.literal("agent"),
  conversationId: IdSchema, agentId: IdSchema, workspaceId: IdSchema, workflowId: IdSchema,
  runId: IdSchema.optional(), executionId: IdSchema.optional(),
}).strict().refine((scope) => (scope.runId === undefined) === (scope.executionId === undefined),
  "runId and executionId must be supplied together");
export const TemporaryFileScopeSchema = z.object({
  kind: z.literal("temporary"),
  chat: z.discriminatedUnion("kind", [OperatorFileChatScopeSchema, AgentFileChatScopeSchema]),
}).strict();
export const WorkflowReferenceFileScopeSchema = z.object({
  kind: z.literal("workflow_reference"), workspaceId: IdSchema, workflowId: IdSchema,
}).strict();
export const WorkspaceReferenceFileScopeSchema = z.object({
  kind: z.literal("workspace_reference"), workspaceId: IdSchema,
}).strict();
export const PermanentFileScopeSchema = z.discriminatedUnion("kind", [
  WorkflowReferenceFileScopeSchema, WorkspaceReferenceFileScopeSchema,
]);
export const FileScopeSchema = z.discriminatedUnion("kind", [
  TemporaryFileScopeSchema, WorkflowReferenceFileScopeSchema, WorkspaceReferenceFileScopeSchema, JobExecutionFileScopeSchema,
]);
export type WorkflowReferenceFileScope = z.infer<typeof WorkflowReferenceFileScopeSchema>;
export type WorkspaceReferenceFileScope = z.infer<typeof WorkspaceReferenceFileScopeSchema>;
export type TemporaryFileScope = z.infer<typeof TemporaryFileScopeSchema>;
export type PermanentFileScope = z.infer<typeof PermanentFileScopeSchema>;
export type FileScope = z.infer<typeof FileScopeSchema>;

/** Fixed-duration UTC arithmetic. No ambient clock, local calendar arithmetic, or sliding lease. */
export function temporaryFileExpiresAt(createdAt: string, durationSeconds: number): string {
  const start = Date.parse(TimestampSchema.parse(createdAt));
  const duration = FileRetentionDurationSchema.parse(durationSeconds);
  return UtcTimestamp.parse(new Date(start + duration * 1_000).toISOString());
}

const FileIdentity = {
  fileId: IdSchema,
  /** Mutable discovery pointer ONLY. Reads and Run provenance must pin a separate revisionId. */
  currentRevisionId: IdSchema,
  createdAt: TimestampSchema,
};
export const TemporaryFileSchema = z.object({
  ...FileIdentity, scope: TemporaryFileScopeSchema, state: FileStateSchema,
  retentionDurationSeconds: FileRetentionDurationSchema, expiresAt: UtcTimestamp,
}).strict().refine((file) => Date.parse(file.expiresAt) - Date.parse(file.createdAt)
  === file.retentionDurationSeconds * 1_000, "expiresAt must equal createdAt plus the retention snapshot");
const PermanentFileSchema = z.object({
  ...FileIdentity, scope: PermanentFileScopeSchema,
  state: z.enum(["pending", "ready", "removed"]),
}).strict();
/** Removed files retain this record as a tombstone; a missing head/creation identity is invalid. */
export const FileSchema = z.union([TemporaryFileSchema, PermanentFileSchema, JobArtifactFileSchema]);
export type TemporaryFile = z.infer<typeof TemporaryFileSchema>;
export type PermanentFile = z.infer<typeof PermanentFileSchema>;
export type File = z.infer<typeof FileSchema>;

function hasMatchingExtension(value: { filename: string; mediaType: FileMediaType }): boolean {
  const extension = value.filename.slice(value.filename.lastIndexOf(".") + 1).toLowerCase();
  return value.filename.includes(".") && FILE_EXTENSIONS_BY_MEDIA_TYPE[value.mediaType].includes(extension);
}
const FileDescription = { filename: FileNameSchema, mediaType: FileMediaTypeSchema };
export const FileDescriptionSchema = z.object(FileDescription).strict()
  .refine(hasMatchingExtension, "Filename extension must match an allowed media type");
/** A revision identifies one immutable set of bytes and metadata, never the current-file pointer. */
export const FileRevisionSchema = z.object({
  fileId: IdSchema, revisionId: IdSchema, ...FileDescription,
  byteSize: z.number().int().min(0).max(MAX_FILE_BYTES),
  sha256: FileSha256Schema, origin: FileOriginSchema, createdAt: TimestampSchema,
}).strict().refine(hasMatchingExtension, "Filename extension must match an allowed media type").readonly();
export type FileRevision = z.infer<typeof FileRevisionSchema>;

function revisionBelongsToFile(value: { file: File; revision: FileRevision | z.infer<typeof JobArtifactFileRevisionSchema> }): boolean {
  if ((value.file.scope.kind === "job_execution") !== (value.revision.origin === "job_output")) return false;
  return value.file.fileId === value.revision.fileId
    && Date.parse(value.revision.createdAt) >= Date.parse(value.file.createdAt);
}
/** Historical readback may intentionally return a revision other than currentRevisionId. */
export const FileWithRevisionSchema = z.object({ file: FileSchema, revision: z.union([FileRevisionSchema, JobArtifactFileRevisionSchema]) })
  .strict().refine(revisionBelongsToFile, "Revision must belong to this file and not predate it");
export type FileWithRevision = z.infer<typeof FileWithRevisionSchema>;

/** Effective state at an explicit UTC instant; an overdue pending/ready record is already expired. */
export function fileStateAt(file: File, asOfUtc: string): FileState {
  const value = FileSchema.parse(file);
  const now = Date.parse(UtcTimestamp.parse(asOfUtc));
  if (value.state === "removed" || value.state === "expired") return value.state;
  return "expiresAt" in value && Date.parse(value.expiresAt) <= now ? "expired" : value.state;
}

/** Apply-to-existing is only for still-live temporary files. Never un-expire an overdue record. */
export function applyFileRetention(file: File, durationSeconds: number, asOfUtc: string): File {
  const value = FileSchema.parse(file);
  const duration = FileRetentionDurationSchema.parse(durationSeconds);
  const state = fileStateAt(value, asOfUtc);
  if (!("expiresAt" in value)) return value;
  if (state === "removed" || state === "expired") return { ...value, state };
  const updated = { ...value, retentionDurationSeconds: duration,
    expiresAt: temporaryFileExpiresAt(value.createdAt, duration) };
  return { ...updated, state: fileStateAt(updated, asOfUtc) };
}

export function canTransitionFileState(file: File, to: FileState, asOfUtc: string): boolean {
  const value = FileSchema.parse(file);
  if (to === "expired" && !("expiresAt" in value)) return false;
  const from = fileStateAt(value, asOfUtc);
  if (from === to) return true;
  if (from === "removed") return false;
  if (to === "removed") return true;
  return (from === "pending" && (to === "ready" || to === "expired"))
    || (from === "ready" && to === "expired");
}

/** The authenticated principal selects the preference. Mutation inputs cannot choose another owner. */
export const FileRetentionPreferenceSchema = z.object({
  ownerPrincipalId: IdSchema,
  durationSeconds: FileRetentionDurationSchema.default(DEFAULT_FILE_RETENTION_SECONDS),
  revision: Revision,
}).strict();
export const FileRetentionGetInputSchema = z.object({}).strict();
export const FileRetentionGetResultSchema = z.object({ preference: FileRetentionPreferenceSchema }).strict();
export const FileRetentionSaveInputSchema = z.object({
  commandId: optionalCommandId(Command), expectedRevision: Revision.optional().describe('Omit for last write wins; supply to reject a stale revision.'), durationSeconds: FileRetentionDurationSchema,
  applyToExisting: z.boolean().optional(),
}).strict();
export const FileRetentionSaveResultSchema = z.object({
  value: z.object({
    preference: FileRetentionPreferenceSchema,
    updatedFileCount: z.number().int().nonnegative(), expiredNowCount: z.number().int().nonnegative(),
  }).strict().refine((value) => value.expiredNowCount <= value.updatedFileCount,
    "Expired files must be included in the updated count"),
  replayed: z.boolean(),
}).strict();
export const FileRetentionPreviewInputSchema = z.object({ durationSeconds: FileRetentionDurationSchema }).strict();
export const FileRetentionPreviewResultSchema = z.object({
  ownerPrincipalId: IdSchema, preferenceRevision: Revision, durationSeconds: FileRetentionDurationSchema,
  asOfUtc: UtcTimestamp,
  /** Still-live files of this owner that the proposed snapshot would expire at asOfUtc. */
  expireNowCount: z.number().int().nonnegative(),
}).strict();
export type FileRetentionPreference = z.infer<typeof FileRetentionPreferenceSchema>;
export type FileRetentionGetResult = z.infer<typeof FileRetentionGetResultSchema>;
export type FileRetentionSaveInput = z.infer<typeof FileRetentionSaveInputSchema>;
export type FileRetentionSaveResult = z.infer<typeof FileRetentionSaveResultSchema>;
export type FileRetentionPreviewInput = z.infer<typeof FileRetentionPreviewInputSchema>;
export type FileRetentionPreviewResult = z.infer<typeof FileRetentionPreviewResultSchema>;

export const MessageAttachmentRefSchema = z.object({ fileId: IdSchema, revisionId: IdSchema }).strict();
export const MessageAttachmentRefsSchema = z.array(MessageAttachmentRefSchema).max(MAX_MESSAGE_ATTACHMENTS)
  .refine((refs) => new Set(refs.map((ref) => ref.fileId)).size === refs.length,
    "Attach a logical file at most once per message");
/** Compose these fields into BOTH chat send contracts; no send contracts are edited in this lane. */
export const MessageAttachmentFields = { attachments: MessageAttachmentRefsSchema.default([]) };
const MessageFileIdentitySchema = z.object({ requestId: IdSchema, ...MessageAttachmentFields }).strict();
export type MessageAttachmentRef = z.infer<typeof MessageAttachmentRefSchema>;

/** Canonical identity component, NOT a replacement for the existing text/intent/target input hash.
 * Attachment order matters. Add this component to both chat receipt hashes before accepting sends. */
export function messageAttachmentIdentity(input: z.input<typeof MessageFileIdentitySchema>): string {
  const value = MessageFileIdentitySchema.parse(input);
  return JSON.stringify([value.requestId, value.attachments.map((ref) => [ref.fileId, ref.revisionId])]);
}
export function hasMessageAttachmentConflict(
  previous: z.input<typeof MessageFileIdentitySchema>, next: z.input<typeof MessageFileIdentitySchema>,
): boolean {
  const before = MessageFileIdentitySchema.parse(previous);
  const after = MessageFileIdentitySchema.parse(next);
  return before.requestId === after.requestId && messageAttachmentIdentity(before) !== messageAttachmentIdentity(after);
}

/** Small metadata-only rows: no paths, signed URLs, inline bytes, or inferred latest-version reads. */
export const FileRowSchema = FileWithRevisionSchema.refine(
  (row) => row.file.currentRevisionId === row.revision.revisionId, "List rows must describe the current revision");
export const FilePageSchema = z.object({
  items: z.array(FileRowSchema).max(MAX_FILE_PAGE_SIZE), pageInfo: PageInfo,
}).strict().refine((page) => new Set(page.items.map((row) => row.file.fileId)).size === page.items.length,
  "A file may appear only once on a page");
export type FileRow = z.infer<typeof FileRowSchema>;
export type FilePage = z.infer<typeof FilePageSchema>;

export const AgentFileListInputSchema = z.object({ scope: FileScopeSchema, ...Page }).strict();
export const AgentFileListResultSchema = FilePageSchema;
export const AgentReferenceListInputSchema = AgentFileListInputSchema.pick({ cursor: true, limit: true }).strict();
export const AgentReferenceManifestSchema = z.object({
  items: z.array(z.object(FileRevisionSchema.unwrap().shape).pick({
    fileId: true, revisionId: true, filename: true, mediaType: true, byteSize: true,
  }).extend({ scope: PermanentFileScopeSchema, state: z.enum(['pending', 'ready', 'removed']) }).strict()),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict();
export const AgentFileReadInputSchema = MessageAttachmentRefSchema.extend({
  offset: z.number().int().min(0).max(MAX_FILE_BYTES).default(0),
  length: z.number().int().min(1).max(MAX_FILE_READ_BYTES).default(MAX_FILE_READ_BYTES),
}).strict();
// Canonical padded base64 (including zero pad bits); no Node-only Buffer import in shared contracts.
const ReadBytes = z.string().max(4 * Math.ceil(MAX_FILE_READ_BYTES / 3))
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/);
function base64ByteLength(value: string): number {
  return value.length / 4 * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
}
export const AgentFileReadResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"), file: FileSchema, revision: z.union([FileRevisionSchema, JobArtifactFileRevisionSchema]), readAt: UtcTimestamp,
    offset: z.number().int().min(0).max(MAX_FILE_BYTES),
    byteLength: z.number().int().min(0).max(MAX_FILE_READ_BYTES), contentBase64: ReadBytes, eof: z.boolean(),
  }).strict().refine((value) => revisionBelongsToFile(value) && value.file.state === "ready"
    && (!("expiresAt" in value.file) || Date.parse(value.file.expiresAt) > Date.parse(value.readAt))
    && Date.parse(value.readAt) >= Date.parse(value.revision.createdAt)
    && base64ByteLength(value.contentBase64) === value.byteLength
    && value.offset + value.byteLength <= value.revision.byteSize
    && value.eof === (value.offset + value.byteLength === value.revision.byteSize)
    && (value.byteLength > 0 || value.eof), "Read metadata, byte range, and content must agree"),
  z.object({
    status: z.literal("unavailable"), ref: MessageAttachmentRefSchema,
    reason: z.enum(["pending", "expired", "removed", "not_found", "forbidden"]),
  }).strict(),
]);
export type AgentFileReadInput = z.infer<typeof AgentFileReadInputSchema>;
export type AgentFileReadResult = z.infer<typeof AgentFileReadResultSchema>;

/** Bind readback to the requested immutable revision/range, never silently substitute newer bytes. */
export function parseAgentFileReadResult(input: unknown, result: unknown): AgentFileReadResult {
  const request = AgentFileReadInputSchema.parse(input);
  const response = AgentFileReadResultSchema.parse(result);
  const ref = response.status === "ready" ? response.revision : response.ref;
  if (ref.fileId !== request.fileId || ref.revisionId !== request.revisionId
    || (response.status === "ready" && (response.offset !== request.offset || response.byteLength > request.length))) {
    throw new Error("File readback does not match the requested revision/range");
  }
  return response;
}

/** Copies land in an authenticated conversation's working area, not in reference storage.
 * artifactId is an opaque runner-owned handle, scoped to this conversation; not a host path or URL. */
export const AgentFileCreateWorkingCopyInputSchema = z.object({
  commandId: Command, source: MessageAttachmentRefSchema, destination: TemporaryFileScopeSchema,
}).strict();
export const AgentFileCreateWorkingCopyResultSchema = z.object({
  value: z.object({
    artifactId: IdSchema, source: MessageAttachmentRefSchema, destination: TemporaryFileScopeSchema,
    filename: FileNameSchema, createdAt: TimestampSchema,
  }).strict(), replayed: z.boolean(),
}).strict();
/** Publish allocates NEW fileId/revisionId values. No target/replace/remove operation is exposed.
 * The handle may identify a working copy or generated output; the server computes size/hash/origin. */
export const AgentFilePublishInputSchema = z.object({
  commandId: Command, artifactId: IdSchema, scope: TemporaryFileScopeSchema, ...FileDescription,
}).strict().refine(hasMatchingExtension, "Filename extension must match an allowed media type");
export const AgentFilePublishResultSchema = z.object({
  value: z.object({ file: TemporaryFileSchema, revision: FileRevisionSchema }).strict()
    .refine((value) => revisionBelongsToFile(value) && value.file.state === "ready"
      && value.file.currentRevisionId === value.revision.revisionId && value.revision.origin !== "upload",
    "Agent results must be ready temporary files with the exact published revision"),
  replayed: z.boolean(),
}).strict();
export type AgentFileCreateWorkingCopyResult = z.infer<typeof AgentFileCreateWorkingCopyResultSchema>;
export type AgentFilePublishInput = z.infer<typeof AgentFilePublishInputSchema>;
export type AgentFilePublishResult = z.infer<typeof AgentFilePublishResultSchema>;

/** Append-only audit fact. Preserve these pins even after retention/removal makes bytes unavailable. */
export const RunFileProvenanceSchema = z.object({
  runId: IdSchema, executionId: IdSchema, fileId: IdSchema, revisionId: IdSchema, readAt: TimestampSchema,
}).strict().readonly();
export type RunFileProvenance = z.infer<typeof RunFileProvenanceSchema>;

export const BoardFilesListInputSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema,
  workflowCursor: Page.cursor, inheritedWorkspaceCursor: Page.cursor, limit: Page.limit,
}).strict();
export const BoardFilesListSchema = z.object({
  workspaceId: IdSchema, workflowId: IdSchema,
  workflowFiles: FilePageSchema, inheritedWorkspaceFiles: FilePageSchema,
}).strict().refine((list) => list.workflowFiles.items.every(({ file }) => file.scope.kind === "workflow_reference"
  && file.scope.workspaceId === list.workspaceId && file.scope.workflowId === list.workflowId)
  && list.inheritedWorkspaceFiles.items.every(({ file }) => file.scope.kind === "workspace_reference"
    && file.scope.workspaceId === list.workspaceId)
  && new Set([...list.workflowFiles.items, ...list.inheritedWorkspaceFiles.items].map(({ file }) => file.fileId)).size
    === list.workflowFiles.items.length + list.inheritedWorkspaceFiles.items.length,
"Board groups must contain distinct references from this workflow or its workspace");
export const WorkspaceProjectFilesListInputSchema = z.object({ workspaceId: IdSchema, ...Page }).strict();
export const WorkspaceProjectFilesListSchema = z.object({ workspaceId: IdSchema, files: FilePageSchema }).strict()
  .refine((list) => list.files.items.every(({ file }) => file.scope.kind === "workspace_reference"
    && file.scope.workspaceId === list.workspaceId), "Project files must belong to this workspace");
export type BoardFilesListInput = z.infer<typeof BoardFilesListInputSchema>;

/** FIL-05b. Additive working-copy tools; never accept file/reference IDs or host paths as targets. */
export const MAX_FILE_WRITE_BYTES = MAX_FILE_BYTES;
/** Canonical padded base64, bounded BEFORE decoding. Avoid a repeated-group regex on full files. */
export const FileWorkingCopyBytesSchema = z.string().max(4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3))
  .refine((value) => value.length <= 4 * Math.ceil(MAX_FILE_WRITE_BYTES / 3)
    && value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value) && /^[A-Za-z0-9+/]*={0,2}$/.test(value)
    && (!value.endsWith("==") || /[AQgw]==$/.test(value))
    && (!value.endsWith("=") || value.endsWith("==") || /[AEIMQUYcgkosw048]=$/.test(value))
    && base64ByteLength(value) <= MAX_FILE_WRITE_BYTES, "Expected bounded canonical base64");
const WorkingCopyEditTarget = {
  artifactId: IdSchema,
  /** A working-copy snapshot revision, NOT the source file revision. Omit on the first edit. */
  baseRevisionId: IdSchema.optional(),
};
export const AgentFileWriteWorkingCopyInputSchema = z.object({
  ...WorkingCopyEditTarget, contentBase64: FileWorkingCopyBytesSchema,
}).strict();
/** Only the existing helpers' supported edits; media type is derived from the owned artifact. */
const AgentFileFormatEditSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("append_text"), text: z.string().max(MAX_FILE_READ_BYTES)
    .refine((text) => text.length <= MAX_FILE_READ_BYTES
      && new TextEncoder().encode(text).byteLength <= MAX_FILE_READ_BYTES,
      "Append text exceeds the UTF-8 byte limit") }).strict(),
  z.object({ kind: z.literal("resize_image"), width: z.number().int().min(1).max(8192),
    height: z.number().int().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal("replace_zip_entry"), entryName: z.string().min(1).max(1024),
    contentBase64: FileWorkingCopyBytesSchema }).strict(),
]);
export const AgentFileApplyFormatEditInputSchema = z.object({
  ...WorkingCopyEditTarget, edit: AgentFileFormatEditSchema,
}).strict();
/** This identifies the committed working snapshot, not a published file or a storage location. */
export const AgentFileWorkingCopyEditResultSchema = z.object({
  artifactId: IdSchema, revisionId: IdSchema,
  byteSize: z.number().int().min(0).max(MAX_FILE_WRITE_BYTES), sha256: FileSha256Schema,
}).strict();
export const AgentFileWriteWorkingCopyResultSchema = AgentFileWorkingCopyEditResultSchema;
export const AgentFileApplyFormatEditResultSchema = AgentFileWorkingCopyEditResultSchema;
export type AgentFileFormatEdit = z.infer<typeof AgentFileFormatEditSchema>;

/** Shared upload metadata and permanent-reference transport envelopes. */
const uploadDescription = FileRevisionSchema.unwrap().shape
export const FileUploadRequestSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  filename: uploadDescription.filename, mediaType: uploadDescription.mediaType,
  byteSize: uploadDescription.byteSize, sha256: uploadDescription.sha256,
}).strict().superRefine((input, context) => {
  const revision = FileRevisionSchema.safeParse({ filename: input.filename, mediaType: input.mediaType,
    byteSize: input.byteSize, sha256: input.sha256, fileId: 'validation', revisionId: 'validation',
    origin: 'upload', createdAt: '2000-01-01T00:00:00.000Z' })
  if (!revision.success) for (const issue of revision.error.issues) {
    context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
  }
})
export type FileUploadRequest = z.infer<typeof FileUploadRequestSchema>

export const MAX_REFERENCE_BASE64_CHARACTERS = 4 * Math.ceil(MAX_FILE_BYTES / 3);
export const FileReferenceListInputSchema = AgentFileListInputSchema.extend({ scope: PermanentFileScopeSchema })
export const FileReferenceReadInputSchema = AgentFileReadInputSchema.extend({ scope: PermanentFileScopeSchema })
export const FileReferenceReadResultSchema = z.object({ value: AgentFileReadResultSchema }).strict()
export const FileReferenceAddInputSchema = z.object({
  scope: PermanentFileScopeSchema,
  upload: FileUploadRequestSchema,
  contentBase64: z.string().max(MAX_REFERENCE_BASE64_CHARACTERS),
}).strict()
export const FileReferenceRemoveBodySchema = z.object({
  commandId: FileRetentionSaveInputSchema.shape.commandId,
}).strict()
export const FileReferenceRemoveInputSchema = FileReferenceRemoveBodySchema.extend(MessageAttachmentRefSchema.shape)
export const FileReferenceRemoveToolInputSchema = FileReferenceRemoveInputSchema.extend({ scope: PermanentFileScopeSchema })
export const FileReferenceMutationResultSchema = z.object({
  value: FileWithRevisionSchema.refine((row) => row.file.scope.kind !== 'temporary', 'Expected a permanent reference'),
  replayed: z.boolean(),
}).strict()

export const FileMutationResultSchema = z.object({ value: FileWithRevisionSchema, replayed: z.boolean() }).strict();
export const FileConversationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('operator'), conversationId: IdSchema }).strict(),
  z.object({ kind: z.literal('agent'), workspaceId: IdSchema, conversationId: IdSchema }).strict(),
]);
export const ConversationFileUploadInputSchema = z.object({
  conversation: FileConversationSchema, upload: FileUploadRequestSchema,
  contentBase64: z.string().max(MAX_REFERENCE_BASE64_CHARACTERS),
}).strict();
export const ConversationFileCommandInputSchema = z.object({
  conversation: FileConversationSchema, requestId: FileUploadRequestSchema.shape.requestId,
}).strict();
export const ConversationFilesListInputSchema = AgentFileListInputSchema.omit({ scope: true }).extend({
  conversation: FileConversationSchema,
});
export const ConversationFileReadInputSchema = AgentFileReadInputSchema.extend({ conversation: FileConversationSchema });
export const ConversationFileReadResultSchema = z.object({ value: AgentFileReadResultSchema }).strict();
