import type { Readable } from 'node:stream'
import type {
  FileRevision, FileWithRevision, MessageAttachmentRef, TemporaryFileScope,
} from '@foreman-code/contracts/files'
import type { AgentFileToolService } from '../../files/tools/service.js'
import type { FileToolOperation } from '../../files/tools/types.js'

/** Trusted chat admission, not HTTP input and not a native tool's arguments. */
export interface AcceptedCodexFileTurn {
  ownerPrincipalId: string
  scope: TemporaryFileScope
  nativeSessionId: string
  messageId?: string
  /** Persisted send/turn admission identity. Not the provider turn ID. */
  admissionId: string
  executionHostId: string
  projectMode: 'read' | 'write'
  /** Accepted file-tool policy, never inferred from the owner's broader grants. */
  allowMutation: boolean
  allowedTools: readonly FileToolOperation[]
  expiresAt: Date
  attachments: readonly MessageAttachmentRef[]
}

/** FIL-10's authenticated attachment read seam. Both calls must reauthorize the owner
 * and persisted conversation lineage. No API storage paths cross this boundary. */
export interface CodexAttachmentSource {
  open(ref: MessageAttachmentRef): Promise<{ value: FileWithRevision; stream: Readable }>
  recheck(ref: MessageAttachmentRef): Promise<FileWithRevision>
}

export interface RegisteredCodexCopy {
  registrationId: string
  executionHostId: string
  /** An absolute path in the execution process's filesystem namespace. */
  executionPath: string
  writable: boolean
  byteSize: number
  sha256: string
}

/** Implement on the selected execution host, never by mapping an API storage path.
 * The host allocates random names and privately owns registration -> path lookup.
 * Readers/writers must reject links, traversal, special files and size overflow.
 * Copy bytes, never hard-link reference backing storage. Read-only receipts require
 * actual process-namespace isolation: source storage and its parents must not be
 * writable by Codex, even when its project is writable. No chmod-only guarantee,
 * writable-root expansion, or API-host path substitution is sufficient.
 * close must be idempotent and clean only this lease's allocations.
 *
 * sealCompleted is deliberately stronger than readFile/chmod/stat: the runner must
 * establish that all writers have finished, fence further writers, and stream an
 * immutable snapshot. A live/uncertain writer MUST fail, not yield partial bytes.
 * A chmod-only implementation under Codex's own UID does not satisfy this port.
 * Repeated sealCompleted calls must return the same frozen bytes, never reopen
 * the registration for writing or select new mutable bytes after a lost reply.
 * There is no source-reference path or arbitrary-path open operation here. */
export interface CodexFileHostLease {
  readonly executionHostId: string
  readonly pathStyle: 'posix' | 'win32'
  materialize(input: {
    filename: string
    mediaType: FileRevision['mediaType']
    sha256: string
    byteSize: number
    writable: boolean
    bytes: Readable
  }): Promise<RegisteredCodexCopy>
  sealCompleted(registrationId: string): Promise<Readable>
  close(): Promise<void>
}

export type CodexFileServices = Pick<AgentFileToolService,
  'list' | 'read' | 'createWorkingCopy' | 'publish' | 'publishedForTurn' | 'writeWorkingCopy' | 'applyFormatEdit'> & {
    sessions: Pick<AgentFileToolService['sessions'], 'issueForAcceptedSession' | 'authenticate' | 'revoke' | 'renew'>
    artifacts: Pick<AgentFileToolService['artifacts'], 'beginWrite' | 'completeWrite' | 'abortWrite'>
  }

export interface CodexFileLimits {
  fileBytes: number
  readBytes: number
  attachments: number
}

export interface CodexFileCall {
  threadId: string
  turnId: string
  tool: string
  arguments: unknown
  namespace?: string | null
}
export interface CodexFileCallResult {
  success: boolean
  contentItems: Array<{ type: 'inputText'; text: string }>
}
export type CodexFileInput =
  | { type: 'text'; text: string; text_elements: [] }
  | { type: 'localImage'; path: string }

export type CodexImagePreparation = (bytes: Uint8Array, mediaType: FileRevision['mediaType']) => Promise<{
  bytes: Uint8Array; mediaType: FileRevision['mediaType']; firstFrameOnly: boolean
}>
