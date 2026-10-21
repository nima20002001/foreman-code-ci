import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { DomainError } from '../../errors.js'
import { pathsOverlap } from '../../workspaces/filesystem.js'
import { collectCodexFileBytes } from './bytes.js'
import type { CodexFileHostLease, RegisteredCodexCopy } from './port.js'

/** Read-only delivery directory outside Codex's workspace-write roots. Working-copy
 * edits go through FIL-05b; this lease never exposes a mutable host path. */
export function codexChatHostDirectory(fileStorageRoot: string): string {
  const root = resolve(fileStorageRoot)
  // A sibling, not a name derived from the storage path: prompts must never contain the storage root.
  return join(dirname(root), 'codex-chat-files')
}

export async function localCodexChatHost(fileStorageRoot: string): Promise<CodexFileHostLease> {
  const parent = codexChatHostDirectory(fileStorageRoot)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const stat = await lstat(parent)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)
    || (process.getuid && stat.uid !== process.getuid()) || await realpath(parent) !== resolve(parent)) {
    throw new Error('CODEX_FILE_HOST_UNSAFE')
  }
  const root = await mkdtemp(join(parent, 'turn-'))
  const executionHostId = `local:${randomUUID()}`
  let closed = false
  return {
    executionHostId, pathStyle: 'posix',
    async materialize(input): Promise<RegisteredCodexCopy> {
      if (closed || input.writable) throw new Error('CODEX_MUTABLE_HOST_PATH_DENIED')
      const data = await collectCodexFileBytes(input.bytes, input.byteSize)
      if (data.length !== input.byteSize || createHash('sha256').update(data).digest('hex') !== input.sha256) {
        throw new Error('CODEX_FILE_BYTES_CHANGED')
      }
      const registrationId = randomUUID()
      const extension = /^[.][A-Za-z0-9]{1,8}$/.test(extname(input.filename)) ? extname(input.filename) : ''
      const executionPath = join(root, `${registrationId}${extension}`)
      const handle = await open(executionPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o400)
      try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
      return { registrationId, executionHostId, executionPath, writable: false,
        byteSize: data.length, sha256: input.sha256 }
    },
    async sealCompleted() { throw new Error('CODEX_MUTABLE_HOST_PATH_DENIED') },
    async close() { if (!closed) { closed = true; await rm(root, { recursive: true, force: true }) } },
  }
}

export async function assertCodexChatHost(fileStorageRoot: string, workingDirectory: string,
  additionalWritableDirectories: readonly string[], allowMutation: boolean): Promise<void> {
  const hostDirectory = codexChatHostDirectory(fileStorageRoot)
  await mkdir(hostDirectory, { recursive: true, mode: 0o700 })
  const canonicalHost = await realpath(hostDirectory)
  const roots = await Promise.all([workingDirectory, ...additionalWritableDirectories].map((path) => realpath(path)))
  if (canonicalHost !== resolve(hostDirectory) || roots.some((root) => pathsOverlap(root, canonicalHost))
    || allowMutation && ['/tmp', '/var/tmp'].some((root) => pathsOverlap(root, canonicalHost))) throw new DomainError(
    'CODEX_FILE_HOST_UNAVAILABLE', 'The file host overlaps a Codex writable root.', 409)
}
