import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { IdSchema } from './schemaPrimitives.js'

export const COMPUTER_SYNC_NAMESPACE = 'computer-sync-v1'
const SyncthingDeviceIdSchema = z.string().regex(/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/)
export const TailscaleAddressSchema = z.ipv4().refine(value => {
  const octets = value.split('.').map(Number)
  return /^\d+\.\d+\.\d+\.\d+$/u.test(value) && octets.length === 4
    && octets.every(octet => octet >= 0 && octet <= 255) && octets[0] === 100
    && octets[1]! >= 64 && octets[1]! <= 127
}, 'A Tailscale IPv4 address is required')
const SyncPeerSchema = z.object({ deviceId: SyncthingDeviceIdSchema, address: TailscaleAddressSchema }).strict()
export const SyncIdentitySchema = SyncPeerSchema.extend({ rootPath: z.string().startsWith('/') }).strict()
const SyncFolderStateSchema = z.object({
  workspaceId: IdSchema,
  path: z.string().startsWith('/'),
  state: z.enum(['idle', 'syncing', 'error']),
  connected: z.boolean(),
  conflicts: z.array(z.string()).max(100),
  message: z.string().max(500).nullable(),
}).strict()
export const SyncComputerStateSchema = z.object({
  installed: z.boolean(), running: z.boolean(), deviceId: SyncthingDeviceIdSchema.nullable(),
  folders: z.array(SyncFolderStateSchema), message: z.string().max(500).nullable(),
}).strict()
export const SyncComputerRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('identity') }).strict(),
  z.object({ operation: z.literal('status'), workspaceId: IdSchema.optional() }).strict(),
  z.object({ operation: z.literal('configure'), workspaceId: IdSchema,
    enabled: z.boolean(), peers: z.array(SyncPeerSchema),
    preserveUnknownPeers: z.boolean().optional(), knownPeerIds: z.array(SyncthingDeviceIdSchema).optional() }).strict(),
])
export const SyncChannelRequestSchema = z.object({
  target: DeviceProvisioningTargetSchema, request: SyncComputerRequestSchema,
}).strict()
export const ComputerSyncReadInputSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const ComputerSyncUpdateInputSchema = ComputerSyncReadInputSchema.extend({
  workspaceId: IdSchema, enabled: z.boolean(), expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  commandId: optionalCommandId(z.string().min(8).max(200)),
}).strict()
export const ComputerSyncStatusSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  installed: z.boolean().nullable(), running: z.boolean().nullable(), message: z.string().max(500).nullable(),
  folders: z.array(z.object({
    workspaceId: IdSchema, name: z.string(), participating: z.boolean(), enabled: z.boolean(),
    revision: z.number().int().nonnegative(), status: SyncFolderStateSchema.nullable(),
  }).strict()),
}).strict()
export type SyncIdentity = z.infer<typeof SyncIdentitySchema>
export type SyncComputerRequest = z.infer<typeof SyncComputerRequestSchema>
export type SyncComputerState = z.infer<typeof SyncComputerStateSchema>
export type ComputerSyncStatus = z.infer<typeof ComputerSyncStatusSchema>
export type ComputerSyncUpdateInput = z.infer<typeof ComputerSyncUpdateInputSchema>
