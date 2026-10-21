import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DeviceSessionBindingSchema, type DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { BYTE_TRANSFER_POLICY, TransferContextSchema, TransferIntentSchema, TransferProgressSchema,
  VerifiedTransferReceiptSchema, type TransferContext, type TransferIntent, type ByteTransferPort } from '@foreman-code/contracts/byte-transfer'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DeviceApplicationError, type DeviceApplicationChannel, type DeviceExtensionContext, type DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { ResumableByteTransferService, TransferExpiredError, type TransferAuthorization, type TransferOperation } from './service.js'
import { ResumableByteTransferSender, type ImmutableTransferSource, type TransferSenderConnection } from './sender.js'

export const BYTE_TRANSFER_NAMESPACE = 'byte-transfer-v1'
/** Preserve the genuine opaque W07 epoch. Generation is a separate connection fact. */
export function transferContextForBinding(input: Readonly<DeviceSessionBinding>): TransferContext {
  const binding = DeviceSessionBindingSchema.parse(input)
  return TransferContextSchema.parse({ mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
    authorizationRevision: binding.authorizationRevision, bootId: binding.bootId, connectionEpoch: binding.connectionEpoch })
}
export interface AcceptedTransferAuthority extends TransferAuthorization {
  /** Authoritative accepted intent from main admission or the worker's original main-issued journal. */
  intent(id: string, binding: Readonly<DeviceSessionBinding>): Promise<TransferIntent>
}
const RequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.enum(['start', 'status', 'finish', 'cancel']), transferId: z.uuid() }).strict(),
  z.object({ method: z.literal('append'), transferId: z.uuid(), offset: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().positive().max(BYTE_TRANSFER_POLICY.maxChunkBytes) }).strict(),
])
/** Both before and after private operation authorization, fence against W07's actual ready epoch. */
export function authenticatedTransferAuthority(current: (deviceId: string) => Readonly<DeviceSessionBinding> | undefined,
  accepted: TransferAuthorization): TransferAuthorization {
  return { async authorize(intent, context, operation) {
    const observed = current(intent.deviceId)
    const binding = observed ? DeviceSessionBindingSchema.parse(observed) : undefined
    if (!binding || !isDeepStrictEqual(transferContextForBinding(binding), TransferContextSchema.parse(context))) throw new Error('Transfer current authenticated connection differs')
    await accepted.authorize(intent, context, operation)
    const latest = current(intent.deviceId)
    if (!latest || !isDeepStrictEqual(latest, binding)) throw new Error('Transfer authenticated connection changed during authorization')
  } }
}
/** Existing W07 carrier; the frame supplies identity, never worker JSON or a synthesized context. */
export function createAuthenticatedTransferReceiver(input: { stagingRoot: string;
  current(deviceId: string): Readonly<DeviceSessionBinding> | undefined; accepted: AcceptedTransferAuthority; clock?: () => number;
  /** Reuse the original canonical store when another byte backend shares its allocation. */
  receiver?: ResumableByteTransferService }) {
  const authority = authenticatedTransferAuthority(input.current, input.accepted)
  const receiver = input.receiver ?? new ResumableByteTransferService(input.stagingRoot, authority, input.clock)
  const handle = async (raw: unknown, frame: DeviceExtensionContext) => {
    frame.signal.throwIfAborted()
    const request = RequestSchema.parse(raw), context = transferContextForBinding(frame.binding)
    const current = input.current(frame.binding.deviceId)
    if (!current || !isDeepStrictEqual(current, frame.binding)) throw new Error('Transfer incoming authenticated epoch is stale')
    if (request.method !== 'append' && frame.bytes?.byteLength) throw new Error('Unexpected transfer binary bytes')
    const intent = TransferIntentSchema.parse(await input.accepted.intent(request.transferId, frame.binding))
    if (intent.transferId !== request.transferId) throw new Error('Accepted transfer identity differs')
    frame.signal.throwIfAborted()
    if (input.receiver) await authority.authorize(intent, context, request.method)
    let payload
    try {
      if (request.method === 'start') payload = await receiver.start(intent, context, frame.signal)
      else if (request.method === 'status') payload = await receiver.status(intent.transferId, context, frame.signal)
      else if (request.method === 'finish') payload = await receiver.finish(intent.transferId, context, frame.signal)
      else if (request.method === 'cancel') payload = await receiver.cancel(intent.transferId, context, frame.signal)
      else if (request.method === 'append') {
        if (!frame.bytes || frame.bytes.byteLength !== request.byteLength) throw new Error('Transfer binary length differs')
        payload = await receiver.append(intent.transferId, context, { offset: request.offset, sha256: request.sha256, bytes: frame.bytes }, frame.signal)
      } else throw new Error('Unknown transfer operation')
    } catch (error) {
      // The sender must allocate a new transfer; resending this identity can never succeed.
      if (error instanceof TransferExpiredError) throw new DeviceApplicationError('transfer-expired', undefined, { cause: error })
      throw error
    }
    if (input.receiver) await authority.authorize(intent, context, request.method)
    frame.signal.throwIfAborted()
    return { payload }
  }
  const extension: DeviceExtensionRegistration = { namespace: BYTE_TRANSFER_NAMESPACE, version: 1, role: 'server',
    maxJsonBytes: 16384, maxBinaryBytes: BYTE_TRANSFER_POLICY.maxChunkBytes, handle }
  return { receiver, handle, extension }
}
/** Main incoming authority is the private endpoint's synchronized, negotiated channel. */
export function createEndpointTransferReceiver(input: { stagingRoot: string; endpoint: Pick<DeviceEndpoint, 'currentBinding'>;
  accepted: AcceptedTransferAuthority; clock?: () => number }) {
  return createAuthenticatedTransferReceiver({ ...input, current: deviceId => input.endpoint.currentBinding(deviceId, BYTE_TRANSFER_NAMESPACE) })
}
/** Worker has only its selected-main channel and original accepted operation; no SQL capability. */
export function createChannelTransferReceiver(input: { stagingRoot: string; channel: Pick<DeviceApplicationChannel, 'currentBindingForIncoming'>;
  accepted: AcceptedTransferAuthority; clock?: () => number }) {
  return createAuthenticatedTransferReceiver({ ...input, current: deviceId => {
    const binding = input.channel.currentBindingForIncoming(BYTE_TRANSFER_NAMESPACE)
    return binding.deviceId === deviceId ? binding : undefined
  } })
}
type Capture = ReturnType<DeviceApplicationChannel['captureRequest']>
function createClient(capture: () => Capture | undefined) {
  const signals = new WeakMap<TransferContext, AbortSignal>()
  const request = async (context: TransferContext, payload: unknown, bytes?: Uint8Array) => {
    const signal = signals.get(context), channel = capture()
    signal?.throwIfAborted()
    if (!channel || !isDeepStrictEqual(transferContextForBinding(channel.binding), TransferContextSchema.parse(context))) throw new DeviceConnectionError('transport')
    // captureRequest closure is fixed to this exact channel, even if the supervisor reconnects.
    try { return await channel.request(payload, { ...(signal ? { signal } : {}), ...(bytes ? { bytes } : {}) }) }
    catch (error) {
      if (error instanceof DeviceApplicationError && error.code === 'transfer-expired') throw new TransferExpiredError('Transfer expired', { cause: error })
      throw error
    }
  }
  const progress = async (context: TransferContext, payload: unknown, id: string, bytes?: Uint8Array) => {
    const result = await request(context, payload, bytes)
    if (result.bytes?.byteLength) throw new Error('Unexpected transfer response bytes')
    const parsed = TransferProgressSchema.parse(result.payload)
    if (parsed.transferId !== id) throw new Error('Transfer response identity differs')
    return parsed
  }
  const receiver: ByteTransferPort = {
    start: async (intent, context) => progress(context, { method: 'start', transferId: TransferIntentSchema.parse(intent).transferId }, intent.transferId),
    status: async (id, context) => progress(context, { method: 'status', transferId: z.uuid().parse(id) }, id),
    append: async (id, context, chunk) => {
      const payload = RequestSchema.parse({ method: 'append', transferId: id, offset: chunk.offset, sha256: chunk.sha256, byteLength: chunk.bytes.byteLength })
      return progress(context, payload, id, chunk.bytes)
    },
    finish: async (id, context) => {
      const result = await request(context, { method: 'finish', transferId: z.uuid().parse(id) })
      if (result.bytes?.byteLength) throw new Error('Unexpected transfer response bytes')
      const receipt = VerifiedTransferReceiptSchema.parse(result.payload)
      if (receipt.transferId !== id) throw new Error('Transfer receipt identity differs')
      return receipt
    },
    cancel: async (id, context) => progress(context, { method: 'cancel', transferId: z.uuid().parse(id) }, id),
  }
  const connection: TransferSenderConnection = {
    async current(signal) {
      signal?.throwIfAborted()
      let channel = capture()
      // A bounded caller waits for the supervisor's reconnect instead of spending its retries.
      while (!channel && signal) {
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, 250)
          function done() { clearTimeout(timer); signal!.removeEventListener('abort', done); resolve() }
          signal.addEventListener('abort', done, { once: true })
        })
        signal.throwIfAborted()
        channel = capture()
      }
      if (!channel) throw new DeviceConnectionError('transport')
      const context = transferContextForBinding(channel.binding)
      if (signal) signals.set(context, signal)
      return context
    },
    retryable: error => (error instanceof DeviceConnectionError && (error.code === 'transport' || error.code === 'timeout'))
      || (error instanceof DeviceApplicationError && error.code === 'timeout'),
  }
  return { receiver, connection, sender: (source: ImmutableTransferSource) => new ResumableByteTransferSender(receiver, source, connection) }
}
export function createEndpointTransferClient(endpoint: Pick<DeviceEndpoint, 'captureRequest'>, deviceId: string) {
  return createClient(() => endpoint.captureRequest(deviceId, BYTE_TRANSFER_NAMESPACE))
}
export function createChannelTransferClient(channel: { captureRequest(namespace: string): Capture | undefined }) {
  return createClient(() => channel.captureRequest(BYTE_TRANSFER_NAMESPACE))
}
export type { TransferOperation }
