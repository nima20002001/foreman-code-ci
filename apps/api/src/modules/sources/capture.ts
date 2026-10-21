import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { SourceManifest, SourceEntry } from '@foreman-code/contracts/source-materialization'
import { createSourceManifest, SOURCE_LIMITS, SourceError, sourcePath, sourceSha256, verifySourceBytes } from './manifest.js'
import type { ExclusiveSourceCapture } from './ports.js'
import { DomainError } from '../errors.js'
const execute = promisify(execFile)
const gitEnvironment = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' }
export interface SourceSnapshotSink {
  /** Writes quarantined, detached bytes into the source namespace, never file revisions. */
  write(snapshotId: string, entry: SourceEntry, bytes: Uint8Array): Promise<void>
  writeGitMetadata?(snapshotId: string, bytes: Uint8Array): Promise<void>
  commit(manifest: SourceManifest): Promise<void>
  abort(snapshotId: string): Promise<void>
}
export async function qualifiedGit(root: string, args: string[], maxBuffer = 2 * 1024 * 1024, signal?: AbortSignal): Promise<Buffer> {
  const result = await execute('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], {
    encoding: 'buffer', maxBuffer, timeout: SOURCE_LIMITS.preparationMs, ...(signal ? { signal } : {}),
    env: gitEnvironment,
  })
  return result.stdout
}
/** Inventory the pinned commit, never the index or working tree. Capture verifies its objects separately. */
export async function approvedGitTreePaths(root: string, commit: string): Promise<string[]> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new SourceError('SOURCE_GIT_REF_INVALID', 'An exact Git commit object is required; branch names are not source pins.')
  }
  const names = await qualifiedGit(root, ['ls-tree', '-rz', '--name-only', '--full-tree', commit], 8 * 1024 * 1024)
  const paths = names.toString('utf8').split('\0').filter(Boolean)
  if (!Buffer.from(names.toString('utf8')).equals(names)) {
    throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Unsupported Git path encoding.')
  }
  if (paths.length > SOURCE_LIMITS.entries) {
    throw new SourceError('SOURCE_CAPACITY', 'Tracked source inventory exceeds the supported source limits.')
  }
  return paths.map(sourcePath)
}
/** One bounded process verifies every exact commit/tree/blob in the capture. */
function gitObjectReader(root: string, objectFormat: string, signal: AbortSignal) {
  const child = spawn('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, 'cat-file', '--batch'],
    { env: gitEnvironment, signal, stdio: ['pipe', 'pipe', 'pipe'] })
  let closed = false
  const exited = new Promise<void>(resolve => child.once('close', () => { closed = true; resolve() }))
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => { closed = true; if (code === 0) resolve(); else reject(new SourceError('SOURCE_GIT_OBJECT_UNAVAILABLE', 'The exact Git object reader did not complete.')) })
  })
  void finished.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
  child.stderr.resume(); child.stdin.on('error', () => {})
  const chunks = child.stdout[Symbol.asyncIterator]()
  let chunk: Buffer = Buffer.alloc(0), offset = 0
  const readBytes = async (size: number) => {
    const bytes = Buffer.allocUnsafe(size)
    let copied = 0
    while (copied < size) {
      signal.throwIfAborted()
      if (offset === chunk.length) {
        const next = await chunks.next()
        if (next.done) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git output ended before the exact object was read.')
        chunk = Buffer.from(next.value); offset = 0
      }
      const length = Math.min(size - copied, chunk.length - offset)
      chunk.copy(bytes, copied, offset, offset + length); offset += length; copied += length
    }
    return bytes
  }
  return {
    async read(kind: 'commit' | 'tree' | 'blob', object: string, limit: number): Promise<Buffer> {
      signal.throwIfAborted(); child.stdin.write(`${object}\n`)
      let header = ''
      for (;;) {
        const byte = (await readBytes(1))[0]!
        if (byte === 10) break
        if (header.length >= 128) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git object header exceeds its bound.')
        header += String.fromCharCode(byte)
      }
      const fields = /^([a-f0-9]+) (commit|tree|blob) (\d+)$/.exec(header), size = Number(fields?.[3])
      if (!fields || fields[1] !== object || fields[2] !== kind) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git returned another exact object or kind.')
      if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new SourceError('SOURCE_CAPACITY', 'Git object exceeds its separate source budget.')
      const bytes = await readBytes(size)
      if ((await readBytes(1))[0] !== 10 || createHash(objectFormat).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex') !== object)
        throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Git object bytes do not match their exact accepted identity.')
      return bytes
    },
    async finish() {
      signal.throwIfAborted()
      child.stdin.end()
      if (offset !== chunk.length || !(await chunks.next()).done) throw new SourceError('SOURCE_GIT_OBJECT_CORRUPT', 'Unexpected extra Git object output.')
      await finished
    },
    async close() {
      if (!closed) child.kill('SIGTERM')
      child.stdin.destroy(); child.stdout.destroy()
      await exited
    },
  }
}
async function captureBlobs(reader: ReturnType<typeof gitObjectReader>, records: { path: string; mode: string; object: string }[],
  signal: AbortSignal, write: (record: typeof records[number], bytes: Buffer) => Promise<void>) {
  const writes = new Set<Promise<void>>()
  const failure: { error?: unknown; failed: boolean } = { failed: false }
  let total = 0, bufferedBytes = 0
  try {
    for (const record of records) {
      signal.throwIfAborted()
      if (failure.failed) throw failure.error
      // Eight small writes can overlap, with the same 64 MiB maximum including
      // the next 16 MiB read. Retain every sink verification and durability barrier.
      while (writes.size >= 8 || bufferedBytes > 48 * 1024 * 1024) await Promise.race(writes)
      const bytes = await reader.read('blob', record.object, Math.min(SOURCE_LIMITS.fileBytes, SOURCE_LIMITS.bytes - total))
      if ((total += bytes.length) > SOURCE_LIMITS.bytes) throw new SourceError('SOURCE_CAPACITY', 'Source bytes exceed their separate source budget.')
      if (failure.failed) throw failure.error
      bufferedBytes += bytes.length
      const pending = write(record, bytes).catch(error => { if (!failure.failed) { failure.failed = true; failure.error = error } throw error })
        .finally(() => { bufferedBytes -= bytes.length })
      writes.add(pending)
      void pending.then(() => writes.delete(pending), () => writes.delete(pending))
    }
    await Promise.all(writes)
    if (failure.failed) throw failure.error
  } finally { await Promise.allSettled(writes) }
}
/** Exact Git objects, never archive/export filters or working-tree bytes. */
export async function captureGitSource(input: { root: string; approvedSourceId: string; commit: string;
  snapshotId?: string; repository?: string; executablePolicy: SourceManifest['executablePolicy']; sink: SourceSnapshotSink }): Promise<SourceManifest> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)) throw new SourceError('SOURCE_GIT_REF_INVALID', 'An exact Git commit object is required; branch names are not source pins.')
  if (await realpath(input.root) !== input.root || input.root === process.env.HOME || input.root === '/') throw new SourceError('SOURCE_ROOT_INVALID', 'An explicitly approved canonical project root is required.')
  const snapshotId = input.snapshotId ?? randomUUID(), entries: SourceEntry[] = [], signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
  const git = (args: string[], limit = 2 * 1024 * 1024) => qualifiedGit(input.root, args, limit, signal)
  let reader: ReturnType<typeof gitObjectReader> | undefined
  try {
    if ((await git(['rev-parse', '--show-toplevel'])).toString().trim() !== input.root) throw new SourceError('SOURCE_ROOT_INVALID', 'The approved source root must be the exact repository root.')
    const objectFormat = (await git(['rev-parse', '--show-object-format'])).toString().trim()
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') throw new SourceError('SOURCE_GIT_FORMAT_UNSUPPORTED', 'Unsupported Git object format.')
    reader = gitObjectReader(input.root, objectFormat, signal)
    const objectBytes = (kind: 'commit' | 'tree' | 'blob', object: string, limit = 2 * 1024 * 1024) => reader!.read(kind, object, limit)
    const commit = input.commit, commitBytes = await objectBytes('commit', commit)
    const objects = input.sink.writeGitMetadata
      ? [{ kind: 'commit', object: commit, bytes: commitBytes.toString('base64') }] : undefined
    const tree = /^tree ([a-f0-9]+)\n/.exec(commitBytes.toString('utf8'))?.[1]
    if (!tree || tree.length !== (objectFormat === 'sha1' ? 40 : 64)) throw new SourceError('SOURCE_GIT_REF_INVALID', 'The accepted commit has no exact supported tree.')
    const records: { path: string; mode: string; object: string }[] = []
    let treeBytes = 0
    const readTree = async (object: string, prefix: string): Promise<void> => {
      const bytes = await objectBytes('tree', object)
      objects?.push({ kind: 'tree', object, bytes: bytes.toString('base64') })
      if ((treeBytes += bytes.length) > 8 * 1024 * 1024) throw new SourceError('SOURCE_CAPACITY', 'Git tree metadata exceeds the separate source budget.')
      let offset = 0
      while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1), width = objectFormat === 'sha1' ? 20 : 32
        if (space < offset || nul < space || nul + 1 + width > bytes.length) throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Malformed Git tree encoding.')
        const mode = bytes.subarray(offset, space).toString('ascii'), nameBytes = bytes.subarray(space + 1, nul), name = nameBytes.toString('utf8')
        if (!Buffer.from(name).equals(nameBytes) || name.includes('/')) throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Unsupported Git path encoding.')
        const path = sourcePath(prefix ? `${prefix}/${name}` : name), child = bytes.subarray(nul + 1, nul + 1 + width).toString('hex')
        offset = nul + 1 + width
        if (mode === '40000') await readTree(child, path)
        else if (mode === '100644' || mode === '100755') {
          records.push({ path, mode, object: child })
          if (records.length > SOURCE_LIMITS.entries) throw new SourceError('SOURCE_CAPACITY', 'Too many exact Git source entries.')
        } else throw new SourceError('SOURCE_GIT_TREE_UNSUPPORTED', 'Symlinks and submodules require a separately qualified source policy.')
      }
    }
    await readTree(tree, '')
    let metadata: NonNullable<SourceManifest['git']>['metadata']
    if (objects && input.sink.writeGitMetadata) {
      const metadataBytes = Buffer.from(JSON.stringify(objects))
      metadata = { byteSize: metadataBytes.length, sha256: sourceSha256(metadataBytes) }
      await input.sink.writeGitMetadata(snapshotId, metadataBytes)
      objects.length = 0
    }
    await captureBlobs(reader, records, signal, async (record, bytes) => {
      if (bytes.subarray(0, 200).toString().startsWith('version https://git-lfs.github.com/spec/v1\n')) throw new SourceError('SOURCE_LFS_UNSUPPORTED', 'Pin and qualify LFS object delivery before capturing this source.')
      const entry: SourceEntry = { path: record.path, kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: input.executablePolicy === 'preserve-approved' && record.mode === '100755' }
      verifySourceBytes(entry, bytes); await input.sink.write(snapshotId, entry, bytes); entries.push(entry)
    })
    await reader.finish()
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const manifest = createSourceManifest({ version: 1, snapshotId, approvedSourceId: input.approvedSourceId,
      capturePolicy: 'git-tree-v1', executablePolicy: input.executablePolicy,
      git: { commit, tree, objectFormat, ...(input.repository ? { repository: input.repository } : {}),
        ...(metadata ? { metadata } : {}) }, entries, deletions: [] })
    if (metadata && Buffer.byteLength(JSON.stringify(manifest)) + 12 + metadata.byteSize + manifest.totalBytes > SOURCE_LIMITS.bytes) {
      throw new SourceError('SOURCE_CAPACITY', 'The approved source and Git objects exceed the source transfer budget.')
    }
    signal.throwIfAborted(); await input.sink.commit(manifest); return manifest
  } catch (error) {
    const timedOut = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    await reader?.close(); await input.sink.abort(snapshotId)
    if (timedOut) {
      const timeout = new DomainError('SOURCE_CAPTURE_TIMEOUT', 'Source preparation exceeded its bounded deadline. Retry with a new explicit approval command.', 503, { retryable: true, newCommandRequired: true })
      timeout.cause = error
      throw timeout
    }
    throw error
  }
  finally { await reader?.close() }
}
export async function captureExplicitSource(input: { capture: ExclusiveSourceCapture; entries: readonly { path: string; executable: boolean }[];
  deletions: string[]; overlayBaseDigest?: string; executablePolicy: SourceManifest['executablePolicy']; sink: SourceSnapshotSink }): Promise<SourceManifest> {
  if (input.capture.writerExcluded !== true) throw new SourceError('SOURCE_CAPTURE_UNSUPPORTED', 'A qualified writer exclusion is required for dirty or untracked capture.')
  const snapshotId = randomUUID(), entries: SourceEntry[] = [], signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
  try {
    signal.throwIfAborted(); await input.capture.validateExclusion()
    if (input.entries.length > SOURCE_LIMITS.entries) throw new SourceError('SOURCE_CAPACITY', 'Too many source entries.')
    let total = 0
    for (const inclusion of input.entries) {
      signal.throwIfAborted(); sourcePath(inclusion.path)
      const bytes = await input.capture.read(inclusion)
      if (bytes.byteLength > SOURCE_LIMITS.fileBytes || (total += bytes.byteLength) > SOURCE_LIMITS.bytes) throw new SourceError('SOURCE_CAPACITY', 'Source byte budget exceeded.')
      const entry: SourceEntry = { path: inclusion.path, kind: 'file', byteSize: bytes.byteLength, sha256: sourceSha256(bytes), executable: input.executablePolicy === 'preserve-approved' && inclusion.executable }
      verifySourceBytes(entry, bytes); await input.sink.write(snapshotId, entry, bytes); entries.push(entry)
      await input.capture.validateExclusion()
    }
    await input.capture.validateExclusion()
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const manifest = createSourceManifest({ version: 1, snapshotId, approvedSourceId: input.capture.approvedSourceId,
      capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: input.executablePolicy, entries,
      deletions: [...input.deletions].sort(), ...(input.overlayBaseDigest ? { overlayBaseDigest: input.overlayBaseDigest } : {}) })
    signal.throwIfAborted(); await input.sink.commit(manifest); return manifest
  } catch (error) {
    const timedOut = signal.aborted && signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError'
    await input.sink.abort(snapshotId)
    if (timedOut) {
      const timeout = new DomainError('SOURCE_CAPTURE_TIMEOUT', 'Source preparation exceeded its bounded deadline. Retry with a new explicit approval command.', 503, { retryable: true, newCommandRequired: true })
      timeout.cause = error
      throw timeout
    }
    throw error
  }
}
