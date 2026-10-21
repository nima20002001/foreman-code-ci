import type { FileQuery } from '../repository.js'
import type { FileCleanupCandidate } from '../cleanup/repository.js'

/** W09-B/A report owned live transfer/materialization holds using the canonical storage key.
 * They do not grant byte access, extend retention, or erase publication/read receipts. */
export interface ArtifactPhysicalDeletionOwnership {
  assertCanDelete(candidate: FileCleanupCandidate, query: FileQuery): Promise<boolean>
}
export interface ArtifactPhysicalHoldPort {
  /** SQL-only lookup under the same transaction; absent/uncertain ownership returns unknown. */
  inspect(storageKey: string, query: FileQuery): Promise<'clear' | 'held' | 'unknown'>
}
export class DistributedArtifactDeletionOwnership implements ArtifactPhysicalDeletionOwnership {
  constructor(private readonly transfers: ArtifactPhysicalHoldPort, private readonly materializations: ArtifactPhysicalHoldPort) {}
  async assertCanDelete(candidate: FileCleanupCandidate, query: FileQuery): Promise<boolean> {
    // Sequential SQL ownership checks use the same connection and row/advisory lock order.
    return await this.transfers.inspect(candidate.storageKey, query) === 'clear'
      && await this.materializations.inspect(candidate.storageKey, query) === 'clear'
  }
}
