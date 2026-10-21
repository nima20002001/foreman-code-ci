import type { GraphSqlClient } from '../run-graph/connection.js'
import type { File, FilePage, FileScope, FileWithRevision, PermanentFileScope, MessageAttachmentRef } from '@foreman-code/contracts/files'

export type FileQuery = GraphSqlClient
export type FileMutationSource = 'http' | 'mcp' | 'device'
/** Reference writes revalidate live grants and lineage in the same transaction as their metadata/audit. */
export interface FileMutationContext {
  source: FileMutationSource
  authorize(query: FileQuery): Promise<void>
}

/** Internal persistence seam, not an authorization boundary. No host path is public metadata. */
export interface StoredFile {
  value: FileWithRevision
  ownerPrincipalId: string
  storageKey: string
}
export type NewStoredFile = StoredFile
export interface FileRepository {
  /** Atomic logical file + first immutable revision. Also accepts permanent scopes (FIL-36). */
  create(value: NewStoredFile): Promise<StoredFile>
  /** Never substitutes currentRevisionId for a requested revision. */
  read(fileId: string, revisionId: string): Promise<StoredFile | undefined>
  /** Exact discriminated scope, not a set of optional/null wildcard filters. */
  list(scope: FileScope, page: { cursor?: string; limit: number }, asOfUtc: string): Promise<FilePage>
  /** Metadata-only, due temporary files only; cleanup owns physical deletion. */
  markExpired(fileId: string, asOfUtc: string): Promise<File | undefined>
}
export type AllocationState = 'allocated' | 'staged' | 'finalized' | 'canceled'
export interface FileAllocation {
  allocationId: string
  requestId: string
  inputHash: string
  state: AllocationState
  stored: StoredFile
}
export interface AllocationSession {
  read(): Promise<FileAllocation | undefined>
  create(allocation: FileAllocation): Promise<void>
  /** Optional transactional preference snapshot + creation. Production FIL-40 installs this adapter. */
  createWithRetention?(build: (durationSeconds: number) => FileAllocation): Promise<FileAllocation>
  /** Atomic allocation/file lifecycle update. The immutable revision is never rewritten. */
  setState(state: AllocationState): Promise<FileAllocation>
}
export interface FileAllocationRepository {
  /** Across API processes; interruption drops ownership, so a crashed upload can be retried. */
  withAllocation<T>(ownerPrincipalId: string, requestId: string,
    operation: (session: AllocationSession) => Promise<T>, mutation?: FileMutationContext): Promise<T>
}

export interface FileReferenceRepository extends FileRepository, FileAllocationRepository {
  /** Caller supplies a command transaction; tombstone and allocation fencing commit with its receipt/audit. */
  removeReference(scope: PermanentFileScope, ref: MessageAttachmentRef, query: FileQuery): Promise<FileWithRevision>
}
