import type { BrowserSnapshotArchive } from './archive.js'
import type { BrowserSnapshotKeyStore } from './keys.js'
import type { BrowserProfileHost, BrowserProfileRepository } from './types.js'

/** Retains current/prior publications and every admitted retry/apply reference. */
export class BrowserProfileRetention {
  constructor(readonly repository: BrowserProfileRepository, readonly keys: BrowserSnapshotKeyStore,
    readonly archive: BrowserSnapshotArchive, readonly host: BrowserProfileHost) {}

  async reconcile(profileId: string): Promise<void> {
    const retainedKeys = await this.keys.prune(profileId, () => this.repository.read(tx => tx.retention(profileId)))
    const references = await this.repository.read(tx => tx.retention(profileId))
    const snapshots = [...new Map([...references.snapshots, ...retainedKeys].map(value => [value.sha256, value])).values()]
    await this.archive.prune(profileId, snapshots)
    // Offline recipients keep their own bounded current/prior generation. A later paired wake retries this receipt.
    for (const computerId of references.computers) {
      await this.host.prune({ profileId, computerId, snapshots, operations: references.operations })
    }
    await this.repository.transaction([`profile:${profileId}`], tx => tx.clearRetention(profileId, references.revision))
  }
}
