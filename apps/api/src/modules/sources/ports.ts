import type { SourceManifest, SourceEntry, SourceSnapshotReference }
  from '@foreman-code/contracts/source-materialization'
import type { FileHandle } from 'node:fs/promises'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceWorktreeRequest, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import type { SourceMaterializationRecord, SourcePreparationClosure, SourceRootRecord, VerifiedSourceWorkingTree }
  from '@foreman-code/contracts/source-admission'
import type { RetainedSourceFootprint, SourceActiveNativeSession, SourceOperationOwner, SourceStorageCapacity }
  from '@foreman-code/contracts/source-operations'
import type { GraphSqlClient } from '../run-graph/connection.js'

/** Main persists this exact approved pin; neither worker nor resolver chooses latest. */
export type SourceSnapshotPin = Pick<SourceManifest, 'snapshotId' | 'manifestDigest' | 'approvedSourceId'>
export interface SourceByteReader {
  openReference?(manifest: SourceManifest, signal: AbortSignal): Promise<{
    tree: FileHandle; snapshotReference: SourceSnapshotReference;
  }>
  /** Local snapshots can copy raw files in bulk; the materializer still verifies the activated tree. */
  copyTo?(manifest: SourceManifest, target: FileHandle, fileMode: 0o400 | 0o600, signal: AbortSignal): Promise<void>
  readGitMetadata?(manifest: SourceManifest, signal: AbortSignal): Promise<Uint8Array>
  read(snapshot: SourceSnapshotPin, entry: SourceEntry, signal: AbortSignal): Promise<Uint8Array>
  /** A batch retains qualified snapshot handles; every entry still requires byte verification. */
  readEntries?(snapshot: SourceSnapshotPin, entries: readonly SourceEntry[], signal: AbortSignal,
    consume: (entry: SourceEntry, bytes: Uint8Array) => Promise<void>): Promise<void>
}
export type MaterializationAttempt = {
  placementHash: string; executionId: string; attemptId: string; keyRevision: number | null; authorizationRevision: number | null
}
/** The caller must hold a qualified writer exclusion for explicit/dirty capture. */
export interface ExclusiveSourceCapture {
  readonly approvedSourceId: string
  readonly writerExcluded: true
  read(entry: { path: string; executable: boolean }): Promise<Uint8Array>
  validateExclusion(): Promise<void>
}
export interface SourceExecutionHostPort {
  storageCapacity?(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<SourceStorageCapacity>
  /** W08/CI allocated this actual attempt; this SQL-only port checks its accepted
   * owner and placement before source service can prepare a native directory. */
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal,
    input: { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }): Promise<void>
  prepare(manifest: SourceManifest, root: SourceRootRecord, attempt: MaterializationAttempt, options?: { sharedWritableTree?: true; worktree?: SourceWorktreeRequest; retainedReceipt?: MaterializationReceipt }): Promise<SourceMaterializationRecord['receipt']>
  verifyWorkingDirectory(record: SourceMaterializationRecord, relativeCwd: string): Promise<VerifiedSourceWorkingTree>
  verify(record: SourceMaterializationRecord): Promise<string>
  releaseClaim(record: SourceMaterializationRecord, options?: { signal?: AbortSignal; deadlineAt?: string; retainWorkingTree?: true }): Promise<RetainedSourceFootprint>
  authorizeFinal(sql: GraphSqlClient, principal: ManagementPrincipal, record: SourceMaterializationRecord, finalDispatchBindingHash: string): Promise<void>
  reconcilePreparation?(reconciliationId: string, owner: SourceOperationOwner): Promise<SourcePreparationClosure>
}
/** Installed lifetime capture only: never accepted from filesystem requests. */
export interface SourceNativeSessionCapture {
  proof: SourceActiveNativeSession
  signal: AbortSignal
  assertCurrent(): Promise<void> | void
}
/** `lock` false is for a read-only admission that acts only after its transaction ends: it reads committed Run
 * rows without row locks, so it never queues behind the Run owner. Writers keep the default and their locks. */
export interface SourceAttemptAuthority {
  authorize(sql: GraphSqlClient, principal: ManagementPrincipal, input: { workspaceId: string; root: SourceRootRecord; attempt: MaterializationAttempt; operationId: string }, lock?: boolean): Promise<void>
  authorizeFinal(sql: GraphSqlClient, principal: ManagementPrincipal, record: SourceMaterializationRecord, finalDispatchBindingHash: string, lock?: boolean): Promise<void>
  /** Rechecks exact accepted source/root/current host authorization on that host.
   * It confers no native launch right; W08 final intent controls entry. */
  revalidate(root: SourceRootRecord, attempt: MaterializationAttempt): Promise<void>
  revalidateMaterialization(record: SourceMaterializationRecord): Promise<void>
}
