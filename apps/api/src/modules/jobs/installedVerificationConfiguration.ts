import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { SourceManifestSchema } from '@foreman-code/contracts/source-materialization'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobVerificationRuntimeFingerprintSchema, JobVerificationInstalledRuntimeDescriptorSchema, VerificationToolKindSchema }
  from '@foreman-code/contracts/job-verification-runtime'

export const MAX_VERIFICATION_CONFIGURATION_BYTES = 2 * 1024 * 1024 + 65536

const machine = z.object({ ...JobVerificationRuntimeFingerprintSchema.shape }).omit({
  schemaVersion: true, profileId: true, profileRevision: true, specDigest: true,
  hostRef: true, registration: true, mainInstallationId: true, root: true,
}).extend({ tools: z.array(JobVerificationRuntimeFingerprintSchema.shape.tools.element.extend({
  kind: VerificationToolKindSchema,
})).max(16) })
const InstalledVerificationRuntimeConfigurationFields = z.object({
  schemaVersion: z.literal(2), root: SourceRootRecordSchema,
  descriptor: JobVerificationInstalledRuntimeDescriptorSchema,
  machine,
  seedReceiptPath: z.string().startsWith('/').max(2048),
  seedReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  qualificationSource: z.object({ directory: z.string().startsWith('/').max(2048),
    manifest: SourceManifestSchema }).strict(),
}).strict()
export const InstalledVerificationRuntimeConfigurationSchema = InstalledVerificationRuntimeConfigurationFields.superRefine((value, context) => {
  const { descriptor, machine } = value
  if (descriptor.runtimeExecutable !== machine.runtimeExecutable || descriptor.ociExecutable !== machine.ociExecutable
    || !isDeepStrictEqual(descriptor.resources, machine.resources)
    || !isDeepStrictEqual(descriptor.quotaPool, machine.quotaPool)
    || !isDeepStrictEqual(descriptor.network, machine.network)
    || !isDeepStrictEqual(descriptor.approvalConfig, machine.approvalConfig)
    || value.seedReceiptSha256 !== machine.seedReceiptSha256
    || value.qualificationSource.manifest.manifestDigest !== value.root.source.manifestDigest
    || value.qualificationSource.manifest.snapshotId !== value.root.source.snapshotId
    || value.qualificationSource.manifest.approvedSourceId !== value.root.source.approvedSourceId
    || value.qualificationSource.manifest.git?.commit !== machine.sourceCommit) {
    context.addIssue({ code: 'custom', message: 'Protected descriptor and verification fingerprint must agree.' })
  }
})

export const InstalledVerificationRuntimeCaptureInputSchema = InstalledVerificationRuntimeConfigurationFields.omit({
  machine: true, seedReceiptSha256: true,
}).extend({
  machine: machine.omit({ bootId: true, runtimeBinarySha256: true, ociBinarySha256: true,
    configurationDigest: true, seedReceiptSha256: true, tools: true }),
  toolSources: z.array(z.object({
    kind: VerificationToolKindSchema,
    executable: z.string().startsWith('/').max(1024),
    sourceExecutable: z.string().startsWith('/').max(2048),
    version: z.string().min(1).max(200),
  }).strict()).max(16),
}).strict()
export type InstalledVerificationRuntimeCaptureInput = z.infer<typeof InstalledVerificationRuntimeCaptureInputSchema>
export type InstalledVerificationRuntimeConfiguration = z.infer<typeof InstalledVerificationRuntimeConfigurationSchema>
