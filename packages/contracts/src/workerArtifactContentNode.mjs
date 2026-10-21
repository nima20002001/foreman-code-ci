import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/**
 * Build provenance and product version do not change the installed Worker bytes.
 * @param {Pick<import('./workerUpdate.js').WorkerArtifactManifest,
 * 'format' | 'packageManager' | 'protocolVersion' | 'identityFormat' | 'target' | 'files'>} manifest
 */
export function workerArtifactContentSha256(manifest) {
  const hash = createHash('sha256').update('worker-bundle-content-v1\0')
  const { os, osRelease, arch, libc, node } = manifest.target
  const facts = [manifest.format, manifest.packageManager, manifest.protocolVersion,
    manifest.identityFormat, os, osRelease, arch, libc, node, manifest.files.length]
  const files = [...manifest.files].sort((left, right) => {
    if (left.path === right.path) return 0
    return left.path < right.path ? -1 : 1
  })
  const values = [...facts, ...files.flatMap(file => [file.path, file.size, file.sha256])]
  for (const value of values) {
    const text = String(value)
    // Length framing makes file paths and facts unambiguous without serializing metadata.
    hash.update(`${Buffer.byteLength(text)}:${text}`)
  }
  return hash.digest('hex')
}
