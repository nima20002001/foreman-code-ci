import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, expect, it, vi } from 'vitest'
import type { RootBinding, SourceManifest } from '@foreman-code/contracts/source-materialization'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { createPrivateSourceRepository } from './repository.js'
import { qualifiedGit } from './capture.js'
import { verificationRuntimeFixture } from '../../../test/helpers/verificationRuntimeFixture.js'

const execute = promisify(execFile)
const phases = vi.hoisted(() => new Map<string, { count: number; ms: number }>())
const importer = vi.hoisted(() => ({ onSpawn: null as ((pid: number) => void) | null }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFile: new Proxy(actual.execFile, { apply(target, receiver, args) {
    const child: ReturnType<typeof actual.execFile> = Reflect.apply(target, receiver, args)
    if (args[0] === '/usr/bin/git' && args[1]?.includes('fast-import')) {
      const start = performance.now()
      child.once('spawn', () => importer.onSpawn?.(child.pid!))
      child.once('close', () => phases.set('fast-import', { count: 1, ms: performance.now() - start }))
    }
    return child
  } }) }
})
vi.mock('./capture.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./capture.js')>()
  return { ...actual, qualifiedGit: vi.fn(async (...args: Parameters<typeof actual.qualifiedGit>) => {
    const start = performance.now(), phase = args[1][0]!, value = phases.get(phase) ?? { count: 0, ms: 0 }
    try { return await actual.qualifiedGit(...args) }
    finally { value.count++; value.ms += performance.now() - start; phases.set(phase, value) }
  }) }
})
const roots: string[] = []
afterEach(async () => { importer.onSpawn = null; phases.clear(); vi.restoreAllMocks(); vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(files: Map<string, { bytes: Buffer; executable: boolean }>, git?: SourceManifest['git']) {
  const root = await mkdtemp('/tmp/jobprep-repository-'); roots.push(root)
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: git ? 'git-tree-v1' : 'exclusive-explicit-bytes-v1', executablePolicy: 'preserve-approved', ...(git ? { git } : {}),
    entries: [...files].map(([path, file]) => ({ path, kind: 'file' as const, byteSize: file.bytes.length, sha256: sourceSha256(file.bytes), executable: file.executable }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), deletions: [] })
  const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: root, filesystem,
    accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null }
  const materializer = new PrivateSourceMaterializer({ read: async (_snapshot, entry) => files.get(entry.path)!.bytes }, async () => {})
  const start = performance.now(), receipt = await materializer.prepare({ manifest, binding, attempt })
  return { root, manifest, receipt, materializer, attempt, materializeMs: performance.now() - start }
}

it.each(['sha1', 'sha256'] as const)('imports exact binary, empty, executable, quoted and Unicode paths into one private %s snapshot without history', async objectFormat => {
  const files = new Map([
    ['empty', { bytes: Buffer.alloc(0), executable: false }],
    ['quote" space/فایل.txt', { bytes: Buffer.from([0, 10, 255, 1]), executable: false }],
    ['run.sh', { bytes: Buffer.from('#!/bin/sh\nexit 0\n'), executable: true }],
  ])
  const width = objectFormat === 'sha1' ? 40 : 64
  const f = await fixture(files, { commit: 'c'.repeat(width), tree: 'd'.repeat(width), objectFormat }), repository = await createPrivateSourceRepository(f)
  for (const [path, file] of files) expect(await qualifiedGit(repository.gitDirectory, ['show', `HEAD:${path}`])).toEqual(file.bytes)
  expect((await qualifiedGit(repository.gitDirectory, ['rev-list', '--count', 'HEAD'])).toString().trim()).toBe('1')
  expect((await qualifiedGit(repository.gitDirectory, ['ls-files', '--stage'])).toString()).toContain('100755')
  expect(await createPrivateSourceRepository(f)).toEqual(repository)
  expect(await readdir(repository.workTree)).not.toContain('.git')
})

it('rejects changed bytes before publishing a repository receipt and retains the interrupted namespace', async () => {
  const f = await fixture(new Map([['source.txt', { bytes: Buffer.from('original'), executable: false }]]))
  const resolve = f.materializer.resolve.bind(f.materializer)
  vi.spyOn(f.materializer, 'resolve').mockImplementationOnce(async (...args) => {
    const tree = await resolve(...args); await writeFile(join(tree, 'source.txt'), 'modified'); return tree
  })
  await expect(createPrivateSourceRepository(f)).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
  expect(await readdir(join(f.root, f.receipt.materializationId))).not.toContain('repository-receipt.json')
})

it('honors an already canceled worker request before private repository creation', async () => {
  const f = await fixture(new Map([['source.txt', { bytes: Buffer.from('original'), executable: false }]]))
  await expect(createPrivateSourceRepository({ ...f, signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  expect(await readdir(join(f.root, f.receipt.materializationId))).not.toContain('repository')
})

it('cancels the active importer and retains incomplete ownership without publishing or reinitializing', async () => {
  const f = await fixture(new Map([['source.txt', { bytes: Buffer.from('original'), executable: false }]])), controller = new AbortController()
  let pid = 0
  importer.onSpawn = current => { pid = current; controller.abort() }
  await expect(createPrivateSourceRepository({ ...f, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(pid).toBeGreaterThan(0)
  expect(() => process.kill(pid, 0)).toThrow()
  expect(await readdir(join(f.root, f.receipt.materializationId))).not.toContain('repository-receipt.json')
  await expect(createPrivateSourceRepository(f)).rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_UNCERTAIN' })
})

it('maps total-deadline expiration during import to a retryable sanitized error after positive child closure', async () => {
  const f = await fixture(new Map([['source.txt', { bytes: Buffer.from('original'), executable: false }]])), deadline = new AbortController()
  vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal)
  let pid = 0
  importer.onSpawn = current => { pid = current; deadline.abort(new DOMException('private /source/path', 'TimeoutError')) }
  await expect(createPrivateSourceRepository(f)).rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_TIMEOUT', status: 503, details: { retryable: true } })
  expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid, 0)).toThrow()
  expect(await readdir(join(f.root, f.receipt.materializationId))).not.toContain('repository-receipt.json')
})

it.runIf(process.env.JOBPREP_REAL_TREE === '1')('prepares the actual 7bd78e54 tree within the unchanged worker RPC budget', async () => {
  const commit = '7bd78e5412c7591feb088457b8b41f415fab416a', repositoryRoot = new URL('../../../../..', import.meta.url).pathname.replace(/\/$/, '')
  const { stdout } = await execute('/usr/bin/git', ['-C', repositoryRoot, 'ls-tree', '-r', '-z', commit], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 })
  const files = new Map<string, { bytes: Buffer; executable: boolean }>()
  const records = stdout.toString().split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line)
    if (!match) throw new Error('Unsupported real-tree fixture entry')
    return { executable: match[1] === '100755', object: match[2]!, path: match[3]! }
  })
  // execFile drains both pipes concurrently while the bounded object request is written.
  const blobs = await new Promise<Buffer>((resolve, reject) => {
    const reader = execFile('/usr/bin/git', ['-C', repositoryRoot, 'cat-file', '--batch'], { encoding: 'buffer', maxBuffer: 128 * 1024 * 1024 }, (error, output) => error ? reject(error) : resolve(output))
    reader.stdin!.end(records.map(record => `${record.object}\n`).join(''))
  })
  let offset = 0
  for (const record of records) {
    const end = blobs.indexOf(10, offset), size = Number(blobs.subarray(offset, end).toString().split(' ')[2])
    files.set(record.path, { bytes: blobs.subarray(end + 1, end + 1 + size), executable: record.executable }); offset = end + size + 2
  }
  const tree = (await execute('/usr/bin/git', ['-C', repositoryRoot, 'rev-parse', `${commit}^{tree}`])).stdout.trim()
  const f = await fixture(files, { commit, tree, objectFormat: 'sha1' })
  const resolve = f.materializer.resolve.bind(f.materializer), verify = f.materializer.verify.bind(f.materializer)
  let resolving = false
  vi.spyOn(f.materializer, 'resolve').mockImplementation(async (...args) => {
    const start = performance.now(); resolving = true
    try { return await resolve(...args) }
    finally { resolving = false; phases.set('resolve', { count: 1, ms: performance.now() - start }) }
  })
  vi.spyOn(f.materializer, 'verify').mockImplementation(async (...args) => {
    const start = performance.now()
    try { return await verify(...args) }
    finally { if (!resolving) phases.set('final-verify', { count: 1, ms: performance.now() - start }) }
  })
  const start = performance.now()
  const repository = await createPrivateSourceRepository(f), preparationMs = performance.now() - start
  const profile = { entries: f.manifest.totalEntries, bytes: f.manifest.totalBytes, materializeMs: f.materializeMs, preparationMs, phases: Object.fromEntries(phases) }
  process.stdout.write(`JOBPREP_PROFILE ${JSON.stringify(profile)}\n`)
  expect((await qualifiedGit(repository.gitDirectory, ['rev-parse', 'HEAD^{tree}'])).toString().trim()).toBe(tree)
  expect(await readFile(join(f.root, f.receipt.materializationId, 'repository-receipt.json'), 'utf8')).toContain(repository.generatedCommit)
  expect(preparationMs).toBeLessThan(30_000)
  expect([...phases.values()].reduce((sum, phase) => sum + phase.count, 0)).toBeLessThan(20)
}, 180_000)

it('imports a per-Job quota materialization from its quota namespace', async () => {
  const files = new Map([['README.md', { bytes: Buffer.from('quota source\n'), executable: false }]])
  const f = await fixture(files), slot = verificationRuntimeFixture().measurement.fingerprint.quotaPool!.slots[0]!
  const receipt = { ...f.receipt, quota: slot }
  await mkdir(join(f.root, slot.namespace), { mode: 0o700 })
  await rename(join(f.root, f.receipt.materializationId), join(f.root, slot.namespace, f.receipt.materializationId))
  const record = join(f.root, slot.namespace, f.receipt.materializationId, 'receipt.json')
  await unlink(record); await writeFile(record, JSON.stringify({ receipt, manifest: f.manifest }), { mode: 0o600 })
  const repository = await createPrivateSourceRepository({ ...f, receipt })
  expect(await qualifiedGit(repository.gitDirectory, ['show', 'HEAD:README.md'])).toEqual(files.get('README.md')!.bytes)
  expect(repository.workTree).toBe(join(f.root, slot.namespace, f.receipt.materializationId, 'tree'))
})
