import { DomainError } from '../errors.js'
import type { BrowserInstallationBinding, BrowserSnapshotKeyStore } from './keys.js'
import type { BrowserProfileRepository, BrowserSnapshotTransfer } from './types.js'
import { sameBrowserSnapshot } from './identity.js'

/** Installed-peer key requests are authorized against admitted browser work, without a Run/root transfer. */
export class BrowserSnapshotKeyService {
  constructor(readonly repository: BrowserProfileRepository, readonly keys: BrowserSnapshotKeyStore) {}

  async exportKey(caller: BrowserInstallationBinding, input: {
    profileId: string; publishedRevision: number; operationId: string; stateHash: string
  }) {
    await this.keys.authority.assertCurrent(caller)
    const admitted = await this.repository.read(async tx => {
      const owner = await tx.exportOwner(input.profileId), stored = await tx.profile(input.profileId)
      return owner && stored && !stored.deleted && stored.profile.sourceComputerId === caller.computerId
        && await tx.jobInstallation(owner, caller.computerId) === caller.installationId
        && input.operationId === `${owner}:export:${input.profileId}` && input.publishedRevision === stored.profile.publishedRevision + 1
    })
    if (!admitted) throw new DomainError('BROWSER_TRANSFER_SCOPE', 'This source has no admitted browser publication for that key.', 403)
    await this.keys.allocate({ ...input, source: caller })
    return this.keys.envelope(input.operationId, caller)
  }

  async snapshotKey(caller: BrowserInstallationBinding, transfer: BrowserSnapshotTransfer, jobId: string) {
    await this.keys.authority.assertCurrent(caller)
    const admitted = await this.repository.read(async tx => {
      const replica = await tx.replica(transfer.snapshot.profileId, caller.computerId)
      return replica && sameBrowserSnapshot(replica.desiredSnapshot, transfer.snapshot)
        && await tx.jobInstallation(jobId, caller.computerId) === caller.installationId
        && (await tx.intent(`${jobId}:target:${transfer.snapshot.profileId}:${caller.computerId}`))?.operation === 'sync'
    })
    if (!admitted) throw new DomainError('BROWSER_TRANSFER_SCOPE', 'This computer has no admitted browser snapshot apply.', 403)
    return this.keys.snapshotEnvelope(transfer.snapshot, caller)
  }
}
