import type { z } from 'zod'
import type {
  BrowserProfileSchema, BrowserProfileReplicaSchema, BrowserProfileSyncJobSchema,
  BrowserProfileSnapshotManifestSchema, BrowserSnapshotIdentitySchema, BrowserLoginEvidenceSchema,
} from '@foreman-code/contracts/browser-profiles'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SqlQuery } from '../../infrastructure/transaction.js'

export type BrowserProfile = z.infer<typeof BrowserProfileSchema>
export type BrowserProfileReplica = z.infer<typeof BrowserProfileReplicaSchema>
export type BrowserProfileSyncJob = z.infer<typeof BrowserProfileSyncJobSchema>
export type BrowserSnapshotIdentity = z.infer<typeof BrowserSnapshotIdentitySchema>
export type BrowserProfileSnapshotManifest = z.infer<typeof BrowserProfileSnapshotManifestSchema>
export type BrowserLoginEvidence = z.infer<typeof BrowserLoginEvidenceSchema>

/** Private service inputs. C0 owns their HTTP/MCP parsers and response envelopes. */
export interface BrowserCommandOptions { commandId?: string; expectedRevision?: number }
export interface BrowserCommandReceipt<T> { commandId: string; value: T; replayed: boolean }
export interface BrowserPage<T> { items: T[]; nextCursor: string | null; hasMore: boolean; revision: number }
export interface BrowserComputer { id: string; online: boolean }
export interface ProfileHostIntent {
  id: string; profileId: string; computerId: string
  revision: number
  installationId: string
  operation: 'create' | 'remove' | 'sync'; state: 'queued' | 'running' | 'completed' | 'failed'
  reason: string | null
  claimId?: string
  claimUntil?: number
}
export interface BrowserReplicaFacts { present: boolean; presenceRevision: number; currentIntent: ProfileHostIntent | null }
export interface BrowserCatalogRow { profile: BrowserProfile; replica: BrowserProfileReplica | null; facts: BrowserReplicaFacts; computerId: string }
export interface StoredProfile { profile: BrowserProfile; deleted: boolean }
export interface ProfileCommand { hash: string; result: unknown }

export interface BrowserProfilePendingWork { key: string; kind: 'intent' | 'job' | 'retention'; id: string }
export interface BrowserSnapshotRetention { snapshots: BrowserSnapshotIdentity[]; operations: string[]; computers: string[]; revision: number }

export interface BrowserProfileTransaction {
  readonly sql?: SqlQuery
  pendingWork(after: string | undefined, limit: number): Promise<BrowserProfilePendingWork[]>
  retention(profileId: string): Promise<BrowserSnapshotRetention>
  clearRetention(profileId: string, revision: number): Promise<void>
  profile(id: string): Promise<StoredProfile | undefined>
  putProfile(value: StoredProfile): Promise<void>
  profiles(after: string | undefined, limit: number): Promise<StoredProfile[]>
  catalogRows(after: readonly [string, string] | undefined, computerIds: readonly string[], limit: number): Promise<BrowserCatalogRow[]>
  replicaFacts(profileId: string, computerId: string): Promise<BrowserReplicaFacts>
  replica(profileId: string, computerId: string): Promise<BrowserProfileReplica | undefined>
  replicas(profileId: string): Promise<BrowserProfileReplica[]>
  putReplica(replica: BrowserProfileReplica): Promise<void>
  job(id: string): Promise<BrowserProfileSyncJob | undefined>
  putJob(job: BrowserProfileSyncJob): Promise<void>
  command(key: string): Promise<ProfileCommand | undefined>
  putCommand(key: string, command: ProfileCommand): Promise<void>
  intent(id: string): Promise<ProfileHostIntent | undefined>
  putIntent(intent: ProfileHostIntent): Promise<void>
  intents(profileId: string): Promise<ProfileHostIntent[]>
  exportOwner(profileId: string): Promise<string | undefined>
  setExportOwner(profileId: string, jobId: string | null): Promise<void>
  catalogRevision(): Promise<number>
  publishedManifest(profileId: string): Promise<BrowserProfileSnapshotManifest | undefined>
  putPublishedManifest(manifest: BrowserProfileSnapshotManifest): Promise<void>
  jobInstallation(jobId: string, computerId: string): Promise<string | undefined>
  putJobInstallation(jobId: string, computerId: string, installationId: string): Promise<void>
}
export interface BrowserProfileRepository {
  read<T>(work: (tx: BrowserProfileTransaction) => Promise<T>): Promise<T>
  transaction<T>(locks: readonly string[], work: (tx: BrowserProfileTransaction) => Promise<T>): Promise<T>
}

/** D supplies live existing authority and paired-computer resolution, never a new grant. */
export interface BrowserProfileAuthority {
  authorize(principal: ManagementPrincipal, action: 'settings:read' | 'settings:update',
    computerIds: readonly string[], sql?: SqlQuery): Promise<void>
  computers(principal: ManagementPrincipal, sql?: SqlQuery): Promise<BrowserComputer[]>
}
export interface BrowserSnapshotTransfer {
  /** Immutable encrypted bytes are private. The host verifies the same identity on receipt/apply. */
  snapshot: BrowserSnapshotIdentity
  manifest: BrowserProfileSnapshotManifest
}
export type BrowserHostAvailability = 'ready' | 'offline' | 'busy' | 'runtime_missing'
export interface BrowserProfileHost {
  installation(computerId: string): Promise<string>
  status(profileId: string, computerId: string): Promise<BrowserHostAvailability>
  create(input: { profileId: string; computerId: string; operationId: string; revision: number; installationId: string }): Promise<void>
  remove(input: { profileId: string; computerId: string; operationId: string; revision: number; installationId: string }): Promise<void>
  export(input: { profileId: string; computerId: string; publishedRevision: number;
    operationId: string; jobId: string }): Promise<BrowserSnapshotTransfer>
  receive(input: { profileId: string; computerId: string; sourceComputerId: string;
    transfer: BrowserSnapshotTransfer; operationId: string; revision: number; jobId: string }): Promise<void>
  apply(input: { profileId: string; computerId: string; transfer: BrowserSnapshotTransfer;
    operationId: string; revision: number; jobId: string }): Promise<void>
  prune(input: { profileId: string; computerId: string; snapshots: readonly BrowserSnapshotIdentity[]; operations: readonly string[] }): Promise<void>
  checkOrigin(input: { profileId: string; computerId: string; origin: string; operationId: string; installationId: string }): Promise<BrowserLoginEvidence>
}
