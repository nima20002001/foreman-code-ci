import { RSYNC_STAGE_EXTENSION, RsyncControlResponseSchema, type TransferIntent, type RsyncControlRequest } from '@foreman-code/contracts/byte-transfer'
import { isDeepStrictEqual } from 'node:util'
import { lstatSync, realpathSync } from 'node:fs'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { DomainError } from '../errors.js'
import { assertRsyncBackendSelection, createRsyncProductionBackend, type RsyncProductionInput } from './rsyncProduction.js'
import { ResumableByteTransferService } from './service.js'
import { RsyncWriterOwnership, rsyncArgumentDigest, type RsyncOwnerReference } from './rsyncWriterOwnership.js'
import type { RsyncTransferWriters } from './rsync.js'
import { authenticatedTransferAuthority, transferContextForBinding } from './carrier.js'
import { createWorkerRsyncWriterControl } from '../devices/rsyncWriterControl.js'

/** Protected installation ports, never request fields. The canonical service is
 * also the durable quota owner; source/output authority must select its exact domain. */
export type ProductionRsyncProviders = Omit<RsyncProductionInput,
  'side' | 'current' | 'receiver' | 'quota' | 'resolveSource' | 'acknowledged' | 'quiescent'> & {
  receiver: ResumableByteTransferService
  resolveSource: NonNullable<RsyncProductionInput['resolveSource']>
  acknowledged: NonNullable<RsyncProductionInput['acknowledged']>
  quiescent: NonNullable<RsyncProductionInput['quiescent']>
}
export type ProductionMainRsyncProviders = ProductionRsyncProviders & {
  selection: NonNullable<RsyncProductionInput['selection']>
  peer: NonNullable<RsyncProductionInput['peer']>
}

/** Availability means complete trusted ports, not an installed/SSH qualification.
 * No default proof, new connection, process launch or cleanup loop is created here. */
export function createProductionRsyncComposition(input: {
  side: 'main' | 'worker'
  providers?: Partial<ProductionRsyncProviders> | undefined
  current(deviceId: string): Readonly<DeviceSessionBinding> | undefined
}) {
  const p = input.providers, missing: string[] = []
  if (!p?.stagingRoot) missing.push('protected stagingRoot')
  if (typeof p?.accepted?.intent !== 'function' || typeof p.accepted.authorize !== 'function') missing.push('accepted transfer authority')
  if (!(p?.receiver instanceof ResumableByteTransferService)) missing.push('canonical receiver/shared quota')
  if (typeof p?.resolveSource !== 'function') missing.push('original immutable source reader')
  if (typeof p?.acknowledged !== 'function') missing.push('canonical acknowledgement')
  if (typeof p?.quiescent !== 'function') missing.push('stopped-writer proof')
  if (!(p?.ownership instanceof RsyncWriterOwnership)) missing.push('original writer ownership')
  if (['local', 'remote', 'activate', 'quiescent', 'stop'].some(method => typeof Reflect.get(p?.writers ?? {}, method) !== 'function')) missing.push('causal byte writer ports')
  if (input.side === 'main') {
    if (typeof p?.selection !== 'function') missing.push('explicit trusted selection')
    if (typeof p?.peer?.capture !== 'function') missing.push('existing W07 rsync control channel')
  }
  if (missing.length) return { kind: 'unavailable' as const, missing, extensions: [] as DeviceExtensionRegistration[],
    sender: () => { throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', `Selected rsync is missing: ${missing.join(', ')}.`, 409) } }
  const providers = p as ProductionRsyncProviders
  const backend = createRsyncProductionBackend({ ...providers, side: input.side, current: input.current,
    receiver: providers.receiver, quota: providers.receiver })
  const extension: DeviceExtensionRegistration = { ...RSYNC_STAGE_EXTENSION, role: input.side === 'main' ? 'client' : 'server',
    ...(input.side === 'worker' ? { handle: backend.handle } : {}) }
  return { kind: 'configured' as const, missing, extensions: [extension], backend, sender: backend.sender }
}

/** Installer ports omit runtime owners: the common mount creates exactly one
 * registry with the real current binding and shares it with the store/control. */
export type InstalledRsyncProviders = Omit<ProductionRsyncProviders, 'ownership' | 'writers'> & {
  binary?: { executable: string; sha256: string }
}
export type InstalledMainRsyncProviders = InstalledRsyncProviders & Pick<ProductionMainRsyncProviders, 'selection' | 'peer'>
export function createInstalledRsyncComposition(input: {
  side: 'main' | 'worker'; providers?: InstalledRsyncProviders | undefined
  current(deviceId: string): Readonly<DeviceSessionBinding> | undefined
}) {
  const p = input.providers
  if (!p || input.side === 'worker' && !p.binary) {
    const partial: Partial<ProductionRsyncProviders> | undefined = p ? { ...p } : undefined
    if (partial) { delete partial.ownership; delete partial.writers }
    const absent = createProductionRsyncComposition({ ...input, providers: partial })
    if (absent.kind !== 'unavailable') throw new Error('Unowned rsync installation was mounted')
    if (p && input.side === 'worker') absent.missing.push('protected worker rsync executable')
    return absent
  }
  let present = false
  try { const root = lstatSync(p.stagingRoot); present = root.isDirectory() && !root.isSymbolicLink() && realpathSync(p.stagingRoot) === p.stagingRoot }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!present) return { kind: 'unavailable' as const, missing: ['protected installed staging root'], extensions: [] as DeviceExtensionRegistration[],
    sender: () => { throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The original installed rsync staging root is unavailable.', 409) } }
  const ownership = new RsyncWriterOwnership(p.stagingRoot, input.current)
  const authority = authenticatedTransferAuthority(input.current, p.accepted)
  const references = new Map<string, RsyncOwnerReference>()
  const closedReferences = new Map<string, RsyncOwnerReference>()
  const selections = new Map<string, Awaited<ReturnType<NonNullable<RsyncProductionInput['selection']>>>>()
  let closing = false
  const assertAdmission = (signal: AbortSignal) => {
    signal.throwIfAborted()
    if (closing) throw new Error('Installed rsync admission closed')
  }
  const selection = async (intent: TransferIntent, signal: AbortSignal) => {
    const current = await p.selection?.(intent, signal)
    if (!current) throw new Error('Original protected rsync selection unavailable')
    assertRsyncBackendSelection(current, intent)
    const original = selections.get(intent.transferId)
    if (original && (!isDeepStrictEqual(original.endpoint, current.endpoint) || !isDeepStrictEqual(original.check.consent, current.check.consent)
      || original.nodeBinary !== current.nodeBinary || original.entryPoint !== current.entryPoint)) throw new Error('Original protected rsync selection changed')
    if (!original) selections.set(intent.transferId, {
      backend: current.backend,
      endpoint: structuredClone(current.endpoint),
      check: structuredClone(current.check),
      nodeBinary: current.nodeBinary,
      entryPoint: current.entryPoint,
    })
    return current
  }
  const remote = async (intent: TransferIntent, method: RsyncControlRequest['method'], signal: AbortSignal) => {
    signal.throwIfAborted()
    if (input.side !== 'main') throw new Error('Only Main coordinates remote rsync writers')
    const captured = p.peer?.capture()
    if (!captured || !isDeepStrictEqual(input.current(intent.deviceId), captured.binding)) throw new Error('Original rsync writer channel unavailable')
    const operation = method === 'writer-stop' ? 'cancel' : method === 'writer-status' ? 'read' : 'start'
    await authority.authorize(intent, transferContextForBinding(captured.binding), operation)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(input.current(intent.deviceId), captured.binding)) throw new Error('Original rsync writer channel changed')
    const reply = await captured.request({ kind: 'rsync-stage-v1', method, transferId: intent.transferId }, { signal })
    if (reply.bytes !== undefined || !isDeepStrictEqual(input.current(intent.deviceId), captured.binding)) throw new Error('Original rsync writer response changed')
    const response = RsyncControlResponseSchema.parse(reply.payload)
    if (response.method !== method || response.transferId !== intent.transferId) throw new Error('Original rsync writer response differs')
    await authority.authorize(intent, transferContextForBinding(captured.binding), operation)
    signal.throwIfAborted()
    if (!isDeepStrictEqual(input.current(intent.deviceId), captured.binding)) throw new Error('Original rsync writer channel changed')
    return response
  }
  const join = async (tasks: Promise<unknown>[]) => {
    const results = await Promise.allSettled(tasks), failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Original rsync physical closure remains incomplete')
  }
  const writers: RsyncTransferWriters = {
    async local(intent, command, signal) {
      assertAdmission(signal)
      if (input.side !== 'main') throw new Error('Original selected rsync client unavailable')
      const selected = await selection(intent, signal)
      const endpoint = assertRsyncBackendSelection(selected, intent), binding = input.current(intent.deviceId)
      assertAdmission(signal)
      if (!binding || command.executable !== endpoint.localBinary) throw new Error('Original rsync client binary changed')
      await authority.authorize(intent, transferContextForBinding(binding), 'start'); assertAdmission(signal)
      return ownership.prepareProcess(intent, binding, 'rsync-client', { executable: endpoint.localBinary, sha256: endpoint.localBinarySha256,
        commandDigest: rsyncArgumentDigest(command.args) })
    },
    async remote(intent, signal) {
      assertAdmission(signal)
      const selected = await selection(intent, signal)
      const response = await remote(intent, 'writer-prepare', signal); assertAdmission(signal)
      if (response.method !== 'writer-prepare') throw new Error('Original rsync server reference missing')
      const reference = { transferId: response.transferId, ownerId: response.ownerId, ownerDigest: response.ownerDigest }
      references.set(intent.transferId, reference)
      closedReferences.delete(intent.transferId)
      return { ...reference, nodeBinary: selected.nodeBinary, entryPoint: selected.entryPoint }
    },
    async activate(intent, reference, signal) {
      assertAdmission(signal)
      if (!isDeepStrictEqual(references.get(intent.transferId), { transferId: reference.transferId, ownerId: reference.ownerId, ownerDigest: reference.ownerDigest }))
        throw new Error('Original rsync server activation reference changed')
      await remote(intent, 'writer-activate', signal); assertAdmission(signal)
    },
    async quiescent(intent, signal) {
      await join([ownership.processesQuiescent(intent, signal, true), ...(input.side === 'main' ? [remote(intent, 'writer-status', signal)] : [])])
      const original = references.get(intent.transferId)
      if (original) closedReferences.set(intent.transferId, original)
    },
    async stop(intent, signal) {
      const original = references.get(intent.transferId)
      const alreadyClosed = original && isDeepStrictEqual(closedReferences.get(intent.transferId), original)
      await join([ownership.stopProcesses(intent, signal), ...(input.side === 'main' && !alreadyClosed ? [remote(intent, 'writer-stop', signal)] : [])])
      if (original) closedReferences.set(intent.transferId, original)
    },
  }
  const mounted = createProductionRsyncComposition({ ...input, providers: { ...p, ...(p.selection ? { selection } : {}), ownership, writers } })
  if (mounted.kind !== 'configured') return mounted
  const control = input.side === 'worker' ? createWorkerRsyncWriterControl({ ownership, accepted: p.accepted, current: input.current,
    binary: p.binary!, handle: mounted.backend.handle }) : undefined
  if (control) mounted.extensions[0]!.handle = control.handle
  let shutdown: Promise<void> | undefined
  const rsyncWriters = {
    inventory: () => ownership.inventory(),
    async bindingLost(binding?: Readonly<DeviceSessionBinding>) {
      const signal = AbortSignal.timeout(5000)
      const tasks: Promise<unknown>[] = []
      if (control) { try { tasks.push(control.bindingLost(binding)) } catch (error) { tasks.push(Promise.reject(error)) } }
      try {
        for (const intent of ownership.inventory().filter(i => !binding || i.deviceId === binding.deviceId && i.connectionEpoch === binding.connectionEpoch)) {
          tasks.push(ownership.stop(intent, signal))
          if (input.side === 'main') tasks.push(writers.stop(intent, signal))
        }
      } catch (error) { tasks.push(Promise.reject(error)) }
      await join(tasks)
    },
    close() {
      closing = true
      if (shutdown) return shutdown
      const attempt = (async () => {
        const signal = AbortSignal.timeout(5000)
        const tasks: Promise<unknown>[] = [ownership.drain(signal)]
        if (control) { try { tasks.push(control.close()) } catch (error) { tasks.push(Promise.reject(error)) } }
        try {
          // Drain every local owner, but coordinate only peers acquired by this instance.
          // Historical remote uncertainty remains in its journal for reconciliation.
          const acquired = ownership.inventory().filter(intent => references.has(intent.transferId))
          tasks.push(...acquired.map(intent => writers.stop(intent, signal)))
        } catch (error) {
          tasks.push(Promise.reject(error))
        }
        await join(tasks)
      })()
      shutdown = attempt
      void attempt.catch(() => { if (shutdown === attempt) shutdown = undefined })
      return attempt
    },
  }
  return { ...mounted, ownership, writers, rsyncWriters }
}
