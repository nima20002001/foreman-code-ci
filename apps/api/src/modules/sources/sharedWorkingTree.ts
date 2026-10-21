import { processSourceDirectories } from './entryProcessing.js'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { RootBindingSchema, type RootBinding, type MaterializationReceipt,
  type SourceManifest } from '@foreman-code/contracts/source-materialization'
import { anchored, identity, openChildDirectory } from './privateFilesystem.js'
import { SourceError } from './manifest.js'
import { join } from 'node:path'
import { addGitWorktree, type GitWorktreePorts, type WorktreeRequest } from './gitWorktree.js'
import { componentLogger } from '../diagnostics/logger.js'
import { copySourceTree } from './copySourceTree.js'
import { verifySourceEntry } from './verifySourceEntry.js'
import type { MaterializationAttempt } from './ports.js'
import type { SecondarySourceAllocation } from '@foreman-code/contracts/source-operations'
import { writeSecondaryAllocation } from './secondaryAllocation.js'
import { writeSourceClaim } from './quotaClaims.js'
import { scheduler } from 'node:timers/promises'

const SharedTreeSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  binding: RootBindingSchema,
  filesystem: RootBindingSchema.shape.filesystem,
}).strict()

function markerName(binding: RootBinding): string {
  return `working-tree-${binding.rootId}-${binding.bindingRevision}.json`
}

async function readMarker<T extends z.ZodType = typeof SharedTreeSchema>(root: FileHandle, name: string,
  schema: T = SharedTreeSchema as unknown as T): Promise<z.infer<T> | null> {
  let file: FileHandle
  try { file = await open(anchored(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
      || stat.mode & 0o077 || stat.size > 16384) {
      throw new SourceError('SOURCE_TREE_INVALID', 'Shared working tree metadata is invalid.')
    }
    return schema.parse(JSON.parse(await file.readFile('utf8')))
  } finally { await file.close() }
}

async function assertTree(root: FileHandle, record: z.infer<typeof SharedTreeSchema>, binding: RootBinding) {
  if (!isDeepStrictEqual(record.binding, binding)) {
    throw new SourceError('SOURCE_PIN_CONFLICT', 'Shared working tree belongs to another approved source binding.')
  }
  const directory = await openChildDirectory(root, record.id)
  try {
    const tree = await openChildDirectory(directory, 'tree')
    try {
      if (!isDeepStrictEqual(await identity(tree), record.filesystem)) {
        throw new SourceError('SOURCE_TREE_CHANGED', 'Shared working tree identity changed.')
      }
    } finally { await tree.close() }
  } finally { await directory.close() }
  return record
}

async function copyEntries(reference: FileHandle, target: FileHandle, manifest: SourceManifest, signal: AbortSignal) {
  await copySourceTree({ source: reference, target, manifest, fileMode: 0o600, signal })
}

/** The caller holds the root mutation lock only while initializing the shared directory. */
export async function prepareSharedWorkingTree(input: {
  root: FileHandle
  binding: RootBinding
  primary: FileHandle
  materializationId: string
  attempt: MaterializationAttempt
  manifest: SourceManifest
  reference: FileHandle
  authorize(): Promise<void>
  signal: AbortSignal
}) {
  const { root, binding, manifest, reference, signal } = input
  const name = markerName(binding)
  const existing = await readMarker(root, name)
  if (existing) return assertTree(root, existing, binding)
  const pendingName = `${name}.pending`
  try {
    const pending = await open(anchored(root, pendingName), constants.O_RDONLY | constants.O_NOFOLLOW)
    await pending.close()
    throw new SourceError('SOURCE_MATERIALIZATION_UNCERTAIN', 'Shared working tree initialization requires reconciliation.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const id = randomUUID()
  const allocation: SecondarySourceAllocation = { version: 1, id, binding,
    materializationId: input.materializationId, attempt: input.attempt, kind: 'shared', state: 'preparing' }
  await writeSecondaryAllocation(input.primary, allocation, signal)
  await writeSourceClaim(root, pendingName, JSON.stringify(allocation), signal)
  await mkdir(anchored(root, id), { mode: 0o700 })
  const directory = await openChildDirectory(root, id)
  try {
    await writeSecondaryAllocation(input.primary, { ...allocation, filesystem: await identity(directory) }, signal)
    await mkdir(anchored(directory, 'staging'), { mode: 0o700 })
    const tree = await openChildDirectory(directory, 'staging')
    let filesystem: RootBinding['filesystem']
    try {
      await copySourceTree({ source: reference, target: tree, manifest,
        fileMode: binding.accessMode === 'read-only' ? 0o400 : 0o600, signal })
      await input.authorize()
      signal.throwIfAborted()
      filesystem = await identity(tree)
      await tree.sync()
    } finally { await tree.close() }
    await rename(anchored(directory, 'staging'), anchored(directory, 'tree'))
    await directory.sync()
    const record = SharedTreeSchema.parse({ version: 1, id, binding, filesystem })
    await writeSourceClaim(root, `${pendingName}.ready`, JSON.stringify(record), signal)
    await rename(anchored(root, `${pendingName}.ready`), anchored(root, name))
    await root.sync()
    await unlink(anchored(root, pendingName))
    await root.sync()
    return record
  } finally { await directory.close() }
}

export async function verifySharedWorkingTree(root: FileHandle, receipt: MaterializationReceipt): Promise<void> {
  if (!receipt.sharedTree) return
  if (receipt.worktree) {
    const raw = await readMarker(root, worktreeMarker(receipt.sharedTree.id), WorktreeMarkerSchema)
    if (!raw || raw.id !== receipt.sharedTree.id || raw.executionId !== receipt.executionId
      || !isDeepStrictEqual(raw.filesystem, receipt.localTreeIdentity)
      || !isDeepStrictEqual(raw.worktree, receipt.worktree)) {
      throw new SourceError('SOURCE_TREE_CHANGED', 'The execution is not bound to its original agent worktree.')
    }
    await assertTree(root, raw, receipt.binding)
    return
  }
  const record = await readMarker(root, markerName(receipt.binding))
  if (!record || record.id !== receipt.sharedTree.id
    || !isDeepStrictEqual(record.filesystem, receipt.localTreeIdentity)) {
    throw new SourceError('SOURCE_TREE_CHANGED', 'The execution is not bound to its original shared working tree.')
  }
  await assertTree(root, record, receipt.binding)
}

const WorktreeMarkerSchema = SharedTreeSchema.extend({
  executionId: z.string().min(1),
  worktree: z.object({ repository: z.string(), branch: z.string(), commit: z.string(), startCommit: z.string().optional() }).strict(),
}).strict()
const worktreeMarker = (id: string) => `worktree-${id}.json`

/** One writable git worktree per agent execution, verified against the approved manifest before it is used. */
export async function prepareAgentWorktree(input: {
  root: FileHandle
  binding: RootBinding
  executionId: string
  primary: FileHandle
  materializationId: string
  attempt: MaterializationAttempt
  manifest: SourceManifest
  reference: FileHandle
  request: WorktreeRequest
  ports: GitWorktreePorts
  authorize(): Promise<void>
  signal: AbortSignal
}) {
  const { root, binding, manifest, signal } = input
  const started = performance.now()
  const commit = manifest.git?.commit
  if (!commit) throw new SourceError('SOURCE_WORKTREE_INVALID', 'Only Git sources can become agent worktrees.')
  const id = randomUUID()
  let allocation: SecondarySourceAllocation = { version: 1, id, binding,
    materializationId: input.materializationId, attempt: input.attempt, kind: 'worktree', state: 'preparing',
    worktree: { repository: input.request.repository, branch: input.request.branch, commit } }
  await writeSecondaryAllocation(input.primary, allocation, signal)
  await mkdir(anchored(root, id), { mode: 0o700 })
  const allocatedDirectory = await openChildDirectory(root, id)
  try {
    allocation = { ...allocation, filesystem: await identity(allocatedDirectory) }
    await writeSecondaryAllocation(input.primary, allocation, signal)
  } finally {
    await allocatedDirectory.close()
  }
  const path = join(binding.canonicalPath, id, 'tree')
  const added = await addGitWorktree(input.ports, input.request, commit, path, signal, {
    checkout: 'deferred',
    beforeAllocate: async branch => {
      allocation = { ...allocation, worktree: { repository: input.request.repository, branch, commit } }
      await writeSecondaryAllocation(input.primary, allocation, signal)
    },
  })
  const allocated = performance.now()
  const directory = await openChildDirectory(root, id)
  try {
    const tree = await openChildDirectory(directory, 'tree')
    let filesystem: RootBinding['filesystem']
    try {
      await copyEntries(input.reference, tree, manifest, signal)
      await verifyWorktreeContent(tree, manifest, signal)
      await input.authorize()
      filesystem = await identity(tree)
    } finally { await tree.close() }
    const record = WorktreeMarkerSchema.parse({ version: 1, id, binding, filesystem, executionId: input.executionId,
      worktree: { repository: input.request.repository, branch: added.branch, commit } })
    const file = await open(anchored(root, worktreeMarker(id)),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(JSON.stringify(record)); await file.sync() } finally { await file.close() }
    await root.sync()
    componentLogger('engine').info({ executionId: input.executionId, snapshotId: manifest.snapshotId,
      durationMs: Math.round(performance.now() - started),
      allocationMs: Math.round(allocated - started),
      populateVerifyAndActivateMs: Math.round(performance.now() - allocated) }, 'source worktree prepared')
    return record
  } finally { await directory.close() }
}

/** The worktree holds exactly the approved files plus Git's own `.git` link file. */
async function verifyWorktreeContent(tree: FileHandle, manifest: SourceManifest, signal: AbortSignal) {
  await processSourceDirectories(tree, manifest.entries, async (parent, entries) => {
    for (const entry of entries) {
      signal.throwIfAborted()
      verifySourceEntry(parent, entry)
      await scheduler.yield()
    }
  }, { signal })
}
