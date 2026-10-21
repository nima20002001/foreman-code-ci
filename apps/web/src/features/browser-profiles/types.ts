import type { z } from 'zod'
import type { BrowserLoginEvidenceSchema, BrowserProfileSchema, BrowserProfileReplicaSchema,
  BrowserProfileSyncJobSchema } from '@foreman-code/contracts/browser-profiles'
import type { BrowserSession } from '../agent-browser/types'

export type BrowserProfile = z.infer<typeof BrowserProfileSchema>
export type BrowserProfileReplica = z.infer<typeof BrowserProfileReplicaSchema>
export type BrowserProfileSyncJob = z.infer<typeof BrowserProfileSyncJobSchema>
export type BrowserLoginEvidence = z.infer<typeof BrowserLoginEvidenceSchema>

/** Display-only projection supplied by the existing computer owner, not a new computer record. */
export interface BrowserComputerLabel {
  id: string
  name: string
  online: boolean
  runtimeReady: boolean
  lastSeenAt: string | null
}

export interface BrowserProfileCatalog {
  profiles: BrowserProfile[]
  replicas: BrowserProfileReplica[]
  /** Native presence remains true until the host confirms removal. */
  presentReplicas: { profileId: string; computerId: string }[]
  pendingReplicas: { profileId: string; computerId: string; operation: 'create' | 'remove' | 'sync';
    state: 'queued' | 'running'; reason: string | null }[]
}

/** In-process composition port. HTTP/MCP request envelopes remain C0-owned. */
export interface BrowserProfilesPort {
  readCatalog(signal: AbortSignal): Promise<BrowserProfileCatalog>
  create(name: string, computerId: string, distribution: BrowserProfile['distribution'], commandId: string): Promise<BrowserProfile>
  addExisting(profileId: string, computerId: string, commandId: string): Promise<{
    state: 'ready' | 'queued' | 'first_snapshot_pending'; replica: BrowserProfileReplica
  }>
  update(profileId: string, patch: Partial<Pick<BrowserProfile, 'name' | 'sourceComputerId' | 'distribution'>>, commandId: string): Promise<BrowserProfile>
  setLocalOverride(profileId: string, computerId: string, localOverride: boolean, commandId: string): Promise<BrowserProfileReplica>
  confirmLogin(profileId: string, computerId: string, origin: string,
    state: 'signed_in' | 'sign_in_required', commandId: string): Promise<BrowserProfileReplica>
  remove(profileId: string, computerId: string, commandId: string): Promise<'removed' | 'queued'>
  openSetup(profileId: string, computerId: string, commandId: string): Promise<BrowserSession>
  closeSetup(session: BrowserSession, commandId: string): Promise<'closed' | 'pending' | 'already_closed'>
  sync(profileIds: readonly string[] | undefined, commandId: string): Promise<BrowserProfileSyncJob>
  readSync(jobId: string, signal: AbortSignal): Promise<BrowserProfileSyncJob>
}
