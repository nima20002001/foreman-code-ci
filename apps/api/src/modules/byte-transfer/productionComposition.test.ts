import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { createInstalledRsyncComposition, createProductionRsyncComposition, type ProductionRsyncProviders } from './productionComposition.js'
import { ResumableByteTransferService } from './service.js'
import { transferContextForBinding } from './carrier.js'
import { RsyncWriterOwnership } from './rsyncWriterOwnership.js'
import type { RsyncTransferWriters } from './rsync.js'
import { bootIdentity } from '../harnesses/recovery/linuxIdentity.js'
import type { RsyncBackendSelection } from './rsyncProduction.js'
import { rsyncCommand } from './rsync.js'

const roots: string[] = [], receivers: ResumableByteTransferService[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const receiver of receivers.splice(0)) await receiver.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp('/tmp/graphql-rsync-composition-')
  roots.push(root)
  const stagingRoot = join(root, 'rsync'); await mkdir(stagingRoot, { mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const sha256 = createHash('sha256').update('abcdefgh').digest('hex')
  const intent: TransferIntent = { ...transferContextForBinding(binding), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), rootId: randomUUID(), rootBindingRevision: 1, placementHash: sha256,
    direction: 'to-worker', byteClass: 'source', sha256, byteSize: 8, manifestDigest: sha256,
    chunkBytes: 4, expiresAt: new Date(Date.now() + 60_000).toISOString() }
  let denied = false
  const accepted = { intent: async (id: string) => { if (id !== intent.transferId) throw new Error('Unknown original intent'); return intent },
    authorize: vi.fn(async () => { if (denied) throw new Error('Denied original accepted owner') }) }
  const receiver = new ResumableByteTransferService(join(root, 'canonical'), accepted); receivers.push(receiver)
  const ownership = new RsyncWriterOwnership(stagingRoot, () => binding)
  const writers: RsyncTransferWriters = {
    local: async () => { throw new Error('No selected client command in this fixture') },
    remote: async () => { throw new Error('No authenticated peer in this fixture') },
    activate: async () => { throw new Error('No actual waiting wrapper in this fixture') },
    quiescent: (intent, signal) => ownership.processesQuiescent(intent, signal, true),
    stop: (intent, signal) => ownership.stopProcesses(intent, signal),
  }
  const ownershipPorts = { ownership, writers }
  const providers: ProductionRsyncProviders = { stagingRoot, accepted, receiver, ...ownershipPorts,
    resolveSource: vi.fn(async () => ({ read: async () => { throw new Error('No output bytes supplied by this composition-only fixture') } })),
    acknowledged: vi.fn(async () => { throw new Error('No canonical acknowledgement in this fixture') }),
    quiescent: vi.fn(async () => { throw new Error('No stopped-writer proof in this fixture') }) }
  return { root, binding, intent, providers, receiver, deny: () => { denied = true }, current: () => binding }
}

describe('original rsync common composition, no SSH/native acceptance', () => {
  it('keeps discovery absent and selected send unavailable when original ports are missing', () => {
    const mounted = createProductionRsyncComposition({ side: 'main', current: () => undefined })
    expect(mounted.kind).toBe('unavailable'); expect(mounted.extensions).toEqual([])
    expect(mounted.missing).toContain('canonical acknowledgement')
    if (mounted.kind !== 'unavailable') throw new Error('Missing original ports were advertised')
    expect(() => mounted.sender()).toThrow('Selected rsync is missing')
  })
  it('requires every worker provider before advertising metadata-only control', async () => {
    const f = await fixture()
    for (const field of ['stagingRoot', 'accepted', 'receiver', 'resolveSource', 'acknowledged', 'quiescent', 'ownership', 'writers'] as const) {
      const providers: Partial<ProductionRsyncProviders> = { ...f.providers }; delete providers[field]
      const mounted = createProductionRsyncComposition({ side: 'worker', providers, current: f.current })
      expect(mounted.kind, field).toBe('unavailable'); expect(mounted.extensions, field).toEqual([])
    }
    const mounted = createProductionRsyncComposition({ side: 'worker', providers: f.providers, current: f.current })
    expect(mounted.kind).toBe('configured')
    expect(mounted.extensions[0]).toMatchObject({ ...RSYNC_STAGE_EXTENSION, role: 'server', handle: expect.any(Function) })
  })
  it('requires Main explicit selection and its existing captured W07 channel', async () => {
    const f = await fixture(), selection = vi.fn(async () => { throw new Error('No trusted physical selection in this fixture') })
    const partial = createProductionRsyncComposition({ side: 'main', providers: { ...f.providers, selection }, current: f.current })
    expect(partial.kind).toBe('unavailable'); expect(partial.missing).toEqual(['existing W07 rsync control channel'])
    const mounted = createProductionRsyncComposition({ side: 'main', providers: { ...f.providers, selection,
      peer: { capture: () => undefined } }, current: f.current })
    expect(mounted.kind).toBe('configured')
    expect(mounted.extensions).toEqual([{ ...RSYNC_STAGE_EXTENSION, role: 'client' }])
    expect(selection).not.toHaveBeenCalled()
    if (mounted.kind !== 'configured') throw new Error('Complete fixture ports were not composed')
    await expect(mounted.sender({ read: async () => Buffer.alloc(0) }).send(f.intent)).rejects.toThrow('No trusted physical selection')
    expect(f.providers.resolveSource).not.toHaveBeenCalled()
  })
  it('uses one genuine receiver journal for external and canonical bytes and denies stale/revoked callers', async () => {
    const f = await fixture(), mounted = createProductionRsyncComposition({ side: 'worker', providers: f.providers, current: f.current })
    if (mounted.kind !== 'configured') throw new Error('Complete fixture ports were not composed')
    const extension = mounted.extensions[0]!, signal = new AbortController().signal
    const command = { kind: 'rsync-stage-v1', method: 'receiver-prepare', transferId: f.intent.transferId }
    await expect(extension.handle!(command, { binding: { ...f.binding, connectionGeneration: 2 }, signal })).rejects.toThrow('Stale')
    await expect(readFile(join(f.root, 'canonical', `${f.intent.transferId}.json`))).rejects.toThrow()
    await extension.handle!(command, { binding: f.binding, signal })
    const journal = join(f.root, 'canonical', `${f.intent.transferId}.json`), before = await readFile(journal, 'utf8')
    expect(JSON.parse(before).payload).toMatchObject({ canonical: true,
      external: { 'rsync-receiver': { byteSize: f.intent.byteSize * 3, released: false } } })
    await extension.handle!({ ...command, method: 'receiver-interrupt' }, { binding: f.binding, signal })
    expect(await readFile(journal, 'utf8')).toBe(before)
    f.deny()
    await expect(extension.handle!(command, { binding: f.binding, signal })).rejects.toThrow('Denied')
    expect(await readFile(journal, 'utf8')).toBe(before)
  })
  it('mounts the real installed factory with one ownership/store and original kernel issuer records', async () => {
    const f = await fixture(), stagingRoot = join(f.root, 'installed'); await mkdir(stagingRoot, { mode: 0o700 })
    f.binding.bootId = bootIdentity(); f.intent.bootId = f.binding.bootId
    const executable = await realpath(process.execPath), sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
    const store = vi.spyOn(RsyncWriterOwnership.prototype, 'store')
    const mounted = createInstalledRsyncComposition({ side: 'worker', current: f.current,
      providers: { ...f.providers, stagingRoot, binary: { executable, sha256 } } })
    if (mounted.kind !== 'configured') throw new Error('Original installed factory failed to mount')
    expect(store).toHaveBeenCalledTimes(1)
    expect(store.mock.instances[0]).toBe(mounted.ownership)
    const frame = { binding: f.binding, signal: new AbortController().signal }
    const extension = mounted.extensions[0]!, request = { kind: 'rsync-stage-v1', method: 'writer-prepare', transferId: f.intent.transferId }
    const response = await extension.handle!(request, frame), reference = response.payload as { ownerId: string; ownerDigest: string }
    const original = JSON.parse(await readFile(join(stagingRoot, '.rsync-writers', f.intent.transferId, `${reference.ownerId}.owner`), 'utf8'))
    expect(original).toMatchObject({ role: 'rsync-server', intent: f.intent, binding: f.binding, issuer: { pid: process.pid }, hostBootId: bootIdentity() })
    expect(mounted.rsyncWriters.inventory()).toEqual([f.intent])
    await expect(extension.handle!(request, { ...frame, binding: { ...f.binding, connectionGeneration: 2 } })).rejects.toThrow('Stale')
    await mounted.rsyncWriters.bindingLost(f.binding)
    await extension.handle!({ ...request, method: 'writer-status' }, frame)
    await mounted.rsyncWriters.close(); await mounted.rsyncWriters.close()
    await expect(extension.handle!(request, frame)).rejects.toThrow()
  })
  it('keeps the installed worker unavailable without a protected executable selection', async () => {
    const f = await fixture(), mounted = createInstalledRsyncComposition({ side: 'worker', providers: f.providers, current: f.current })
    expect(mounted.kind).toBe('unavailable'); expect(mounted.extensions).toEqual([])
    expect(mounted.missing).toContain('protected worker rsync executable')
  })
  it('does not create a missing installed root or ownership journal', async () => {
    const f = await fixture(), stagingRoot = join(f.root, 'uninstalled')
    const mounted = createInstalledRsyncComposition({ side: 'worker', current: f.current,
      providers: { ...f.providers, stagingRoot, binary: { executable: '/protected/rsync', sha256: 'a'.repeat(64) } } })
    expect(mounted.kind).toBe('unavailable'); expect(mounted.missing).toEqual(['protected installed staging root'])
    await expect(readFile(join(stagingRoot, '.rsync-writers', 'intent.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each(['fixed', 'revalidated'])('joins both hosts and pins the client with a %s selection', async mode => {
    const f = await fixture(), localRoot = join(f.root, 'installed-main'), remoteRoot = join(f.root, 'installed-worker')
    await mkdir(localRoot, { mode: 0o700 }); await mkdir(remoteRoot, { mode: 0o700 })
    f.binding.bootId = bootIdentity(); f.intent.bootId = f.binding.bootId
    const executable = await realpath(process.execPath), sha256 = createHash('sha256').update(await readFile(executable)).digest('hex')
    const worker = createInstalledRsyncComposition({ side: 'worker', current: f.current,
      providers: { ...f.providers, stagingRoot: remoteRoot, binary: { executable, sha256 } } })
    if (worker.kind !== 'configured') throw new Error('Original worker factory unavailable')
    const registration = { mainId: f.binding.mainId, deviceId: f.binding.deviceId, workerInstallationId: f.binding.workerInstallationId,
      keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), status: 'paired' as const, scopes: ['connect' as const, 'heartbeat' as const] }
    const endpoint = { user: 'fixture', host: 'worker.example', localBinary: executable, remoteBinary: executable,
      localRoot, remoteRoot, localBinarySha256: sha256, remoteBinarySha256: sha256 }
    const selected: RsyncBackendSelection = { backend: 'rsync', endpoint, nodeBinary: executable, entryPoint: '/protected/rsync-writer.mjs', check: {
      registration, state: 'ready', checkedAt: new Date().toISOString(), consent: { mainId: registration.mainId, deviceId: registration.deviceId,
        workerInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: registration.publicKeyFingerprint,
        revision: 1, endpoint: { transport: 'tailscale', host: endpoint.host, port: 22, osUser: endpoint.user }, hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`,
        allowOwnerCommands: true, privilege: 'selected-os-user',
        automaticSudo: false, grantsAgentPermissions: false }, probe: { state: 'connected', hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, osUser: endpoint.user,
        uid: 1000, hostname: 'worker', sshVersion: 'fixture', rsyncVersion: 'fixture', tailscaleVersion: 'fixture' } } }
    if (mode === 'revalidated') selected.revalidate = vi.fn(async () => {})
    const main = createInstalledRsyncComposition({ side: 'main', current: f.current, providers: { ...f.providers, stagingRoot: localRoot,
      selection: async () => selected, peer: { capture: () => ({ binding: f.binding, request: (payload, options) =>
        worker.extensions[0]!.handle!(payload, { binding: f.binding, signal: options.signal }) }) } } })
    if (main.kind !== 'configured') throw new Error('Original Main factory unavailable')
    const signal = new AbortController().signal, reference = await main.writers.remote(f.intent, signal)
    const command = rsyncCommand(endpoint, f.intent, reference)
    await main.writers.local(f.intent, command, signal)
    const local = vi.spyOn(main.ownership, 'processesQuiescent'), remote = vi.spyOn(worker.ownership, 'processesQuiescent')
    await expect(main.writers.quiescent(f.intent, signal)).rejects.toThrow('physical closure remains incomplete')
    expect(local).toHaveBeenCalled(); expect(remote).toHaveBeenCalled()
    await expect(main.writers.activate(f.intent, { ...reference, ownerId: randomUUID() }, signal)).rejects.toThrow('activation reference changed')
    selected.endpoint.localBinarySha256 = '0'.repeat(64)
    await expect(main.writers.local(f.intent, command, signal)).rejects.toThrow('protected rsync selection changed')
    // The only positive closure here is cancellation of both real never-dispatched reservations.
    await main.writers.stop(f.intent, signal); await main.writers.quiescent(f.intent, signal)
    await main.rsyncWriters.close(); await worker.rsyncWriters.close()
    const peer = vi.fn(() => undefined)
    const restarted = createInstalledRsyncComposition({ side: 'main', current: () => undefined,
      providers: { ...f.providers, stagingRoot: localRoot, selection: async () => selected,
        peer: { capture: peer } } })
    if (restarted.kind !== 'configured') throw new Error('Restarted Main factory unavailable')
    expect(restarted.rsyncWriters.inventory()).toEqual([f.intent])
    await restarted.rsyncWriters.close()
    expect(peer).not.toHaveBeenCalled()
    expect(restarted.rsyncWriters.inventory()).toEqual([f.intent])
  })
})
