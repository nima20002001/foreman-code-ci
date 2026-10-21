import { DomainError } from '../errors.js'
import type { BrowserSnapshotArchive } from './archive.js'
import type { BrowserPairingAuthority, BrowserInstallationBinding, BrowserSnapshotKeyStore } from './keys.js'
import type { BrowserProfileHost, BrowserSnapshotTransfer, BrowserHostAvailability, BrowserLoginEvidence, BrowserProfileRepository } from './types.js'

/** B owns these native operations; D adapts its existing installed-device transport to this port. */
export interface BrowserProfileEndpoint {
  status(profileId: string): Promise<BrowserHostAvailability>
  create(input: Parameters<BrowserProfileHost['create']>[0]): Promise<void>
  remove(input: Parameters<BrowserProfileHost['remove']>[0]): Promise<void>
  export(input: Parameters<BrowserProfileHost['export']>[0]): Promise<BrowserSnapshotTransfer>
  readSnapshot(transfer: BrowserSnapshotTransfer, offset: number): Promise<Uint8Array>
  receive(input: Parameters<BrowserProfileHost['receive']>[0], chunks: AsyncIterable<Uint8Array>): Promise<void>
  apply(input: Parameters<BrowserProfileHost['apply']>[0]): Promise<void>
  prune(input: Parameters<BrowserProfileHost['prune']>[0]): Promise<void>
  checkOrigin(input: Parameters<BrowserProfileHost['checkOrigin']>[0]): Promise<BrowserLoginEvidence>
}
export interface BrowserProfileTransport {
  /** Returns the dedicated browser byte/control domain bound to this exact installed connection. */
  endpoint(binding: BrowserInstallationBinding): Promise<BrowserProfileEndpoint>
}

export class PairedBrowserProfileHost implements BrowserProfileHost {
  constructor(readonly authority: BrowserPairingAuthority, readonly transport: BrowserProfileTransport,
    readonly archive: BrowserSnapshotArchive, readonly keys: BrowserSnapshotKeyStore, readonly repository: BrowserProfileRepository) {}

  async installation(computerId: string): Promise<string> { return (await this.authority.current(computerId)).installationId }

  private async paired(computerId: string) {
    const binding = await this.authority.current(computerId); await this.authority.assertCurrent(binding)
    return { binding, endpoint: await this.transport.endpoint(binding) }
  }
  private async admitted(jobId: string, binding: BrowserInstallationBinding) {
    const installationId = await this.repository.read(tx => tx.jobInstallation(jobId, binding.computerId))
    if (!installationId || installationId !== binding.installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'This browser job belongs to another installed computer identity. Admit a new sync.', 403)
  }

  async status(profileId: string, computerId: string): Promise<BrowserHostAvailability> {
    try { return await (await this.paired(computerId)).endpoint.status(profileId) } catch (error) {
      if (error instanceof DomainError && error.status < 500) throw error
      return 'offline'
    }
  }
  async create(input: Parameters<BrowserProfileHost['create']>[0]) { const host = await this.paired(input.computerId); await this.authority.assertInstallation(input.computerId, input.installationId); await host.endpoint.create(input); await this.authority.assertCurrent(host.binding) }
  async remove(input: Parameters<BrowserProfileHost['remove']>[0]) { const host = await this.paired(input.computerId); await this.authority.assertInstallation(input.computerId, input.installationId); await host.endpoint.remove(input); await this.authority.assertCurrent(host.binding) }

  async export(input: Parameters<BrowserProfileHost['export']>[0]): Promise<BrowserSnapshotTransfer> {
    const { binding, endpoint } = await this.paired(input.computerId), authority = this.authority
    await this.admitted(input.jobId, binding)
    const transfer = await endpoint.export(input)
    await authority.assertCurrent(binding)
    async function* chunks() {
      let offset = 0
      while (offset < transfer.manifest.byteLength) {
        await authority.assertCurrent(binding)
        const bytes = await endpoint.readSnapshot(transfer, offset)
        await authority.assertCurrent(binding)
        if (!bytes.length || bytes.length > 262_144) throw new DomainError('SNAPSHOT_INCOMPLETE', 'The source snapshot byte transfer did not settle.', 503)
        offset += bytes.length; yield bytes
      }
    }
    await this.archive.put(transfer, chunks())
    await this.keys.seal(input.operationId, transfer.snapshot)
    return transfer
  }

  async receive(input: Parameters<BrowserProfileHost['receive']>[0]): Promise<void> {
    const { binding, endpoint } = await this.paired(input.computerId), authority = this.authority, archive = this.archive
    await this.admitted(input.jobId, binding)
    async function* chunks() {
      for await (const bytes of archive.chunks(input.transfer)) { await authority.assertCurrent(binding); yield bytes }
    }
    await endpoint.receive(input, chunks()); await authority.assertCurrent(binding)
  }
  async apply(input: Parameters<BrowserProfileHost['apply']>[0]) { const host = await this.paired(input.computerId); await this.admitted(input.jobId, host.binding); await host.endpoint.apply(input); await this.authority.assertCurrent(host.binding) }
  async prune(input: Parameters<BrowserProfileHost['prune']>[0]) { const host = await this.paired(input.computerId); await host.endpoint.prune(input); await this.authority.assertCurrent(host.binding) }
  async checkOrigin(input: Parameters<BrowserProfileHost['checkOrigin']>[0]) { const host = await this.paired(input.computerId); await this.authority.assertInstallation(input.computerId, input.installationId); const value = await host.endpoint.checkOrigin(input); await this.authority.assertCurrent(host.binding); return value }
}
