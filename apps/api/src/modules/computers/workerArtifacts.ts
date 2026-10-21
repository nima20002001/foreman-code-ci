import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { workerArtifactContentSha256 } from '@foreman-code/contracts/worker-artifact-content-node'
import {
  WORKER_PUBLICATION_DEADLINE_MS, WORKER_UPDATE_MAX_BINARY_BYTES, WORKER_UPDATE_MAX_JSON_BYTES, WORKER_UPDATE_NAMESPACE, WORKER_UPDATE_VERSION,
  WorkerArtifactIndexSchema, WorkerArtifactManifestSchema, WorkerArtifactRequestSchema, WorkerCiSmokeSchema,
  type WorkerArtifactManifest, type WorkerArtifactTarget, type WorkerReleasePublication, type WorkerBundleIdentity,
} from '@foreman-code/contracts/computer-maintenance'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { DomainError } from '../errors.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

function sameTarget(left: WorkerArtifactTarget, right: WorkerArtifactTarget) {
  return left.os === right.os && left.osRelease === right.osRelease && left.arch === right.arch
    && left.libc === right.libc && left.node === right.node
}

async function openArtifactFile(root: string, path: string) {
  const source = join(root, path)
  const parent = await realpath(dirname(source))
  if (parent !== root && !parent.startsWith(`${root}/`)) throw new DeviceApplicationError('extension-rejected')
  return open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
}

async function readRegularFile(root: string, path: string, maximum: number) {
  const file = await openArtifactFile(root, path)
  try {
    const info = await file.stat({ bigint: true })
    if (!info.isFile() || info.size > BigInt(maximum)) throw new DeviceApplicationError('extension-rejected')
    const bytes = await file.readFile()
    const after = await file.stat({ bigint: true })
    if (BigInt(bytes.byteLength) !== info.size || info.dev !== after.dev || info.ino !== after.ino
      || info.size !== after.size || info.mtimeNs !== after.mtimeNs || info.ctimeNs !== after.ctimeNs) {
      throw new DeviceApplicationError('extension-rejected')
    }
    return bytes
  } finally {
    await file.close()
  }
}

async function artifactIndex(directory: string, version: string) {
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new DeviceApplicationError('extension-rejected')
  }
  const root = await realpath(directory)
  const bytes = await readRegularFile(root, 'index.json', WORKER_UPDATE_MAX_JSON_BYTES)
  const index = WorkerArtifactIndexSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (index.version !== version) throw new DeviceApplicationError('extension-rejected')
  return { root, index }
}

async function artifactManifest(root: string, manifestSha256: string) {
  const directory = join(root, manifestSha256)
  if (!(await lstat(directory)).isDirectory()) throw new DeviceApplicationError('extension-rejected')
  const bytes = await readRegularFile(directory, 'manifest.json', WORKER_UPDATE_MAX_JSON_BYTES)
  if (sha256(bytes) !== manifestSha256) throw new DeviceApplicationError('extension-rejected')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  WorkerArtifactManifestSchema.parse(value)
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`))) {
    throw new DeviceApplicationError('extension-rejected')
  }
  const manifest = value as WorkerArtifactManifest
  return { manifest }
}

async function publishedArtifactIndex(options: { directory: string; version: string }) {
  const result = await artifactIndex(options.directory, options.version)
  const { index } = result
  if (!index.github || index.publication?.state !== 'published' || !index.artifacts.length) {
    const publicationError = index.publication?.lastError ?? 'Worker release assets have not been published.'
    throw new DomainError('WORKER_BUNDLE_UNPUBLISHED', publicationError, 503, { publicationError })
  }
  return result
}

export async function readWorkerManifestSha256s(options: { directory: string; version: string }): Promise<string[]> {
  const { index } = await publishedArtifactIndex(options)
  return index.artifacts.map(artifact => artifact.manifestSha256)
}

export async function readWorkerContentSha256s(options: { directory: string; version: string }): Promise<string[]> {
  const { root, index } = await publishedArtifactIndex(options)
  return Promise.all(index.artifacts.map(async artifact => {
    const { manifest } = await artifactManifest(root, artifact.manifestSha256)
    if (!sameTarget(manifest.target, artifact.target)) throw new DeviceApplicationError('extension-rejected')
    const contentSha256 = workerArtifactContentSha256(manifest)
    if (artifact.contentSha256 && artifact.contentSha256 !== contentSha256) {
      throw new DeviceApplicationError('extension-rejected')
    }
    return contentSha256
  }))
}

export async function readWorkerBundleIdentity(options: { directory: string; version: string },
  target?: WorkerArtifactTarget): Promise<WorkerBundleIdentity> {
  const { root, index } = await publishedArtifactIndex(options)
  if (!target) return { version: options.version, target: null, manifestSha256: null, contentSha256: null }
  const artifact = index.artifacts.find(entry => sameTarget(entry.target, target))
  if (!artifact) {
    throw new DomainError('WORKER_BUNDLE_UNPUBLISHED', 'No published Worker bundle matches this target.', 503,
      { publicationError: 'No published Worker bundle matches this target.' })
  }
  const { manifest } = await artifactManifest(root, artifact.manifestSha256)
  const contentSha256 = workerArtifactContentSha256(manifest)
  if (!sameTarget(manifest.target, target) || artifact.contentSha256 && artifact.contentSha256 !== contentSha256) {
    throw new DeviceApplicationError('extension-rejected')
  }
  return { version: manifest.version, target, manifestSha256: artifact.manifestSha256, contentSha256 }
}

export async function readWorkerReleasePublication(options: {
  directory: string; version: string; now?: number
}): Promise<WorkerReleasePublication> {
  const { index } = await artifactIndex(options.directory, options.version)
  const publication = index.publication ?? { state: 'pending' as const, lastError: null }
  const startedAt = publication.startedAt ? Date.parse(publication.startedAt) : null
  const deadline = publication.deadlineAt ? Date.parse(publication.deadlineAt)
    : startedAt === null ? null : startedAt + WORKER_PUBLICATION_DEADLINE_MS
  const now = options.now ?? Date.now()
  if (publication.state !== 'pending' || deadline === null || startedAt === null || now <= deadline) {
    return { version: index.version, ...publication }
  }
  // The publication unit records its own failures; a pending record past its deadline means it stopped reporting.
  return { version: index.version, ...publication, state: 'failed',
    lastError: `WORKER_PUBLICATION_DEADLINE_EXCEEDED: phase publishing, age ${Math.round((now - startedAt) / 60_000)} min, `
      + `over the ${Math.round((deadline - startedAt) / 60_000)} min limit. Cause: the publication unit stopped reporting `
      + 'progress; check the foreman-worker-publish service.' }
}

export function createWorkerArtifactExtension(options: {
  directory: string
  version: string
  buildEnabled?: (binding: DeviceSessionBinding) => Promise<boolean>
  ciSmoke?: () => Promise<unknown>
}): DeviceExtensionRegistration {
  return {
    namespace: WORKER_UPDATE_NAMESPACE,
    version: WORKER_UPDATE_VERSION,
    role: 'server',
    maxJsonBytes: WORKER_UPDATE_MAX_JSON_BYTES,
    maxBinaryBytes: WORKER_UPDATE_MAX_BINARY_BYTES,
    async handle(raw, context) {
      context.signal.throwIfAborted()
      if (context.bytes?.byteLength) throw new DeviceApplicationError('extension-rejected')
      const request = WorkerArtifactRequestSchema.parse(raw)
      const { root, index } = await artifactIndex(options.directory, options.version)
      if (!index.github || index.publication?.state !== 'published') {
        throw new DeviceApplicationError('WORKER_RELEASE_ASSET_UNAVAILABLE')
      }
      const artifact = request.operation === 'release'
        ? index.artifacts.find(entry => sameTarget(entry.target, request.target))
        : index.artifacts.find(entry => entry.manifestSha256 === request.manifestSha256)
      if (!artifact) {
        if (request.operation === 'release') return { payload: { operation: 'release', release: null } }
        throw new DeviceApplicationError('extension-rejected')
      }
      const { manifest } = await artifactManifest(root, artifact.manifestSha256)
      if (!sameTarget(manifest.target, artifact.target)) throw new DeviceApplicationError('extension-rejected')
      if (request.operation === 'ci-smoke') {
        const enabled = await options.buildEnabled?.(context.binding) ?? false
        if (!enabled) return { payload: { operation: 'ci-smoke', ciSmoke: null } }
        const configuration: unknown = options.ciSmoke
          ? await options.ciSmoke()
          : { repository: index.github.repository, commit: index.commit ?? manifest.commit }
        const smoke = WorkerCiSmokeSchema.safeParse(configuration)
        if (!smoke.success || smoke.data.commit !== (index.commit ?? manifest.commit)) {
          throw new DeviceApplicationError('WORKER_UPDATE_SMOKE_UNAVAILABLE')
        }
        return { payload: { operation: 'ci-smoke', ciSmoke: smoke.data } }
      }
      return { payload: { operation: 'release', release: {
        version: manifest.version, manifestSha256: artifact.manifestSha256, manifest,
        github: artifact.github ?? index.github,
      } } }
    },
  }
}
