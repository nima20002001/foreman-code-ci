import type { Readable } from 'node:stream'
import type {
  AgentFileCreateWorkingCopyResult, AgentFileReadResult, FilePage, FileRevision, FileWithRevision,
  MessageAttachmentRef, PermanentFileScope, RunFileProvenance, TemporaryFileScope,
} from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

export const FILE_TOOL_NAMES = ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result'] as const
export type FileToolName = typeof FILE_TOOL_NAMES[number]
// Keep the original native-bridge allowlist/type stable until each adapter opts in.
export const FILE_EDIT_TOOL_NAMES = ['files.write_working_copy', 'files.apply_format_edit'] as const
export type FileEditToolName = typeof FILE_EDIT_TOOL_NAMES[number]
export const ALL_FILE_TOOL_NAMES = [...FILE_TOOL_NAMES, ...FILE_EDIT_TOOL_NAMES] as const
export type FileToolOperation = typeof ALL_FILE_TOOL_NAMES[number]

/** Server-issued native session/turn binding. Never constructed from tool arguments or browser selection. */
export interface FileToolContext {
  ownerPrincipalId: string
  scope: TemporaryFileScope
  nativeSessionId: string
  /** Exactly one observed submission kind; message IDs never masquerade as turns. */
  turnId?: string | undefined
  nativeMessageId?: string | undefined
  messageId?: string | undefined
  /** Must come from the accepted harness security configuration, not merely the owner's grants. */
  allowMutation: boolean
  allowedTools: FileToolOperation[]
}
export interface FileToolSession { context: FileToolContext; expiresAt: string }
export interface AuthorizedFileCaller {
  context: FileToolContext
  principal: ManagementPrincipal
  binding: string
}
export interface ArtifactSnapshot {
  storageKey: string
  revision: FileRevision
}
export interface FileToolArtifact {
  artifactId: string
  binding: string
  filename: string
  mediaType: FileRevision['mediaType']
  createdAt: string
  state: 'writing' | 'complete' | 'failed'
  writeId: string
  source?: MessageAttachmentRef
  sourceSha256?: string
  snapshot?: ArtifactSnapshot
  /** Durable ownership of every attempted immutable write, including superseded snapshots. */
  storageKeys?: string[]
  /** Terminal cleanup marker: failed writers may retry, retired artifacts may not. */
  retiredAt?: string
}
export interface CopyReceipt {
  ownerPrincipalId: string
  commandId: string
  inputHash: string
  result: AgentFileCreateWorkingCopyResult
}
export interface PublicationLink {
  ownerPrincipalId: string
  requestId: string
  binding: string
  context: FileToolContext
  ref: MessageAttachmentRef
  createdAt: string
}

/** All writes here are durable before resolving; implementations must use compare-and-set / unique keys. */
export interface FileToolRepository {
  putSession(tokenHash: string, session: FileToolSession): Promise<void>
  session(tokenHash: string, asOfUtc: string): Promise<FileToolSession | undefined>
  revokeSession(tokenHash: string): Promise<void>
  /** Extends a live, unrevoked session; returns false when it is expired or revoked. */
  renewSession(tokenHash: string, expiresAt: string, asOfUtc: string): Promise<boolean>
  createArtifact(artifact: FileToolArtifact): Promise<void>
  artifact(binding: string, artifactId: string): Promise<FileToolArtifact | undefined>
  beginWrite(binding: string, artifactId: string, writeId: string, baseRevisionId?: string): Promise<boolean>
  /** Commit storage ownership before receive/stage/finalize can create any bytes. */
  registerStorage(binding: string, artifactId: string, writeId: string, storageKey: string): Promise<boolean>
  finishWrite(binding: string, artifactId: string, writeId: string, snapshot: ArtifactSnapshot): Promise<boolean>
  failWrite(binding: string, artifactId: string, writeId: string): Promise<void>
  copyReceipt(ownerPrincipalId: string, commandId: string): Promise<CopyReceipt | undefined>
  saveCopyReceipt(receipt: CopyReceipt): Promise<CopyReceipt>
  linkPublication(link: PublicationLink): Promise<void>
  publications(binding: string): Promise<MessageAttachmentRef[]>
  recordRead(binding: string, provenance: RunFileProvenance): Promise<void>
}

/** FIL-37 seam. Resolver must authorize reference inheritance before returning metadata or opening bytes.
 * There deliberately is no write, replace, remove, or publish-reference method. */
export interface FileReferenceResolver {
  list(caller: AuthorizedFileCaller, scope: PermanentFileScope,
    page: { limit: number; cursor?: string }): Promise<FilePage>
  read(caller: AuthorizedFileCaller, input: { fileId: string; revisionId: string; offset: number; length: number }): Promise<AgentFileReadResult>
  open?(caller: AuthorizedFileCaller, ref: MessageAttachmentRef): Promise<{ value: FileWithRevision; stream: Readable }>
}
