import { createHash } from 'node:crypto'
import { DomainError } from '../errors.js'
import { SOURCE_ENTRY_LIMIT, SOURCE_MANIFEST_MAX_BYTES, SourceManifestSchema, type SourceManifest, type SourceEntry } from '@foreman-code/contracts/source-materialization'

export class SourceError extends DomainError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    let status = 400
    if (code === 'SOURCE_CAPACITY') status = 413
    if (code === 'SOURCE_CAPTURE_TIMEOUT') status = 503
    if (code === 'COMPUTER_GITHUB_REQUIRED') status = 409
    super(code, message, status)
    if (options && 'cause' in options) this.cause = options.cause
    this.name = 'SourceError'
  }
}
export const SOURCE_LIMITS = Object.freeze({ entries: SOURCE_ENTRY_LIMIT, bytes: 128 * 1024 * 1024,
  fileBytes: 16 * 1024 * 1024, depth: 32, preparationMs: 300_000, concurrent: 2 })
// Credential implementation/test/declaration leaves are code, not credential data or directories.
// Byte verification still applies; data/backup suffixes never qualify as source filenames.
const credentialSourceLeaf = /^credentials(?:(?:\.(?:test|spec))?\.(?:[cm]?[jt]s|[jt]sx)|\.d\.[cm]?ts)$/
export function sourcePath(path: string): string {
  if (!path || path.length > 1024 || path.normalize('NFC') !== path || /[\\:]/u.test(path) || [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))
    || path.split('/').length > SOURCE_LIMITS.depth) throw new SourceError('SOURCE_PATH_INVALID', 'Source paths must be unambiguous relative paths.')
  const parts = path.toLowerCase().split('/')
  if (parts.some((part, index) => /^(?:\.git|\.ssh|\.aws|\.config|\.local|\.mozilla|\.gnupg|node_modules|\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\..*)?|.*\.pem|.*\.key|.*\.sqlite(?:3)?|.*\.db)$/.test(part)
    && part !== '.env.example' && !(index === parts.length - 1 && credentialSourceLeaf.test(part))) || parts.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part))) {
    throw new SourceError('SOURCE_SENSITIVE_PATH', 'The approved source includes a credential, runtime, or unsupported path; approve a different snapshot.')
  }
  return path
}
export function sourceSha256(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
export function manifestDigest(manifest: Omit<SourceManifest, 'manifestDigest'>): string {
  // Fixed construction order is part of v1; caller JSON property order is irrelevant.
  return sourceSha256(Buffer.from(JSON.stringify({ version: manifest.version, snapshotId: manifest.snapshotId,
    approvedSourceId: manifest.approvedSourceId, capturePolicy: manifest.capturePolicy,
    executablePolicy: manifest.executablePolicy, git: manifest.git ? { commit: manifest.git.commit,
      tree: manifest.git.tree, objectFormat: manifest.git.objectFormat,
      ...(manifest.git.repository ? { repository: manifest.git.repository } : {}),
      ...(manifest.git.metadata ? { metadata: { byteSize: manifest.git.metadata.byteSize,
        sha256: manifest.git.metadata.sha256 } } : {}) } : null,
    entries: manifest.entries.map((e) => ({ path: e.path, kind: e.kind, byteSize: e.byteSize, sha256: e.sha256, executable: e.executable })),
    deletions: manifest.deletions, overlayBaseDigest: manifest.overlayBaseDigest ?? null,
    totalEntries: manifest.totalEntries, totalBytes: manifest.totalBytes })))
}
export function verifySourceManifest(input: unknown): SourceManifest {
  const manifest = SourceManifestSchema.parse(input)
  if (Buffer.byteLength(JSON.stringify(manifest)) > SOURCE_MANIFEST_MAX_BYTES) throw new SourceError('SOURCE_CAPACITY', 'Source manifest metadata exceeds its separate 2 MiB budget.')
  const paths = new Set<string>()
  let previous = '', bytes = 0
  for (const entry of manifest.entries) {
    sourcePath(entry.path)
    const folded = entry.path.toLowerCase()
    if (previous && previous >= entry.path || paths.has(folded)) throw new SourceError('SOURCE_PATH_COLLISION', 'Entries must be sorted and unique without case aliases.')
    previous = entry.path; paths.add(folded); bytes += entry.byteSize
    if (manifest.executablePolicy === 'strip' && entry.executable) throw new SourceError('SOURCE_POLICY_INVALID', 'Executable bits require explicit approval.')
  }
  for (const path of paths) {
    const components = path.split('/')
    for (let i = 1; i < components.length; i++) if (paths.has(components.slice(0, i).join('/'))) throw new SourceError('SOURCE_PATH_COLLISION', 'A file cannot also be a directory.')
  }
  previous = ''
  const removed = new Set<string>()
  for (const deletion of manifest.deletions) {
    sourcePath(deletion)
    if (previous && previous >= deletion || paths.has(deletion.toLowerCase()) || removed.has(deletion.toLowerCase())) throw new SourceError('SOURCE_PATH_COLLISION', 'Deletion paths must be sorted and separate from included files.')
    previous = deletion; removed.add(deletion.toLowerCase())
  }
  if (manifest.totalEntries !== manifest.entries.length || manifest.totalBytes !== bytes || manifestDigest(manifest) !== manifest.manifestDigest)
    throw new SourceError('SOURCE_MANIFEST_INVALID', 'Source totals or digest do not match the complete manifest.')
  if (manifest.capturePolicy === 'git-tree-v1' && (!manifest.git || manifest.deletions.length || manifest.overlayBaseDigest)
    || manifest.git && (manifest.git.commit.length !== (manifest.git.objectFormat === 'sha1' ? 40 : 64) || manifest.git.tree.length !== manifest.git.commit.length))
    throw new SourceError('SOURCE_POLICY_INVALID', 'Git source provenance must identify an exact complete tree.')
  return manifest
}
export function createSourceManifest(input: Omit<SourceManifest, 'manifestDigest' | 'totalEntries' | 'totalBytes'>): SourceManifest {
  const complete = { ...input, totalEntries: input.entries.length, totalBytes: input.entries.reduce((sum, e) => sum + e.byteSize, 0) }
  return verifySourceManifest({ ...complete, manifestDigest: manifestDigest(complete) })
}
export function verifySourceBytes(entry: SourceEntry, bytes: Uint8Array): void {
  if (bytes.byteLength !== entry.byteSize || sourceSha256(bytes) !== entry.sha256) throw new SourceError('SOURCE_BYTES_INVALID', 'Source content does not match its accepted manifest.')
  if (/^-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\r?$/m.test(Buffer.from(bytes).toString('latin1')))
    throw new SourceError('SOURCE_SECRET_CONTENT', 'Private key content is not approved source.')
}
