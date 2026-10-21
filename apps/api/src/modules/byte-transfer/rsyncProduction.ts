import { constants } from 'node:fs'
import { lstat, open, unlink } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { join, parse, sep } from 'node:path'
import { BYTE_TRANSFER_POLICY as POLICY, TransferIntentSchema, VerifiedTransferReceiptSchema,
  RsyncControlRequestSchema, RsyncControlResponseSchema, type RsyncControlRequest,
  type TransferIntent, type TransferContext, type ByteTransferPort, type VerifiedTransferReceipt } from '@foreman-code/contracts/byte-transfer'
import { TrustedConnectionCheckSchema, type TrustedConnectionCheck } from '@foreman-code/contracts/trusted-device-connection'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionContext } from '../devices/deviceApplicationChannel.js'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { SourcePreparationClosure, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { authenticatedTransferAuthority, transferContextForBinding, type AcceptedTransferAuthority } from './carrier.js'
import type { ImmutableTransferSource } from './sender.js'
import { RsyncPrivateStore } from './rsyncStore.js'
import type { RsyncWriterOwnership } from './rsyncWriterOwnership.js'
import { importRsyncStagedBytes } from './rsyncAdapter.js'
import { RsyncStagingTransport, validateRsyncEndpoint, type RsyncEndpoint, type RsyncExecutor,
  type RsyncSnapshot, type RsyncReceiverLease, type RsyncStagedBytes, type RsyncTransferWriters } from './rsync.js'

export type RsyncQuotaKind = 'rsync-source' | 'rsync-receiver'
/** Implemented by the SAME durable byte-transfer allocation supervisor as the canonical receiver.
 * No independent quota counter: include canonical bytes, snapshots, transient source files and parts. */
export interface RsyncExternalStagingQuota {
  reserve(intent: TransferIntent, context: TransferContext, input: { kind: RsyncQuotaKind; byteSize: number }): Promise<void>
  release(intent: TransferIntent, kind: RsyncQuotaKind): Promise<void>
  hasReservation(intent: TransferIntent, kind: RsyncQuotaKind): Promise<boolean>
  retire(id: string): Promise<void>
  inventory(): Promise<TransferIntent[]>
}
export interface RsyncBackendSelection {
  backend: 'rsync'
  check: TrustedConnectionCheck
  endpoint: RsyncEndpoint
  /** Protected installed remote wrapper paths; never accepted through control RPC. */
  nodeBinary: string
  entryPoint: string
  revalidate?: (signal: AbortSignal) => Promise<void>
}
export type { RsyncControlRequest } from '@foreman-code/contracts/byte-transfer'
export interface RsyncControlChannel {
  /** Capture rsync-stage-v1 on the exact existing authenticated W07 connection. No new socket/supervisor. */
  capture(): { binding: Readonly<DeviceSessionBinding>; request(payload: RsyncControlRequest,
    options: { signal: AbortSignal; timeoutMs?: number }): Promise<DeviceApplicationResult> } | undefined
}
export interface RsyncProductionInput {
  side: 'main' | 'worker'
  /** Protected installed root. Never supplied by an RPC/transfer declaration. Must already exist privately. */
  stagingRoot: string
  current(deviceId: string): Readonly<DeviceSessionBinding> | undefined
  accepted: AcceptedTransferAuthority
  receiver: ByteTransferPort
  /** SAME root/binding registry as the existing writer and shutdown/expiry supervisor. */
  ownership: RsyncWriterOwnership
  /** Captures actual local/remote owners; closure/stop must join BOTH original hosts. */
  writers: RsyncTransferWriters
  quota?: RsyncExternalStagingQuota
  /** Existing authorized immutable package/sealed output reader. No provider/native output path guessing. */
  resolveSource?(intent: TransferIntent, signal: AbortSignal): Promise<ImmutableTransferSource>
  /** Genuine publication/adoption acknowledgement from existing canonical/operation authority.
   * Caller-supplied receipt or rsync exit must never satisfy this hook. */
  acknowledged?(intent: TransferIntent, context: TransferContext): Promise<void>
  /** Main-local protected configuration + fresh persisted owner consent/current probe. Worker never SSHes Main. */
  selection?(intent: TransferIntent, signal: AbortSignal): Promise<RsyncBackendSelection>
  peer?: RsyncControlChannel
  /** Existing supervisor validates exact persisted intent/original expiry and proves byte writers stopped.
   * This trusted local hook must reject caller-altered pins; missing proof fails closed. */
  quiescent?(intent: TransferIntent, signal: AbortSignal): Promise<void>
  executor?: RsyncExecutor
}
const isSource = (side: RsyncProductionInput['side'], i: TransferIntent) => (side === 'main') === (i.direction === 'to-worker')
const metadata = (i: TransferIntent) => ({ intent: i, sha256: i.sha256, byteSize: i.byteSize })
const sameReceipt = (raw: unknown, intent: TransferIntent) => {
  const receipt = VerifiedTransferReceiptSchema.parse(raw)
  if (!isDeepStrictEqual(receipt.intent, intent) || receipt.transferId !== intent.transferId
    || receipt.sha256 !== intent.sha256 || receipt.byteSize !== intent.byteSize) throw new Error('Rsync verified receipt conflicts with accepted intent')
  return receipt
}
/** Setup consent selects SSH ownership; accepted transfer authority still independently controls bytes. */
export function assertRsyncBackendSelection(raw: RsyncBackendSelection, intent: TransferIntent): RsyncEndpoint {
  if (raw.backend !== 'rsync') throw new Error('Rsync backend is not explicitly selected')
  const check = TrustedConnectionCheckSchema.parse(raw.check), { registration: r, consent: c, probe: p } = check
  const endpoint = validateRsyncEndpoint(raw.endpoint)
  for (const path of [raw.nodeBinary, raw.entryPoint]) {
    if (!/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path)
      || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Unsafe rsync selected writer path')
  }
  if (check.state !== 'ready' || r.status !== 'paired' || !c?.allowOwnerCommands || !p || p.state !== 'connected'
    || Date.now() - Date.parse(check.checkedAt) > 60000 || Date.parse(check.checkedAt) > Date.now() + 1000
    || c.mainId !== r.mainId || c.deviceId !== r.deviceId || c.workerInstallationId !== r.workerInstallationId
    || c.keyRevision !== r.keyRevision || c.authorizationRevision !== r.authorizationRevision || c.publicKeyFingerprint !== r.publicKeyFingerprint
    || intent.mainId !== r.mainId || intent.deviceId !== r.deviceId || intent.workerInstallationId !== r.workerInstallationId
    || intent.keyRevision !== r.keyRevision || intent.authorizationRevision !== r.authorizationRevision
    || p.hostKeyFingerprint !== c.hostKeyFingerprint || p.osUser !== c.endpoint.osUser
    || c.endpoint.port !== 22 || c.endpoint.host !== endpoint.host || c.endpoint.osUser !== endpoint.user) {
    throw new Error('Rsync trusted selection is unavailable or changed')
  }
  return endpoint
}
async function privateDirectory(root: string) {
  if (!root.startsWith('/') || root.split('/').some(x => x === '.' || x === '..')) throw new Error('Unsafe rsync production root')
  let path = parse(root).root
  for (const part of root.slice(path.length).split(sep).filter(Boolean)) {
    path = join(path, part)
    const stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
      || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) throw new Error('Unsafe rsync production ancestor')
  }
  const stat = await lstat(root)
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Rsync production root must be private')
  const directory = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY)
  const pinned = await directory.stat()
  if (stat.ino !== pinned.ino || stat.dev !== pinned.dev) { await directory.close(); throw new Error('Rsync production root changed') }
  return directory
}

/** Worker-safe leaf. HRT mounts handle into the approved metadata namespace; Root owns shared
 * discovery/schema composition and actual source/acknowledgement/quota producers. No listener or loop. */
export function createRsyncProductionBackend(input: RsyncProductionInput) {
  if (!input.ownership || !input.writers) throw new Error('Rsync causal writer production ports unavailable')
  input.ownership.assertRoot(input.stagingRoot)
  const authority = authenticatedTransferAuthority(input.current, input.accepted)
  const sources = new Map<string, RsyncSnapshot>(), leases = new Map<string, RsyncReceiverLease>()
  const verified = new Map<string, { bytes: RsyncStagedBytes; receipt?: VerifiedTransferReceipt }>()
  const busy = new Set<string>()
  const current = async (i: TransferIntent) => {
    const binding = input.current(i.deviceId)
    if (!binding) throw new Error('Rsync authenticated connection is unavailable')
    return transferContextForBinding(binding)
  }
  const authorize = async (i: TransferIntent, operation: Parameters<typeof authority.authorize>[2], signal: AbortSignal) => {
    signal.throwIfAborted()
    if (Date.now() >= Date.parse(i.expiresAt)) throw new Error('Rsync transfer expired')
    await authority.authorize(i, await current(i), operation)
    signal.throwIfAborted()
  }
  const quota = (kind: RsyncQuotaKind) => ({
    reserve: async (i: TransferIntent) => {
      if (!input.quota) throw new Error('Shared external staging quota unavailable')
      await input.quota.reserve(i, await current(i), { kind, byteSize: i.byteSize * (kind === 'rsync-source' ? 2 : 3) })
      return () => input.quota!.release(i, kind)
    },
    retire: async (i: TransferIntent) => {
      if (!input.quota) throw new Error('Shared external staging quota unavailable')
      await input.quota.release(i, kind)
    },
  })
  const storeOwnership = input.ownership.store()
  const sourceStore = new RsyncPrivateStore(input.stagingRoot, quota('rsync-source'), storeOwnership)
  const receiverStore = new RsyncPrivateStore(input.stagingRoot, quota('rsync-receiver'), storeOwnership)
  const capacity = () => {
    if (sources.size + leases.size + verified.size >= POLICY.maxActiveGlobal) throw new Error('Rsync staging handle capacity exceeded')
  }
  const prepareSource = async (i: TransferIntent, signal: AbortSignal, supplied?: ImmutableTransferSource) => {
    if (!isSource(input.side, i)) throw new Error('Wrong rsync source host')
    await authorize(i, 'read', signal)
    if (sources.has(i.transferId)) return sources.get(i.transferId)!
    capacity()
    const binding = input.current(i.deviceId)
    if (!binding) throw new Error('Rsync authenticated connection is unavailable')
    const access = input.ownership.access(i, binding, 'source-materializer')
    try {
      const snapshot = await access.run(async ownerSignal => {
        const bounded = AbortSignal.any([signal, ownerSignal])
        const reader = supplied ?? await input.resolveSource?.(i, bounded)
        if (!reader) throw new Error('Original immutable rsync source unavailable')
        // Capture reservation, producer IO and descriptors before reading or writing any bytes.
        await quota('rsync-source').reserve(i)
        bounded.throwIfAborted()
        const directory = await privateDirectory(input.stagingRoot)
        access.attach(directory)
        const temporary = `/proc/self/fd/${directory.fd}/${i.transferId}.${randomUUID()}.input`
        try {
          const handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          access.attach(handle)
          // Sealed Worker outputs are local reads, outside the metadata channel's frame limit.
          const chunkBytes = i.direction === 'to-main' ? POLICY.maxChunkBytes : i.chunkBytes
          for (let offset = 0; offset < i.byteSize;) {
            await authorize(i, 'read', bounded)
            const length = Math.min(chunkBytes, i.byteSize - offset), bytes = await reader.read(i, offset, length, bounded)
            if (bytes.byteLength !== length) throw new Error('Immutable rsync source extent changed')
            let written = 0
            while (written < length) {
              bounded.throwIfAborted()
              const result = await handle.write(bytes, written, length - written, offset + written)
              if (!result.bytesWritten) throw new Error('Rsync input write stalled')
              written += result.bytesWritten
            }
            offset += length
          }
          await handle.sync()
          const frozen = await sourceStore.freeze(i, handle, bounded)
          try { await authorize(i, 'read', bounded) }
          catch (error) { await frozen.close(); throw error }
          return frozen
        } finally {
          await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
          await directory.sync()
        }
      })
      sources.set(i.transferId, snapshot)
      return snapshot
    } finally {
      await access.close()
      // Snapshot/reservation persist on failure for the existing stopped-owner/expiry supervisor.
    }
  }
  const prepareReceiver = async (i: TransferIntent, signal: AbortSignal) => {
    if (isSource(input.side, i)) throw new Error('Wrong rsync receiver host')
    await authorize(i, 'start', signal)
    if (verified.has(i.transferId) || leases.has(i.transferId)) return
    capacity()
    // Existing receiver admission reserves canonical bytes BEFORE rsync writes its additional private copy.
    await quota('rsync-receiver').reserve(i)
    await input.receiver.start(i, await current(i))
    const lease = await receiverStore.receive(i, signal)
    try { await authorize(i, 'start', signal) }
    catch (error) { await lease.interrupt(); throw error }
    leases.set(i.transferId, lease)
  }
  const verifyReceiver = async (i: TransferIntent, signal: AbortSignal) => {
    await authorize(i, 'finish', signal)
    const previous = verified.get(i.transferId)
    if (previous) {
      const receipt = previous.receipt
        ? await input.receiver.finish(i.transferId, await current(i))
        : await importRsyncStagedBytes(previous.bytes, input.receiver, () => current(i), signal)
      previous.receipt = sameReceipt(receipt, i)
      await authorize(i, 'finish', signal)
      return previous.receipt
    }
    const lease = leases.get(i.transferId)
    if (!lease) throw new Error('Rsync receiver was not prepared')
    const bytes = await lease.verify(signal)
    leases.delete(i.transferId)
    try {
      const receipt = sameReceipt(await importRsyncStagedBytes(bytes, input.receiver, () => current(i), signal), i)
      await authorize(i, 'finish', signal)
      verified.set(i.transferId, { bytes, receipt }); return receipt
    } catch (error) {
      // Preserve the verified-only producer copy if adoption fails. Existing supervisor reconciles it.
      verified.set(i.transferId, { bytes })
      throw error
    }
  }
  const acknowledge = async (i: TransferIntent, signal: AbortSignal) => {
    await authorize(i, 'read', signal)
    if (!input.acknowledged) throw new Error('Canonical rsync acknowledgement unavailable')
    await input.acknowledged(i, await current(i)); await authorize(i, 'read', signal)
    await sources.get(i.transferId)?.close(); sources.delete(i.transferId)
    const value = verified.get(i.transferId)
    if (value) { await value.bytes.close(); verified.delete(i.transferId) }
    if (leases.has(i.transferId)) throw new Error('Cannot acknowledge an active rsync writer')
    await (isSource(input.side, i) ? sourceStore : receiverStore).retire(i)
  }
  const locked = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    if (busy.has(id)) throw new Error('Rsync transfer operation busy')
    busy.add(id)
    try { return await action() } finally { busy.delete(id) }
  }
  const handle = async (raw: unknown, frame: DeviceExtensionContext): Promise<DeviceApplicationResult> => {
    const request = RsyncControlRequestSchema.parse(raw)
    if (frame.bytes?.byteLength) throw new Error('Rsync control cannot carry byte payloads')
    if (!isDeepStrictEqual(input.current(frame.binding.deviceId), frame.binding)) throw new Error('Stale rsync control binding')
    const i = TransferIntentSchema.parse(await input.accepted.intent(request.transferId, frame.binding))
    const assertFrame = () => {
      if (!isDeepStrictEqual(input.current(frame.binding.deviceId), frame.binding)) throw new Error('Rsync control binding changed')
      frame.signal.throwIfAborted()
    }
    assertFrame()
    if (i.transferId !== request.transferId) throw new Error('Rsync accepted transfer differs')
    return locked(i.transferId, async () => {
      await authorize(i, request.method === 'receiver-prepare' ? 'start' : 'read', frame.signal)
      let receipt: VerifiedTransferReceipt | undefined
      if (request.method === 'source-prepare') await prepareSource(i, frame.signal)
      else if (request.method === 'source-verify') {
        const source = sources.get(i.transferId)
        if (!source) throw new Error('Rsync source was not prepared')
        await source.verify(frame.signal)
      } else if (request.method === 'source-close') { await sources.get(i.transferId)?.close(); sources.delete(i.transferId) }
      else if (request.method === 'receiver-prepare') await prepareReceiver(i, frame.signal)
      else if (request.method === 'receiver-verify') receipt = await verifyReceiver(i, frame.signal)
      else if (request.method === 'receiver-interrupt') { await leases.get(i.transferId)?.interrupt(); leases.delete(i.transferId) }
      else if (request.method === 'acknowledge') await acknowledge(i, frame.signal)
      else throw new Error('Rsync writer control requires the installed W07 handler')
      await authorize(i, 'read', frame.signal); assertFrame()
      return { payload: { kind: 'rsync-stage-v1', method: request.method, transferId: i.transferId, ...(receipt ? { receipt } : {}) } }
    })
  }
  const remote = async (i: TransferIntent, method: RsyncControlRequest['method'], signal: AbortSignal) => {
    if (!input.peer) throw new Error('Authenticated rsync control channel unavailable')
    const captured = input.peer.capture()
    if (!captured || !isDeepStrictEqual(transferContextForBinding(captured.binding), await current(i))) throw new Error('Rsync control epoch differs')
    const byteOperation = method === 'source-prepare' || method === 'receiver-verify'
    const timeoutMs = Math.min(POLICY.maxIdleMs, Date.parse(i.expiresAt) - Date.now())
    if (timeoutMs <= 0) throw new Error('Original rsync transfer expired')
    const result = await captured.request({ kind: 'rsync-stage-v1', method, transferId: i.transferId },
      { signal, ...(byteOperation ? { timeoutMs } : {}) })
    if (!isDeepStrictEqual(input.current(i.deviceId), captured.binding)) throw new Error('Rsync control response epoch changed')
    if (result.bytes?.byteLength) throw new Error('Unexpected rsync control response bytes')
    const payload = RsyncControlResponseSchema.parse(result.payload)
    if (payload.method !== method || payload.transferId !== i.transferId) throw new Error('Rsync control response identity differs')
    await authorize(i, 'read', signal)
    return payload.method === 'receiver-verify' ? payload.receipt : undefined
  }
  const send = async (raw: TransferIntent, source?: ImmutableTransferSource, signal = AbortSignal.timeout(POLICY.maxIdleMs)) => {
    if (input.side !== 'main' || !input.selection) throw new Error('Main-selected rsync backend unavailable')
    const i = TransferIntentSchema.parse(raw)
    if (source && i.direction !== 'to-worker') throw new Error('Main cannot supply worker output bytes')
    return locked(i.transferId, async () => {
      await authorize(i, 'start', signal)
      const selection = await input.selection!(i, signal), endpoint = assertRsyncBackendSelection(selection, i)
      const { nodeBinary, entryPoint } = selection
      if (endpoint.localRoot !== input.stagingRoot) throw new Error('Rsync selected root differs from installed staging root')
      let receipt: VerifiedTransferReceipt | undefined
      const selectedAuthority = { authorize: async (...args: Parameters<typeof authority.authorize>) => {
        if (selection.revalidate) {
          await selection.revalidate(signal)
          await authority.authorize(...args)
          return
        }
        const next = await input.selection!(i, signal)
        assertRsyncBackendSelection(next, i)
        if (!isDeepStrictEqual(next.check.consent, selection.check.consent) || !isDeepStrictEqual(next.endpoint, endpoint)
          || next.nodeBinary !== nodeBinary || next.entryPoint !== entryPoint) throw new Error('Rsync owner selection changed')
        await authority.authorize(...args)
      } }
      const transport = new RsyncStagingTransport(endpoint, selectedAuthority, {
        writers: {
          local: (...args) => input.writers.local(...args),
          remote: async (...args) => {
            const reference = await input.writers.remote(...args)
            return { ...reference, nodeBinary, entryPoint }
          },
          activate: (...args) => input.writers.activate(...args),
          quiescent: (...args) => input.writers.quiescent(...args),
          stop: (...args) => input.writers.stop(...args),
        },
        source: async (_intent, path, bounded) => {
          const expected = join(i.direction === 'to-worker' ? endpoint.localRoot : endpoint.remoteRoot, `${i.transferId}.snapshot`)
          if (path !== expected) throw new Error('Rsync source path differs')
          if (i.direction === 'to-worker') {
            const own = await prepareSource(i, bounded, source)
            return { verify: check => own.verify(check), close: async () => { await own.close(); sources.delete(i.transferId) } }
          }
          await remote(i, 'source-prepare', bounded)
          return { verify: async check => { await remote(i, 'source-verify', check) }, close: async () => { await remote(i, 'source-close', signal) } }
        },
        receiver: async (_intent, path, bounded) => {
          const expected = join(i.direction === 'to-worker' ? endpoint.remoteRoot : endpoint.localRoot, `${i.transferId}.part`)
          if (path !== expected) throw new Error('Rsync destination path differs')
          if (i.direction === 'to-worker') await remote(i, 'receiver-prepare', bounded)
          else await prepareReceiver(i, bounded)
          return { interrupt: async () => {
            if (i.direction === 'to-worker') await remote(i, 'receiver-interrupt', AbortSignal.timeout(5000))
            else { await leases.get(i.transferId)?.interrupt(); leases.delete(i.transferId) }
          }, verify: async check => {
            receipt = i.direction === 'to-worker' ? sameReceipt(await remote(i, 'receiver-verify', check), i) : await verifyReceiver(i, check)
            return { ...metadata(i), read: async () => { throw new Error('Use the actual canonical receiver reader') }, close: async () => {
              throw new Error('Canonical acknowledgement is required to release rsync staging')
            } }
          } }
        },
      }, input.executor)
      await transport.stage(i, () => current(i), signal)
      if (!receipt) throw new Error('Rsync canonical byte receipt unavailable')
      return sameReceipt(receipt, i)
    })
  }
  const retireTransfer = async (intent: TransferIntent, signal: AbortSignal) => {
    await locked(intent.transferId, async () => {
      const owned = input.ownership.inventory().find(value => value.transferId === intent.transferId)
      if (owned) {
        if (!isDeepStrictEqual(owned, intent)) throw new Error('Retained transfer ownership changed')
        await input.ownership.stopProcesses(intent, signal)
        await sources.get(intent.transferId)?.close()
        sources.delete(intent.transferId)
        await leases.get(intent.transferId)?.interrupt()
        leases.delete(intent.transferId)
        await verified.get(intent.transferId)?.bytes.close()
        verified.delete(intent.transferId)
        await input.ownership.quiescent(intent, signal)
      }
      if (!input.quota) throw new Error('Shared external staging quota unavailable')
      const source = isSource(input.side, intent)
      const kind = source ? 'rsync-source' : 'rsync-receiver'
      if (await input.quota.hasReservation(intent, kind)) {
        if (!owned) throw new Error('Original external staging owner is unavailable')
        await (source ? sourceStore : receiverStore).retire(intent, 'execution-closed')
      }
      const canonical = (await input.quota.inventory()).find(value => value.transferId === intent.transferId)
      if (canonical) {
        if (!isDeepStrictEqual(canonical, intent)) throw new Error('Retained canonical transfer changed')
        await input.quota.retire(intent.transferId)
      }
    })
  }
  const retireMaterialization = async (record: SourceMaterializationRecord, signal: AbortSignal) => {
    if (!input.quota) throw new Error('Shared external staging quota unavailable')
    const receipt = record.receipt
    const expected = { mainId: receipt.binding.mainId, deviceId: receipt.binding.deviceId,
      workerInstallationId: receipt.binding.workerInstallationId, keyRevision: receipt.keyRevision,
      authorizationRevision: receipt.authorizationRevision, rootId: receipt.binding.rootId,
      rootBindingRevision: receipt.binding.bindingRevision }
    const intents = new Map([...input.ownership.inventory(), ...await input.quota.inventory()]
      .map(intent => [intent.transferId, intent]))
    for (const intent of intents.values()) {
      if (intent.executionId !== receipt.executionId || intent.attemptId !== receipt.attemptId) continue
      if (!Object.entries(expected).every(([key, value]) => Reflect.get(intent, key) === value)
        || ![record.sourceBindingHash, record.finalDispatchBindingHash].includes(intent.placementHash)) {
        throw new Error('Closed materialization does not own this transfer')
      }
      await retireTransfer(intent, signal)
    }
  }
  const retirePreparation = async (closure: SourcePreparationClosure, signal: AbortSignal) => {
    for (const intent of input.ownership.inventory().filter(value => value.operationId === closure.operationId)) {
      const matchingOwner = intent.byteClass === 'source' && intent.direction === 'to-worker'
        && intent.rootBindingRevision === closure.bindingRevision
        && ['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision',
          'executionId', 'attemptId', 'rootId'].every(key => Reflect.get(intent, key) === Reflect.get(closure, key))
      if (!matchingOwner || !closure.admissionClosed || !closure.childrenClosed || !closure.claimReleased) {
        throw new Error('Source preparation closure does not own this rsync transfer')
      }
      await retireTransfer(intent, signal)
    }
  }
  return { handle, send, retirePreparation, retireMaterialization, sender: (source: ImmutableTransferSource) => ({ send: (intent: TransferIntent, signal?: AbortSignal) => send(intent, source, signal) }), retireExpired: async (raw: TransferIntent, signal = AbortSignal.timeout(5000)) => {
    const i = TransferIntentSchema.parse(raw)
    if (Date.now() < Date.parse(i.expiresAt)) throw new Error('Rsync cleanup requires original expiry')
    if (!input.quiescent) throw new Error('Stopped rsync writer proof unavailable')
    await input.quiescent(i, signal)
    signal.throwIfAborted()
    await retireTransfer(i, signal)
  }, acknowledge: async (raw: TransferIntent, signal = AbortSignal.timeout(5000)) => {
    const i = TransferIntentSchema.parse(raw)
    if (input.side !== 'main') throw new Error('Only Main coordinates canonical rsync acknowledgment')
    return locked(i.transferId, async () => { await acknowledge(i, signal); await remote(i, 'acknowledge', signal) })
  } }
}
