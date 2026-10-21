import { materializationDirectory, type PrivateSourceMaterializer } from './materialization.js'
import { SOURCE_MATERIALIZATION_RECORD_MAX_BYTES, sourceMaterializationParent } from '@foreman-code/contracts/source-materialization'
import { isDeepStrictEqual } from 'node:util'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, readdir, type FileHandle } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { MaterializationReceipt, SourceManifest } from '@foreman-code/contracts/source-materialization'
import { z } from 'zod'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import { JOB_RUNTIME_WORKSPACE_LAYOUT } from '@foreman-code/contracts/job-runtime'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { sourceMaterializationDigest } from './bindingHash.js'
import { qualifiedGit } from './capture.js'
import { anchored, entryParent, identity, openChildDirectory, openPrivateRoot } from './privateFilesystem.js'
import { SOURCE_LIMITS, SourceError, sourceSha256, verifySourceBytes, verifySourceManifest } from './manifest.js'
import type { MaterializationAttempt } from './ports.js'
import { DomainError } from '../errors.js'

/** Drain bounded Git output while streaming input. Waiting for writes before
 * reading a child's output can deadlock both pipes on a realistic source tree. */
async function importSnapshot(gitDirectory: string, input: AsyncIterable<Buffer>, signal: AbortSignal) {
  let child: ReturnType<typeof execFile>
  const finished = new Promise<void>((resolve, reject) => {
    child = execFile('/usr/bin/git', ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-C', gitDirectory, 'fast-import', '--quiet', '--done', '--date-format=raw'], {
      encoding: 'buffer', maxBuffer: 2 * 1024 * 1024, timeout: SOURCE_LIMITS.preparationMs, killSignal: 'SIGKILL', signal,
      env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' },
    }, error => error ? reject(error) : resolve())
  })
  void finished.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
  const closed = new Promise<void>(resolve => child!.once('close', () => resolve()))
  try { await Promise.all([pipeline(Readable.from(input), child!.stdin!, { signal }), finished]) }
  finally {
    if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL')
    child!.stdin?.destroy()
    await finished.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    await closed
  }
}

/** CI gets a freshly generated object database and explicit Git environment.
 * It contains this approved snapshot only, with no source hooks/config/helpers,
 * no shared .git and no implied approval to transfer repository history.
 */
export async function createPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; manifest: SourceManifest; materializer: PrivateSourceMaterializer;
  attempt: MaterializationAttempt; signal?: AbortSignal;
}): Promise<{ workTree: string; gitDirectory: string; generatedCommit: string; sourceCommit: string | null }> {
  const deadline = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
  const signal = AbortSignal.any([deadline, ...(input.signal ? [input.signal] : [])])
  try { signal.throwIfAborted(); const result = await buildPrivateSourceRepository({ ...input, signal }); signal.throwIfAborted(); return result }
  catch (error) {
    if (deadline.aborted && signal.aborted && (error === signal.reason || (error as Error)?.name === 'AbortError'))
      throw new DomainError('SOURCE_REPOSITORY_TIMEOUT', 'Private source preparation timed out. Retry the original command to read its retained state; incomplete ownership requires reconciliation.', 503, { retryable: true }, { cause: error })
    throw error
  }
}
async function buildPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; manifest: SourceManifest; materializer: PrivateSourceMaterializer;
  attempt: MaterializationAttempt; signal: AbortSignal;
}): Promise<{ workTree: string; gitDirectory: string; generatedCommit: string; sourceCommit: string | null }> {
  const signal = input.signal
  const manifest = verifySourceManifest(input.manifest), receipt = input.receipt
  if (manifest.snapshotId !== receipt.binding.snapshotId || manifest.manifestDigest !== receipt.verifiedManifestDigest)
    throw new SourceError('SOURCE_PIN_CONFLICT', 'Repository generation requires the accepted complete source snapshot.')
  const expected = { binding: receipt.binding, attempt: input.attempt, signal }
  const workTree = await input.materializer.resolve(receipt, expected)
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  let gitDirectory: string
  try {
    if (JSON.stringify(await identity(root)) !== JSON.stringify(receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    const reservation = await materializationDirectory(root, receipt)
    try {
      const prior = await open(anchored(reservation, 'repository-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
        throw error
      })
      if (prior) {
        return await readPrivateRepository(prior, reservation, receipt, manifest, workTree, signal)
      }
      signal.throwIfAborted()
      await mkdir(anchored(reservation, 'repository'), { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DomainError('SOURCE_REPOSITORY_UNCERTAIN', 'The original private repository is incomplete; reconcile this exact attempt before retry.', 409, undefined, { cause: error })
        throw error
      })
    }
    finally { await reservation.close() }
    gitDirectory = join(sourceMaterializationParent(receipt), 'repository')
  } finally { await root.close() }
  // Every Git subprocess uses only this new store, qualified system Git, no
  // global/system config, no replace refs, no hooks and no interactive prompts.
  const git = (args: string[]) => qualifiedGit(gitDirectory, args, 2 * 1024 * 1024, signal)
  await git(['init', '--bare', '--template=', `--object-format=${manifest.git?.objectFormat ?? 'sha1'}`])
  const expectedTree: Buffer[] = [], message = Buffer.from(`Source snapshot ${manifest.snapshotId}\nManifest ${manifest.manifestDigest}\n`)
  await importSnapshot(gitDirectory, (async function* () {
    yield Buffer.from(`commit refs/heads/source\ncommitter Foreman Code Source <source@graphql.invalid> 0 +0000\ndata ${message.length}\n`)
    yield message; yield Buffer.from('\n')
    const tree = await openPrivateRoot(join(sourceMaterializationParent(receipt), 'tree'))
    try {
      for (const entry of manifest.entries) {
        signal.throwIfAborted()
        const { parent, leaf } = await entryParent(tree, entry.path, false)
        let bytes: Buffer
        try {
          const file = await open(anchored(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
          try {
            const stat = await file.stat()
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.byteSize || !!(stat.mode & 0o111) !== entry.executable)
              throw new SourceError('SOURCE_TREE_INVALID', 'Materialized kind, size, link count or executable policy changed.')
            bytes = await file.readFile({ signal }); verifySourceBytes(entry, bytes)
          } finally { await file.close() }
        } finally { await parent.close() }
        const mode = entry.executable ? '100755' : '100644'
        const object = createHash(manifest.git?.objectFormat ?? 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
        expectedTree.push(Buffer.from(`${mode} blob ${object}\t${entry.path}\0`))
        yield Buffer.from(`M ${mode} inline ${JSON.stringify(entry.path)}\ndata ${bytes.length}\n`)
        yield bytes; yield Buffer.from('\n')
      }
    } finally { await tree.close() }
    yield Buffer.from('\ndone\n')
  })(), signal)
  const generatedCommit = (await git(['rev-parse', 'refs/heads/source'])).toString().trim()
  // Git orders trees by directory components, which differs from manifest path
  // order. Compare the complete exact path/mode/object set before publication.
  const actualTree = (await git(['ls-tree', '-r', '-z', generatedCommit])).toString().split('\0').filter(Boolean).sort()
  const expectedObjects = Buffer.concat(expectedTree).toString().split('\0').filter(Boolean).sort()
  if (!isDeepStrictEqual(actualTree, expectedObjects)) throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Imported private Git objects differ from the complete approved snapshot.')
  await git(['update-ref', 'HEAD', generatedCommit])
  await git(['read-tree', generatedCommit])
  await git(['config', 'core.bare', 'false'])
  await git(['config', 'core.worktree', workTree])
  await input.materializer.verify(receipt, expected)
  const owner = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    const reservation = await materializationDirectory(owner, receipt)
    try {
      const repository = await openChildDirectory(reservation, 'repository')
      let configDigest: string
      try {
        await protectGeneratedRepositoryEntries(repository, ['config', 'index', 'HEAD', 'refs'], signal)
        const config = await open(anchored(repository, 'config'), constants.O_RDONLY | constants.O_NOFOLLOW)
        try { configDigest = sourceSha256(await config.readFile()) } finally { await config.close() }
      } finally { await repository.close() }
      signal.throwIfAborted()
      const record = await open(anchored(reservation, 'repository-receipt.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await record.writeFile(JSON.stringify({ materializationId: receipt.materializationId, manifestDigest: manifest.manifestDigest,
        receiptDigest: sourceSha256(Buffer.from(JSON.stringify(receipt))), generatedCommit, configDigest })); await record.sync() }
      finally { await record.close() }
      await reservation.sync(); await owner.sync()
    } finally { await reservation.close() }
  } finally { await owner.close() }
  return { workTree, gitDirectory, generatedCommit, sourceCommit: manifest.git?.commit ?? null }
}

/** Git inherits the host umask; protect fresh metadata before publishing its receipt. */
async function protectGeneratedRepositoryEntries(directory: FileHandle, names: readonly string[], signal: AbortSignal) {
  const parent = await identity(directory)
  for (const name of names) {
    signal.throwIfAborted()
    const entry = await open(anchored(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const metadata = await entry.stat()
      const filesystem = await identity(entry)
      if (metadata.uid !== process.getuid?.() || filesystem.device !== parent.device
        || filesystem.mountId !== parent.mountId
        || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) {
        throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Generated private Git metadata changed.')
      }
      await entry.chmod(metadata.isDirectory() ? 0o700 : 0o600)
      if (metadata.isDirectory()) {
        await protectGeneratedRepositoryEntries(entry, await readdir(anchored(entry)), signal)
      }
      await entry.sync()
    } finally { await entry.close() }
  }
  await directory.sync()
}

/** Verify only the retained original repository. Missing receipts fail closed;
 * this path cannot initialize Git, write objects or replace source state. */
export async function verifyPrivateSourceRepository(input: {
  receipt: MaterializationReceipt; materializer: PrivateSourceMaterializer; attempt: MaterializationAttempt;
}) {
  const receipt = input.receipt
  const workTree = await input.materializer.resolve(receipt, { binding: receipt.binding, attempt: input.attempt })
  const root = await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if (JSON.stringify(await identity(root)) !== JSON.stringify(receipt.binding.filesystem)) throw new SourceError('SOURCE_ROOT_CHANGED', 'Destination root changed.')
    const reservation = await materializationDirectory(root, receipt)
    try {
      const record = await open(anchored(reservation, 'receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      let manifest: SourceManifest
      try {
        const stat = await record.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_MATERIALIZATION_RECORD_MAX_BYTES) throw new SourceError('SOURCE_RECEIPT_INVALID', 'Invalid original source receipt.')
        const stored = JSON.parse(await record.readFile('utf8')) as { receipt: MaterializationReceipt; manifest: SourceManifest }
        manifest = verifySourceManifest(stored.manifest)
        if (!isDeepStrictEqual(stored.receipt, receipt) || manifest.snapshotId !== receipt.binding.snapshotId
          || manifest.manifestDigest !== receipt.verifiedManifestDigest || manifest.totalEntries !== receipt.verifiedEntries || manifest.totalBytes !== receipt.verifiedBytes)
          throw new SourceError('SOURCE_RECEIPT_INVALID', 'Stored source receipt changed.')
      } finally { await record.close() }
      const prior = await open(anchored(reservation, 'repository-receipt.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
      return await readPrivateRepository(prior, reservation, receipt, manifest, workTree)
    } finally { await reservation.close() }
  } finally { await root.close() }
}

async function readPrivateRepository(prior: FileHandle, reservation: FileHandle, receipt: MaterializationReceipt, manifest: SourceManifest, workTree: string, signal?: AbortSignal) {
  try {
    const stat = await prior.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384) throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Invalid private repository receipt.')
    const saved = JSON.parse(await prior.readFile('utf8')) as { materializationId: string; manifestDigest: string; receiptDigest: string; generatedCommit: string; configDigest: string }
    const repository = await openChildDirectory(reservation, 'repository')
    try {
      const config = await open(anchored(repository, 'config'), constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const stat = await config.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384 || sourceSha256(await config.readFile()) !== saved.configDigest)
          throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Private repository configuration changed.')
      } finally { await config.close() }
    } finally { await repository.close() }
    const gitDirectory = join(sourceMaterializationParent(receipt), 'repository')
    const head = () => signal ? qualifiedGit(gitDirectory, ['rev-parse', 'HEAD'], 2 * 1024 * 1024, signal) : qualifiedGit(gitDirectory, ['rev-parse', 'HEAD'])
    if (saved.materializationId !== receipt.materializationId || saved.manifestDigest !== manifest.manifestDigest
      || saved.receiptDigest !== sourceSha256(Buffer.from(JSON.stringify(receipt))) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.generatedCommit)
      || (await head()).toString().trim() !== saved.generatedCommit)
      throw new SourceError('SOURCE_REPOSITORY_INVALID', 'Private repository no longer matches the original materialization.')
    return { workTree, gitDirectory, generatedCommit: saved.generatedCommit, sourceCommit: manifest.git?.commit ?? null }
  } finally { await prior.close() }
}


export const JOB_PRIVATE_GIT_LAYOUT = JOB_RUNTIME_WORKSPACE_LAYOUT
const Filesystem = z.object({device:z.string().regex(/^\d+$/),inode:z.string().regex(/^\d+$/),mountId:z.string().regex(/^\d+$/)}).strict()
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const PrivateJobRepositoryMountsSchema = z.object({version:z.literal(1),layout:z.literal(JOB_PRIVATE_GIT_LAYOUT),
  workspaceId:z.string().min(1),executionId:z.string().min(1),attemptId:z.string().min(1),operationId:z.string().min(1),
  owner:z.object({grantId:z.string().min(1),epoch:z.string().regex(/^[1-9][0-9]*$/)}).strict(),
  specDigest:Digest,bindingHash:Digest,materializationId:z.uuid(),materializationDigest:Digest,
  git:z.object({directory:z.string().startsWith('/'),filesystem:Filesystem,generatedCommit:z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    sourceCommit:z.string().nullable(),repositoryReceiptDigest:Digest,configDigest:Digest,indexDigest:Digest,mountpoint:Filesystem}).strict(),
  scheduler:z.object({directory:z.string().startsWith('/'),filesystem:Filesystem}).strict(),
}).strict()
export type PrivateJobRepositoryMounts = z.infer<typeof PrivateJobRepositoryMountsSchema> & {receiptDigest:string}
function mountBody(raw:PrivateJobRepositoryMounts) {
  const {receiptDigest,...record}=raw
  Digest.parse(receiptDigest)
  return PrivateJobRepositoryMountsSchema.parse(record)
}
async function gitChild(parent:FileHandle,name:string) {
  const child=await open(anchored(parent,name),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  try {
    const stat=await child.stat(),before=await identity(parent),after=await identity(child)
    if(stat.uid!==process.getuid?.()||(stat.mode&0o022)||before.device!==after.device||before.mountId!==after.mountId)
      throw new SourceError('SOURCE_REPOSITORY_INVALID','Original Git reference directory changed.')
    return child
  } catch(error) {await child.close();throw error}
}
const schedulerReceipt = 'job-heavy-jobs-receipt.json'
async function privateFile(directory:FileHandle,name:string,maxBytes:number):Promise<Buffer> {
  const handle=await open(anchored(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
  try {
    const stat=await handle.stat()
    if(!stat.isFile()||stat.nlink!==1||stat.uid!==process.getuid?.()||(stat.mode&0o022)||stat.size>maxBytes)
      throw new SourceError('SOURCE_REPOSITORY_INVALID','Original private Git record changed.')
    return await handle.readFile()
  } finally {await handle.close()}
}
function jobRepositoryOwner(execution:JobExecutionRecord) {
  return {workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId,
    owner:execution.owner,specDigest:execution.acceptedSpec.specDigest,bindingHash:execution.acceptedSpec.bindingHash,
    materializationId:execution.acceptedSpec.source.materializationId,materializationDigest:execution.acceptedSpec.source.materializationDigest}
}
function requireJobRepositoryOwner(execution:JobExecutionRecord,mounts:PrivateJobRepositoryMounts) {
  const expected=jobRepositoryOwner(execution),parent=dirname(execution.acceptedSpec.target.destination.canonicalProjectRoot)
  if(!isDeepStrictEqual(expected,{workspaceId:mounts.workspaceId,executionId:mounts.executionId,attemptId:mounts.attemptId,
    operationId:mounts.operationId,owner:mounts.owner,specDigest:mounts.specDigest,bindingHash:mounts.bindingHash,
    materializationId:mounts.materializationId,materializationDigest:mounts.materializationDigest})
    ||parent.split('/').at(-1)!==mounts.materializationId
    ||execution.acceptedSpec.target.destination.canonicalProjectRoot!==join(parent,'tree')
    ||mounts.git.directory!==join(parent,'repository')||mounts.scheduler.directory!==join(parent,'job-heavy-jobs')
    ||mounts.git.sourceCommit!==execution.acceptedSpec.source.commit)
    throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Git mounts belong to another original Job materialization/owner.')
}
/** Creates only exact app-owned mountpoint/state metadata under an already verified
 * original materialization. Incomplete claims persist; no aged-lock deletion or cleanup. */
export async function preparePrivateJobRepositoryMounts(input:{record:SourceMaterializationRecord;execution:JobExecutionRecord;
  attempt:MaterializationAttempt;materializer:PrivateSourceMaterializer;reauthorize:()=>Promise<void>}):Promise<PrivateJobRepositoryMounts> {
  const {record,execution}=input,receipt=record.receipt
  if(record.operationId!==execution.operationId||receipt.executionId!==execution.id||receipt.attemptId!==execution.attemptId
    ||receipt.binding.workspaceId!==execution.workspaceId||receipt.materializationId!==execution.acceptedSpec.source.materializationId
    ||sourceMaterializationDigest(record)!==execution.acceptedSpec.source.materializationDigest||record.finalDispatchBindingHash!==execution.acceptedSpec.bindingHash||receipt.binding.accessMode!=='exclusive-write')
    throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Scheduler reservation requires the exact original Job/source owner.')
  await input.reauthorize()
  const original=await verifyPrivateSourceRepository({receipt,attempt:input.attempt,materializer:input.materializer})
  if(original.workTree!==execution.acceptedSpec.target.destination.canonicalProjectRoot||original.sourceCommit!==execution.acceptedSpec.source.commit)
    throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original private Git placement changed.')
  const root=await openPrivateRoot(receipt.binding.canonicalPath)
  try {
    if(!isDeepStrictEqual(await identity(root),receipt.binding.filesystem))throw new SourceError('SOURCE_ROOT_CHANGED','Original Job root changed.')
    const reservation=await materializationDirectory(root,receipt)
    try {
      try {
        const claim=JSON.parse((await privateFile(reservation,'job-heavy-jobs-claim.json',16384)).toString())
    if(!isDeepStrictEqual(claim,jobRepositoryOwner(execution)))throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original scheduler claim changed.')
    const bytes=await privateFile(reservation,schedulerReceipt,32768),saved=PrivateJobRepositoryMountsSchema.parse(JSON.parse(bytes.toString()))
        const mounts={...saved,receiptDigest:sourceSha256(bytes)}
        requireJobRepositoryOwner(execution,mounts);await input.reauthorize();await verifyPrivateJobRepositoryMounts(execution,mounts)
        return mounts
      } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
      await input.reauthorize()
      // EXCL ownership fence: interrupted initialization is retained, never guessed/reinitialized.
      const claim=await open(anchored(reservation,'job-heavy-jobs-claim.json'),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
      try {await claim.writeFile(JSON.stringify(jobRepositoryOwner(execution)));await claim.sync();await reservation.sync()} finally {await claim.close()}
      const git=await openChildDirectory(reservation,'repository')
      try {
        await mkdir(anchored(git,'graphql-heavy-jobs'),{mode:0o700})
        await mkdir(anchored(reservation,'job-heavy-jobs'),{mode:0o700})
        const mountpoint=await openChildDirectory(git,'graphql-heavy-jobs'),scheduler=await openChildDirectory(reservation,'job-heavy-jobs')
        try {
          if((await readdir(anchored(mountpoint))).length||(await readdir(anchored(scheduler))).length)throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Only fresh private scheduler directories may be reserved.')
          const saved=PrivateJobRepositoryMountsSchema.parse({version:1,layout:JOB_PRIVATE_GIT_LAYOUT,...jobRepositoryOwner(execution),
            git:{directory:original.gitDirectory,filesystem:await identity(git),generatedCommit:original.generatedCommit,sourceCommit:original.sourceCommit,
              repositoryReceiptDigest:sourceSha256(await privateFile(reservation,'repository-receipt.json',16384)),
              configDigest:sourceSha256(await privateFile(git,'config',16384)),indexDigest:sourceSha256(await privateFile(git,'index',4*1024*1024)),mountpoint:await identity(mountpoint)},
            scheduler:{directory:join(sourceMaterializationParent(receipt),'job-heavy-jobs'),filesystem:await identity(scheduler)}})
          await input.reauthorize()
          const bytes=Buffer.from(JSON.stringify(saved)),file=await open(anchored(reservation,schedulerReceipt),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
          try {await file.writeFile(bytes);await file.sync()} finally {await file.close()}
          await mountpoint.sync();await scheduler.sync();await git.sync();await reservation.sync();await root.sync()
          const mounts={...saved,receiptDigest:sourceSha256(bytes)}
          requireJobRepositoryOwner(execution,mounts);await input.reauthorize();await verifyPrivateJobRepositoryMounts(execution,mounts)
          return mounts
        } finally {await mountpoint.close();await scheduler.close()}
      } finally {await git.close()}
    } finally {await reservation.close()}
  } finally {await root.close()}
}
/** Read-only original-record check before native create. Does not initialize Git,
 * reopen arbitrary paths, drop held state, or reverify an already mutable Job tree. */
export async function verifyPrivateJobRepositoryMounts(execution:JobExecutionRecord,raw:PrivateJobRepositoryMounts):Promise<void> {
  const mounts={...mountBody(raw),receiptDigest:raw.receiptDigest}
  requireJobRepositoryOwner(execution,mounts)
  const reservation=await openPrivateRoot(dirname(mounts.git.directory))
  try {
    const claim=JSON.parse((await privateFile(reservation,'job-heavy-jobs-claim.json',16384)).toString())
    if(!isDeepStrictEqual(claim,jobRepositoryOwner(execution)))throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original scheduler claim changed.')
    const bytes=await privateFile(reservation,schedulerReceipt,32768)
    if(sourceSha256(bytes)!==mounts.receiptDigest||!isDeepStrictEqual(PrivateJobRepositoryMountsSchema.parse(JSON.parse(bytes.toString())),mountBody(mounts)))
      throw new SourceError('SOURCE_REPOSITORY_CONFLICT','Original scheduler receipt changed.')
    const repositoryReceipt=await privateFile(reservation,'repository-receipt.json',16384)
    if(sourceSha256(repositoryReceipt)!==mounts.git.repositoryReceiptDigest)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original repository receipt changed.')
    const original=JSON.parse(repositoryReceipt.toString()) as {generatedCommit:string;configDigest:string}
    if(original.generatedCommit!==mounts.git.generatedCommit||original.configDigest!==mounts.git.configDigest)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original Git pins changed.')
    const git=await openChildDirectory(reservation,'repository'),scheduler=await openChildDirectory(reservation,'job-heavy-jobs')
    try {
      if(!isDeepStrictEqual(await identity(git),mounts.git.filesystem)||!isDeepStrictEqual(await identity(scheduler),mounts.scheduler.filesystem))
        throw new SourceError('SOURCE_ROOT_CHANGED','Original Git/scheduler directory identity changed.')
      const mountpoint=await openChildDirectory(git,'graphql-heavy-jobs')
      try {if(!isDeepStrictEqual(await identity(mountpoint),mounts.git.mountpoint)||(await readdir(anchored(mountpoint))).length)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original empty scheduler mountpoint changed.')} finally {await mountpoint.close()}
      if(sourceSha256(await privateFile(git,'config',16384))!==mounts.git.configDigest||sourceSha256(await privateFile(git,'index',4*1024*1024))!==mounts.git.indexDigest)
        throw new SourceError('SOURCE_REPOSITORY_INVALID','Original Git configuration/index changed.')
      const head=(await privateFile(git,'HEAD',4096)).toString().trim()
      let commit=head
      if(head.startsWith('ref: ')) {
        const ref=head.slice(5)
        if(!/^refs\/heads\/[a-zA-Z0-9_-]+$/.test(ref))throw new SourceError('SOURCE_REPOSITORY_INVALID','Unexpected original private Git HEAD.')
        const refs=await gitChild(git,'refs'),heads=await gitChild(refs,'heads')
        try {commit=(await privateFile(heads,ref.slice('refs/heads/'.length),4096)).toString().trim()} finally {await heads.close();await refs.close()}
      }
      if(commit!==mounts.git.generatedCommit)throw new SourceError('SOURCE_REPOSITORY_INVALID','Original private Git HEAD changed.')
    } finally {await git.close();await scheduler.close()}
  } finally {await reservation.close()}
}
