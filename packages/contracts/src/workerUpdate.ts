import { z } from 'zod'

export const WORKER_UPDATE_NAMESPACE = 'worker-update-v1'
export const WORKER_UPDATE_VERSION = 1
export const WORKER_UPDATE_MAX_JSON_BYTES = 1_048_576
export const WORKER_UPDATE_MAX_BINARY_BYTES = 0
export const WORKER_UPDATE_DRAIN_TIMEOUT_MS = 30 * 60_000
export const WORKER_UPDATE_ATTEMPT_TIMEOUT_MS = 45 * 60_000
/** Publication retries share one deadline from when publication becomes pending. */
export const WORKER_PUBLICATION_DEADLINE_MS = 2 * 60 * 60_000

const WorkerUpdatePhaseSchema = z.enum([
  'current', 'pending', 'draining', 'downloading', 'installing', 'restarting', 'rolled-back', 'failed',
])
const WorkerArtifactTargetSchema = z.object({
  os: z.string().min(1).max(100),
  osRelease: z.string().min(1).max(100),
  arch: z.string().min(1).max(100),
  libc: z.string().min(1).max(100),
  node: z.string().min(1).max(100),
}).strict()
export type WorkerArtifactTarget = z.infer<typeof WorkerArtifactTargetSchema>

export const WorkerUpdateStatusSchema = z.object({
  currentVersion: z.string().min(1).max(128),
  target: WorkerArtifactTargetSchema.optional(),
  /** Hash of the running release, independently of a pending or failed update target. */
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  /** Identity of running bundle files, target facts and protocol versions, excluding build metadata. */
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  targetVersion: z.string().min(1).max(128).nullable(),
  state: WorkerUpdatePhaseSchema,
  lastError: z.string().max(2000).nullable(),
}).strict()
export type WorkerUpdateStatus = z.infer<typeof WorkerUpdateStatusSchema>

export const WorkerBundleIdentitySchema = z.object({
  version: z.string().min(1).max(128),
  target: WorkerArtifactTargetSchema.nullable(),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).strict()
export type WorkerBundleIdentity = z.infer<typeof WorkerBundleIdentitySchema>

export const WorkerBundleReadinessSchema = z.object({
  ready: z.boolean(),
  code: z.enum(['WORKER_VERSION_SKEW', 'WORKER_BUNDLE_UNPUBLISHED', 'WORKER_UPDATING']).nullable(),
  expected: WorkerBundleIdentitySchema.nullable(),
  running: WorkerBundleIdentitySchema.nullable(),
  updatePhase: WorkerUpdatePhaseSchema.nullable(),
  publicationError: z.string().max(2000).nullable(),
}).strict()
export type WorkerBundleReadiness = z.infer<typeof WorkerBundleReadinessSchema>

const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const artifactPath = z.string().min(1).max(1024).regex(/^[a-zA-Z0-9_@./-]+$/u)
  .refine(path => path.split('/').every(part => part !== '' && part !== '.' && part !== '..'))
const fileSize = z.number().int().nonnegative().max(64 * 1024 * 1024)

export const WorkerArtifactManifestSchema = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  lockfileSha256: digest,
  packageManager: z.literal('pnpm@11.27.0'),
  protocolVersion: z.literal(1),
  identityFormat: z.literal(1),
  target: WorkerArtifactTargetSchema,
  files: z.array(z.object({
    path: artifactPath,
    sha256: digest,
    size: fileSize,
  }).strict()).min(1).max(512),
}).passthrough().refine(manifest => {
  const paths = new Set(manifest.files.map(file => file.path))
  return paths.size === manifest.files.length && paths.has('src/cli.mjs') && !paths.has('manifest.json')
}, 'Invalid artifact file list')
export type WorkerArtifactManifest = z.infer<typeof WorkerArtifactManifestSchema>

const WorkerPublicationFieldsSchema = z.object({
  state: z.enum(['pending', 'published', 'failed']),
  lastError: z.string().max(2000).nullable(),
  startedAt: z.string().datetime().optional(),
  /** The pending publication's start plus WORKER_PUBLICATION_DEADLINE_MS; retries keep it. */
  deadlineAt: z.string().datetime().optional(),
  nextRetryAt: z.string().datetime().optional(),
}).strict()
export const WorkerReleasePublicationSchema = WorkerPublicationFieldsSchema.extend({
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
})
export type WorkerReleasePublication = z.infer<typeof WorkerReleasePublicationSchema>

/** Where Workers download a release: a GitHub release asset per artifact, named <manifestSha256>.tar.gz. */
const WorkerArtifactGitHubSchema = z.object({
  repository: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u),
  tag: z.string().regex(/^worker-[a-f0-9]{12,64}$/u),
}).strict()
export const WorkerArtifactIndexSchema = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  /** Installed release provenance; retained bundles keep their original build manifest. */
  commit: z.string().regex(/^[a-f0-9]{40}$/u).optional(),
  github: WorkerArtifactGitHubSchema.optional(),
  /** Published only after every GitHub asset has been downloaded and checksum verified. */
  publication: WorkerPublicationFieldsSchema.optional(),
  publicationRecovery: z.object({
    abandonedAttempts: z.number().int().nonnegative(),
    lastAbandonedAt: z.string().datetime(),
  }).strict().optional(),
  artifacts: z.array(z.object({
    target: WorkerArtifactTargetSchema,
    manifestSha256: digest,
    contentSha256: digest.optional(),
    /** Verified publication retained when this target's bundle is unchanged. */
    github: WorkerArtifactGitHubSchema.optional(),
  }).strict()).max(100),
}).strict()

export const WorkerArtifactRequestSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('release'), target: WorkerArtifactTargetSchema }).strict(),
  z.object({ operation: z.literal('ci-smoke'), manifestSha256: digest }).strict(),
])

export const WorkerCiSmokeSchema = z.object({ repository: WorkerArtifactGitHubSchema.shape.repository,
  commit: z.string().regex(/^[a-f0-9]{40}$/u) }).strict()

export const WorkerArtifactReplySchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('release'),
    release: z.object({
      version: z.string().regex(/^\d+\.\d+\.\d+$/u),
      manifestSha256: digest,
      manifest: z.unknown(),
      github: WorkerArtifactGitHubSchema.optional(),
    }).strict().nullable(),
  }).strict(),
  z.object({ operation: z.literal('ci-smoke'), ciSmoke: WorkerCiSmokeSchema.nullable() }).strict(),
])
