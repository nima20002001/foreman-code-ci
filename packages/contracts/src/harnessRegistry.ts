import { optionalCommandId } from './management/commands.js'
import { ClaudeQualificationProofSchema } from './claudeQualification.js'
import { z } from 'zod'
import { HarnessConfigurationSchema, SupportedHarnessConfigurationSchema, type HarnessConfiguration } from './index.js'
import { DevicePresenceSchema } from './deviceConnection.js'
import { DeviceSessionBindingSchema } from './deviceConnection.js'
import { RecordedHarnessQualificationSchema } from './harnessQualification.js'
import { HarnessHostReferenceSchema, HostHarnessOverrideTargetSchema } from './harnessProfileSelection.js'
export { HarnessHostReferenceSchema, HostHarnessOverrideTargetSchema, HarnessProfileSelectionSchema, type HarnessProfileSelection } from './harnessProfileSelection.js'

const Identity = z.string().min(1)
const HarnessInstanceAvailabilitySchema = z.enum(['available', 'disabled', 'unknown-driver', 'invalid-configuration', 'retired'])
export const ConfiguredHarnessInstanceSchema = z.object({
  instanceId: Identity, instanceRevision: Identity, driverId: Identity, enabled: z.boolean(),
  // Unrecognized configuration stays unavailable; raw unknown data is never exposed to clients.
  configuration: z.lazy(() => HarnessConfigurationSchema).nullable(),
  availability: HarnessInstanceAvailabilitySchema, retirementMessage: z.string().optional(), driverRevision: Identity.optional(),
}).strict()
export type ConfiguredHarnessInstanceDto = z.infer<typeof ConfiguredHarnessInstanceSchema>
const HarnessTargetEnvironmentSchema = z.object({
  generation: Identity, provenance: z.enum(['terminal', 'gui', 'systemd', 'ssh', 'worker']), cwd: z.string(), path: z.string(),
}).strict()
const HarnessLauncherEvidenceSchema = z.object({
  requested: z.string(), resolvedLauncher: z.string().nullable(), fingerprint: z.string().nullable(),
  payloadFingerprints: z.array(z.object({ path: z.string(), fingerprint: Identity }).strict()).optional(),
  status: z.enum(['installed', 'missing', 'not-executable', 'broken-symlink', 'missing-interpreter', 'unreadable']),
  interpreter: z.string().nullable(), diagnostics: z.array(z.string()), environment: HarnessTargetEnvironmentSchema, checkedAt: z.string().datetime(),
}).strict()
export const HostHarnessInstallationSchema = z.object({
  hostRef: HarnessHostReferenceSchema, harnessInstallationId: Identity, installationFingerprint: Identity.nullable(),
  driverId: Identity, driverRevision: Identity, protocolRevision: Identity,
  environmentGeneration: Identity, connectionGeneration: Identity,
  launcher: HarnessLauncherEvidenceSchema, observedVersion: z.string().nullable(), installed: z.boolean(),
  claudeSdk: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/u),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/=]+$/u) }).strict().optional(),
  authenticated: z.boolean().nullable(), compatible: z.boolean().nullable(), qualified: z.boolean().nullable(),
}).strict()
export type HostHarnessInstallationDto = z.infer<typeof HostHarnessInstallationSchema>
export const PinnedHarnessSelectionSchema = z.object({
  driverId: Identity, instanceId: Identity, instanceRevision: Identity, hostRef: HarnessHostReferenceSchema,
  harnessInstallationId: Identity, installationFingerprint: Identity,
}).strict()
/** References to W09/W08 permitted roots, never a new root authority or filesystem proof. */
const HarnessWorkspaceRootReferenceSchema = z.object({
  rootId: z.uuid(), bindingRevision: z.number().int().positive(), rootPolicyId: Identity,
  rootPolicyRevision: z.string().regex(/^[1-9][0-9]*$/), locationRevision: z.string().regex(/^[1-9][0-9]*$/),
  workspaceId: Identity, rootPath: z.string().min(1), accessMode: z.enum(['read-only', 'exclusive-write']),
}).strict()
export const HarnessHostInventoryMetadataSchema = z.object({
  hostRef: HarnessHostReferenceSchema, applicationInstallationId: z.uuid(),
  connection: DevicePresenceSchema.nullable(),
  platform: z.object({ platform: Identity, architecture: Identity }).strict().nullable(),
  // Null means no authorized canonical-root projection is supplied, not an empty allowlist.
  workspaceRoots: z.array(HarnessWorkspaceRootReferenceSchema).nullable(),
}).strict().superRefine((value, context) => {
  if (value.connection === null) return
  const binding = value.connection.binding
  if (value.hostRef.kind !== 'device' || binding.mainId !== value.hostRef.mainId
    || binding.deviceId !== value.hostRef.deviceId || binding.workerInstallationId !== value.applicationInstallationId) {
    context.addIssue({ code: 'custom', path: ['connection'], message: 'Observed connection must belong to the exact canonical device and application installation.' })
  }
})
export type HarnessHostInventoryMetadata = z.infer<typeof HarnessHostInventoryMetadataSchema>
export const HarnessRegistryReadbackSchema = z.object({
  hostMetadata: HarnessHostInventoryMetadataSchema.optional(),
  instances: z.array(ConfiguredHarnessInstanceSchema), installations: z.array(HostHarnessInstallationSchema),
}).strict()
export type HarnessRegistryReadback = z.infer<typeof HarnessRegistryReadbackSchema>


function validateHostEnvironment(configuration: HarnessConfiguration, context: z.RefinementCtx, prefix: string[]): void {
  if (configuration.harness !== 'codex') return
  for (const [key, text] of Object.entries(configuration.advanced?.shellEnvironment.set ?? {})) {
    if (/(?:API.?KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION|CREDENTIAL|COOKIE|PRIVATE.?KEY)/i.test(key)
      || /^(?:sk-proj-|sk-ant-|Bearer\s+)/i.test(text)
      || /^[a-z][a-z0-9+.-]*:\/\/[^@\s]+:[^@\s]+@/i.test(text)) {
      context.addIssue({ code: 'custom', path: [...prefix, 'advanced', 'shellEnvironment', 'set', key],
        message: 'Credential environment values must stay in the target native credential store.' })
    }
  }
}


export const HostHarnessOverrideSaveSchema = z.object({
  commandId: optionalCommandId(z.uuid()), instanceId: z.uuid(), expectedRevision: z.number().int().nonnegative().optional().describe('Omit for last write wins; supply to reject a stale revision.'),
  target: HostHarnessOverrideTargetSchema, presetId: Identity, enabled: z.boolean(),
  configuration: z.lazy(() => SupportedHarnessConfigurationSchema),
}).strict().superRefine((value, context) => validateHostEnvironment(value.configuration, context, ['configuration']))
export type HostHarnessOverrideSave = z.infer<typeof HostHarnessOverrideSaveSchema>
export const HostHarnessOverrideSchema = z.object({
  instanceId: z.uuid(), revision: z.number().int().positive(), instanceRevision: Identity,
  target: HostHarnessOverrideTargetSchema, presetId: Identity, enabled: z.boolean(), driverId: Identity,
  configuration: z.lazy(() => HarnessConfigurationSchema), configurationFingerprint: Identity,
  qualification: z.enum(['unqualified', 'qualifying', 'qualified', 'installation-changed', 'disabled', 'retired']),
  qualificationFailure: z.object({ code: Identity, message: z.string().min(1).max(500) }).strict().optional(),
  retirementMessage: z.string().optional(),
}).strict()
export type HostHarnessOverride = z.infer<typeof HostHarnessOverrideSchema>
export const HostHarnessOverrideListInputSchema = z.object({
  hostRef: HarnessHostReferenceSchema, applicationInstallationId: z.uuid(),
}).strict()
export type HostHarnessOverrideListInput = z.infer<typeof HostHarnessOverrideListInputSchema>
export const HostHarnessOverrideListSchema = z.object({ overrides: z.array(HostHarnessOverrideSchema) }).strict()
export const HostHarnessOverrideSaveResultSchema = z.object({ value: HostHarnessOverrideSchema, replayed: z.boolean() }).strict()

export const HARNESS_DISCOVERY_NAMESPACE = 'harness-discovery-v1' as const
export const HarnessDiscoveryRequestSchema = z.object({ operation: z.literal('discover'), refreshId: z.uuid() }).strict()

export const HostHarnessInstanceCheckInputSchema = z.object({
  commandId: optionalCommandId(z.uuid()), instanceId: z.uuid(), expectedRevision: z.number().int().positive(), target: HostHarnessOverrideTargetSchema,
}).strict()
export type HostHarnessInstanceCheckInput = z.infer<typeof HostHarnessInstanceCheckInputSchema>
export const CompletedNativeQualificationSchema = z.object({
  purpose: z.literal('explicit-host-qualification'), checkId: z.uuid(), binding: DeviceSessionBindingSchema,
  target: HostHarnessOverrideTargetSchema, binarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  record: RecordedHarnessQualificationSchema,
}).strict()

/** Native-produced exact-profile evidence; callers cannot supply it to the check command. */
export const HostHarnessProfileEvidenceSchema = z.object({
  target: HostHarnessOverrideTargetSchema, instanceRevision: Identity, configurationFingerprint: Identity,
  driverId: Identity, driverRevision: Identity, protocolRevision: Identity, suiteRevision: Identity,
  environmentGeneration: Identity, connectionGeneration: Identity,
  authenticated: z.boolean().nullable(), compatible: z.boolean().nullable(), qualified: z.boolean(), checkedAt: z.string().datetime(),
  modelCatalogSource: z.enum(['native', 'cached']).optional(),
  failure: z.object({ code: Identity, message: z.string().min(1).max(500) }).strict().optional(),
  /** Native-produced provider checks stored in this same exact-host profile proof. */
  claudeProof: ClaudeQualificationProofSchema.optional(),
  completedNativeQualification: CompletedNativeQualificationSchema.optional(),
}).strict()
export type HostHarnessProfileEvidence = z.infer<typeof HostHarnessProfileEvidenceSchema>
export const HostHarnessInstanceCheckResultSchema = z.object({
  value: HostHarnessOverrideSchema, proof: HostHarnessProfileEvidenceSchema, replayed: z.boolean(),
}).strict()
export const HARNESS_PROFILE_CHECK_NAMESPACE = 'host-harness-check-v1' as const
export const HostHarnessProfileCheckRequestSchema = z.object({
  checkId: z.uuid(), override: HostHarnessOverrideSchema,
}).strict().superRefine((value, context) => validateHostEnvironment(value.override.configuration, context, ['override', 'configuration']))
export const HostHarnessConfigurationInspectionRequestSchema = z.object({
  operation: z.literal('operator-configuration-inspect'),
  override: HostHarnessOverrideSchema,
  proof: HostHarnessProfileEvidenceSchema,
  endpoint: z.string().url(),
}).strict().superRefine((value, context) => validateHostEnvironment(value.override.configuration, context, ['override', 'configuration']))
export type HostHarnessConfigurationInspectionRequest = z.infer<typeof HostHarnessConfigurationInspectionRequestSchema>

export { HarnessOptionsDiscoveryRequestSchema, type HarnessOptionsDiscoveryRequest } from './harnessOptionsDiscovery.js'
