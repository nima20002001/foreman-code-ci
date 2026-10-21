import { z } from 'zod'
import { DeviceDigestSchema, DeviceSafeIntegerSchema } from './deviceResources.js'
import { IdSchema, TimestampSchema } from './schemaPrimitives.js'

const path = z.string().min(1).max(2048).refine(value => !value.startsWith('/')
  && !value.includes('\\') && !value.includes('\0')
  && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Safe seed path required.')

/** Protected installer input. Public profile saves do not accept seed trust or review metadata. */
export const JobVerificationOfflineSeedReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  packageManager: z.literal('pnpm@11.27.0'),
  platform: z.object({ os: z.literal('linux'), arch: z.literal('x64'), libc: z.literal('glibc') }).strict(),
  minimumReleaseAge: z.literal(2880),
  minimumReleaseAgeStrict: z.literal(true),
  minimumReleaseAgeIgnoreMissingTime: z.literal(false),
  capturedAt: TimestampSchema,
  provenanceDigest: DeviceDigestSchema,
  review: z.object({ reviewedByPrincipalId: IdSchema, reviewedAt: TimestampSchema,
    decisionDigest: DeviceDigestSchema }).strict(),
  maxBytes: DeviceSafeIntegerSchema.positive(),
  maxInodes: DeviceSafeIntegerSchema.positive(),
  dependencyInputs: z.array(z.object({ path, sha256: DeviceDigestSchema }).strict()).min(3).max(256),
  files: z.array(z.object({ path, bytes: DeviceSafeIntegerSchema,
    sha256: DeviceDigestSchema }).strict()).min(3).max(1_000_000),
  packages: z.array(z.object({ name: z.string().min(1).max(214), version: z.string().min(1).max(200),
    integrity: z.string().min(1).max(1024), publishedAt: TimestampSchema, metadataPath: path }).strict())
    .max(100_000),
}).strict().superRefine((receipt, context) => {
  const inputs = new Set(receipt.dependencyInputs.map(input => input.path))
  const files = new Map(receipt.files.map(file => [file.path, file]))
  const bytes = receipt.files.reduce((total, file) => total + file.bytes, 0)
  const packages = new Set(receipt.packages.map(pkg => `${pkg.name}@${pkg.version}`))
  if (inputs.size !== receipt.dependencyInputs.length
    || !['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].every(name => inputs.has(name))
    || receipt.dependencyInputs.some(input => !['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(input.path)
      && !/^(?:apps|packages)\/[^/]+\/package\.json$/.test(input.path))
    || files.size !== receipt.files.length || packages.size !== receipt.packages.length
    || !Number.isSafeInteger(bytes) || bytes > receipt.maxBytes || files.size > receipt.maxInodes
    || receipt.files.some(file => !/^(?:corepack-cache|pnpm-store|registry-cache|metadata)\//.test(file.path))
    || !['corepack-cache', 'pnpm-store', 'registry-cache'].every(directory =>
      receipt.files.some(file => file.path.startsWith(`${directory}/`)))
    || Date.parse(receipt.review.reviewedAt) < Date.parse(receipt.capturedAt)
    || receipt.packages.some(pkg => !pkg.metadataPath.startsWith('metadata/') || !files.has(pkg.metadataPath)
      || Date.parse(receipt.capturedAt) - Date.parse(pkg.publishedAt) < 2880 * 60_000)) {
    context.addIssue({ code: 'custom', message: 'Offline seed must retain reviewed inputs, bounded inventories and mature releases.' })
  }
})

/** Files whose bytes decide the offline dependency seed: the workspace manifests, lockfile and policy. */
function isJobDependencyInputPath(path: string): boolean {
  return ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
    || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path)
}
const DependencyInputSchema = z.object({ path: z.string().min(1).max(1024), sha256: DeviceDigestSchema }).strict()
/** The dependency files of a source manifest, sorted by path. */
export function jobDependencyInputs(entries: readonly { path: string; sha256?: string | null }[]): z.infer<typeof DependencyInputSchema>[] {
  return entries.filter(entry => isJobDependencyInputPath(entry.path) && typeof entry.sha256 === 'string')
    .map(entry => ({ path: entry.path, sha256: entry.sha256! }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}
export function sameJobDependencyInputs(left: readonly { path: string; sha256: string }[], right: readonly { path: string; sha256: string }[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.path === right[index]!.path && entry.sha256 === right[index]!.sha256)
}
/** A verification Job may run a commit other than the one its computer qualified when the dependency
 * files are byte-identical, so the qualified offline seed installs it exactly. */
export const JobDependencyBasisSchema = z.object({
  qualificationCommit: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
  inputs: z.array(DependencyInputSchema).min(3).max(256),
}).strict().superRefine((value, context) => {
  if (value.inputs.some(input => !isJobDependencyInputPath(input.path))
    || !sameJobDependencyInputs(value.inputs, jobDependencyInputs(value.inputs))) {
    context.addIssue({ code: 'custom', message: 'A dependency basis lists only sorted dependency files.' })
  }
})
export type JobDependencyBasis = z.infer<typeof JobDependencyBasisSchema>
