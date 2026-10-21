import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from './deviceResources.js'
import { IdSchema } from './schemaPrimitives.js'

export const CiEnrollmentReadSchema = z.object({ workspaceId: IdSchema }).strict()
/** Pairing authorizes managed storage setup; runtime qualification is reported separately. */
export const CiManagedSetupSchema = z.object({
  state: z.enum(['ready', 'runtime-unavailable', 'failed']),
  migrated: z.boolean(),
  message: z.string().max(2000).nullable(),
  updatedAt: z.string().datetime(),
}).strict()
export const CiEnrollmentUpdateSchema = CiEnrollmentReadSchema.extend({
  commandId: IdSchema.optional().describe('Optional retry identity; generated server-side when omitted.'),
  target: DeviceProvisioningTargetSchema,
  expectedRevision: z.number().int().nonnegative(),
  enabled: z.boolean(),
})
const CiEnrollmentTemplateStateSchema = z.enum([
  'pending', 'runtime-required', 'root-required', 'storage-required', 'not-enrolled-automatically',
  'preparing', 'ready', 'failed',
])
const CiEnrollmentTemplateSchema = z.object({
  templateId: IdSchema,
  profileId: IdSchema.nullable(),
  state: CiEnrollmentTemplateStateSchema,
  message: z.string().max(2000).nullable(),
}).strict()
export const CiEnrollmentComputerSchema = z.object({
  executionMode: z.enum(['host', 'protected']).optional(),
  managedSetup: CiManagedSetupSchema.optional(),
  target: DeviceProvisioningTargetSchema,
  revision: z.number().int().nonnegative(),
  enabled: z.boolean(),
  state: z.enum(['pending', 'templates-required', 'disabled', 'offline', 'setup-required', 'runtime-required',
    'root-required', 'storage-required', 'not-enrolled-automatically', 'preparing', 'ready', 'partial', 'failed']),
  profileIds: z.array(IdSchema),
  templates: z.array(CiEnrollmentTemplateSchema).default([]),
  message: z.string().max(2000).nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict()
export const CiEnrollmentStateSchema = z.object({
  workspaceId: IdSchema,
  computers: z.array(CiEnrollmentComputerSchema),
}).strict()
/** Installed storage bounds template availability; it does not establish qualification. */
export const CiInstalledStorageSchema = z.object({
  diskBytes: z.number().int().positive().safe(),
  mutableInodes: z.number().int().positive().safe(),
}).strict()
export type CiEnrollmentComputer = z.infer<typeof CiEnrollmentComputerSchema>
export type CiEnrollmentTemplate = z.infer<typeof CiEnrollmentTemplateSchema>
export type CiEnrollmentState = z.infer<typeof CiEnrollmentStateSchema>
export type CiInstalledStorage = z.infer<typeof CiInstalledStorageSchema>
