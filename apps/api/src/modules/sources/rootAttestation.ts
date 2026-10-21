/** Worker-safe: Node + shared contracts only. No main DB/bootstrap/provider state. */
import { constants } from 'node:fs'
import { open, access, opendir, realpath, type FileHandle } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  ApprovedRootAllowlistSchema, WorkspaceRootSelectionSchema, WorkspaceRootAttestationSchema, WorkspaceRootWorkerRequestSchema, WorkspaceRootPolicySchema,
  type ApprovedRootAllowlist, type WorkspaceRootSelection, type WorkspaceRootAttestation, type WorkspaceRootPolicy, type WorkspaceRootBrowseResult,
  type WorkspaceRootWorkerRequest,
} from '@foreman-code/contracts/workspace-root-policies'
import { anchored, directoryFlags, identity, openPrivateRoot, openChildDirectory } from './privateFilesystem.js'
import { SourceError, sourceSha256 } from './manifest.js'

const run = promisify(execFile)

async function persistentFilesystemId(directory: FileHandle): Promise<string> {
  // statfs reads the filesystem ID through the parent's pinned handle; ext4 derives it from its UUID.
  const { stdout } = await run('/usr/bin/stat', ['--file-system', '--format=%i',
    `/proc/${process.pid}/fd/${directory.fd}`], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 })
  const filesystemId = stdout.trim()
  if (!/^[a-f0-9]{1,16}$/.test(filesystemId) || /^0+$/.test(filesystemId)) {
    throw new SourceError('ROOT_FILESYSTEM_UNSUPPORTED', 'A persistent filesystem identity is required.')
  }
  return filesystemId
}

async function matchesApprovedDirectory(directory: FileHandle,
  expected: ApprovedRootAllowlist['runtimeFilesystem'], filesystemId?: string): Promise<boolean> {
  const current = await identity(directory)
  if (!filesystemId) return isDeepStrictEqual(current, expected)
  return current.inode === expected.inode && await persistentFilesystemId(directory) === filesystemId
}

export function rootRelativePath(path: string): string {
  if (path === '') return path
  if (path.length > 1024 || path.normalize('NFC') !== path || path.startsWith('/') || /[\\:]/.test(path)
    || [...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    || path.split('/').length > 32 || path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)))
    throw new SourceError('ROOT_RELATIVE_PATH_INVALID', 'Choose an unambiguous folder relative to an approved base.')
  return path
}
export function rootSelectionDigest(selection: WorkspaceRootSelection): string {
  const parsed = WorkspaceRootSelectionSchema.parse(selection)
  return sourceSha256(Buffer.from(JSON.stringify(parsed)))
}
export function rootAttestationDigest(value: Omit<WorkspaceRootAttestation, 'attestationDigest'>): string {
  return sourceSha256(Buffer.from(JSON.stringify(value)))
}
export async function openRootDirectory(base: string, relativePath: string,
  expectedIdentity: ApprovedRootAllowlist['runtimeFilesystem'], filesystemId?: string): Promise<FileHandle> {
  rootRelativePath(relativePath)
  let directory = await openPrivateRoot(base, false)
  try {
    let privatePrefix = ((await directory.stat()).mode & 0o077) === 0
    if (!await matchesApprovedDirectory(directory, expectedIdentity, filesystemId)) throw new SourceError('ROOT_BASE_CHANGED', 'The explicitly approved root base was replaced.')
    for (const component of relativePath.split('/').filter(Boolean)) {
      const next = await open(anchored(directory, component), directoryFlags).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new SourceError('ROOT_DIRECTORY_MISSING', 'The selected folder does not exist on this computer.', { cause: error })
        throw error
      })
      try {
        const stat = await next.stat(), parentIdentity = await identity(directory), childIdentity = await identity(next)
        if (stat.uid !== process.getuid?.() || (!privatePrefix && (stat.mode & 0o022) !== 0) || parentIdentity.device !== childIdentity.device || parentIdentity.mountId !== childIdentity.mountId)
          throw new SourceError('ROOT_FILESYSTEM_UNSUPPORTED', 'Selected folders must be worker-owned and protected from other writers on the approved filesystem.')
      } catch (error) { await next.close(); throw error }
      privatePrefix ||= ((await next.stat()).mode & 0o077) === 0
      await directory.close(); directory = next
    }
    return directory
  } catch (error) { await directory.close(); throw error }
}
function selectBase(allowlist: ApprovedRootAllowlist, selection: WorkspaceRootSelection) {
  allowlist = ApprovedRootAllowlistSchema.parse(allowlist); selection = WorkspaceRootSelectionSchema.parse(selection)
  if (!isDeepStrictEqual(allowlist.hostRef, selection.hostRef) || allowlist.configurationRevision !== selection.configurationRevision)
    throw new SourceError('ROOT_CONFIGURATION_CONFLICT', 'The selected host or approved root configuration changed.')
  const base = allowlist.bases.find(base => base.baseId === selection.allowedBaseId)
  if (!base || !base.accessModes.includes(selection.accessMode)) throw new SourceError('ROOT_ACCESS_DENIED', 'This folder base/access mode is not in the explicit host allowlist.')
  rootRelativePath(selection.relativePath); return base
}
export async function attestWorkspaceRoot(raw: ApprovedRootAllowlist, input: WorkspaceRootSelection): Promise<WorkspaceRootAttestation> {
  const allowlist = ApprovedRootAllowlistSchema.parse(raw), selection = WorkspaceRootSelectionSchema.parse(input), base = selectBase(allowlist, selection)
  const baseHandle = await openPrivateRoot(base.canonicalPath, false)
  try { if (!await matchesApprovedDirectory(baseHandle, base.filesystem, base.filesystemId)) throw new SourceError('ROOT_BASE_CHANGED', 'The explicitly approved root base was replaced.') }
  finally { await baseHandle.close() }
  const directory = await openRootDirectory(base.canonicalPath, selection.relativePath, base.filesystem, base.filesystemId)
  let runtime: FileHandle | undefined
  try {
    runtime = await openPrivateRoot(allowlist.managedRuntimeRoot)
    await access(anchored(directory), constants.R_OK | constants.X_OK | (selection.accessMode === 'read-write' ? constants.W_OK : 0))
    if (!await matchesApprovedDirectory(runtime, allowlist.runtimeFilesystem, allowlist.runtimeFilesystemId)) throw new SourceError('ROOT_RUNTIME_CHANGED', 'The app-owned runtime root changed.')
    const filesystem = await identity(directory), canonicalProjectRoot = join(base.canonicalPath, selection.relativePath)
    for (const [left, right] of [[canonicalProjectRoot, allowlist.managedRuntimeRoot], [allowlist.managedRuntimeRoot, canonicalProjectRoot]]) {
      const suffix = relative(left!, right!)
      if (suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../'))) throw new SourceError('ROOT_RUNTIME_OVERLAP', 'The user project and app-owned runtime must be disjoint.')
    }
    if (canonicalProjectRoot !== await realpath(anchored(directory))) throw new SourceError('ROOT_DIRECTORY_CHANGED', 'The selected folder changed during attestation.')
    const stamp = { schemaVersion: 1 as const, attestationId: randomUUID(), requestDigest: rootSelectionDigest(selection), hostRef: allowlist.hostRef,
      applicationInstallationId: allowlist.applicationInstallationId, configurationRevision: allowlist.configurationRevision, allowedBaseId: base.baseId,
      relativePath: selection.relativePath, accessMode: selection.accessMode, canonicalProjectRoot, filesystem,
      directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(filesystem))), managedRuntimeRoot: allowlist.managedRuntimeRoot, runtimeFilesystem: await identity(runtime) }
    return WorkspaceRootAttestationSchema.parse({ ...stamp, attestationDigest: rootAttestationDigest(stamp) })
  } finally {
    try { await runtime?.close() }
    finally { await directory.close() }
  }
}
/** The Worker selects the base during pairing; callers can only create their workspace's folder. */
export async function prepareManagedWorkspaceRoot(raw: ApprovedRootAllowlist, input: WorkspaceRootSelection) {
  const allowlist = ApprovedRootAllowlistSchema.parse(raw)
  const selection = WorkspaceRootSelectionSchema.parse(input)
  const base = selectBase(allowlist, selection)
  const folder = sourceSha256(Buffer.from(selection.workspaceId))
  if (base.managedBy !== 'worker-pairing' || selection.relativePath !== folder || selection.accessMode !== 'read-write') {
    throw new SourceError('ROOT_ACCESS_DENIED', 'Automatic root setup is limited to this workspace’s managed folder.')
  }
  const directory = await openPrivateRoot(base.canonicalPath)
  try {
    if (!await matchesApprovedDirectory(directory, base.filesystem, base.filesystemId)) {
      throw new SourceError('ROOT_BASE_CHANGED', 'The managed workspace base changed.')
    }
    const child = await openChildDirectory(directory, folder, true)
    try { await child.sync(); await directory.sync() }
    finally { await child.close() }
  } finally { await directory.close() }
  return attestWorkspaceRoot(allowlist, selection)
}
export async function browseApprovedRoot(raw: ApprovedRootAllowlist, input: WorkspaceRootSelection, relativePath: string): Promise<WorkspaceRootBrowseResult> {
  const allowlist = ApprovedRootAllowlistSchema.parse(raw), selection = WorkspaceRootSelectionSchema.parse(input), base = selectBase(allowlist, selection)
  rootRelativePath(relativePath)
  const directory = await openRootDirectory(base.canonicalPath, relativePath, base.filesystem, base.filesystemId)
  try {
    const iterator = await opendir(anchored(directory)), directories: WorkspaceRootBrowseResult['directories'] = []
    let scanned = 0, truncated = false
    for await (const entry of iterator) {
      if (++scanned > 4096 || directories.length === 256) { truncated = true; break }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const child = relativePath ? `${relativePath}/${entry.name}` : entry.name
      try { rootRelativePath(child) } catch { continue }
      directories.push({ name: entry.name, relativePath: child })
    }
    directories.sort((a, b) => a.name.localeCompare(b.name))
    return { relativePath, directories, truncated }
  } finally { await directory.close() }
}
/** Human-approved bootstrap only; remote messages never accept these paths. */
export async function qualifyApprovedRootAllowlist(input: Omit<ApprovedRootAllowlist, 'bases' | 'runtimeFilesystem' | 'runtimeFilesystemId'> & {
  bases: Omit<ApprovedRootAllowlist['bases'][number], 'filesystem'>[]
}): Promise<ApprovedRootAllowlist> {
  const bases: ApprovedRootAllowlist['bases'] = []
  for (const base of input.bases) {
    const handle = await openPrivateRoot(base.canonicalPath, false)
    try {
      bases.push({ ...base, filesystem: await identity(handle), filesystemId: await persistentFilesystemId(handle) })
    } finally { await handle.close() }
  }
  const runtime = await openPrivateRoot(input.managedRuntimeRoot)
  try { return ApprovedRootAllowlistSchema.parse({ ...input, bases, runtimeFilesystem: await identity(runtime),
    runtimeFilesystemId: await persistentFilesystemId(runtime) }) }
  finally { await runtime.close() }
}
export async function attestSourceNamespace(allowlist: ApprovedRootAllowlist, policy: WorkspaceRootPolicy) {
  policy = WorkspaceRootPolicySchema.parse(policy)
  const selection: WorkspaceRootSelection = { workspaceId: policy.workspaceId, hostRef: policy.hostRef, allowedBaseId: policy.allowedBaseId,
    configurationRevision: policy.configurationRevision, relativePath: policy.relativePath, accessMode: policy.accessMode,
    expectedLocationRevision: Number(policy.locationRevision), expectedRootPolicyRevision: Number(policy.rootPolicyRevision) }
  const observed = await attestWorkspaceRoot(allowlist, selection)
  if (!isDeepStrictEqual(observed.filesystem, policy.filesystem) || observed.canonicalProjectRoot !== policy.canonicalProjectRoot || observed.directoryIdentityHash !== policy.directoryIdentityHash)
    throw new SourceError('ROOT_DIRECTORY_CHANGED', 'The originally bound project directory was replaced; validate and bind its new identity explicitly.')
  if (policy.applicationInstallationId !== allowlist.applicationInstallationId || policy.managedRuntimeRoot !== allowlist.managedRuntimeRoot)
    throw new SourceError('ROOT_CONFIGURATION_CONFLICT', 'Source namespaces belong only to the original approved installation/runtime root.')
  const runtime = await openPrivateRoot(allowlist.managedRuntimeRoot)
  try {
    const sources = await openChildDirectory(runtime, 'source-materializations', true)
    try {
      const namespace = await openChildDirectory(sources, policy.rootPolicyId, true)
      try {
        await namespace.sync(); await sources.sync(); await runtime.sync()
        const filesystem = await identity(namespace)
        return { canonicalPath: join(allowlist.managedRuntimeRoot, 'source-materializations', policy.rootPolicyId), filesystem,
          attestationId: randomUUID(), attestationDigest: sourceSha256(Buffer.from(JSON.stringify({ rootPolicyId: policy.rootPolicyId, filesystem, configurationRevision: policy.configurationRevision }))) }
      } finally { await namespace.close() }
    } finally { await sources.close() }
  } finally { await runtime.close() }
}
/** C/B must authenticate the selected main/device and scoped root permission
 * BEFORE reading the allowlist or performing any target filesystem operation. */
export function createWorkspaceRootWorkerHandler(readApproved: () => Promise<ApprovedRootAllowlist>, authorize: (request: WorkspaceRootWorkerRequest) => Promise<void>) {
  return async (raw: unknown) => {
    const request = WorkspaceRootWorkerRequestSchema.parse(raw)
    await authorize(request)
    const allowlist = ApprovedRootAllowlistSchema.parse(await readApproved())
    if (request.operation === 'workspace-roots.configuration') return allowlist
    if (request.operation === 'workspace-roots.attest') return attestWorkspaceRoot(allowlist, request.selection)
    if (request.operation === 'workspace-roots.prepare-managed') return prepareManagedWorkspaceRoot(allowlist, request.selection)
    if (request.operation === 'workspace-roots.browse') return browseApprovedRoot(allowlist, request.selection, request.relativePath)
    return attestSourceNamespace(allowlist, request.policy)
  }
}

/** Persistent filesystem IDs and directory inodes survive remounts; legacy records require an exact match. */
export async function verifyApprovedRootAllowlist(raw: ApprovedRootAllowlist): Promise<ApprovedRootAllowlist> {
  const allowlist = ApprovedRootAllowlistSchema.parse(raw)
  if (new Set(allowlist.bases.map(base => base.baseId)).size !== allowlist.bases.length || new Set(allowlist.bases.map(base => base.canonicalPath)).size !== allowlist.bases.length)
    throw new SourceError('ROOT_CONFIGURATION_CONFLICT', 'Approved root bases must have unique identities and paths.')
  const bases: ApprovedRootAllowlist['bases'] = []
  for (const base of allowlist.bases) {
    const handle = await openPrivateRoot(base.canonicalPath, false)
    try {
      if (!await matchesApprovedDirectory(handle, base.filesystem, base.filesystemId)) {
        throw new SourceError('ROOT_BASE_CHANGED', 'An explicitly approved root base changed.')
      }
      bases.push({ ...base, filesystem: await identity(handle),
        filesystemId: base.filesystemId ?? await persistentFilesystemId(handle) })
    }
    finally { await handle.close() }
  }
  const runtime = await openPrivateRoot(allowlist.managedRuntimeRoot)
  try {
    if (!await matchesApprovedDirectory(runtime, allowlist.runtimeFilesystem, allowlist.runtimeFilesystemId)) {
      throw new SourceError('ROOT_RUNTIME_CHANGED', 'The explicitly approved runtime root changed.')
    }
    return { ...allowlist, bases, runtimeFilesystem: await identity(runtime),
      runtimeFilesystemId: allowlist.runtimeFilesystemId ?? await persistentFilesystemId(runtime) }
  }
  finally { await runtime.close() }
}
