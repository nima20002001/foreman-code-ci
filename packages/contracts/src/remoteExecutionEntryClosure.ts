import { z } from 'zod'
import { DispatchIntentSchema } from './nodePlacement.js'
import { DeviceConnectionIdentitySchema } from './deviceIdentity.js'

const NativeProcessIdentitySchema = z.object({
  pid: z.number().int().safe().gt(1), startTicks: z.string().regex(/^\d+$/),
}).strict()
const NativeCgroupBoundarySchema = z.object({
  kind: z.literal('cgroup-v2'), path: z.string().startsWith('/'),
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^\d+$/),
}).strict()
export const NativeProcessObservationSchema = z.object({
  owner: z.string().min(1).max(4096), launchId: z.uuid(), bootId: z.string().min(1),
  guardian: NativeProcessIdentitySchema.optional(), provider: NativeProcessIdentitySchema.optional(),
  boundary: NativeCgroupBoundarySchema.optional(),
  lifecycle: z.enum(['active', 'ended', 'closure-unconfirmed', 'closed']),
  closureEvidence: z.enum(['linux_boot_changed', 'native_not_started', 'cgroup_v2_empty',
    'native_exit_removed_cgroup', 'cgroup_v2_removed']).optional(),
}).strict()

/** Original entry ownership can close before a provider session is acknowledged. */
export const RemoteEntryClosureSchema = z.object({
  intent: DispatchIntentSchema, connection: DeviceConnectionIdentitySchema,
  owner: z.string().min(1).max(4096), initialLaunchId: z.uuid(),
  launches: z.array(NativeProcessObservationSchema).min(1).max(10_000),
}).strict().superRefine((value, context) => {
  if (value.owner !== `execution:${value.intent.executionId}` || value.connection.mainId !== value.intent.mainId
    || !value.launches.some(launch => launch.launchId === value.initialLaunchId)
    || new Set(value.launches.map(launch => launch.launchId)).size !== value.launches.length
    || value.launches.some(launch => launch.owner !== value.owner || launch.bootId !== value.connection.bootId
      || launch.lifecycle !== 'closed' || !launch.closureEvidence
      || ['cgroup_v2_empty', 'native_exit_removed_cgroup', 'cgroup_v2_removed'].includes(launch.closureEvidence)
        && !launch.boundary)) {
    context.addIssue({ code: 'custom', message: 'Entry closure requires all original registered owners to be positively closed.' })
  }
})
export type RemoteEntryClosure = z.infer<typeof RemoteEntryClosureSchema>
