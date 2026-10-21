import { z } from 'zod'
import { DeviceProvisioningTargetSchema, DeviceCommandIdSchema, DeviceSafeIntegerSchema } from './deviceResources.js'

/** Share (percent) of the computer's CPU and memory that builds may use together. */
export const BuildComputerAllowanceSchema = z.number().int().min(10).max(100)
export const BuildComputerPreferenceSchema = z.object({
  target: DeviceProvisioningTargetSchema,
  revision: DeviceSafeIntegerSchema,
  buildEnabled: z.boolean(),
  buildPriority: z.number().int().min(0).max(100),
  buildAllowancePercent: BuildComputerAllowanceSchema.default(100),
}).strict()
export const BuildComputerReadSchema = z.object({ target: DeviceProvisioningTargetSchema }).strict()
export const BuildComputerUpdateSchema = BuildComputerReadSchema.extend({
  commandId: DeviceCommandIdSchema.optional().describe('Optional retry identity; generated server-side when omitted.'),
  expectedRevision: DeviceSafeIntegerSchema,
  buildEnabled: z.boolean(),
  buildPriority: z.number().int().min(0).max(100),
  /** Omitted fields keep their saved values. */
  buildAllowancePercent: BuildComputerAllowanceSchema.optional(),
}).strict()
const BuildComputerChangeSchema = BuildComputerUpdateSchema.omit({ commandId: true })
export const BuildComputerBatchUpdateSchema = z.object({
  commandId: DeviceCommandIdSchema.optional().describe('Optional retry identity; generated server-side when omitted.'),
  updates: z.array(BuildComputerChangeSchema).min(1),
}).strict().superRefine(({ updates }, context) => {
  const keys = new Set<string>()
  for (const [index, { target }] of updates.entries()) {
    const host = target.hostRef
    const key = host.kind === 'main' ? 'main' : host.deviceId
    if (host.mainId !== updates[0]!.target.hostRef.mainId || keys.has(key)) {
      context.addIssue({ code: 'custom', path: ['updates', index, 'target'],
        message: 'Update each computer once, on the same Main.' })
    }
    keys.add(key)
  }
})
export const BuildComputerStatusSchema = z.object({
  preference: BuildComputerPreferenceSchema,
  state: z.enum(['disabled', 'ready', 'busy', 'offline', 'setup-required']),
  reasons: z.array(z.string()),
  remoteExecutionEnabled: z.boolean(),
}).strict()
export const BuildComputerBatchResultSchema = z.object({ computers: z.array(BuildComputerStatusSchema).min(1) }).strict()
export type BuildComputerPreference = z.infer<typeof BuildComputerPreferenceSchema>
export type BuildComputerStatus = z.infer<typeof BuildComputerStatusSchema>
export type BuildComputerChange = z.infer<typeof BuildComputerChangeSchema>
export type BuildComputerBatchResult = z.infer<typeof BuildComputerBatchResultSchema>
