import { join } from 'node:path'
import { open, mkdir, rm } from 'node:fs/promises'
import { BrowserSnapshotArchive } from '../browser-profiles/archive.js'
import { unwrapBrowserSnapshotKey, type BrowserInstallationBinding, type BrowserPairingAuthority, type BrowserPrivateKeyEnvelope } from '../browser-profiles/keys.js'
import type { BrowserProfileEndpoint } from '../browser-profiles/host.js'
import type { BrowserSnapshotTransfer, BrowserLoginEvidence } from '../browser-profiles/types.js'
import { browserInputHash } from '../browser-profiles/identity.js'
import { DomainError } from '../errors.js'
import { BrowserBroker } from './broker.js'
import { BrowserSnapshotStorage, type BrowserSnapshotKeyMaterial } from './snapshotStorage.js'
import { ManagedBrowserNativeDriver } from './nativeDriver.js'
import { createBrowserRuntimeJournal } from './journal.js'
import { BrowserFileStore } from './files.js'
import { BrowserMediaService } from './media.js'
import { createBrowserSessionCleanup } from './sessionCleanup.js'
import { startBrowserRuntimeControl } from './runtimeControl.js'
import { checkpointBrowserRuntimeProfiles } from './profileCheckpoint.js'
import type { BrowserRuntimeInstallation } from './browserUseAdapter.js'
import type { BrowserSubjectAuthority } from './types.js'

export { createBrowserRuntimeProfileCheckpoint, restoreBrowserRuntimeProfiles, pruneBrowserRuntimeProfiles } from './profileCheckpoint.js'
export { createBrowserHostDeviceEndpoint, createBrowserHostKeyRequests } from './deviceExtension.js'

export interface BrowserHostKeyRequests {
  exportKey(caller: BrowserInstallationBinding, input: { profileId: string; publishedRevision: number; operationId: string; stateHash: string }): Promise<BrowserPrivateKeyEnvelope>
  snapshotKey(caller: BrowserInstallationBinding, transfer: BrowserSnapshotTransfer, jobId: string): Promise<BrowserPrivateKeyEnvelope>
}
export interface BrowserHostOptions {
  stateDirectory: string; computerId: string; installationId: string; runtime: BrowserRuntimeInstallation
  subjectAuthority: BrowserSubjectAuthority; pairing: BrowserPairingAuthority; keys: BrowserHostKeyRequests
  /** The existing native/worker owner holds its exclusive host lease before constructing this factory. */
  assertHostOwnership(): Promise<void>
  reportFailure(error: unknown): void
  originProbe?(input: { profileId: string; origin: string }): Promise<BrowserLoginEvidence>
}

/** Real native implementation, used identically by Main and the installed Worker bundle. */
export async function createBrowserHost(options: BrowserHostOptions) {
  await options.assertHostOwnership()
  const root = join(options.stateDirectory, 'browser'), profileStateRoot = join(root, 'profile-data')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const archive = new BrowserSnapshotArchive(join(root, 'incoming-snapshots'))
  const applyJobs = new Map<string, string>()
  const downloadOwners = new Map<string, { sessionId: string; tabId: string; browserGeneration: number }>()
  const binding = async () => {
    await options.assertHostOwnership()
    const value = await options.pairing.current(options.computerId)
    if (value.installationId !== options.installationId) throw new DomainError('BROWSER_PAIRING_CHANGED', 'The browser host installation identity changed.', 403)
    await options.pairing.assertCurrent(value); return value
  }
  const material = async (envelope: BrowserPrivateKeyEnvelope): Promise<BrowserSnapshotKeyMaterial> => ({
    key: await unwrapBrowserSnapshotKey(envelope, await binding(), options.pairing), keyId: envelope.keyId,
    sourceInstallationId: envelope.source.installationId, sourceOperationId: envelope.operationId, stateHash: envelope.stateHash,
  })
  const storage: BrowserSnapshotStorage = new BrowserSnapshotStorage({ root: profileStateRoot, computerId: options.computerId, installationId: options.installationId,
    exportKey: async (profileId, publishedRevision, operationId, stateHash) => material(await options.keys.exportKey(await binding(), { profileId, publishedRevision, operationId, stateHash })),
    snapshotKey: async transfer => {
      const jobId = applyJobs.get(transfer.snapshot.profileId)
      if (!jobId) throw new DomainError('BROWSER_TRANSFER_SCOPE', 'No exact snapshot application owns this key request.', 403)
      return material(await options.keys.snapshotKey(await binding(), transfer, jobId))
    },
    busy: profileId => broker.isProfileBusy(profileId), maintenance: (profileId, work) => broker.withProfileMaintenance(profileId, work),
    closeProfile: profileId => driver.closeProfile(profileId), exportState: (profileId, origins) => driver.exportState(profileId, origins),
    importState: (profileId, directory, generation, state) => driver.importState(profileId, directory, generation, state),
  })
  const driver: ManagedBrowserNativeDriver = new ManagedBrowserNativeDriver({ runtime: options.runtime,
    actionDirectory: root, profileDirectory: profileId => storage.directory(profileId),
    allocateGeneration: profileId => storage.allocateProcessGeneration(profileId), onOrigin: (profileId, origin) => storage.noteOrigin(profileId, origin),
    onDisconnected: (profileId, generation) => { void broker.disconnected(profileId, generation).catch(options.reportFailure) },
    downloadDirectory: profileId => join(root, 'native-downloads', browserInputHash(profileId)),
    onDownload: async event => {
      const owner = downloadOwners.get(event.nativeId) ?? broker.ownerForTarget(event.profileId, event.generation, event.targetId)
      if (!owner) return
      downloadOwners.set(event.nativeId, owner)
      if (event.state === 'completed') {
        await files.adoptDownload(owner, event.nativeId, event.privatePath, event.name, event.byteLength)
        downloadOwners.delete(event.nativeId)
      } else {
        await files.trackDownload(owner, event.nativeId, event.name, event.byteLength, event.receivedBytes, event.state === 'canceled')
        if (event.state === 'canceled') downloadOwners.delete(event.nativeId)
      }
    } })
  const journal = createBrowserRuntimeJournal(join(root, 'journal'))
  const broker: BrowserBroker = new BrowserBroker({ computerId: options.computerId, driver, journal, authority: options.subjectAuthority,
    closeSessionResources: sessionId => createBrowserSessionCleanup(media, files, options.reportFailure)(sessionId) })
  const files: BrowserFileStore = new BrowserFileStore(join(root, 'session-files'), async (owner, mutate) => {
    await options.assertHostOwnership()
    const read = broker.read(owner.sessionId)
    if (mutate && (read.session.state === 'closed' || read.session.browserGeneration !== owner.browserGeneration
      || !read.tabs.some(tab => tab.tabId === owner.tabId && tab.browserGeneration === owner.browserGeneration))) {
      throw new DomainError('BROWSER_FILE_SCOPE', 'The upload no longer has its exact owned tab.', 403)
    }
  })
  const media: BrowserMediaService = new BrowserMediaService(broker, options.reportFailure)
  const ensureComputer = async (computerId: string, installationId?: string) => {
    const current = await binding()
    if (computerId !== options.computerId || installationId && current.installationId !== installationId) throw new DomainError('BROWSER_COMPUTER_SCOPE', 'This operation belongs to another installed computer.', 403)
  }
  const profileEndpoint: BrowserProfileEndpoint = {
    status: async profileId => { await binding(); return !broker.accepting() ? 'runtime_missing' : broker.isProfileBusy(profileId) ? 'busy' : 'ready' },
    create: async input => { await ensureComputer(input.computerId, input.installationId); await storage.create(input.profileId, input.revision) },
    remove: async input => {
      await ensureComputer(input.computerId, input.installationId)
      await storage.remove(input.profileId, input.revision)
      for (const session of broker.list()) if (session.setupForProfileId === input.profileId) await files.closeSession(session.id, true)
      await rm(join(root, 'native-downloads', browserInputHash(input.profileId)), { recursive: true, force: true })
    },
    export: async input => { await ensureComputer(input.computerId); return storage.export(input.profileId, input.publishedRevision, input.operationId) },
    readSnapshot: async (transfer, offset) => {
      await binding()
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > transfer.manifest.byteLength) throw new DomainError('SNAPSHOT_RANGE_INVALID', 'Invalid snapshot offset.', 400)
      const path = await storage.snapshotPath(transfer), handle = await open(path, 'r')
      try { const bytes = Buffer.alloc(Math.min(262_144, transfer.manifest.byteLength - offset)); const result = await handle.read(bytes, 0, bytes.length, offset); return bytes.subarray(0, result.bytesRead) } finally { await handle.close() }
    },
    receive: async (input, chunks) => {
      await ensureComputer(input.computerId); await archive.put(input.transfer, chunks)
      await ensureComputer(input.computerId)
      await storage.receive(input.transfer, await archive.bytes(input.transfer), input.revision)
      await archive.remove(input.transfer)
    },
    apply: async input => {
      await ensureComputer(input.computerId)
      if (applyJobs.has(input.profileId)) throw new DomainError('PROFILE_BUSY', 'A browser snapshot apply is already active.', 409)
      applyJobs.set(input.profileId, input.jobId)
      try { await storage.apply(input.transfer, input.revision) } finally { applyJobs.delete(input.profileId) }
    },
    prune: async input => { await ensureComputer(input.computerId); await storage.prune(input.profileId, input.snapshots, input.operations) },
    checkOrigin: async input => {
      await ensureComputer(input.computerId, input.installationId)
      if (!await storage.exists(input.profileId)) throw new DomainError('PROFILE_MISSING', 'This browser profile is absent.', 404)
      const key = `origin-probe:${input.operationId}`, inputHash = browserInputHash(input), prior = await journal.read(key)
      if (prior) {
        if (prior.inputHash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This sign-in check belongs to another request.', 409)
        if (prior.state !== 'completed') throw new DomainError('BROWSER_RESULT_UNKNOWN', 'The original sign-in check is unconfirmed. Read the current page before starting a new check.', 409)
        return prior.value as BrowserLoginEvidence
      }
      await journal.write(key, { inputHash, state: 'reserved' })
      const value: BrowserLoginEvidence = options.originProbe ? await options.originProbe(input) : { origin: input.origin, state: 'unknown',
        checkedAt: new Date().toISOString(), evidence: 'none', reason: 'No reliable sign-in probe is configured for this origin. Open the site and confirm its current sign-in.' }
      await journal.write(key, { inputHash, state: 'completed', value }); return value
    },
  }
  await broker.recover()
  const closeOwnedProfiles = async () => {
    const profiles = new Set(driver.ownedProfileIds())
    for await (const profileId of storage.profileIds()) profiles.add(profileId)
    for (const profileId of profiles) await driver.closeProfile(profileId)
  }
  const closeIdleProfiles = async () => {
    if (broker.activeSessionCount()) throw new DomainError('BROWSER_RUNTIME_BUSY', 'Browser sessions are still active.', 409)
    await closeOwnedProfiles()
  }
  let hostClosing = false
  const runtimeControl = await startBrowserRuntimeControl(root, { stopAdmission: () => broker.stopAdmission(),
    resumeAdmission: () => { if (!hostClosing) broker.resumeAdmission() }, activeSessionCount: () => broker.activeSessionCount(), closeIdleProfiles },
  options.assertHostOwnership, options.reportFailure)
  let closing: Promise<void> | undefined
  const close = async () => {
    hostClosing = true
    broker.stopAdmission()
    for (const session of broker.list()) {
      const result = session.subject ? await broker.release({ sessionId: session.id, subject: session.subject,
        commandId: `shutdown:${session.id}`, reason: 'runtime_update' }) : await broker.closeSetup(session.id)
      if (result.state === 'pending') throw new DomainError('BROWSER_RUNTIME_BUSY', result.reason ?? 'Browser cleanup is pending.', 409)
    }
    if (broker.activeSessionCount()) throw new DomainError('BROWSER_RUNTIME_BUSY', 'Browser preparation is still settling.', 409)
    await closeOwnedProfiles()
    await runtimeControl.close()
  }
  return { broker, driver, storage, files, media, profileEndpoint, profileStateRoot,
    stopAdmission: () => broker.stopAdmission(),
    resumeAdmission: () => { if (!hostClosing && !runtimeControl.draining()) broker.resumeAdmission() },
    status: () => ({ ready: broker.accepting() && !runtimeControl.draining(), admissionPaused: !broker.accepting() || runtimeControl.draining(), runtimeVersion: options.runtime.runtimeVersion, computerId: options.computerId }),
    async drainForRuntimeUpdate() {
      broker.stopAdmission()
      try {
        if (broker.activeSessionCount()) throw new DomainError('BROWSER_RUNTIME_BUSY', 'Finish browser sessions and release user control before updating the runtime.', 409)
        await closeOwnedProfiles()
        return await checkpointBrowserRuntimeProfiles(profileStateRoot, profileId => driver.closeProfile(profileId))
      } catch (error) { if (!runtimeControl.draining()) broker.resumeAdmission(); throw error }
    },
    close() {
      if (closing) return closing
      const task = close().finally(() => { if (closing === task) closing = undefined })
      closing = task; return task
    },
  }
}
