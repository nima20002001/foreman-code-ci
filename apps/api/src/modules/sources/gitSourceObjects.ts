import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { ensureClone, type GitWorktreePorts } from './gitWorktree.js'
import { SOURCE_LIMITS, SourceError, verifySourceBytes } from './manifest.js'

// Local Git diagnostics contain paths and arbitrary config output. Retain only
// diagnostic vocabulary; unknown words may contain credentials or identities.
const diagnosticWords = new Set(('fatal error warning unable to add database hash object objects file files '
  + 'directory temporary create open read write permission denied no such or not a git repository '
  + 'invalid corrupt malformed missing bad tree commit blob format sha1 sha256 mismatch '
  + 'too many arguments argument list long cannot could failed failure lock ref reference '
  + 'is empty exists already expected found disk space left on device operation aborted '
  + 'signal killed timed out broken pipe resource temporarily unavailable input output').split(' '))

function importFailure(operation: string, code: number, stderr: string): SourceError {
  // ANSI CSI sequences intentionally start with the ESC control character.
  // eslint-disable-next-line no-control-regex
  const diagnostic = stderr.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[^\s]+/g, token => diagnosticWords.has(token.toLowerCase().replace(/^[(:]+|[):,.;]+$/g, ''))
      ? token : `[redacted]${/[):,.;]+$/.exec(token)?.[0] ?? ''}`)
    .replace(/\s+/g, ' ').trim().slice(0, 512)
  return new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE',
    `git ${operation} failed (exit ${code}) while importing approved objects: ${diagnostic || 'No stderr.'}`)
}

const ObjectsSchema = z.array(z.object({
  kind: z.enum(['commit', 'tree']), object: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  bytes: z.string().max(3 * 1024 * 1024),
}).strict()).min(2).max(SOURCE_LIMITS.entries * 32 + 1)

type SourceObjectImport = {
  ports: GitWorktreePorts; repository: string; manifest: SourceManifest; metadata: Uint8Array;
  blobPath(path: string): Promise<string>; signal: AbortSignal;
}
const imports = new Map<string, Promise<string>>()

/** Concurrent preparations of one verified snapshot share its Git object import. */
export async function importGitSourceObjects(input: SourceObjectImport): Promise<string> {
  input.signal.throwIfAborted()
  const metadata = input.manifest.git?.metadata
  if (!metadata) throw new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'Approved Git metadata is missing.')
  verifySourceBytes({ ...metadata, path: 'git-objects.json', kind: 'file', executable: false }, input.metadata)
  const key = JSON.stringify([input.ports.cloneDirectory(input.repository), input.repository, input.manifest.manifestDigest])
  const existing = imports.get(key)
  const pending = existing ?? importSourceObjects({ ...input, signal: AbortSignal.timeout(SOURCE_LIMITS.preparationMs) })
  if (!existing) imports.set(key, pending)
  try {
    const clone = await pending
    input.signal.throwIfAborted()
    return clone
  } finally {
    if (!existing) imports.delete(key)
  }
}

/** Delivers only the approved commit, trees and blobs; repository history is not source approval. */
async function importSourceObjects(input: SourceObjectImport): Promise<string> {
  const { ports, manifest, signal } = input
  const provenance = manifest.git
  if (!provenance?.metadata) throw new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'Approved Git metadata is missing.')
  verifySourceBytes({ ...provenance.metadata, path: 'git-objects.json', kind: 'file', executable: false }, input.metadata)
  const objects = ObjectsSchema.parse(JSON.parse(Buffer.from(input.metadata).toString('utf8')))
  const clone = await ensureClone(ports, input.repository, signal)
  const scratch = await mkdtemp(join(tmpdir(), 'foreman-source-objects-'))
  const git = async (args: string[]) => {
    const result = await ports.git(['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', ...args],
      { cwd: clone, signal, env: { GIT_NO_LAZY_FETCH: '1' } })
    if (result.code !== 0) throw importFailure(args[0]!, result.code, result.stderr)
    return result.stdout.trim()
  }
  const hashFiles = async (kind: 'commit' | 'tree' | 'blob', files: { file: string; object?: string }[]) => {
    let offset = 0
    while (offset < files.length) {
      signal.throwIfAborted()
      const batch: typeof files = []
      let argumentBytes = 0
      // Bound both argv bytes and output, including long UTF-8 source paths.
      while (offset < files.length && batch.length < 64) {
        const file = files[offset]!
        const size = Buffer.byteLength(file.file) + 1
        if (batch.length && argumentBytes + size > 32 * 1024) break
        batch.push(file)
        argumentBytes += size
        offset++
      }
      const hashes = (await git(['hash-object', '-w', '-t', kind, '--no-filters', '--',
        ...batch.map(file => file.file)])).split('\n')
      if (hashes.length !== batch.length || batch.some((file, index) => file.object && file.object !== hashes[index])) {
        throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'The destination uses another Git object format.')
      }
    }
  }
  try {
    if (await git(['rev-parse', '--show-object-format']) !== provenance.objectFormat) {
      throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'The destination uses another Git object format.')
    }
    const metadataFiles: Record<'commit' | 'tree', { file: string; object: string }[]> = { commit: [], tree: [] }
    for (const [index, object] of objects.entries()) {
      signal.throwIfAborted()
      const bytes = Buffer.from(object.bytes, 'base64')
      const hash = createHash(provenance.objectFormat).update(`${object.kind} ${bytes.length}\0`).update(bytes).digest('hex')
      if (hash !== object.object) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git metadata has an invalid object identity.')
      const file = join(scratch, `object-${index}`)
      await writeFile(file, bytes, { mode: 0o600 })
      metadataFiles[object.kind].push({ file, object: object.object })
    }
    await hashFiles('commit', metadataFiles.commit)
    await hashFiles('tree', metadataFiles.tree)
    const blobs: { file: string }[] = []
    for (const entry of manifest.entries) {
      signal.throwIfAborted()
      blobs.push({ file: await input.blobPath(entry.path) })
    }
    await hashFiles('blob', blobs)
    if (!objects.some(object => object.kind === 'commit' && object.object === provenance.commit)
      || await git(['rev-parse', `${provenance.commit}^{tree}`]) !== provenance.tree) {
      throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git metadata does not contain the approved commit and tree.')
    }
    await git(['rev-list', '--objects', '--no-object-names', '--missing=error', `${provenance.commit}^{tree}`])
    await git(['update-ref', `refs/foreman/sources/${manifest.snapshotId}`, provenance.commit])
    return clone
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}
