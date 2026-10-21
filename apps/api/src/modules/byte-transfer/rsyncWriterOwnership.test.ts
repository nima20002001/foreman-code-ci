import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, open, readFile, writeFile, rm, mkdir, rmdir, rename, symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { RsyncWriterOwnership, rsyncArgumentDigest, type RsyncOwnerReference } from './rsyncWriterOwnership.js'
import { parseRsyncWriterArguments, runRsyncWriterCli } from './rsyncWriterCli.js'
import { RsyncPrivateStore } from './rsyncStore.js'
import { NodeRsyncExecutor, RsyncStagingTransport, rsyncCommand, type RsyncEndpoint, type RsyncStagingPorts } from './rsync.js'
import { bootIdentity, processIdentity } from '../harnesses/recovery/linuxIdentity.js'
import * as storage from '../harnesses/recovery/storage.js'
import { readRecord, writeRecord } from '../harnesses/recovery/storage.js'

// Simulate a failure BEFORE executable configuration. Real write-ahead registry,
// abandonment and durable retirement receipts remain in use. No provider is launched.
vi.mock('../harnesses/recovery/processRegistry.js', async importOriginal => ({
  ...await importOriginal<typeof import('../harnesses/recovery/processRegistry.js')>(),
  spawnNativeProcess: vi.fn(() => { throw new Error('fixture before executable dispatch') }),
}))
const bytes = Buffer.from('original rsync bytes\n')
const hash = (input: Uint8Array) => createHash('sha256').update(input).digest('hex')
const signal = () => AbortSignal.timeout(5000)
async function fixture() {
  const root = await mkdtemp('/tmp/rsync-writer-owner-')
  const intent: TransferIntent = { version: 1, transferId: randomUUID(), operationId: randomUUID(), mainId: randomUUID(),
    deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionEpoch: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(),
    placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker', byteClass: 'artifact',
    sha256: hash(bytes), byteSize: bytes.length, manifestDigest: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString(), chunkBytes: 1024 }
  const binding: DeviceSessionBinding = { mainId: intent.mainId, deviceId: intent.deviceId, workerInstallationId: intent.workerInstallationId,
    keyRevision: intent.keyRevision, authorizationRevision: intent.authorizationRevision, bootId: intent.bootId,
    connectionEpoch: intent.connectionEpoch, connectionGeneration: 1 }
  let current: DeviceSessionBinding | undefined = binding
  const ownership = new RsyncWriterOwnership(root, () => current)
  const release = vi.fn(async () => {}), retire = vi.fn(async () => {})
  const quota = { reserve: vi.fn(async () => release), retire }
  const store = new RsyncPrivateStore(root, quota, ownership.store())
  const binary = join(root, 'pinned-rsync'); await writeFile(binary, bytes, { mode: 0o600 })
  const pin = { executable: binary, sha256: hash(bytes) }
  const ownerPath = (ref: RsyncOwnerReference, suffix: string) => join(root, '.rsync-writers', intent.transferId, `${ref.ownerId}.${suffix}`)
  return { root, intent, binding, ownership, quota, store, pin, ownerPath, release, retire,
    change: (next?: DeviceSessionBinding) => { current = next }, dispose: () => rm(root, { recursive: true, force: true }) }
}
describe.skipIf(process.platform !== 'linux')('causal rsync byte ownership', () => {
  it('retires an interrupted receiver after its original byte lease has been stopped', async () => {
    const f = await fixture()
    try {
      const receiver = await f.store.receive(f.intent, signal())
      await f.ownership.stop(f.intent, signal())
      await expect(receiver.interrupt()).resolves.toBeUndefined()
      await f.store.retire(f.intent, 'execution-closed')
      expect(f.quota.retire).toHaveBeenCalledWith(f.intent)
      await expect(f.store.receive(f.intent, signal())).rejects.toThrow('admission is closed')
    } finally { await f.dispose() }
  })

  it('recognizes the latest retirement owner when a lock retains a historical writer inode', async () => {
    const f = await fixture()
    try {
      const lease = f.ownership.access(f.intent, f.binding, 'receiver')
      const lock = join(f.root, `${f.intent.transferId}.lock`)
      const retainedLock = join(f.root, 'original-lock')
      await lease.run(async () => {
        await mkdir(lock, { mode: 0o700 })
        lease.captureLock()
      })
      await lease.close()
      await f.ownership.retire(f.intent, async () => {
        f.ownership.captureRetirementLock(f.intent)
        expect(() => f.ownership.assertLock(f.intent)).not.toThrow()
        await rename(lock, retainedLock)
        await mkdir(lock, { mode: 0o700 })
        expect(() => f.ownership.assertLock(f.intent)).toThrow('lock owner conflicts')
        await rmdir(lock)
        await rename(retainedLock, lock)
      })
    } finally { await f.dispose() }
  })

  it('uses the latest receiver when a removed lock inode is reused, including after reopening', async () => {
    const f = await fixture()
    try {
      const lock = join(f.root, `${f.intent.transferId}.lock`)
      const old = f.ownership.access(f.intent, f.binding, 'receiver')
      await old.run(async () => {
        await mkdir(lock, { mode: 0o700 })
        old.captureLock()
      })
      await old.close()
      await rmdir(lock)
      const receiver = f.ownership.access(f.intent, f.binding, 'receiver')
      await receiver.run(async () => {
        await mkdir(lock, { mode: 0o700 })
        receiver.captureLock()
      })
      const previous = readRecord(f.ownerPath(old.reference, 'lock')) as Record<string, unknown>
      const captured = readRecord(f.ownerPath(receiver.reference, 'lock')) as Record<string, unknown>
      writeRecord(f.ownerPath(old.reference, 'lock'), { ...previous, lock: captured.lock })
      const reopened = new RsyncWriterOwnership(f.root, () => f.binding)
      expect(() => f.ownership.assertLock(f.intent)).not.toThrow()
      expect(() => reopened.assertLock(f.intent)).not.toThrow()
      await receiver.close()
      await rename(lock, `${lock}-original`)
      await mkdir(lock, { mode: 0o700 })
      const replacement = await lstat(lock, { bigint: true })
      writeRecord(f.ownerPath(old.reference, 'lock'), { ...previous,
        lock: { device: replacement.dev.toString(), inode: replacement.ino.toString() } })
      expect(() => reopened.assertLock(f.intent)).toThrow('lock ownership unavailable')
      await rmdir(lock)
      await rename(`${lock}-original`, lock)
      expect(() => reopened.assertLock(f.intent)).not.toThrow()
    } finally { await f.dispose() }
  })

  it('persists exact original binding, root and actual host process identity before any executable handoff', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const row = readRecord(f.ownerPath(ref, 'owner')) as Record<string, unknown>
      const actual = processIdentity(process.pid)!
      expect(row).toMatchObject({ ownerId: ref.ownerId, intent: f.intent, binding: f.binding, hostBootId: bootIdentity(),
        issuer: { pid: actual.pid, startTicks: actual.startTicks }, role: 'rsync-server', binary: f.pin })
      expect(readRecord(f.ownerPath(ref, 'claim'))).toBeUndefined()
      expect(readRecord(f.ownerPath(ref, 'launch'))).toBeUndefined()
      await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow('pending or unconfirmed')
      await f.ownership.stopProcesses(f.intent, signal())
      expect(readRecord(f.ownerPath(ref, 'closed'))).toMatchObject({ ownerDigest: ref.ownerDigest, evidence: 'never-dispatched' })
      await expect(f.ownership.spawnServer(ref, ['--server', '.'], signal())).rejects.toThrow('no longer dispatchable')
      await f.ownership.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('writes actual scoped process reservation before dispatch, and uses genuine no-dispatch retirement after early failure', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await expect(f.ownership.spawnServer(ref, ['--server', '.'], signal())).rejects.toThrow('before executable dispatch')
      const launch = readRecord(f.ownerPath(ref, 'launch')) as { launchId: string }
      expect(launch.launchId).toMatch(/^[a-f0-9-]{36}$/)
      await expect(f.ownership.processesQuiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
      await f.ownership.stopProcesses(f.intent, signal())
      expect(readRecord(f.ownerPath(ref, 'closed'))).toMatchObject({ evidence: 'rsync-process-closed', launchId: launch.launchId })
      await f.ownership.quiescent(f.intent, signal())
      await expect(f.ownership.spawnServer(ref, ['--server', '.'], signal())).rejects.toThrow('no longer dispatchable')
    } finally { await f.dispose() }
  })
  it.each(['epoch', 'generation', 'key', 'offline'] as const)('denies changed %s before claim or executable dispatch', async defect => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin), changed = { ...f.binding }
      if (defect === 'epoch') changed.connectionEpoch = randomUUID()
      if (defect === 'generation') changed.connectionGeneration++
      if (defect === 'key') changed.keyRevision++
      f.change(defect === 'offline' ? undefined : changed)
      await expect(f.ownership.spawnServer(ref, ['--server', '.'], signal())).rejects.toThrow('binding is not current')
      expect(readRecord(f.ownerPath(ref, 'claim'))).toBeUndefined()
      await f.ownership.stopProcesses(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('pins client argv and actual binary, and rejects competing uncertain server reservations', async () => {
    const f = await fixture()
    try {
      const args = ['--checksum', '--', 'exact-source', 'exact-destination']
      expect(() => f.ownership.prepareProcess(f.intent, f.binding, 'rsync-client', f.pin)).toThrow('command pin unavailable')
      const client = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-client', { ...f.pin, commandDigest: rsyncArgumentDigest(args) })
      await expect(f.ownership.spawnProcess(client, f.pin.executable, [...args, 'changed'], signal())).rejects.toThrow('binary differs')
      await writeFile(f.pin.executable, 'changed binary')
      await expect(f.ownership.spawnProcess(client, f.pin.executable, args, signal())).rejects.toThrow('binary differs')
      const server = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      expect(f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)).toEqual(server)
      expect(() => f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', { ...f.pin, sha256: 'f'.repeat(64) })).toThrow('active or unconfirmed')
    } finally { await f.dispose() }
  })
  it('refuses a changed transfer pin, caller digest and unrelated owner instead of replacing ownership', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await expect(f.ownership.stop({ ...f.intent, expiresAt: new Date(Date.now() - 1).toISOString() }, signal())).rejects.toThrow('intent unavailable or changed')
      await expect(f.ownership.spawnServer({ ...ref, ownerDigest: 'f'.repeat(64) }, ['--server', '.'], signal())).rejects.toThrow('identity conflicts')
      await expect(f.ownership.spawnServer({ ...ref, ownerId: randomUUID() }, ['--server', '.'], signal())).rejects.toThrow()
      expect(readRecord(f.ownerPath(ref, 'claim'))).toBeUndefined()
    } finally { await f.dispose() }
  })
  it.each([{ args: ['--server', '--sender', '.'] }, { args: ['--daemon'] }, { args: ['--server', '\0'] }])('denies unadmitted server argv $args', async ({ args }) => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await expect(f.ownership.spawnServer(ref, args, signal())).rejects.toThrow('Invalid admitted')
    } finally { await f.dispose() }
  })
  it('rejects unrelated Job/native closure and fake stopped booleans as rsync process retirement', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      writeRecord(f.ownerPath(ref, 'closed'), { version: 1, transferId: ref.transferId, ownerId: ref.ownerId,
        ownerDigest: ref.ownerDigest, evidence: 'rsync-process-closed', launchId: randomUUID() })
      await expect(f.ownership.processesQuiescent(f.intent, signal())).rejects.toThrow()
      expect(() => f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)).toThrow()
      writeRecord(f.ownerPath(ref, 'closed'), { stopped: true })
      await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow()
    } finally { await f.dispose() }
  })
  it('drains actual pending IO and closes the captured FD before publishing closure, with no late IO', async () => {
    const f = await fixture()
    try {
      const lease = f.ownership.access(f.intent, f.binding, 'snapshot')
      const fd = await open(f.pin.executable, 'r'); lease.attach(fd)
      let finish!: () => void
      const admitted = lease.run(async () => { await new Promise<void>(resolve => { finish = resolve }); await fd.readFile(); return true })
      await Promise.resolve()
      const closing = lease.close()
      expect(readRecord(f.ownerPath(lease.reference, 'closed'))).toBeUndefined()
      await expect(lease.run(async () => true)).rejects.toThrow('access closed')
      finish(); expect(await admitted).toBe(true); await closing
      await expect(fd.readFile()).rejects.toThrow()
      await f.ownership.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('bounds stop while a real admitted callback remains pending and publishes closure only after its late FD drain', async () => {
    const f = await fixture()
    try {
      const access = f.ownership.access(f.intent, f.binding, 'snapshot'), fd = await open(f.pin.executable, 'r')
      access.attach(fd)
      let finish!: () => void
      const running = access.run(async () => { await new Promise<void>(resolve => { finish = resolve }); return fd.readFile() })
      await Promise.resolve()
      const controller = new AbortController(), stopping = f.ownership.stop(f.intent, controller.signal)
      controller.abort(new Error('stop deadline'))
      await expect(stopping).rejects.toThrow('stop remains unconfirmed')
      expect(access.signal.aborted).toBe(true)
      expect(readRecord(f.ownerPath(access.reference, 'closed'))).toBeUndefined()
      expect(await fd.stat()).toBeTruthy()
      await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
      await expect(access.run(async () => fd.readFile())).rejects.toThrow('access closed')
      expect(() => f.ownership.access(f.intent, f.binding, 'receiver')).toThrow('admission is closed')
      finish(); expect(await running).toEqual(bytes)
      await access.close(signal()); await f.ownership.stop(f.intent, signal())
      await expect(fd.stat()).rejects.toThrow()
      expect(readRecord(f.ownerPath(access.reference, 'closed'))).toMatchObject({ evidence: 'access-drained' })
      await f.ownership.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('revokes every sibling before an already-cancelled drain returns and cancels deferred callbacks', async () => {
    const f = await fixture()
    try {
      const first = f.ownership.access(f.intent, f.binding, 'snapshot'), second = f.ownership.access(f.intent, f.binding, 'receiver')
      const server = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const called = vi.fn(async () => true), deferred = first.run(called)
      const controller = new AbortController(); controller.abort(new Error('shutdown deadline'))
      await expect(f.ownership.drain(controller.signal)).rejects.toThrow('drain remains unconfirmed')
      await expect(deferred).rejects.toThrow('access closed')
      expect(called).not.toHaveBeenCalled(); expect(first.signal.aborted).toBe(true); expect(second.signal.aborted).toBe(true)
      expect(readRecord(f.ownerPath(server, 'claim'))).toMatchObject({ mode: 'cancelled', ownerDigest: server.ownerDigest })
      await expect(f.ownership.spawnServer(server, ['--server', '.'], signal())).rejects.toThrow()
      await f.ownership.drain(signal())
    } finally { await f.dispose() }
  })
  it('retries descriptor/close-receipt failure without restoring IO admission or declaring an unclosed descriptor drained', async () => {
    const f = await fixture()
    try {
      const access = f.ownership.access(f.intent, f.binding, 'snapshot'), fd = await open(f.pin.executable, 'r')
      access.attach(fd)
      const closing = vi.spyOn(fd, 'close').mockRejectedValueOnce(new Error('FD close EIO'))
      await expect(access.close(signal())).rejects.toThrow('FD close EIO')
      expect(readRecord(f.ownerPath(access.reference, 'closed'))).toBeUndefined()
      await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
      await expect(access.run(async () => fd.readFile())).rejects.toThrow('access closed')
      await access.close(signal()); closing.mockRestore()
      await f.ownership.quiescent(f.intent, signal())
      await expect(fd.stat()).rejects.toThrow()
      const other = f.ownership.access(f.intent, f.binding, 'receiver'), originalWrite = storage.writeRecord
      let failed = false
      const receipt = vi.spyOn(storage, 'writeRecord').mockImplementation((path, value, immutable) => {
        if (path.endsWith(`${other.reference.ownerId}.closed`) && !failed) { failed = true; throw new Error('receipt EIO') }
        return originalWrite(path, value, immutable)
      })
      try {
        await expect(other.close(signal())).rejects.toThrow('receipt EIO')
        await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
        await other.close(signal()); await f.ownership.quiescent(f.intent, signal())
      } finally { receipt.mockRestore() }
    } finally { await f.dispose() }
  })
  it('does not reinterpret a live same-process crash residue as stopped after a registry reconstruction', async () => {
    const f = await fixture()
    try {
      const access = f.ownership.access(f.intent, f.binding, 'snapshot')
      const recovered = new RsyncWriterOwnership(f.root, () => f.binding)
      await expect(recovered.quiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
      await expect(recovered.stop(f.intent, signal())).rejects.toThrow('stop remains unconfirmed')
      await access.close(); await recovered.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('exposes original expired legacy inventory but preserves unregistered byte/lock holds', async () => {
    const f = await fixture()
    try {
      const expired = { ...f.intent, expiresAt: new Date(Date.now() - 1000).toISOString() }
      await writeFile(join(f.root, `${expired.transferId}.intent`), JSON.stringify(expired), { mode: 0o600 })
      await writeFile(join(f.root, `${expired.transferId}.part`), bytes, { mode: 0o600 })
      await mkdir(join(f.root, `${expired.transferId}.lock`), { mode: 0o700 })
      expect(f.ownership.expiredInventory()).toEqual([expired])
      await expect(f.store.retire(expired)).rejects.toThrow()
      expect(await readFile(join(f.root, `${expired.transferId}.part`))).toEqual(bytes)
      expect(f.retire).not.toHaveBeenCalled()
      expect(() => f.ownership.access(f.intent, f.binding, 'receiver')).toThrow('Unregistered rsync residue')
    } finally { await f.dispose() }
  })
  it('rejects a replaced private root and never follows a caller-created ownership symlink', async () => {
    const f = await fixture(), original = `${f.root}-original`
    try {
      f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await rename(f.root, original); await mkdir(f.root, { mode: 0o700 })
      expect(() => f.ownership.inventory()).toThrow('root changed')
      await rmdir(f.root); await symlink(original, f.root)
      expect(() => f.ownership.inventory()).toThrow('ownership directory')
    } finally { await rm(f.root, { force: true, recursive: true }); await rm(original, { recursive: true, force: true }) }
  })
  it('the existing supervisor can drain and permanently close admission without any background loop', async () => {
    const f = await fixture()
    try {
      const access = f.ownership.access(f.intent, f.binding, 'snapshot')
      const server = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await f.ownership.drain(signal())
      expect(readRecord(f.ownerPath(access.reference, 'closed'))).toMatchObject({ evidence: 'access-drained' })
      expect(readRecord(f.ownerPath(server, 'closed'))).toMatchObject({ evidence: 'never-dispatched' })
      expect(() => f.ownership.access(f.intent, f.binding, 'snapshot')).toThrow('admission is closed')
    } finally { await f.dispose() }
  })
})
describe.skipIf(process.platform !== 'linux')('rsync store causal lock and quota guards', () => {
  it('keeps a receiver lock and quota while the independently registered server is pending', async () => {
    const f = await fixture()
    try {
      const lease = await f.store.receive(f.intent, signal())
      f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await writeFile(join(f.root, `${f.intent.transferId}.part`), bytes, { mode: 0o600 })
      await expect(lease.verify(signal())).rejects.toThrow('pending or unconfirmed')
      await expect(lease.interrupt()).rejects.toThrow('pending or unconfirmed')
      expect(await readFile(join(f.root, `${f.intent.transferId}.part`))).toEqual(bytes)
      expect(f.release).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled()
      await f.ownership.stopProcesses(f.intent, signal())
      await f.store.retire(f.intent)
      await expect(readFile(join(f.root, `${f.intent.transferId}.part`))).rejects.toThrow()
      expect(f.retire).toHaveBeenCalledOnce()
    } finally { await f.dispose() }
  })
  it('verifies original bytes, tracks real staged reads, and releases only after captured FD drain', async () => {
    const f = await fixture()
    try {
      const lease = await f.store.receive(f.intent, signal())
      await writeFile(join(f.root, `${f.intent.transferId}.part`), bytes, { mode: 0o600 })
      await expect(lease.verify(signal())).rejects.toThrow('subprocess ownership unavailable')
      f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      await f.ownership.stopProcesses(f.intent, signal())
      const staged = await lease.verify(signal())
      expect(await staged.read(0, bytes.length, signal())).toEqual(bytes)
      await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
      await staged.close(); expect(f.release).toHaveBeenCalledOnce()
      await f.ownership.quiescent(f.intent, signal())
      await expect(staged.read(0, 1, signal())).rejects.toThrow('closed')
      expect(() => f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)).toThrow('admission is closed')
    } finally { await f.dispose() }
  })
  it('retains quota for failed snapshot writes and seals exact source reads under actual FD ownership', async () => {
    const f = await fixture()
    try {
      const fd = await open(f.pin.executable, 'r')
      try {
        const snapshot = await f.store.freeze(f.intent, fd, signal())
        await expect(f.store.retire(f.intent)).rejects.toThrow('active or unconfirmed')
        await snapshot.close(); await f.store.retire(f.intent)
        expect(f.retire).toHaveBeenCalledOnce()
      } finally { await fd.close() }
      const other = await fixture()
      try {
        const source = await open(other.pin.executable, 'r'); await writeFile(other.pin.executable, 'wrong-size')
        try { await expect(other.store.freeze(other.intent, source, signal())).rejects.toThrow('length changed') }
        finally { await source.close() }
        expect(other.release).not.toHaveBeenCalled(); expect(other.retire).not.toHaveBeenCalled()
      } finally { await other.dispose() }
    } finally { await f.dispose() }
  })
  it('retries expired cleanup after failed shared-quota release without recreating or extending intent', async () => {
    const f = await fixture()
    let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const fd = await open(f.pin.executable, 'r')
      try { const snapshot = await f.store.freeze(f.intent, fd, signal()); await snapshot.close() }
      finally { await fd.close() }
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.intent.expiresAt) + 1)
      f.retire.mockRejectedValueOnce(new Error('shared quota release interrupted'))
      await expect(f.store.retire(f.intent)).rejects.toThrow('shared quota release interrupted')
      await f.store.retire(f.intent)
      expect(f.retire).toHaveBeenCalledTimes(2)
      await expect(readFile(join(f.root, `${f.intent.transferId}.intent`))).rejects.toThrow()
      expect(f.ownership.expiredInventory()).toEqual([f.intent])
    } finally { clock?.mockRestore(); await f.dispose() }
  })
  it('fences a genuinely pending shared-quota cleanup across reconstructed registries and bounded stop', async () => {
    const f = await fixture()
    try {
      const source = await open(f.pin.executable, 'r')
      try { const snapshot = await f.store.freeze(f.intent, source, signal()); await snapshot.close() }
      finally { await source.close() }
      let started!: () => void, finish!: () => void
      const ready = new Promise<void>(resolve => { started = resolve }), pending = new Promise<void>(resolve => { finish = resolve })
      f.retire.mockImplementationOnce(async () => { started(); await pending })
      const cleaning = f.store.retire(f.intent); await ready
      const path = join(f.root, '.rsync-writers', f.intent.transferId, 'retirement-1')
      expect(readRecord(`${path}.cleanup`)).toMatchObject({ intent: f.intent, hostBootId: bootIdentity(), issuer: { pid: process.pid } })
      expect(readRecord(`${path}.lock`)).toMatchObject({ transferId: f.intent.transferId, sequence: 1 })
      expect(readRecord(`${path}.closed`)).toBeUndefined()
      const reconstructed = new RsyncWriterOwnership(f.root, () => f.binding), callback = vi.fn(async () => {})
      await expect(reconstructed.retire(f.intent, callback)).rejects.toThrow('cleanup remains active or unconfirmed')
      const controller = new AbortController(), stopping = f.ownership.stop(f.intent, controller.signal)
      controller.abort(new Error('cleanup drain deadline'))
      await expect(stopping).rejects.toThrow('stop remains unconfirmed')
      expect(callback).not.toHaveBeenCalled(); expect(f.retire).toHaveBeenCalledOnce()
      expect(readRecord(`${path}.closed`)).toBeUndefined()
      finish(); await cleaning; await f.ownership.stop(f.intent, signal())
      expect(readRecord(`${path}.closed`)).toMatchObject({ evidence: 'access-drained' })
      await reconstructed.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('joins a late reservation and retains the actual root FD until admitted IO settles', async () => {
    const f = await fixture()
    const source = await open(f.pin.executable, 'r')
    try {
      const adapter = f.ownership.store(), handles: Awaited<ReturnType<typeof open>>[] = [], original = adapter.access
      adapter.access = (intent, role) => {
        const lease = original(intent, role), attach = lease.attach
        lease.attach = handle => { handles.push(handle); attach(handle) }
        return lease
      }
      const store = new RsyncPrivateStore(f.root, f.quota, adapter)
      let started!: () => void, finish!: () => void
      const ready = new Promise<void>(resolve => { started = resolve }), pending = new Promise<void>(resolve => { finish = resolve })
      f.quota.reserve.mockImplementationOnce(async () => { started(); await pending; return f.release })
      const copying = store.freeze(f.intent, source, signal()), observed = copying.catch(error => error)
      await ready
      const directory = handles[0]!
      expect((await directory.stat()).isDirectory()).toBe(true)
      const controller = new AbortController(), stopping = f.ownership.stop(f.intent, controller.signal)
      controller.abort(new Error('reservation stop deadline'))
      await expect(stopping).rejects.toThrow('stop remains unconfirmed')
      expect((await directory.stat()).isDirectory()).toBe(true)
      await expect(f.ownership.quiescent(f.intent, signal())).rejects.toThrow('active or unconfirmed')
      finish(); expect(await observed).toBeInstanceOf(Error)
      await f.ownership.stop(f.intent, signal())
      await expect(directory.stat()).rejects.toThrow()
      await expect(readFile(join(f.root, `${f.intent.transferId}.snapshot`))).rejects.toThrow()
      expect(f.release).not.toHaveBeenCalled(); expect(f.retire).not.toHaveBeenCalled()
    } finally { await source.close(); await f.dispose() }
  })
  it.each(['claim', 'receipt'] as const)('repairs an interrupted cleanup %s without replaying a callback or changing intent', async defect => {
    const f = await fixture()
    let fault: ReturnType<typeof vi.spyOn> | undefined
    try {
      const lease = f.ownership.access(f.intent, f.binding, 'snapshot'); await lease.close()
      const path = join(f.root, '.rsync-writers', f.intent.transferId, 'retirement-1'), write = storage.writeRecord
      const callback = vi.fn(async () => {})
      fault = vi.spyOn(storage, 'writeRecord').mockImplementation((target, value, exclusive) => {
        write(target, value, exclusive)
        if (target === `${path}.${defect === 'claim' ? 'cleanup' : 'closed'}`) throw new Error('cleanup journal interrupted')
      })
      await expect(f.ownership.retire(f.intent, callback)).rejects.toThrow('cleanup journal interrupted')
      expect(callback).toHaveBeenCalledTimes(defect === 'claim' ? 0 : 1)
      const original = readRecord(`${path}.cleanup`)
      fault.mockRestore()
      await f.ownership.quiescent(f.intent, signal())
      expect(readRecord(`${path}.closed`)).toMatchObject({ evidence: 'access-drained' })
      expect(readRecord(`${path}.cleanup`)).toEqual(original)
      await f.ownership.retire(f.intent, callback)
      expect(callback).toHaveBeenCalledTimes(defect === 'claim' ? 1 : 2)
      expect(f.ownership.inventory()).toEqual([f.intent])
    } finally { fault?.mockRestore(); await f.dispose() }
  })
  it('admits exactly one concurrent cleanup callback through the durable sequence claim', async () => {
    const f = await fixture()
    try {
      const lease = f.ownership.access(f.intent, f.binding, 'snapshot'); await lease.close()
      let finish!: () => void, started!: () => void
      const ready = new Promise<void>(resolve => { started = resolve })
      const pending = new Promise<void>(resolve => { finish = resolve }), callback = vi.fn(async () => { started(); await pending })
      const other = new RsyncWriterOwnership(f.root, () => f.binding)
      const first = f.ownership.retire(f.intent, callback), second = other.retire(f.intent, callback)
      const observed = second.catch(error => error)
      await ready
      expect(await observed).toBeInstanceOf(Error)
      expect(callback).toHaveBeenCalledOnce()
      finish(); await first
      await f.ownership.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('retains an actual failed cleanup FD and repairs closure only through its original captured handle', async () => {
    const f = await fixture()
    try {
      const lease = f.ownership.access(f.intent, f.binding, 'snapshot'); await lease.close()
      const handle = await open(f.pin.executable, 'r'), close = vi.spyOn(handle, 'close').mockRejectedValueOnce(new Error('cleanup FD close interrupted'))
      await expect(f.ownership.retire(f.intent, async () => {
        f.ownership.captureRetirementHandle(f.intent, handle)
        throw new Error('cleanup IO interrupted')
      })).rejects.toThrow('cleanup FD close interrupted')
      const path = join(f.root, '.rsync-writers', f.intent.transferId, 'retirement-1')
      expect(readRecord(`${path}.closed`)).toBeUndefined(); expect(await handle.stat()).toBeTruthy()
      const other = new RsyncWriterOwnership(f.root, () => f.binding)
      await expect(other.quiescent(f.intent, signal())).rejects.toThrow('cleanup remains active or unconfirmed')
      await f.ownership.quiescent(f.intent, signal())
      expect(readRecord(`${path}.closed`)).toMatchObject({ evidence: 'access-drained' })
      await expect(handle.stat()).rejects.toThrow(); expect(close).toHaveBeenCalledTimes(2)
    } finally { await f.dispose() }
  })
  it('recovers only the exact captured cleanup lock after a settled callback error', async () => {
    const f = await fixture()
    try {
      const source = await open(f.pin.executable, 'r')
      try { const snapshot = await f.store.freeze(f.intent, source, signal()); await snapshot.close() }
      finally { await source.close() }
      await expect(f.ownership.retire(f.intent, async () => {
        await mkdir(join(f.root, `${f.intent.transferId}.lock`), { mode: 0o700 })
        f.ownership.captureRetirementLock(f.intent)
        throw new Error('cleanup interrupted after lock capture')
      })).rejects.toThrow('after lock capture')
      await f.store.retire(f.intent)
      expect(f.retire).toHaveBeenCalledOnce()
      await expect(readFile(join(f.root, `${f.intent.transferId}.snapshot`))).rejects.toThrow()
    } finally { await f.dispose() }
  })
  it('retries staged closure after failed quota release while permanently denying further reads', async () => {
    const f = await fixture()
    try {
      const lease = await f.store.receive(f.intent, signal())
      await writeFile(join(f.root, `${f.intent.transferId}.part`), bytes)
      f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin); await f.ownership.stopProcesses(f.intent, signal())
      const staged = await lease.verify(signal())
      f.release.mockRejectedValueOnce(new Error('quota release interrupted'))
      await expect(staged.close()).rejects.toThrow('quota release interrupted')
      await expect(staged.read(0, 1, signal())).rejects.toThrow('closed')
      await staged.close(); await staged.close()
      expect(f.release).toHaveBeenCalledTimes(2)
      await f.ownership.quiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('never removes a replaced lock inode or unregistered source-materializer residue', async () => {
    const f = await fixture()
    try {
      const lease = await f.store.receive(f.intent, signal()), lock = join(f.root, `${f.intent.transferId}.lock`)
      // Keep the original inode allocated so this proves replacement, never inode-age heuristics.
      await rename(lock, `${lock}-original`); await mkdir(lock, { mode: 0o700 })
      await expect(lease.interrupt()).rejects.toThrow('lock ownership unavailable')
      await expect(f.store.retire(f.intent)).rejects.toThrow('lock ownership unavailable')
      expect(f.retire).not.toHaveBeenCalled()
      await rmdir(lock); await rename(`${lock}-original`, lock)
      await writeFile(join(f.root, `${f.intent.transferId}.${randomUUID()}.input`), bytes, { mode: 0o600 })
      await expect(f.store.retire(f.intent)).rejects.toThrow('materializer residue')
      expect(f.retire).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('rejects an absent causal adapter before reserving quota or creating bytes', async () => {
    const f = await fixture()
    try {
      const store = new RsyncPrivateStore(f.root, f.quota)
      await expect(store.receive(f.intent, signal())).rejects.toThrow('ownership unavailable')
      expect(f.quota.reserve).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
})
describe.skipIf(process.platform !== 'linux')('actual wrapper admission through the existing live control channel', () => {
  it('grants only the actual waiting wrapper after accepted-authority readback and never duplicates a claimed launch', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const wrapper = new RsyncWriterOwnership(f.root, () => undefined)
      await expect(wrapper.spawnServer(ref, ['--server', '.'], signal())).rejects.toThrow('binding is not current')
      const waiting = wrapper.waitForServerGrant(ref, signal())
      const actual = processIdentity(process.pid)!
      expect(readRecord(f.ownerPath(ref, 'waiting'))).toMatchObject({ hostBootId: bootIdentity(), process: { pid: actual.pid, startTicks: actual.startTicks } })
      const authorize = vi.fn(async () => {})
      expect(f.ownership.serverAdmission(f.intent, f.binding)).toMatchObject({ ownerId: ref.ownerId, ownerDigest: ref.ownerDigest })
      await f.ownership.activateServer(ref, f.binding, signal(), authorize)
      await waiting
      expect(authorize).toHaveBeenCalledWith(f.intent, f.binding, expect.any(AbortSignal))
      const granted = readRecord(f.ownerPath(ref, 'grant'))
      await f.ownership.activateServer(ref, f.binding, signal(), authorize)
      expect(readRecord(f.ownerPath(ref, 'grant'))).toEqual(granted)
      await expect(wrapper.spawnGrantedServer(ref, ['--server', '.'], signal())).rejects.toThrow('before executable dispatch')
      expect(readRecord(f.ownerPath(ref, 'claim'))).toMatchObject({ mode: 'process', parent: { pid: actual.pid, startTicks: actual.startTicks } })
      expect(() => f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)).toThrow('active or unconfirmed')
      await expect(wrapper.spawnGrantedServer(ref, ['--server', '.'], signal())).rejects.toThrow()
      await wrapper.stopServer(ref, signal()); await f.ownership.processesQuiescent(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('does not grant or invoke authority when no actual wrapper has appeared before caller cancellation', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin), controller = new AbortController()
      const authorize = vi.fn(async () => {})
      const activated = f.ownership.activateServer(ref, f.binding, controller.signal, authorize)
      controller.abort(new Error('admission deadline'))
      await expect(activated).rejects.toThrow()
      expect(authorize).not.toHaveBeenCalled(); expect(readRecord(f.ownerPath(ref, 'grant'))).toBeUndefined()
      await f.ownership.stopProcesses(f.intent, signal())
    } finally { await f.dispose() }
  })
  it.each(['denied', 'epoch', 'generation', 'offline'] as const)('revalidates %s after the wrapper appears, before publishing any grant', async defect => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin), controller = new AbortController()
      const waiting = f.ownership.waitForServerGrant(ref, controller.signal)
      const observed = waiting.catch(() => { /* ignore: the test asserts the authority failure and then cancels this waiting wrapper. */ })
      await expect(f.ownership.activateServer(ref, f.binding, signal(), async () => {
        if (defect === 'denied') throw new Error('accepted transfer denied')
        f.change(defect === 'offline' ? undefined : { ...f.binding,
          ...(defect === 'epoch' ? { connectionEpoch: randomUUID() } : { connectionGeneration: 2 }) })
      })).rejects.toThrow(defect === 'denied' ? 'accepted transfer denied' : 'binding is not current')
      expect(readRecord(f.ownerPath(ref, 'grant'))).toBeUndefined()
      expect(readRecord(f.ownerPath(ref, 'claim'))).toBeUndefined()
      controller.abort(); await observed; await f.ownership.stopProcesses(f.intent, signal())
    } finally { await f.dispose() }
  })
  it('bounds a slow accepted-authority read and never grants after its cancelled callback later finishes', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin), controller = new AbortController()
      const waiting = f.ownership.waitForServerGrant(ref, controller.signal).catch(() => { /* ignore: the test asserts the authority failure and then cancels this waiting wrapper. */ })
      let finish!: () => void
      const activated = f.ownership.activateServer(ref, f.binding, controller.signal,
        async () => new Promise<void>(resolve => { finish = resolve }))
      await Promise.resolve(); controller.abort(new Error('authority deadline'))
      await expect(activated).rejects.toThrow('authority deadline')
      finish(); await waiting; await Promise.resolve()
      expect(readRecord(f.ownerPath(ref, 'grant'))).toBeUndefined()
      await f.ownership.stopProcesses(f.intent, signal())
    } finally { await f.dispose() }
  })
  it.each(['stale', 'nonce', 'waiting', 'stopped'] as const)('rejects a %s grant before any executable claim', async defect => {
    const f = await fixture()
    let clock: ReturnType<typeof vi.spyOn> | undefined
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const waiting = f.ownership.waitForServerGrant(ref, signal())
      await f.ownership.activateServer(ref, f.binding, signal(), async () => {}); await waiting
      const grant = readRecord(f.ownerPath(ref, 'grant')) as Record<string, unknown>
      if (defect === 'stale') clock = vi.spyOn(Date, 'now').mockReturnValue(Number(grant.expiresAt) + 1)
      if (defect === 'nonce') writeRecord(f.ownerPath(ref, 'grant'), { ...grant, nonce: randomUUID() })
      if (defect === 'waiting') writeRecord(f.ownerPath(ref, 'waiting'), { ...readRecord(f.ownerPath(ref, 'waiting')) as object, process: { pid: process.pid, startTicks: '0' } })
      if (defect === 'stopped') await f.ownership.stopProcesses(f.intent, signal())
      await expect(f.ownership.spawnGrantedServer(ref, ['--server', '.'], signal())).rejects.toThrow()
      if (defect !== 'stopped') expect(readRecord(f.ownerPath(ref, 'claim'))).toBeUndefined()
      else expect(readRecord(f.ownerPath(ref, 'claim'))).toMatchObject({ mode: 'cancelled' })
    } finally { clock?.mockRestore(); await f.dispose() }
  })
  it('retains the same original grant after publication failure and permits idempotent accepted readback', async () => {
    const f = await fixture()
    let fault: ReturnType<typeof vi.spyOn> | undefined
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const waiting = f.ownership.waitForServerGrant(ref, signal())
      const write = storage.writeRecord
      fault = vi.spyOn(storage, 'writeRecord').mockImplementation((path, value, exclusive) => {
        write(path, value, exclusive)
        if (path === f.ownerPath(ref, 'grant')) throw new Error('grant publication interrupted')
      })
      await expect(f.ownership.activateServer(ref, f.binding, signal(), async () => {})).rejects.toThrow('publication interrupted')
      fault.mockRestore(); await waiting
      const grant = readRecord(f.ownerPath(ref, 'grant'))
      await f.ownership.activateServer(ref, f.binding, signal(), async () => {})
      expect(readRecord(f.ownerPath(ref, 'grant'))).toEqual(grant)
      await f.ownership.stopProcesses(f.intent, signal())
    } finally { fault?.mockRestore(); await f.dispose() }
  })
  it('strictly parses only protected root plus original owner identifiers, without creating an unknown root', async () => {
    const f = await fixture()
    try {
      const ref = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const args = ['--rsync-root', f.root, '--rsync-transfer', ref.transferId, '--rsync-owner', ref.ownerId,
        '--rsync-owner-digest', ref.ownerDigest, '--server', '.']
      expect(parseRsyncWriterArguments(args)).toEqual({ root: f.root, reference: { transferId: ref.transferId, ownerId: ref.ownerId, ownerDigest: ref.ownerDigest }, args: ['--server', '.'] })
      expect(() => parseRsyncWriterArguments([...args.slice(0, 8), '--daemon'])).toThrow('invocation')
      expect(() => parseRsyncWriterArguments(['--rsync-root', '/tmp/../unknown', ...args.slice(2)])).toThrow('root')
      expect(() => parseRsyncWriterArguments(['--rsync-root', f.root, '--rsync-binary', '/bin/sh', ...args.slice(4)])).toThrow('invocation')
      const missing = `${f.root}/missing`
      await expect(runRsyncWriterCli(['--rsync-root', missing, ...args.slice(2)], signal())).rejects.toThrow()
      await expect(readFile(join(missing, '.rsync-writers', ref.transferId, 'intent.json'))).rejects.toThrow()
    } finally { await f.dispose() }
  })
})
describe('cross-host rsync control boundary', () => {
  it('cannot verify or unlock on local success when remote writer closure is unavailable', async () => {
    const f = await fixture()
    try {
      const endpoint: RsyncEndpoint = { user: 'worker', host: 'worker.example', localBinary: f.pin.executable,
        remoteBinary: '/opt/rsync/bin/rsync', localRoot: f.root, remoteRoot: '/private/worker', localBinarySha256: f.pin.sha256,
        remoteBinarySha256: 'b'.repeat(64) }
      const reference = f.ownership.prepareProcess(f.intent, f.binding, 'rsync-server', f.pin)
      const remote = { ...reference, nodeBinary: '/usr/bin/node', entryPoint: '/opt/app/rsync-wrapper.js' }
      const command = rsyncCommand(endpoint, f.intent, remote)
      await expect(new NodeRsyncExecutor().run(command, signal())).rejects.toThrow('subprocess owner unavailable')
      expect(command.args).toContain(`--rsync-path=/usr/bin/systemd-run --user --scope --quiet --property=Delegate=yes --collect -- /usr/bin/node /opt/app/rsync-wrapper.js --rsync-root ${endpoint.remoteRoot} --rsync-transfer ${f.intent.transferId} --rsync-owner ${remote.ownerId} --rsync-owner-digest ${remote.ownerDigest}`)
      expect(() => rsyncCommand(endpoint, f.intent, { ...remote, entryPoint: '/tmp/$(id)' })).toThrow('Unsafe')
      expect(() => rsyncCommand(endpoint, f.intent, { ...remote, transferId: randomUUID() })).toThrow('remote rsync owner')
      const snapshot = { verify: vi.fn(async () => {}), close: vi.fn(async () => {}) }
      const receiver = { verify: vi.fn(), interrupt: vi.fn(async () => {}) }
      const ports: RsyncStagingPorts = { source: async () => snapshot, receiver: async () => receiver,
        writers: { remote: async () => remote, local: async () => reference, activate: vi.fn(async () => {}),
          quiescent: vi.fn(async () => { throw new Error('remote server closure unconfirmed') }),
          stop: vi.fn(async () => { throw new Error('remote server stop unconfirmed') }) } }
      const executor = { run: vi.fn(async (c: { executable: string; args: string[] }) => c.args[0] === '--version'
        ? 'rsync  version 3.5.1  protocol version 33\n'
        : c.executable === '/usr/bin/ssh' ? `rsync  version 3.5.1  protocol version 33\n${endpoint.remoteBinarySha256}  ${endpoint.remoteBinary}\n` : '') }
      const transport = new RsyncStagingTransport(endpoint, { authorize: async () => {} }, ports, executor)
      const context = () => Promise.resolve({ mainId: f.intent.mainId, deviceId: f.intent.deviceId,
        workerInstallationId: f.intent.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
        bootId: f.binding.bootId, connectionEpoch: f.binding.connectionEpoch })
      await expect(transport.stage(f.intent, context)).rejects.toThrow('remote server stop unconfirmed')
      expect(receiver.verify).not.toHaveBeenCalled(); expect(receiver.interrupt).not.toHaveBeenCalled()
      expect(snapshot.close).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
})
