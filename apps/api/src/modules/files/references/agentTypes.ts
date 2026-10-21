import type { AgentFileReadInput, AgentFileReadResult, FileRevision, PermanentFileScope } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FileQuery } from '../repository.js'

/** Selected by a trusted backend adapter, never by list/read tool arguments. */
export type AgentReferenceSubject = { kind: 'execution' }
  | { kind: 'conversation'; conversationId: string }

/** Resolved afresh from persisted identity. In particular, agentId alone is not a scope. */
export type AgentReferenceContext = {
  workspaceId: string
  workflowId: string
  agentId: string
  conversationId?: string
} & ({ runId: string; executionId: string } | { runId?: never; executionId?: never })

export interface AgentReferenceAuthorization {
  /** null means an authenticated global Operator conversation: no inherited references. */
  resolve(principal: ManagementPrincipal, subject: AgentReferenceSubject,
    query?: FileQuery): Promise<AgentReferenceContext | null>
}

export interface AgentReferenceManifestEntry extends Pick<FileRevision,
  'filename' | 'mediaType' | 'byteSize' | 'fileId' | 'revisionId'> {
  scope: PermanentFileScope
  state: 'pending' | 'ready' | 'removed'
}
export interface AgentReferenceManifest {
  items: AgentReferenceManifestEntry[]
  pageInfo: { nextCursor: string | null }
}
export interface AgentReferencePageInput { limit: number; cursor?: string | undefined }
export interface BoundAgentReferences {
  list(input?: unknown): Promise<AgentReferenceManifest>
  read(input: unknown): Promise<AgentFileReadResult>
}
export interface ReferenceReadRepository {
  /** A Run-wide pin is shared by all executions in that Run. Listing does not create pins. */
  pinned(runId: string, fileIds: readonly string[]): Promise<ReadonlyMap<string, string>>
  /** Reauthorize and check the tombstone before committing a first-read fact. No byte I/O in the transaction. */
  complete(context: AgentReferenceContext, ref: Pick<AgentFileReadInput, 'fileId' | 'revisionId'>,
    readAt: string, reauthorize: (query: FileQuery) => Promise<void>): Promise<'ready' | 'pending' | 'removed' | 'not_found'>
}
