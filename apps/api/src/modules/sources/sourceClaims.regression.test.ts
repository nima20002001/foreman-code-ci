import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { measureRetainedMaterialization, measureRetainedSourceDirectory } from './retainedDirectoryUsage.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import type { RootBinding, MaterializationReceipt } from '@foreman-code/contracts/source-materialization'
import type { MaterializationAttempt } from './ports.js'
import { deferred } from '../../../test/helpers/deferred.js'

const pauses = vi.hoisted(() => ({ beforeUnlink: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, unlink: async (path: Parameters<typeof actual.unlink>[0]) => {
    if (String(path).endsWith('.lock') && pauses.beforeUnlink) {
      const pause = pauses.beforeUnlink; pauses.beforeUnlink = null; await pause()
    }
    return actual.unlink(path)
  }, rename: async (from: Parameters<typeof actual.rename>[0], to: Parameters<typeof actual.rename>[1]) => {
    if (String(from).endsWith('.lock') && pauses.beforeUnlink) {
      const pause = pauses.beforeUnlink; pauses.beforeUnlink = null; await pause()
    }
    return actual.rename(from, to)
  } }
})
const roots: string[] = []
afterEach(async () => { pauses.beforeUnlink = null; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(accessMode: RootBinding['accessMode'] = 'exclusive-write') {
  const root = await mkdtemp(join(tmpdir(), 'source-claims-'))
  roots.push(root)
  await chmod(root, 0o700)
  const bytes = Buffer.from('accepted source\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'src/app.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root,
    filesystem, accessMode, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt: MaterializationAttempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null }
  const materializer = () => new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {})
  return { root, bytes, manifest, binding, attempt, materializer }
}

async function claimPath(root: string, receipt: MaterializationReceipt) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const value = JSON.parse(await readFile(join(root, entry.name), 'utf8')) as { materializationId?: string }
    if (value.materializationId === receipt.materializationId) return join(root, entry.name)
  }
  throw new Error('The original execution claim is missing')
}

it('serializes a delayed duplicate release with successor acquisition and preserves the successor claim', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f), entered = deferred(), resume = deferred()
  pauses.beforeUnlink = async () => { entered.resolve(); await resume.promise }
  const delayed = releaseMaterializationClaim(receipt, async () => 'released')
  await entered.promise
  const duplicate = releaseMaterializationClaim(receipt, async () => 'released').then(() => 'released' as const, () => 'rejected' as const)
  const next = { ...f, attempt: { ...f.attempt, attemptId: randomUUID() } }
  let successor
  try {
    // On the defective implementation the duplicate removes M0 while the first
    // pathname unlink is paused, letting M1 acquire before that stale unlink.
    const outcome = await Promise.race([duplicate, new Promise<'pending'>(done => setTimeout(() => done('pending'), 100))])
    if (outcome === 'released') successor = await f.materializer().prepare(next)
  } finally { resume.resolve() }
  await delayed; await duplicate
  successor ??= await f.materializer().prepare(next)
  expect(await f.materializer().prepare(next)).toEqual(successor)
  await expect(f.materializer().prepare({ ...next, attempt: { ...next.attempt, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
})

it('lets another execution prepare a read-only root while the first execution keeps its claim', async () => {
  const f = await fixture('read-only'), first = await f.materializer().prepare(f)
  const other = { ...f, attempt: { ...f.attempt, executionId: randomUUID(), attemptId: randomUUID() } }
  const second = await f.materializer().prepare(other)
  expect(second.materializationId).not.toBe(first.materializationId)
  expect(await readFile(join(f.root, second.materializationId, 'tree/src/app.txt'))).toEqual(f.bytes)
  // Each original attempt still recovers only its own claim and copy.
  expect(await f.materializer().prepare(f)).toEqual(first)
  expect(await f.materializer().prepare(other)).toEqual(second)
  await expect(f.materializer().prepare({ ...f, attempt: { ...f.attempt, attemptId: randomUUID() } }))
    .rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
  await releaseMaterializationClaim(first, async () => 'released')
  expect(await f.materializer().prepare(other)).toEqual(second)
  await releaseMaterializationClaim(second, async () => 'released')
})

it('lets two writable executions write in the same working directory while the first writer stays alive', async () => {
  const f = await fixture('exclusive-write')
  const firstInput = { ...f, sharedWritableTree: true as const }
  const first = await f.materializer().prepare(firstInput)
  const cwd = await f.materializer().resolve(first, { binding: f.binding, attempt: f.attempt })
  const script = `
    const fs = require('node:fs');
    fs.writeFileSync('orchestrator.txt', 'ORCHESTRATOR');
    fs.writeFileSync('src/app.txt', 'shared edit');
    console.log('ready');
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (fs.existsSync('requester.txt')) { clearInterval(timer); process.exit(0); }
      if (Date.now() > deadline) { clearInterval(timer); process.exit(1); }
    }, 10);
  `
  const writer = spawn(process.execPath, ['-e', script], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<number | null>(resolve => writer.once('exit', resolve))
  try {
    await new Promise<void>((resolve, reject) => {
      writer.stdout.once('data', () => resolve())
      writer.once('error', reject)
      writer.once('exit', () => reject(new Error('The first writer exited before readiness')))
    })
    const other = { ...firstInput, attempt: { ...f.attempt, executionId: randomUUID(), attemptId: randomUUID() } }
    const second = await f.materializer().prepare(other)
    const secondCwd = await f.materializer().resolve(second, { binding: f.binding, attempt: other.attempt })
    expect(secondCwd).toBe(cwd)
    expect(writer.exitCode).toBeNull()
    await promisify(execFile)(process.execPath, ['-e', `
      const fs = require('node:fs');
      if (fs.readFileSync('orchestrator.txt', 'utf8') !== 'ORCHESTRATOR') process.exit(2);
      fs.writeFileSync('requester.txt', 'REQUESTER');
    `], { cwd: secondCwd })
    expect(await exited).toBe(0)
    expect(await readFile(join(cwd, 'src/app.txt'), 'utf8')).toBe('shared edit')
    expect(await readFile(join(cwd, 'requester.txt'), 'utf8')).toBe('REQUESTER')
    expect(await measureRetainedMaterialization(first)).toBe(
      await measureRetainedSourceDirectory(f.root, first.materializationId)
      + await measureRetainedSourceDirectory(f.root, first.sharedTree!.id))
    await releaseMaterializationClaim(first, async () => 'released')
    expect(await f.materializer().prepare(other)).toEqual(second)
    await releaseMaterializationClaim(second, async () => 'released')
  } finally {
    if (writer.exitCode === null) writer.kill('SIGTERM')
    await exited
  }
})

it('holds a kernel lock across validated claim deletion, including other processes', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f), entered = deferred(), resume = deferred()
  pauses.beforeUnlink = async () => { entered.resolve(); await resume.promise }
  const release = releaseMaterializationClaim(receipt, async () => 'released')
  await entered.promise
  try {
    await expect(promisify(execFile)('/usr/bin/flock', ['--exclusive', '--nonblock', f.root, '/usr/bin/true'])).rejects.toMatchObject({ code: 1 })
  } finally { resume.resolve(); await release }
  await promisify(execFile)('/usr/bin/flock', ['--exclusive', '--nonblock', f.root, '/usr/bin/true'])
})

it('measures shared working and reference trees once per hard-linked inode after dependency-link cleanup', async () => {
  const f = await fixture()
  const receipt = await f.materializer().prepare({ ...f, sharedWritableTree: true })
  const cwd = await f.materializer().resolve(receipt, { binding: f.binding, attempt: f.attempt })
  const reference = join(f.root, receipt.materializationId)
  const claim = await claimPath(f.root, receipt)
  const packagePath = join(cwd, 'package.js')
  await writeFile(packagePath, Buffer.alloc(32 * 1024, 1))
  await link(packagePath, join(reference, 'package.js'))
  await symlink('/missing/dependency-cache', join(cwd, 'node_modules'))
  await releaseMaterializationClaim(receipt, async () => 'released')
  const file = await lstat(packagePath)
  const duplicateBytes = Math.max(4096, file.size, file.blocks * 512)
  const separateBytes = await measureRetainedSourceDirectory(f.root, receipt.materializationId)
    + await measureRetainedSourceDirectory(f.root, receipt.sharedTree!.id)
  expect(await measureRetainedMaterialization(receipt)).toBe(separateBytes - duplicateBytes)
  expect(await readFile(join(cwd, 'src/app.txt'))).toEqual(f.bytes)
  await expect(readFile(claim)).rejects.toMatchObject({ code: 'ENOENT' })
})

async function inFreshProcess(receipt: unknown, loseAcknowledgement = false) {
  const script = `import { releaseMaterializationClaim } from './src/modules/sources/materialization.ts';
    await releaseMaterializationClaim(JSON.parse(process.argv[1]), async () => 'released');
    process.exit(${loseAcknowledgement ? 42 : 0});`
  return promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, JSON.stringify(receipt)])
}

it('replays the exact durable release in a fresh process after a lost acknowledgement', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await expect(inFreshProcess(receipt, true)).rejects.toMatchObject({ code: 42 })
  expect(await f.materializer().recover(f.binding, f.attempt)).toBeNull()
  await inFreshProcess(receipt)
  expect(await readFile(join(f.root, receipt.materializationId, 'tree/src/app.txt'))).toEqual(f.bytes)
})

it('replays an old release without deleting a successor claim', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  const next = { ...f, attempt: { ...f.attempt, attemptId: randomUUID() } }
  const successor = await f.materializer().prepare(next)
  await inFreshProcess(receipt)
  expect(await f.materializer().prepare(next)).toEqual(successor)
  await expect(f.materializer().prepare({ ...next, attempt: { ...next.attempt, attemptId: randomUUID() } })).rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
})

it('rejects arbitrary missing claims without a durable original release', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await unlink(await claimPath(f.root, receipt))
  await expect(releaseMaterializationClaim(receipt, async () => 'released')).rejects.toMatchObject({
    code: 'SOURCE_CLAIM_MISSING',
    message: 'The original source claim and its archived release record are missing; cleanup cannot confirm ownership.',
  })
})

it.each(['owned', 'uncertain'] as const)('does not replay without positive reconciliation (%s)', async status => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  await expect(releaseMaterializationClaim(receipt, async () => status)).rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
})

it.each(['materializationId', 'attemptId', 'binding', 'localTreeIdentity', 'verifiedAt'] as const)('binds release evidence to the exact original receipt (%s)', async field => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  const changed = { ...receipt }
  if (field === 'binding') changed.binding = { ...receipt.binding, bindingRevision: 2 }
  else if (field === 'localTreeIdentity') changed.localTreeIdentity = { ...receipt.localTreeIdentity, inode: '9999999' }
  else if (field === 'verifiedAt') changed.verifiedAt = '2020-01-01T00:00:00.000Z'
  else changed[field] = randomUUID()
  await expect(releaseMaterializationClaim(changed, async () => 'released')).rejects.toThrow()
})

it('rejects a corrupted durable release record', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await releaseMaterializationClaim(receipt, async () => 'released')
  await writeFile(join(f.root, receipt.materializationId, 'released-claim.json'), JSON.stringify({ version: 1, materializationId: randomUUID(), binding: f.binding, attempt: f.attempt }))
  await expect(releaseMaterializationClaim(receipt, async () => 'released')).rejects.toMatchObject({ code: 'SOURCE_CLAIM_CONFLICT' })
})

it('rejects changed receipt facts before releasing an active claim', async () => {
  const f = await fixture(), receipt = await f.materializer().prepare(f)
  await expect(releaseMaterializationClaim({ ...receipt, verifiedAt: '2020-01-01T00:00:00.000Z' }, async () => 'released')).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_CONFLICT' })
  expect(await f.materializer().prepare(f)).toEqual(receipt)
})
