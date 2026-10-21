import { isDeepStrictEqual } from 'node:util'
import { RsyncControlRequestSchema, RsyncControlResponseSchema, TransferIntentSchema,
  type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import { authenticatedTransferAuthority, transferContextForBinding, type AcceptedTransferAuthority } from '../byte-transfer/carrier.js'
import type { RsyncWriterOwnership } from '../byte-transfer/rsyncWriterOwnership.js'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from './deviceApplicationChannel.js'

/** Wrap the existing staging handler on the same authenticated W07 namespace.
 * All installation/owner facts come from trusted composition, never RPC JSON. */
export function createWorkerRsyncWriterControl(input: {
  ownership: RsyncWriterOwnership
  accepted: AcceptedTransferAuthority
  current(deviceId: string): Readonly<DeviceSessionBinding> | undefined
  binary: { executable: string; sha256: string }
  handle: NonNullable<DeviceExtensionRegistration['handle']>
}) {
  const authority = authenticatedTransferAuthority(input.current, input.accepted)
  const lifetime = new AbortController(), tasks = new Set<Promise<unknown>>()
  let generation = new AbortController()
  let closing: Promise<void> | undefined
  const track = <T>(task: Promise<T>): Promise<T> => {
    tasks.add(task)
    void task.then(() => tasks.delete(task), () => tasks.delete(task))
    return task
  }
  const stopOriginal = (binding?: Readonly<DeviceSessionBinding>) => {
    const signal = AbortSignal.timeout(5000)
    // stopProcesses revokes synchronously before its first await. Start every
    // original scope before joining any; uncertain closure keeps its own holds.
    const stopping = input.ownership.inventory()
      .filter(i => !binding || i.deviceId === binding.deviceId && i.connectionEpoch === binding.connectionEpoch)
      .map(i => input.ownership.stopProcesses(i, signal))
    return track(Promise.allSettled(stopping).then(results => {
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Original rsync writer revocation remains incomplete')
    }))
  }
  const handleInternal = async (raw: unknown, frame: DeviceExtensionContext): Promise<DeviceApplicationResult> => {
    const request = RsyncControlRequestSchema.parse(raw)
    const signal = AbortSignal.any([frame.signal, generation.signal, lifetime.signal])
    const assertFrame = () => {
      signal.throwIfAborted()
      if (!isDeepStrictEqual(input.current(frame.binding.deviceId), frame.binding)) throw new Error('Stale rsync writer control binding')
    }
    assertFrame()
    if (frame.bytes !== undefined) throw new Error('Rsync writer control cannot carry binary payloads')
    if (!request.method.startsWith('writer-')) return input.handle(request, { ...frame, signal })
    const intent = TransferIntentSchema.parse(await input.accepted.intent(request.transferId, frame.binding))
    assertFrame()
    if (intent.transferId !== request.transferId) throw new Error('Original accepted rsync writer transfer differs')
    if (['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'].some(key =>
      Reflect.get(intent, key) !== Reflect.get(frame.binding, key))) throw new Error('Original accepted rsync writer principal differs')
    const operation = request.method === 'writer-stop' ? 'cancel' : request.method === 'writer-status' ? 'read' : 'start'
    const authorize = async (original: TransferIntent, binding: Readonly<DeviceSessionBinding>, bounded: AbortSignal) => {
      bounded.throwIfAborted(); assertFrame()
      if (!isDeepStrictEqual(binding, frame.binding)) throw new Error('Original rsync writer binding differs')
      const accepted = TransferIntentSchema.parse(await input.accepted.intent(request.transferId, binding))
      bounded.throwIfAborted(); assertFrame()
      if (!isDeepStrictEqual(accepted, intent) || !isDeepStrictEqual(original, intent)) throw new Error('Original accepted rsync writer authority changed')
      await authority.authorize(intent, transferContextForBinding(binding), operation)
      bounded.throwIfAborted(); assertFrame()
      if (operation === 'start' && Date.parse(intent.expiresAt) <= Date.now()) throw new Error('Original rsync writer intent expired')
    }
    let admission = false
    try {
      await authorize(intent, frame.binding, signal)
      let owner: { ownerId: string; ownerDigest: string } | undefined
      if (request.method === 'writer-prepare') {
        owner = input.ownership.prepareProcess(intent, frame.binding, 'rsync-server', input.binary)
        admission = true
      } else if (request.method === 'writer-activate') {
        const reference = input.ownership.serverAdmission(intent, frame.binding)
        admission = true
        await input.ownership.activateServer(reference, frame.binding, signal, authorize)
      } else if (request.method === 'writer-status') await input.ownership.processesQuiescent(intent, signal, true)
      else if (request.method === 'writer-stop') await input.ownership.stopProcesses(intent, signal)
      else throw new Error('Unknown rsync writer method')
      await authorize(intent, frame.binding, signal)
      return { payload: RsyncControlResponseSchema.parse({ ...request,
        ...(owner ? { ownerId: owner.ownerId, ownerDigest: owner.ownerDigest } : {}) }) }
    } catch (error) {
      if (admission) {
        try { await input.ownership.stopProcesses(intent, AbortSignal.timeout(5000)) }
        catch (stopError) { throw new AggregateError([error, stopError], 'Rsync writer admission failed with original stop unconfirmed', { cause: stopError }) }
      }
      throw error
    }
  }
  return {
    handle: (raw: unknown, frame: DeviceExtensionContext) => track(handleInternal(raw, frame)),
    bindingLost(binding?: Readonly<DeviceSessionBinding>) {
      generation.abort(new Error('Original W07 binding lost')); generation = new AbortController()
      return stopOriginal(binding)
    },
    close() {
      lifetime.abort(new Error('Worker rsync writer control closed'))
      return closing ??= (async () => {
        await stopOriginal()
        while (tasks.size) await Promise.allSettled([...tasks])
      })()
    },
  }
}
