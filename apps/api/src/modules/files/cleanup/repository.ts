import type { PostgresFileArtifactCleanupRepository } from './artifacts.js'

/** Internal cleanup identity, not an authorization input or public file DTO.
 * expiresAt is PostgreSQL's lossless UTC text, not a millisecond-rounded JS Date. */
export interface FileCleanupCandidate {
  fileId: string
  revisionId: string
  storageKey: string
  ownerPrincipalId: string
  requestId: string | null
  expiresAt: string
  retentionRevision: number
}
export type FileCleanupOutcome = 'cleaned' | 'remaining' | 'stale' | 'busy'

export interface FileArtifactCleanupCandidate {
  artifactId: string
  binding: string
  storageKey: string
}

export interface FileCleanupRepository {
  /** Turn artifacts have session lifetime, not a user-file retention preference. */
  readonly artifacts?: PostgresFileArtifactCleanupRepository

  /** Only overdue pending/ready files; persisted tombstones are discovered from disk instead. */
  findDue(afterFileId: string | null, limit: number): Promise<FileCleanupCandidate[]>
  /** Maps managed disk keys back to eligible temporary revisions. Unknown/permanent keys are ignored. */
  findByStorageKeys(keys: readonly string[]): Promise<FileCleanupCandidate[]>
  /** Commit the tombstone, then recheck expiry/revision under retention + publication locks.
   * The callback must only unlink these bytes; false means bounded directory work remains. */
  remove(candidate: FileCleanupCandidate, removeBytes: () => Promise<boolean>): Promise<FileCleanupOutcome>
}

export interface FileCleanupBytes {
  scan(limit: number): Promise<{ keys: string[]; exhausted: boolean }>
  remove(storageKey: string): Promise<boolean>
  close(): Promise<void>
}

export function cleanupBatchSize(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Cleanup batches must contain 1 to 100 entries.')
  return limit
}
