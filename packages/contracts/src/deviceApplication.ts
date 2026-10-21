import { z } from 'zod'
import type { Failure } from './failure.js'
import { AGENT_SNAPSHOT_JSON_BYTES, AGENT_SNAPSHOT_NAMESPACE } from './sourceMaterialization.js'
import { WORKER_MCP_EXTENSION } from './workerMcpLimits.js'
export { WORKER_MCP_CHUNK_WINDOW } from './workerMcpLimits.js'

/** Application namespaces share the authenticated W07 socket, never workflow authority. */
export const DEVICE_APPLICATION_MAX_EXTENSIONS = 32
export const DEVICE_APPLICATION_JSON_BYTES = 1_048_576
export const DEVICE_APPLICATION_BINARY_BYTES = 1_048_576
export const DEVICE_APPLICATION_CHUNK_BYTES = 8_192
export const DEVICE_APPLICATION_CHUNK_WINDOW = 4
export const DEVICE_APPLICATION_IN_FLIGHT = 8
export const DEVICE_APPLICATION_OBSERVATION_IN_FLIGHT = 8
export const DEVICE_APPLICATION_STOP_IN_FLIGHT = 1
export const DEVICE_APPLICATION_CALLBACK_IN_FLIGHT = 1
export const DEVICE_APPLICATION_STOP_BYTES = DEVICE_APPLICATION_JSON_BYTES
export const DEVICE_APPLICATION_BUFFER_BYTES = 4_194_304
type DeviceExtensionRole = 'client' | 'server' | 'duplex'
export interface DeviceExtensionDescriptor {
  namespace: string
  version: number
  role: DeviceExtensionRole
  maxJsonBytes: number
  maxBinaryBytes: number
  /** Enables observation admission on this namespace when both peers advertise support. */
  observationAdmission?: true
  /** Enables reserved CI Stop admission when both peers advertise support. */
  ciStopAdmission?: true
  /** Status and receipt pages needed for Stop may use reserved Stop capacity. */
  stopReadAdmission?: true
  /** Copy authorization can complete while its parent preparations occupy ordinary slots. */
  callbackAdmission?: true
}
export interface DeviceNegotiatedExtension {
  namespace: string
  version: number
  mainCanRequest: boolean
  workerCanRequest: boolean
  maxJsonBytes: number
  maxBinaryBytes: number
  observationAdmission?: true
  ciStopAdmission?: true
  stopReadAdmission?: true
  callbackAdmission?: true
}
export type DeviceApplicationFrame =
  | { type: 'application-open'; id: string; namespace: string; version: number; kind: 'request' | 'response' | 'error'; jsonBytes: number; binaryBytes: number; admission?: 'stop' | 'observation' | 'callback'; progress?: true }
  | { type: 'application-chunk'; id: string; offset: number; data: string }
  | { type: 'application-ack'; id: string; offset: number }
  | { type: 'application-cancel'; id: string }
  | { type: 'application-reject'; id: string; code: 'backpressure' }
  | { type: 'application-progress'; id: string; bytes: number }
export interface DeviceApplicationResult { payload: unknown; bytes?: Uint8Array }
export type DeviceRequestPriority = 'foreground' | 'background'
export interface DeviceBusyDetails {
  retryable: true
  reason: string
}
export interface DeviceApplicationFailure extends Failure {
  /** `class === 'transient'`, kept for peers that predate `class`. Operation retries still require their owner
   * and idempotency checks. */
  retryable: boolean
  details?: import('./workerUpdate.js').WorkerBundleReadiness
}

/** Leaves room for the original receipt and physical readout in the same carrier. */
export const DEVICE_HISTORY_PAGE_BYTES = 262_144
export const DEVICE_JSON_CONTINUATION_BYTES = 65_536
export const DEVICE_JSON_CONTINUATION_LIMIT = 4_194_304
export const DeviceJsonContinuationRequestSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/), offset: z.number().int().safe().nonnegative(),
  downloadId: z.uuid().optional(),
}).strict()
export type DeviceJsonContinuationRequest = z.infer<typeof DeviceJsonContinuationRequestSchema>
export const DeviceJsonContinuationSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  downloadId: z.uuid().optional(),
  byteSize: z.number().int().safe().positive().max(DEVICE_JSON_CONTINUATION_LIMIT),
  offset: z.number().int().safe().nonnegative(),
  data: z.string().min(1).max(Math.ceil(DEVICE_JSON_CONTINUATION_BYTES / 3) * 4),
}).strict()
export type DeviceJsonContinuation = z.infer<typeof DeviceJsonContinuationSchema>
export const DeviceHistoryRequestFields = {
  downloadId: z.uuid().optional(),
  afterSequence: z.number().int().safe().min(-1).optional(),
  metadata: DeviceJsonContinuationRequestSchema.optional(),
}
export const DeviceHistoryGapSchema = z.object({
  fromSequence: z.number().int().safe().nonnegative(),
  toSequence: z.number().int().safe().nonnegative(),
  reason: z.enum(['retention', 'event_too_large']),
}).strict().refine(value => value.toSequence >= value.fromSequence)
export type DeviceHistoryGap = z.infer<typeof DeviceHistoryGapSchema>
export const DeviceHistoryPageSchema = z.object({
  nextAfterSequence: z.number().int().safe().min(-1),
  hasMore: z.boolean(),
  metadata: DeviceJsonContinuationSchema.optional(),
}).strict()
export type DeviceHistoryPage = z.infer<typeof DeviceHistoryPageSchema>

export function parseExtensionDescriptors(value: unknown): DeviceExtensionDescriptor[] {
  // Main and its workers update together; 32 leaves room as namespaces are added.
  if (!Array.isArray(value) || value.length > DEVICE_APPLICATION_MAX_EXTENSIONS) throw new Error('Invalid device extensions')
  const seen = new Set<string>()
  return value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid device extension')
    const descriptor = item as DeviceExtensionDescriptor
    const maxJsonBytes = descriptor.namespace === AGENT_SNAPSHOT_NAMESPACE
      ? AGENT_SNAPSHOT_JSON_BYTES : DEVICE_APPLICATION_JSON_BYTES
    const maxBinaryBytes = descriptor.namespace === WORKER_MCP_EXTENSION.namespace
      ? WORKER_MCP_EXTENSION.maxBinaryBytes : DEVICE_APPLICATION_BINARY_BYTES
    if (!/^[a-z][a-z0-9:-]{0,63}$/.test(descriptor.namespace) || seen.has(descriptor.namespace)
      || !Number.isSafeInteger(descriptor.version) || descriptor.version < 1
      || descriptor.observationAdmission !== undefined && descriptor.observationAdmission !== true
      || descriptor.ciStopAdmission !== undefined && descriptor.ciStopAdmission !== true
      || descriptor.stopReadAdmission !== undefined && descriptor.stopReadAdmission !== true
      || descriptor.callbackAdmission !== undefined && descriptor.callbackAdmission !== true
      || !['client', 'server', 'duplex'].includes(descriptor.role)
      || !Number.isSafeInteger(descriptor.maxJsonBytes) || descriptor.maxJsonBytes < 256 || descriptor.maxJsonBytes > maxJsonBytes
      || !Number.isSafeInteger(descriptor.maxBinaryBytes) || descriptor.maxBinaryBytes < 0 || descriptor.maxBinaryBytes > maxBinaryBytes) throw new Error('Invalid device extension')
    seen.add(descriptor.namespace)
    return { namespace: descriptor.namespace, version: descriptor.version, role: descriptor.role,
      maxJsonBytes: descriptor.maxJsonBytes, maxBinaryBytes: descriptor.maxBinaryBytes,
      ...(descriptor.observationAdmission === true ? { observationAdmission: true as const } : {}),
      ...(descriptor.ciStopAdmission === true ? { ciStopAdmission: true as const } : {}),
      ...(descriptor.stopReadAdmission === true ? { stopReadAdmission: true as const } : {}),
      ...(descriptor.callbackAdmission === true ? { callbackAdmission: true as const } : {}) }
  }).sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0)
}
export function negotiateDeviceExtensions(main: DeviceExtensionDescriptor[], worker: DeviceExtensionDescriptor[]): DeviceNegotiatedExtension[] {
  return main.flatMap((local) => {
    const peer = worker.find((item) => item.namespace === local.namespace && item.version === local.version)
    if (!peer) return []
    const mainCanRequest = local.role !== 'server' && peer.role !== 'client'
    const workerCanRequest = peer.role !== 'server' && local.role !== 'client'
    if (!mainCanRequest && !workerCanRequest) return []
    return [{ namespace: local.namespace, version: local.version, mainCanRequest, workerCanRequest,
      maxJsonBytes: Math.min(local.maxJsonBytes, peer.maxJsonBytes),
      maxBinaryBytes: Math.min(local.maxBinaryBytes, peer.maxBinaryBytes),
      ...(local.observationAdmission === true && peer.observationAdmission === true
        ? { observationAdmission: true as const } : {}),
      ...(local.ciStopAdmission === true && peer.ciStopAdmission === true
        ? { ciStopAdmission: true as const } : {}),
      ...(local.stopReadAdmission === true && peer.stopReadAdmission === true
        ? { stopReadAdmission: true as const } : {}),
      ...(local.callbackAdmission === true && peer.callbackAdmission === true
        ? { callbackAdmission: true as const } : {}) }]
  }).sort((a, b) => a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0)
}
