import { z } from 'zod'
import { DeviceProvisioningHostReferenceSchema, DeviceProvisioningTargetSchema } from './deviceResources.js'
import { ProviderAccountBindingSchema } from './providerAccounts.js'

export const HarnessOptionsInputSchema = z.object({
  harness: z.enum(['codex', 'claude']),
  hostRef: DeviceProvisioningHostReferenceSchema.optional(),
  accountBinding: ProviderAccountBindingSchema.optional(),
}).strict()
export const HarnessOptionsRefreshInputSchema = HarnessOptionsInputSchema.extend({
  refresh: z.enum(['catalog', 'upstream']).default('catalog'),
}).strict()
export type HarnessOptionsInput = z.infer<typeof HarnessOptionsInputSchema>
export const HarnessOptionsDiscoveryRequestSchema = HarnessOptionsInputSchema.omit({ hostRef: true }).extend({
  operation: z.literal('options'), target: DeviceProvisioningTargetSchema, refresh: z.boolean().optional(),
}).strict()
export type HarnessOptionsDiscoveryRequest = z.infer<typeof HarnessOptionsDiscoveryRequestSchema>
