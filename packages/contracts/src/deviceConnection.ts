import { z } from 'zod'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'
import type { DeviceApplicationFrame, DeviceExtensionDescriptor, DeviceNegotiatedExtension } from './deviceApplication.js'
import type { MainSignedIdentityProof } from './deviceIdentity.js'
/** Wire compatibility is independent of application and native-provider versions. */
export const DEVICE_PROTOCOL_VERSION = 1
export const DEVICE_FRAME_BYTES = 16_384
export const DEVICE_QUEUE_DEPTH = 32
export const DEVICE_BUFFER_BYTES = 65_536
type DeviceConnectionPhase = 'disconnected' | 'offline' | 'connecting' | 'authenticating' | 'negotiating' | 'synchronizing' | 'ready' | 'backoff' | 'blocked'
export type DeviceFailureCode = 'authentication' | 'revoked' | 'permission' | 'wrong-main' | 'incompatible-protocol' | 'malformed-frame' | 'backpressure' | 'timeout' | 'transport'
export const DeviceSessionBindingSchema = DeviceConnectionIdentitySchema.extend({ connectionEpoch: z.uuid() }).strict()
export type DeviceSessionBinding = z.infer<typeof DeviceSessionBindingSchema>
/** Worker build/wire version and last frame receipt are observed on its authenticated connection. */
export const DevicePresenceSchema = z.object({
  binding: DeviceSessionBindingSchema,
  phase: z.enum(['ready', 'offline']),
  dispatch: z.boolean(),
  transfer: z.boolean(),
  appVersion: z.string().min(1).max(128),
  protocolVersion: z.literal(DEVICE_PROTOCOL_VERSION),
  lastSeenAt: z.string().datetime(),
  clockSkewMs: z.number().nullable().optional(),
  clockReason: z.string().nullable().optional(),
}).strict()
export type DevicePresence = z.infer<typeof DevicePresenceSchema>

export interface DeviceHello extends DeviceSessionBinding {
  type: 'hello'
  protocolVersion: number
  appVersion: string
  nonce: string
  observedAt?: string
  extensions?: DeviceExtensionDescriptor[]
}
export interface DeviceWelcome extends DeviceSessionBinding {
  type: 'welcome'
  protocolVersion: number
  appVersion: string
  mainIdentityProof: MainSignedIdentityProof
  observedAt?: string
  capabilities: { heartbeat: true; dispatch: boolean; transfer: boolean; extensions?: DeviceNegotiatedExtension[] }
}
export type DeviceFrame = DeviceApplicationFrame | DeviceHello | DeviceWelcome
  | { type: 'ping' | 'ready'; connectionEpoch: string; observedAt?: string }
  | { type: 'pong'; connectionEpoch: string; observedAt?: string;
    /** Main has completed reconciliation for this connection. */
    mainReady?: true }
  | { type: 'blocked'; code: DeviceFailureCode }
export interface DeviceConnectionView {
  desired: boolean
  phase: DeviceConnectionPhase
  generation: number
  failure: DeviceFailureCode | null
}
