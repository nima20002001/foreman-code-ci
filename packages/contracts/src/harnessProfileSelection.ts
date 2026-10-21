import { z } from 'zod'
import type { CanonicalMachineReference } from './deviceIdentity.js'

export const HarnessHostReferenceSchema: z.ZodType<CanonicalMachineReference> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('main'), mainId: z.uuid() }).strict(),
  z.object({ kind: z.literal('device'), mainId: z.uuid(), deviceId: z.uuid() }).strict(),
])
const Identity = z.string().min(1)
/** Global presets remain managed defaults; overrides are exact-host immutable revisions. */
export const HostHarnessOverrideTargetSchema = z.object({
  hostRef: HarnessHostReferenceSchema, applicationInstallationId: z.uuid(), harnessInstallationId: Identity,
  installationFingerprint: Identity,
}).strict()
/** Explicit user-selected configured profile. Execution locations retain their separate accepted placement. */
export const HarnessProfileSelectionSchema = z.object({
  instanceId: z.uuid(), instanceRevision: Identity, target: HostHarnessOverrideTargetSchema,
}).strict()
export type HarnessProfileSelection = z.infer<typeof HarnessProfileSelectionSchema>
