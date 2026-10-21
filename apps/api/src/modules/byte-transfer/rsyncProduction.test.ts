import { describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile, readdir, lstat, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { SourcePreparationClosure, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { TrustedConnectionCheck } from '@foreman-code/contracts/trusted-device-connection'
import { ResumableByteTransferService } from './service.js'
import { transferContextForBinding } from './carrier.js'
import { assertRsyncBackendSelection, createRsyncProductionBackend, type RsyncBackendSelection,
  type RsyncExternalStagingQuota, type RsyncControlRequest, type RsyncProductionInput } from './rsyncProduction.js'
import type { RsyncExecutor, RsyncCommand, RsyncTransferWriters } from './rsync.js'
import { RsyncWriterOwnership, rsyncArgumentDigest, type RsyncAccessLease } from './rsyncWriterOwnership.js'
import { createProductionRsyncComposition, type ProductionRsyncProviders } from './productionComposition.js'

const bytes = Buffer.from('exact accepted immutable package\n'), hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
async function fixture(direction: TransferIntent['direction'] = 'to-worker', options: { realQuota?: boolean; cleanupProof?: boolean } = {}) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'rsync-production-'))
  const localRoot = join(root, 'main'), remoteRoot = join(root, 'worker')
  await mkdir(localRoot, { mode: 0o700 }); await mkdir(remoteRoot, { mode: 0o700 })
  const binary = join(root, 'binary'); await writeFile(binary, 'fixture binary', { mode: 0o600 })
  let bound: DeviceSessionBinding | undefined = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const original = bound
  const i = TransferIntentSchema.parse({ ...transferContextForBinding(bound), version: 1, transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash(bytes), rootId: randomUUID(), rootBindingRevision: 1,
    direction, byteClass: direction === 'to-worker' ? 'source' : 'artifact', sha256: hash(bytes), byteSize: bytes.length,
    manifestDigest: hash(bytes), chunkBytes: 8, expiresAt: new Date(Date.now() + 120000).toISOString() })
  const registration = { mainId: original.mainId, deviceId: original.deviceId, workerInstallationId: original.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), status: 'paired' as const, scopes: ['connect' as const, 'heartbeat' as const] }
  const endpoint = { user: 'builder', host: '100.64.0.20', localBinary: binary, remoteBinary: '/private/rsync', localRoot, remoteRoot,
    localBinarySha256: hash(Buffer.from('fixture binary')), remoteBinarySha256: 'b'.repeat(64) }
  const check: TrustedConnectionCheck = { registration, consent: { ...registration, revision: 1, endpoint: { transport: 'tailscale',
    host: endpoint.host, port: 22, osUser: endpoint.user }, hostKeyFingerprint: `SHA256:${'c'.repeat(43)}`, allowOwnerCommands: true,
    privilege: 'selected-os-user',
    automaticSudo: false, grantsAgentPermissions: false }, state: 'ready', checkedAt: new Date().toISOString(),
    probe: { state: 'connected', hostKeyFingerprint: `SHA256:${'c'.repeat(43)}`, osUser: 'builder', uid: 1000,
      hostname: 'worker', sshVersion: 'OpenSSH_9.6p1', rsyncVersion: 'rsync 3.5.1', tailscaleVersion: '1.102.4' } }
  // Consent schema is strict: registration scopes/status are not connection settings.
  delete (check.consent as unknown as Record<string, unknown>).scopes; delete (check.consent as unknown as Record<string, unknown>).status
  let denied = false, published = false, selection: RsyncBackendSelection = { backend: 'rsync', check, endpoint,
    nodeBinary: '/protected/node', entryPoint: '/protected/rsync-writer.mjs' }
  const accepted = { intent: async (id: string) => { if (id !== i.transferId) throw new Error('unknown transfer'); return i },
    authorize: vi.fn(async (candidate: TransferIntent) => {
      if (denied) throw new Error('revoked original grant')
      if (!isDeepStrictEqual(candidate, i)) throw new Error('accepted pins changed')
    }) }
  const quota: RsyncExternalStagingQuota = { reserve: vi.fn(async () => {}), release: vi.fn(async () => {}),
    hasReservation: vi.fn(async () => true), retire: vi.fn(async () => {}), inventory: vi.fn(async () => []) }
  const current = () => bound
  const mainReceiver = new ResumableByteTransferService(join(root, 'main-canonical'), accepted)
  const workerReceiver = new ResumableByteTransferService(join(root, 'worker-canonical'), accepted)
  const source = { read: vi.fn(async (_intent: TransferIntent, offset: number, length: number) => bytes.subarray(offset, offset + length)) }
  const acknowledge = vi.fn(async () => { if (!published) throw new Error('canonical not acknowledged') })
  const mainOwnership = new RsyncWriterOwnership(localRoot, current), workerOwnership = new RsyncWriterOwnership(remoteRoot, current)
  const mainStore = vi.spyOn(mainOwnership, 'store'), workerStore = vi.spyOn(workerOwnership, 'store')
  const accesses: { role: string; lease: RsyncAccessLease; handles: FileHandle[]; close: ReturnType<typeof vi.fn> }[] = []
  for (const owner of [mainOwnership, workerOwnership]) {
    const access = owner.access.bind(owner)
    vi.spyOn(owner, 'access').mockImplementation((intent, binding, role) => {
      const lease = access(intent, binding, role), handles: FileHandle[] = [], attach = lease.attach
      lease.attach = handle => { handles.push(handle); attach(handle) }
      const close = vi.fn(lease.close)
      lease.close = close
      accesses.push({ role, lease, handles, close })
      return lease
    })
  }
  const events: string[] = []
  // No executable dispatch in this fixture. Positive closure is actual cancellation of the
  // original never-dispatched reservations; this does not claim SSH/cgroup acceptance.
  const writers: RsyncTransferWriters = {
    remote: vi.fn(async intent => {
      events.push('remote-prepare')
      const reference = workerOwnership.prepareProcess(intent, original, 'rsync-server', {
        executable: endpoint.remoteBinary, sha256: endpoint.remoteBinarySha256,
      })
      return { transferId: reference.transferId, ownerId: reference.ownerId, ownerDigest: reference.ownerDigest,
        nodeBinary: '/protected/node', entryPoint: '/protected/rsync-writer.mjs' }
    }),
    local: vi.fn(async (intent, command) => {
      events.push('local-prepare')
      return mainOwnership.prepareProcess(intent, original, 'rsync-client', {
        executable: command.executable, sha256: endpoint.localBinarySha256, commandDigest: rsyncArgumentDigest(command.args),
      })
    }),
    activate: vi.fn(async () => { events.push('activate') }),
    quiescent: vi.fn(async (intent, signal) => {
      await mainOwnership.stopProcesses(intent, signal); events.push('local-closed')
      await workerOwnership.stopProcesses(intent, signal); events.push('remote-closed')
      await mainOwnership.processesQuiescent(intent, signal, true)
      await workerOwnership.processesQuiescent(intent, signal, true)
    }),
    stop: vi.fn(async (intent, signal) => {
      const outcomes = await Promise.allSettled([mainOwnership.stopProcesses(intent, signal), workerOwnership.stopProcesses(intent, signal)])
      const failures = outcomes.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'fixture stop unconfirmed')
    }),
  }
  const worker = createRsyncProductionBackend({ side: 'worker', stagingRoot: remoteRoot, accepted, current,
    receiver: workerReceiver, quota: options.realQuota ? workerReceiver : quota,
    resolveSource: async () => source, acknowledged: acknowledge, ownership: workerOwnership, writers })
  const commands: string[][] = []
  const copy = async (command: RsyncCommand, signal: AbortSignal) => {
    signal.throwIfAborted()
    if (!command.owner) throw new Error('Fixture byte command lacks actual owner')
    const [sourcePath, destinationPath] = command.args.slice(-2).map(path => path.replace('builder@100.64.0.20:', ''))
    if (!sourcePath || !destinationPath) throw new Error('Missing fixture transfer paths')
    // Rsync completes by rename, including replacement of a verified read-only private part.
    const temporary = `${destinationPath}.fixture-temp`
    await copyFile(sourcePath, temporary); await rename(temporary, destinationPath); return ''
  }
  const execute = vi.fn(copy)
  const executor: RsyncExecutor = { run: async (command, signal) => {
    signal.throwIfAborted(); commands.push(command.args)
    if (command.args[0] === '--version') return 'rsync  version 3.5.1  protocol version 33\n'
    if (command.executable === '/usr/bin/ssh') return `rsync  version 3.5.1  protocol version 33\n${endpoint.remoteBinarySha256}  ${endpoint.remoteBinary}\n`
    events.push('execute')
    return execute(command, signal)
  } }
  const request = vi.fn((request: RsyncControlRequest, options: { signal: AbortSignal; timeoutMs?: number }) => worker.handle(request,
    { binding: bound!, signal: options.signal }))
  const peer = { capture: () => bound ? { binding: bound, request } : undefined }
  const main = createRsyncProductionBackend({ side: 'main', stagingRoot: localRoot, current, accepted,
    quota: options.realQuota ? mainReceiver : quota,
    ...(options.cleanupProof ? { quiescent: (intent: TransferIntent, signal: AbortSignal) => mainOwnership.quiescent(intent, signal) } : {}),
    receiver: mainReceiver, acknowledged: acknowledge, selection: async () => selection, peer, executor, ownership: mainOwnership, writers })
  return { root, i, original, check, selection, main, worker, quota, source, commands, accepted, localRoot, remoteRoot, mainReceiver, workerReceiver, mainOwnership, workerOwnership, writers, mainStore, workerStore, accesses, events, execute, copy, request,
    publish: () => { published = true }, deny: () => { denied = true }, disconnect: () => { bound = undefined },
    changeSelection: (next: RsyncBackendSelection) => { selection = next },
    dispose: async () => { await Promise.allSettled([mainOwnership.drain(AbortSignal.timeout(5000)), workerOwnership.drain(AbortSignal.timeout(5000))]); await mainReceiver.close(); await workerReceiver.close(); await rm(root, { recursive: true, force: true }) } }
}

describe('production rsync leaf', () => {
  it('copies a sealed local output in one bounded read and still verifies its canonical digest', async () => {
    const f = await fixture('to-main')
    try {
      const receipt = await f.main.send(f.i)
      expect(receipt).toMatchObject({ sha256: f.i.sha256, byteSize: f.i.byteSize })
      expect(f.source.read).toHaveBeenCalledExactlyOnceWith(f.i, 0, f.i.byteSize, expect.any(AbortSignal))
    } finally {
      await f.dispose()
    }
  })
  it.each(['to-main', 'to-worker'] as const)('bounds the %s byte operation by its retained transfer expiry', async direction => {
    const f = await fixture(direction)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.i.expiresAt) - 90000)
    try {
      await f.main.send(f.i, direction === 'to-worker' ? f.source : undefined)
      const method = direction === 'to-main' ? 'source-prepare' : 'receiver-verify'
      expect(f.request).toHaveBeenCalledWith({ kind: 'rsync-stage-v1', method, transferId: f.i.transferId },
        { signal: expect.any(AbortSignal), timeoutMs: 90000 })
    } finally {
      clock.mockRestore()
      await f.dispose()
    }
  })
  it.each(['source-read', 'quota-admission'] as const)('retires an expired %s failure without inventing a staging record', async failure => {
    const f = await fixture('to-worker', { realQuota: true, cleanupProof: true })
    try {
      if (failure === 'source-read') f.source.read.mockRejectedValueOnce(new Error('preparation failed'))
      else vi.spyOn(f.mainReceiver, 'reserve').mockRejectedValueOnce(new Error('preparation failed'))
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('preparation failed')
      await expect(f.main.retireExpired(f.i)).rejects.toThrow('requires original expiry')
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.i.expiresAt) + 1)
      try {
        await f.main.retireExpired(f.i)
        expect(await f.mainReceiver.hasReservation(f.i, 'rsync-source')).toBe(false)
        expect(f.mainOwnership.inventory()).toContainEqual(f.i)
      } finally { clock.mockRestore() }
    } finally {
      await f.dispose()
    }
  })

  function materialization(intent: TransferIntent): SourceMaterializationRecord {
    const filesystem = { device: '1', inode: '2', mountId: '3' }
    return { operationId: randomUUID(), reservationId: randomUUID(), rootPolicyId: randomUUID(), rootPolicyRevision: '1',
      sourceBindingHash: intent.placementHash, finalDispatchBindingHash: intent.placementHash, state: 'closed',
      receipt: { version: 1, materializationId: randomUUID(), placementHash: intent.placementHash,
        executionId: intent.executionId, attemptId: intent.attemptId, keyRevision: intent.keyRevision,
        authorizationRevision: intent.authorizationRevision, verifiedManifestDigest: intent.manifestDigest,
        verifiedEntries: 1, verifiedBytes: intent.byteSize, verifiedAt: new Date().toISOString(), localTreeIdentity: filesystem,
        binding: { version: 1, mainId: intent.mainId, deviceId: intent.deviceId,
          workerInstallationId: intent.workerInstallationId, workspaceId: 'workspace', rootId: intent.rootId,
          bindingRevision: intent.rootBindingRevision, locationRevision: 1, canonicalPath: '/retained/source',
          filesystem, accessMode: 'exclusive-write', snapshotId: randomUUID(), manifestDigest: intent.manifestDigest } } }
  }

  it('retires failed input staging that has only a canonical reservation, keeping other attempts untouched', async () => {
    const f = await fixture('to-worker', { realQuota: true })
    try {
      f.i.byteClass = 'artifact'
      const context = transferContextForBinding(f.original)
      await f.workerReceiver.start(f.i, context)
      expect(f.workerOwnership.inventory()).toEqual([])
      const record = materialization(f.i)
      await f.worker.retireMaterialization({ ...record, receipt: { ...record.receipt, attemptId: randomUUID() } },
        AbortSignal.timeout(5000))
      expect((await f.workerReceiver.status(f.i.transferId, context)).state).toBe('allocated')
      await expect(f.worker.retireMaterialization({ ...record, finalDispatchBindingHash: 'd'.repeat(64),
        sourceBindingHash: 'e'.repeat(64) }, AbortSignal.timeout(5000))).rejects.toThrow('does not own')
      await f.worker.retireMaterialization(record, AbortSignal.timeout(5000))
      await expect(f.workerReceiver.status(f.i.transferId, context)).rejects.toThrow('cancelled')
      expect(await f.workerReceiver.inventory()).toEqual([])
      await f.worker.retireMaterialization(record, AbortSignal.timeout(5000))
      await expect(f.workerReceiver.start(f.i, context)).rejects.toThrow('cancelled')
      await f.workerReceiver.close()
      const restarted = new ResumableByteTransferService(join(f.root, 'worker-canonical'), f.accepted)
      try {
        await expect(restarted.start(f.i, context)).rejects.toThrow('cancelled')
        expect(await restarted.inventory()).toEqual([])
      } finally {
        await restarted.close()
      }
    } finally { await f.dispose() }
  })

  function closedPreparation(intent: TransferIntent): SourcePreparationClosure {
    return { version: 1, reconciliationId: randomUUID(), operationId: intent.operationId,
      executionId: intent.executionId, attemptId: intent.attemptId, rootId: intent.rootId,
      bindingRevision: intent.rootBindingRevision, materializationId: null,
      mainId: intent.mainId, deviceId: intent.deviceId, workerInstallationId: intent.workerInstallationId,
      keyRevision: intent.keyRevision, authorizationRevision: intent.authorizationRevision,
      filesystem: { device: '1', inode: '2', mountId: '3' }, admissionClosed: true,
      childrenClosed: true, claimReleased: true, evidencePreserved: true, observedAt: new Date().toISOString() }
  }

  it('releases both staging reservations after verified failed-preparation cleanup and preserves journals', async () => {
    const f = await fixture('to-worker', { realQuota: true })
    try {
      f.execute.mockRejectedValueOnce(new Error('connection interrupted'))
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('connection interrupted')
      expect(await f.mainReceiver.hasReservation(f.i, 'rsync-source')).toBe(true)
      expect(await f.workerReceiver.hasReservation(f.i, 'rsync-receiver')).toBe(true)
      const closure = closedPreparation(f.i)
      await expect(f.main.retirePreparation({ ...closure, attemptId: randomUUID() }, AbortSignal.timeout(5000)))
        .rejects.toThrow('does not own')
      expect(await f.mainReceiver.hasReservation(f.i, 'rsync-source')).toBe(true)
      await f.worker.retirePreparation(closure, AbortSignal.timeout(5000))
      await f.main.retirePreparation(closure, AbortSignal.timeout(5000))
      expect(await f.mainReceiver.hasReservation(f.i, 'rsync-source')).toBe(false)
      expect(await f.workerReceiver.hasReservation(f.i, 'rsync-receiver')).toBe(false)
      expect(f.mainOwnership.inventory()).toContainEqual(f.i)
      expect(f.workerOwnership.inventory()).toContainEqual(f.i)
      await expect(readFile(join(f.localRoot, `${f.i.transferId}.snapshot`))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(f.remoteRoot, `${f.i.transferId}.part`))).rejects.toMatchObject({ code: 'ENOENT' })
      await f.main.retirePreparation(closure, AbortSignal.timeout(5000))
    } finally { await f.dispose() }
  })

  it('releases a reservation when source reading fails before a staging snapshot exists', async () => {
    const f = await fixture('to-worker', { realQuota: true })
    try {
      f.source.read.mockRejectedValueOnce(new Error('source unavailable'))
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('source unavailable')
      expect(await f.mainReceiver.hasReservation(f.i, 'rsync-source')).toBe(true)
      await f.main.retirePreparation(closedPreparation(f.i), AbortSignal.timeout(5000))
      expect(await f.mainReceiver.hasReservation(f.i, 'rsync-source')).toBe(false)
      expect(f.mainOwnership.inventory()).toContainEqual(f.i)
    } finally { await f.dispose() }
  })

  it.each(['to-worker', 'to-main'] as const)('adopts original %s bytes into actual canonical verifier, retains staging before acknowledgment', async direction => {
    const f = await fixture(direction)
    try {
      const receipt = await f.main.send(f.i, direction === 'to-worker' ? f.source : undefined)
      expect(receipt.intent).toEqual(f.i); expect(receipt.sha256).toBe(hash(bytes))
      const receiver = direction === 'to-worker' ? f.workerReceiver : f.mainReceiver
      expect(await receiver.resolveVerifiedReceipt(f.i.transferId, transferContextForBinding(f.original))).toEqual(receipt)
      const path = join(direction === 'to-worker' ? f.remoteRoot : f.localRoot, `${f.i.transferId}.part`)
      expect(await readFile(path)).toEqual(bytes)
      await expect(f.main.acknowledge(f.i)).rejects.toThrow('canonical not acknowledged')
      expect(await readFile(path)).toEqual(bytes)
      const reserves = vi.mocked(f.quota.reserve).mock.calls
      expect(reserves.some(([, , input]) => input.kind === 'rsync-source' && input.byteSize === bytes.length * 2)).toBe(true)
      expect(reserves.some(([, , input]) => input.kind === 'rsync-receiver' && input.byteSize === bytes.length * 3)).toBe(true)
      f.publish(); await f.main.acknowledge(f.i)
      await expect(readFile(path)).rejects.toThrow()
      expect(vi.mocked(f.quota.release).mock.calls.some(([, kind]) => kind === 'rsync-source')).toBe(true)
      expect(vi.mocked(f.quota.release).mock.calls.some(([, kind]) => kind === 'rsync-receiver')).toBe(true)
    } finally { await f.dispose() }
  })
  it('never selects SSH from owner consent alone when original transfer grant is revoked', async () => {
    const f = await fixture()
    try { f.deny(); await expect(f.main.send(f.i, f.source)).rejects.toThrow('revoked'); expect(f.commands).toHaveLength(0) }
    finally { await f.dispose() }
  })
  it('keeps the verified producer copy after canonical adoption fails and retries the same intent', async () => {
    const f = await fixture()
    try {
      vi.spyOn(f.workerReceiver, 'append').mockRejectedValueOnce(new Error('canonical write interrupted'))
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('canonical write interrupted')
      const part = join(f.remoteRoot, `${f.i.transferId}.part`)
      expect(await readFile(part)).toEqual(bytes)
      expect(f.quota.release).not.toHaveBeenCalled()
      const receipt = await f.main.send(f.i, f.source)
      expect(receipt.intent).toEqual(f.i)
      expect(await f.workerReceiver.resolveVerifiedReceipt(f.i.transferId, transferContextForBinding(f.original))).toEqual(receipt)
      expect(await readFile(part)).toEqual(bytes)
      f.publish(); await f.main.acknowledge(f.i)
      await expect(readFile(part)).rejects.toThrow()
    } finally { await f.dispose() }
  })
  it('rejects missing shared quota before reading or writing source bytes', async () => {
    const f = await fixture()
    try {
      const backend = createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, accepted: f.accepted,
        ownership: f.mainOwnership, writers: f.writers, current: () => f.original, receiver: f.mainReceiver, selection: async () => f.selection })
      // Incoming authenticated source preparation does not require an SSH invocation.
      await expect(backend.handle({ kind: 'rsync-stage-v1', method: 'source-prepare', transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('immutable rsync source unavailable')
      const withSource = createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, accepted: f.accepted,
        ownership: f.mainOwnership, writers: f.writers, current: () => f.original, receiver: f.mainReceiver, resolveSource: async () => f.source })
      await expect(withSource.handle({ kind: 'rsync-stage-v1', method: 'source-prepare', transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('external staging quota unavailable')
      expect(f.source.read).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('rejects control paths, caller intent payloads, binary bytes and stale epochs', async () => {
    const f = await fixture()
    try {
      const request = { kind: 'rsync-stage-v1', method: 'receiver-prepare', transferId: f.i.transferId }
      const frame = { binding: f.original, signal: new AbortController().signal }
      await expect(f.worker.handle({ ...request, path: '/tmp/other' }, frame)).rejects.toThrow()
      await expect(f.worker.handle({ ...request, intent: f.i }, frame)).rejects.toThrow()
      await expect(f.worker.handle(request, { ...frame, bytes })).rejects.toThrow('byte payloads')
      await expect(f.worker.handle(request, { ...frame, binding: { ...f.original, connectionEpoch: randomUUID() } })).rejects.toThrow('Stale')
    } finally { await f.dispose() }
  })
  it('denies missing original source resolver rather than inferring native output paths', async () => {
    const f = await fixture('to-main')
    try {
      const worker = createRsyncProductionBackend({ side: 'worker', stagingRoot: f.remoteRoot, current: () => f.original,
        accepted: f.accepted, receiver: f.workerReceiver, quota: f.quota, ownership: f.workerOwnership, writers: f.writers })
      await expect(worker.handle({ kind: 'rsync-stage-v1', method: 'source-prepare', transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('immutable rsync source unavailable')
      expect(f.quota.reserve).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('denies worker-initiated SSH, arbitrary Main output and missing cleanup proof', async () => {
    const f = await fixture('to-main')
    try {
      await expect(f.worker.send(f.i)).rejects.toThrow('Main-selected')
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('cannot supply worker output')
      await expect(f.main.retireExpired({ ...f.i, expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toThrow('Stopped rsync writer proof unavailable')
      expect(f.commands).toHaveLength(0)
    } finally { await f.dispose() }
  })
  it('rechecks original authority between bounded immutable source reads', async () => {
    const f = await fixture()
    try {
      f.source.read.mockImplementationOnce(async (_intent, offset, length) => { f.deny(); return bytes.subarray(offset, offset + length) })
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('revoked original grant')
      expect(f.source.read).toHaveBeenCalledOnce()
      expect(f.commands.some(args => args.includes('--partial'))).toBe(false)
    } finally { await f.dispose() }
  })
  it('fails when explicit selection or current connection is absent', async () => {
    const f = await fixture()
    try {
      f.disconnect(); await expect(f.main.send(f.i, f.source)).rejects.toThrow('connection is unavailable')
      const noSelection = createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, current: () => f.original,
        accepted: f.accepted, receiver: f.mainReceiver, quota: f.quota, ownership: f.mainOwnership, writers: f.writers })
      await expect(noSelection.send(f.i, f.source)).rejects.toThrow('Main-selected')
    } finally { await f.dispose() }
  })
  it.each(['ownership', 'writers'] as const)('rejects missing %s production port before source IO', async field => {
    const f = await fixture()
    try {
      const input: Partial<RsyncProductionInput> = { side: 'main', stagingRoot: f.localRoot, current: () => f.original,
        accepted: f.accepted, receiver: f.mainReceiver, ownership: f.mainOwnership, writers: f.writers }
      delete input[field]
      expect(() => createRsyncProductionBackend(input as RsyncProductionInput)).toThrow('causal writer production ports unavailable')
      expect(f.source.read).not.toHaveBeenCalled(); expect(f.quota.reserve).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('captures the input and directory descriptors and reserves shared quota before immutable bytes', async () => {
    const f = await fixture()
    try {
      f.source.read.mockImplementationOnce(async (_intent, offset, length) => {
        const materializer = f.accesses.find(access => access.role === 'source-materializer')!
        expect(materializer.handles).toHaveLength(2)
        const stats = await Promise.all(materializer.handles.map(handle => handle.stat()))
        expect(stats[0]!.isDirectory()).toBe(true); expect(stats[1]!.isFile()).toBe(true)
        expect(stats[1]!.size).toBe(0)
        expect(await readdir(f.localRoot)).toContainEqual(expect.stringMatching(/\.input$/))
        expect(f.quota.reserve).toHaveBeenCalledWith(f.i, transferContextForBinding(f.original), { kind: 'rsync-source', byteSize: bytes.length * 2 })
        return bytes.subarray(offset, offset + length)
      })
      await f.main.send(f.i, f.source)
      const materializer = f.accesses.find(access => access.role === 'source-materializer')!
      expect(materializer.handles.every(handle => handle.fd === -1)).toBe(true)
      expect((await readdir(f.localRoot)).some(name => name.endsWith('.input'))).toBe(false)
      expect(f.mainStore).toHaveBeenCalledOnce(); expect(f.workerStore).toHaveBeenCalledOnce()
      expect(f.accesses.map(access => access.role)).toEqual(['source-materializer', 'snapshot', 'receiver'])
    } finally { await f.dispose() }
  })
  it('rejects ownership rooted on the other host before source IO', async () => {
    const f = await fixture()
    try {
      expect(() => createRsyncProductionBackend({ side: 'main', stagingRoot: f.localRoot, current: () => f.original,
        accepted: f.accepted, receiver: f.mainReceiver, ownership: f.workerOwnership, writers: f.writers })).toThrow('ownership differs')
      expect(f.source.read).not.toHaveBeenCalled(); expect(f.quota.reserve).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('uses only selected protected wrapper paths, even when the writer port returns other paths', async () => {
    const f = await fixture()
    try {
      const remote = vi.mocked(f.writers.remote).getMockImplementation()!
      vi.mocked(f.writers.remote).mockImplementationOnce(async (...args) => {
        const reference = await remote(...args)
        return { ...reference, nodeBinary: '/other/node', entryPoint: '/other/writer.mjs' }
      })
      await f.main.send(f.i, f.source)
      expect(f.execute.mock.calls[0]![0].args).toContainEqual(expect.stringContaining('--rsync-path=/usr/bin/systemd-run --user --scope --quiet --property=Delegate=yes --collect -- /protected/node /protected/rsync-writer.mjs '))
      expect(vi.mocked(f.writers.activate).mock.calls[0]![1]).toMatchObject({ nodeBinary: f.selection.nodeBinary, entryPoint: f.selection.entryPoint })
    } finally { await f.dispose() }
  })
  it.each(['nodeBinary', 'entryPoint'] as const)('rejects a changed protected %s before byte dispatch', async path => {
    const f = await fixture()
    try {
      f.source.read.mockImplementationOnce(async (_intent, offset, length) => {
        f.changeSelection({ ...f.selection, [path]: '/protected/replacement' })
        return bytes.subarray(offset, offset + length)
      })
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('owner selection changed')
      expect(f.execute).not.toHaveBeenCalled(); expect(f.quota.release).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it.each(['writer-prepare', 'writer-activate', 'writer-status', 'writer-stop'] as const)('requires the W07 handler for %s', async method => {
    const f = await fixture()
    try {
      await expect(f.worker.handle({ kind: 'rsync-stage-v1', method, transferId: f.i.transferId },
        { binding: f.original, signal: new AbortController().signal })).rejects.toThrow('installed W07 handler')
      expect(f.source.read).not.toHaveBeenCalled(); expect(f.quota.release).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
  it('retains pending producer IO and captured descriptors across a bounded stop until physical completion', async () => {
    const f = await fixture()
    let release!: () => void, started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { started = resolve })
    let sending: Promise<unknown> | undefined
    try {
      f.source.read.mockImplementationOnce(async (_intent, offset, length) => { started(); await pending; return bytes.subarray(offset, offset + length) })
      sending = f.main.send(f.i, f.source).catch(error => error)
      await reading
      const materializer = f.accesses.find(access => access.role === 'source-materializer')!
      const deadline = new AbortController()
      const stop = f.mainOwnership.stop(f.i, deadline.signal)
      deadline.abort(new Error('bounded producer stop'))
      await expect(stop).rejects.toThrow('stop remains unconfirmed')
      await expect(f.mainOwnership.quiescent(f.i, new AbortController().signal)).rejects.toThrow('active or unconfirmed')
      expect(materializer.handles.every(handle => handle.fd >= 0)).toBe(true)
      expect((await readdir(f.localRoot)).some(name => name.endsWith('.input'))).toBe(true)
      expect(f.quota.release).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled()
      release()
      expect(await sending).toBeInstanceOf(Error)
      await f.mainOwnership.stop(f.i, AbortSignal.timeout(5000))
      await f.mainOwnership.quiescent(f.i, AbortSignal.timeout(5000))
      expect(materializer.handles.every(handle => handle.fd === -1)).toBe(true)
      expect((await readdir(f.localRoot)).some(name => name.endsWith('.input'))).toBe(false)
      expect(f.quota.release).not.toHaveBeenCalled()
    } finally { release(); await sending; await f.dispose() }
  })
  it('prepares owners then runs executor and activation concurrently before both-host closure and adoption', async () => {
    const f = await fixture()
    let launched!: () => void, admit!: () => void
    const executing = new Promise<void>(resolve => { launched = resolve }), admitted = new Promise<void>(resolve => { admit = resolve })
    try {
      f.execute.mockImplementationOnce(async (command, signal) => { launched(); await admitted; return f.copy(command, signal) })
      vi.mocked(f.writers.activate).mockImplementationOnce(async () => { await executing; f.events.push('activate'); admit() })
      const append = f.workerReceiver.append.bind(f.workerReceiver)
      vi.spyOn(f.workerReceiver, 'append').mockImplementation(async (...args) => { f.events.push('adopt'); return append(...args) })
      const receipt = await f.main.send(f.i, f.source, AbortSignal.timeout(5000))
      expect(receipt.intent).toEqual(f.i)
      expect(f.events.slice(0, 6)).toEqual(['remote-prepare', 'local-prepare', 'execute', 'activate', 'local-closed', 'remote-closed'])
      expect(f.events.indexOf('adopt')).toBeGreaterThan(f.events.indexOf('remote-closed'))
    } finally { admit(); await f.dispose() }
  })
  it.each(['to-worker', 'to-main'] as const)('retains source and receiver holds for %s on unconfirmed closure', async direction => {
    const f = await fixture(direction)
    try {
      vi.mocked(f.writers.quiescent).mockRejectedValue(new Error('both-host closure unconfirmed'))
      vi.mocked(f.writers.stop).mockRejectedValue(new Error('both-host stop unconfirmed'))
      await expect(f.main.send(f.i, direction === 'to-worker' ? f.source : undefined)).rejects.toThrow('both-host stop unconfirmed')
      const sourceRoot = direction === 'to-worker' ? f.localRoot : f.remoteRoot
      const receiverRoot = direction === 'to-worker' ? f.remoteRoot : f.localRoot
      expect(await readFile(join(sourceRoot, `${f.i.transferId}.snapshot`))).toEqual(bytes)
      expect((await lstat(join(receiverRoot, `${f.i.transferId}.lock`))).isDirectory()).toBe(true)
      const snapshot = f.accesses.find(access => access.role === 'snapshot')!
      expect(snapshot.close).not.toHaveBeenCalled(); expect(snapshot.handles.every(handle => handle.fd >= 0)).toBe(true)
      expect(f.quota.release).not.toHaveBeenCalled()
      const receiver = direction === 'to-worker' ? f.workerReceiver : f.mainReceiver
      await expect(receiver.resolveVerifiedReceipt(f.i.transferId, transferContextForBinding(f.original))).rejects.toThrow()
    } finally { await f.dispose() }
  })
  it('interrupts and unlocks only after positive stop of both original writers, retaining quota', async () => {
    const f = await fixture()
    try {
      f.execute.mockRejectedValueOnce(new Error('fixture byte interruption'))
      await expect(f.main.send(f.i, f.source)).rejects.toThrow('fixture byte interruption')
      expect(f.writers.stop).toHaveBeenCalledOnce(); expect(f.writers.quiescent).toHaveBeenCalledOnce()
      await expect(lstat(join(f.remoteRoot, `${f.i.transferId}.lock`))).rejects.toThrow()
      expect(f.accesses.find(access => access.role === 'snapshot')!.close).toHaveBeenCalledOnce()
      expect(f.quota.release).not.toHaveBeenCalled()
    } finally { await f.dispose() }
  })
})
describe('F-30 production ownership availability', () => {
  async function compositionFixture(side: 'main' | 'worker') {
    const f = await fixture(), ownership = side === 'main' ? f.mainOwnership : f.workerOwnership
    const receiver = side === 'main' ? f.mainReceiver : f.workerReceiver
    const providers: ProductionRsyncProviders = {
      stagingRoot: side === 'main' ? f.localRoot : f.remoteRoot, accepted: f.accepted, receiver, ownership, writers: f.writers,
      resolveSource: async () => f.source,
      acknowledged: async () => { throw new Error('No publication acknowledgement in availability fixture') },
      quiescent: (intent, signal) => ownership.processesQuiescent(intent, signal, true),
      selection: async () => f.selection, peer: { capture: () => undefined },
    }
    return { ...f, providers, receiverStart: vi.spyOn(receiver, 'start'), reserve: vi.spyOn(receiver, 'reserve') }
  }
  describe.each(['main', 'worker'] as const)('%s discovery', side => {
    it.each(['ownership', 'writers'] as const)('is unavailable without %s before allocating canonical or staging state', async field => {
      const f = await compositionFixture(side)
      try {
        const providers: Partial<ProductionRsyncProviders> = { ...f.providers }
        delete providers[field]
        const mounted = createProductionRsyncComposition({ side, providers, current: () => f.original })
        expect(mounted.kind).toBe('unavailable'); expect(mounted.extensions).toEqual([])
        expect(mounted.missing).toContain(field === 'ownership' ? 'original writer ownership' : 'causal byte writer ports')
        expect(f.reserve).not.toHaveBeenCalled(); expect(f.receiverStart).not.toHaveBeenCalled()
        expect(f.source.read).not.toHaveBeenCalled()
      } finally { await f.dispose() }
    })
    it('rejects an ownership-shaped object before configuration or allocation', async () => {
      const f = await compositionFixture(side)
      try {
        const ownership = { store: f.providers.ownership.store.bind(f.providers.ownership),
          assertRoot: f.providers.ownership.assertRoot.bind(f.providers.ownership) } as RsyncWriterOwnership
        const mounted = createProductionRsyncComposition({ side, providers: { ...f.providers, ownership }, current: () => f.original })
        expect(mounted.kind).toBe('unavailable'); expect(mounted.extensions).toEqual([])
        expect(mounted.missing).toContain('original writer ownership')
        expect(f.reserve).not.toHaveBeenCalled(); expect(f.receiverStart).not.toHaveBeenCalled()
        expect(f.source.read).not.toHaveBeenCalled()
      } finally { await f.dispose() }
    })
    it.each(['local', 'remote', 'activate', 'quiescent', 'stop'] as const)('is unavailable without the %s writer method', async method => {
      const f = await compositionFixture(side)
      try {
        const writers: Partial<RsyncTransferWriters> = { ...f.writers }
        delete writers[method]
        const mounted = createProductionRsyncComposition({ side, providers: { ...f.providers, writers: writers as RsyncTransferWriters },
          current: () => f.original })
        expect(mounted.kind).toBe('unavailable'); expect(mounted.extensions).toEqual([])
        expect(mounted.missing).toContain('causal byte writer ports')
        expect(f.reserve).not.toHaveBeenCalled(); expect(f.receiverStart).not.toHaveBeenCalled()
      } finally { await f.dispose() }
    })
  })
})
describe('setup-bound selection', () => {
  it.each(['revoked', 'endpoint', 'host-key', 'expired', 'identity', 'port', 'node', 'entrypoint'] as const)('rejects %s before transport', async defect => {
    const f = await fixture()
    try {
      const s = structuredClone(f.selection)
      if (defect === 'revoked') s.check.consent!.allowOwnerCommands = false
      if (defect === 'endpoint') s.endpoint.host = 'other.example.com'
      if (defect === 'host-key') s.check.probe!.hostKeyFingerprint = `SHA256:${'d'.repeat(43)}`
      if (defect === 'expired') s.check.checkedAt = new Date(Date.now() - 61000).toISOString()
      if (defect === 'identity') s.check.registration.authorizationRevision++
      if (defect === 'port') s.check.consent!.endpoint.port = 2222
      if (defect === 'node') s.nodeBinary = '/tmp/$(id)'
      if (defect === 'entrypoint') s.entryPoint = '/tmp/../other'
      expect(() => assertRsyncBackendSelection(s, f.i)).toThrow(defect === 'node' || defect === 'entrypoint' ? 'selected writer path' : 'selection')
    } finally { await f.dispose() }
  })
})
