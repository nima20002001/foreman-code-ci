import { join } from 'node:path'
import type pg from 'pg'
import { BrowserSnapshotArchive } from './archive.js'
import { BrowserSnapshotKeyStore, type BrowserPairingAuthority } from './keys.js'
import { BrowserSnapshotKeyService } from './keyService.js'
import { PairedBrowserProfileHost, type BrowserProfileTransport } from './host.js'
import { createBrowserProfileRepository } from './repository.js'
import { BrowserProfileService } from './service.js'
import { BrowserProfileSyncCoordinator } from './sync.js'
import { BrowserProfileRetention } from './retention.js'
import { BrowserProfileDispatcher } from './dispatcher.js'
import type { BrowserProfileAuthority, BrowserProfilePendingWork } from './types.js'

/** Main feature lifecycle. D registers its existing pool/authority/pairing hooks and the returned shared services. */
export function createBrowserProfiles(options: {
  pool: pg.Pool; stateDirectory: string; authority: BrowserProfileAuthority
  pairing: BrowserPairingAuthority; transport: BrowserProfileTransport
  reportFailure(error: unknown, work?: BrowserProfilePendingWork): void
}) {
  const repository = createBrowserProfileRepository(options.pool)
  const keys = new BrowserSnapshotKeyStore(join(options.stateDirectory, 'browser', 'snapshot-keys'), options.pairing)
  const archive = new BrowserSnapshotArchive(join(options.stateDirectory, 'browser', 'snapshot-archive'))
  const host = new PairedBrowserProfileHost(options.pairing, options.transport, archive, keys, repository)
  const service = new BrowserProfileService({ repository, authority: options.authority, host })
  const sync = new BrowserProfileSyncCoordinator(service)
  const retention = new BrowserProfileRetention(repository, keys, archive, host)
  const dispatcher = new BrowserProfileDispatcher({ service, sync, retention, reportFailure: options.reportFailure })
  return { service, sync, keyService: new BrowserSnapshotKeyService(repository, keys), host,
    start: () => dispatcher.start(), stop: () => dispatcher.stop(), wake: () => dispatcher.wake() }
}
