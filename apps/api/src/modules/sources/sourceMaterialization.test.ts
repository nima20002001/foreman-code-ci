import { setTimeout as setRealTimeout, clearTimeout as clearRealTimeout } from 'node:timers'
import { randomUUID } from 'node:crypto'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { mkdtemp, mkdir, chmod, writeFile, readFile, readdir, rename, symlink, rm } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSourceManifest, sourceSha256, verifySourceManifest, verifySourceBytes, sourcePath } from './manifest.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { PrivateSourceSnapshotStore } from './store.js'
import { createPrivateSourceRepository } from './repository.js'
import { InstalledSourceExecutionHosts, type SourceAttemptAuthority } from './executionHosts.js'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { captureExplicitSource, captureGitSource, qualifiedGit, type SourceSnapshotSink } from './capture.js'
import type { SourceManifest, RootBinding } from '@foreman-code/contracts/source-materialization'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import type { MaterializationAttempt } from './ports.js'
const diskState = vi.hoisted(() => ({ full: false, syncFailure: false }))
vi.mock('./sourceTreeSync.js', async original => {
  const actual = await original<typeof import('./sourceTreeSync.js')>()
  return { syncSourceTree: async (...args: Parameters<typeof actual.syncSourceTree>) => {
    if (diskState.syncFailure) throw new Error('Filesystem flush failed')
    return actual.syncSourceTree(...args)
  } }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, statfs: async (...args: Parameters<typeof actual.statfs>) => diskState.full ? { bavail: 0n, bsize: 4096n } : actual.statfs(...args) }
})
const roots: string[] = []
afterEach(async () => {
  diskState.full = false
  diskState.syncFailure = false
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-materialization-')); roots.push(root); await chmod(root, 0o700)
  const bytes = Buffer.from('accepted source\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'src/app.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const handle = await openPrivateRoot(root), fs = await identity(handle); await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), workspaceId: randomUUID(), rootId: randomUUID(),
    bindingRevision: 1, locationRevision: 1, canonicalPath: root, filesystem: fs, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt: MaterializationAttempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  return { root, bytes, manifest, binding, attempt }
}
const sink = (): SourceSnapshotSink & { committed: SourceManifest[]; content: Map<string, Buffer> } => {
  const committed: SourceManifest[] = [], content = new Map<string, Buffer>()
  return { committed, content, async write(_id, entry, bytes) { content.set(entry.path, Buffer.from(bytes)) }, async commit(manifest) { committed.push(manifest) }, async abort() { content.clear() } }
}
it('retains an uncertain claim without activating a receipt when the filesystem flush fails', async () => {
  const f = await fixture()
  const materializer = new PrivateSourceMaterializer({ read: async () => f.bytes }, async () => {})
  diskState.syncFailure = true
  await expect(materializer.prepare(f)).rejects.toThrow('Filesystem flush failed')
  const directories = await readdir(f.root, { withFileTypes: true })
  const reservation = directories.find(entry => entry.isDirectory())!
  expect(await readdir(join(f.root, reservation.name))).toEqual(['staging'])
  expect(await readFile(join(f.root, reservation.name, 'staging/src/app.txt'))).toEqual(f.bytes)
  diskState.syncFailure = false
  await expect(materializer.prepare(f)).rejects.toMatchObject({ code: 'SOURCE_MATERIALIZATION_UNCERTAIN' })
})
describe('source manifest policy', () => {
  it('pins a deterministic manifest independent of caller property order', () => {
    const content = Buffer.from('source fixture\n')
    const manifest = createSourceManifest({ version: 1, snapshotId: '11111111-1111-4111-8111-111111111111', approvedSourceId: '22222222-2222-4222-8222-222222222222', capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries: [{ path: 'src/index.ts', kind: 'file', byteSize: content.length, sha256: sourceSha256(content), executable: false }], deletions: [] })
    expect(manifest.manifestDigest).toBe('f57be1db4acbcf750f65b5802f1702cf2d5cd9abe6a4def61c17d5b867f00d60')
  })

  it.each(['../outside', '/absolute', 'C:/drive', 'dir\\file', 'dir//file', 'dir/../file', 'x\0z', 'e\u0301', 'dir/name.', '.git/config', '.env', 'id_ed25519', '.config/provider/token', 'CON'])('rejects ambiguous or sensitive inclusion %s', (path) => { expect(() => sourcePath(path)).toThrow() })
  it.each(['apps/api/src/modules/interactions/wave25/credentials.ts', 'src/credentials.test.ts', 'src/credentials.spec.js', 'src/credentials.d.ts', 'src/credentials.d.mts', 'src/credentials.d.cts',
    'src/credentials.tsx', 'src/credentials.js', 'src/credentials.jsx', 'src/credentials.mts', 'src/credentials.cts',
    'src/credentials.mjs', 'src/credentials.cjs'])('classifies implementation leaf %s as source', path => {
    expect(sourcePath(path)).toBe(path)
  })
  it.each(['credentials', 'credentials/data.ts', 'credentials.ts/index.ts', 'credentials.test.ts/index.ts',
    '.aws/credentials.ts', 'src/.ssh/credentials.ts', 'src/.env', 'src/.env.local',
    'credentials.json', 'credentials.ini', 'credentials.yaml', 'credentials.yml', 'credentials.txt', 'credentials.bak',
    'credentials.ts.bak', 'credentials.backup', 'credentials.unknown', 'credentials.json.ts', 'credentials.pem.ts',
    'credentials.backup.ts', 'credentials.custom.ts', 'private.pem', 'private.key', 'id_rsa', 'id_ed25519'])('keeps credential material or sensitive ancestor %s blocked', path => {
    expect(() => sourcePath(path)).toThrow('credential')
  })
  it('rejects private-key content even inside an otherwise allowed credential implementation filename', () => {
    const path = sourcePath('src/credentials.ts')
    const bytes = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nsynthetic-not-a-key\n-----END OPENSSH PRIVATE KEY-----\n')
    expect(() => verifySourceBytes({ path, kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }, bytes)).toThrow('Private key content')
  })
  it('allows explicit environment examples and rejects changed digests/case aliases', async () => {
    expect(sourcePath('.env.example')).toBe('.env.example')
    const { manifest } = await fixture()
    expect(() => verifySourceManifest({ ...manifest, totalBytes: 0 })).toThrow()
    const entry = manifest.entries[0]!
    expect(() => createSourceManifest({ ...manifest, entries: [
      { ...entry, path: 'SRC/app.txt' }, entry,
    ] })).toThrow(expect.objectContaining({ code: 'SOURCE_PATH_COLLISION' }))
    expect(createSourceManifest({ ...manifest, entries: [
      { ...entry, path: 'SRC/other.txt' }, entry,
    ] }).entries).toHaveLength(2)
  })
})
describe('private materialization', () => {
  it.each([31_000, 301_000])('bounds a slow source copy after %d ms without activating interrupted bytes', async elapsed => {
    const f = await fixture()
    let entered!: () => void
    let release!: () => void
    const reading = new Promise<void>(resolve => { entered = resolve })
    const bytesReady = new Promise<void>(resolve => { release = resolve })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('Source copy deadline exceeded.', 'TimeoutError')), milliseconds)
      return controller.signal
    })
    let transfer: Promise<unknown> | undefined
    try {
      const service = new PrivateSourceMaterializer({ async read(_manifest, _entry, signal) {
        entered()
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(signal.reason)
          signal?.addEventListener('abort', abort, { once: true })
          bytesReady.then(() => {
            signal?.removeEventListener('abort', abort)
            resolve()
          }, reject)
          if (signal?.aborted) abort()
        })
        return f.bytes
      } }, async () => {})
      const prepared = service.prepare(f)
      const outcome = prepared.then(value => ({ value }), error => ({ error }))
      transfer = outcome
      await reading
      await vi.advanceTimersByTimeAsync(elapsed)
      if (elapsed < 300_000) {
        release()
        const receipt = await prepared
        expect(await readFile(join(f.root, receipt.materializationId, 'tree/src/app.txt'))).toEqual(f.bytes)
      } else {
        // Bound the assertion while keeping the simulated transfer blocked.
        let timer: ReturnType<typeof setRealTimeout> | undefined
        try {
          const result = await Promise.race([
            outcome,
            new Promise(resolve => { timer = setRealTimeout(() => resolve('still blocked'), 1000) }),
          ])
          expect(result).toMatchObject({ error: { message: 'Source copy deadline exceeded.' } })
        } finally { clearRealTimeout(timer) }
        const directories = await readdir(f.root, { withFileTypes: true })
        for (const directory of directories.filter(entry => entry.isDirectory())) {
          expect(await readdir(join(f.root, directory.name))).not.toContain('tree')
        }
      }
    } finally {
      release()
      await transfer
      deadline.mockRestore()
      vi.useRealTimers()
    }
  })

  it('verifies complete bytes in a distinct local root and detects later mutation', async () => {
    const f = await fixture(), service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    const receipt = await service.prepare(f), path = await service.resolve(receipt, f)
    expect(await readFile(join(path, 'src/app.txt'))).toEqual(f.bytes)
    await writeFile(join(path, 'src/app.txt'), 'later source')
    await expect(service.resolve(receipt, f)).rejects.toThrow()
  })
  it('rejects corrupt bytes without activating a tree', async () => {
    const f = await fixture(), service = new PrivateSourceMaterializer({ async read() { return Buffer.from('corrupt') } }, async () => {})
    await expect(service.prepare(f)).rejects.toThrow('accepted manifest')
  })
  it('rejects a destination root replacement during transfer and preserves outside files', async () => {
    const f = await fixture(), old = `${f.root}-old`; roots.push(old)
    const service = new PrivateSourceMaterializer({ async read() {
      await rename(f.root, old); await mkdir(f.root, { mode: 0o700 }); await writeFile(join(f.root, 'outside'), 'preserved'); return f.bytes
    } }, async () => {})
    await expect(service.prepare(f)).rejects.toThrow('replaced')
    expect(await readFile(join(f.root, 'outside'), 'utf8')).toBe('preserved')
  })
  it('rejects a destination beneath an unprotected writable ancestor', async () => {
    const f = await fixture(), parent = join(f.root, 'unsafe'), destination = join(parent, 'destination')
    await mkdir(parent); await chmod(parent, 0o777); await mkdir(destination, { mode: 0o700 })
    const service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    await expect(service.prepare({ ...f, binding: { ...f.binding, canonicalPath: destination } })).rejects.toThrow('ancestors')
  })
  it('rejects symlink destination ancestors', async () => {
    const f = await fixture(), link = `${f.root}-link`; roots.push(link); await symlink(f.root, link)
    const service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    await expect(service.prepare({ ...f, binding: { ...f.binding, canonicalPath: link } })).rejects.toThrow()
  })
  it('keeps one exclusive owner across restarts and denies a second writer', async () => {
    const f = await fixture(), reader = { async read() { return f.bytes } }
    const first = await new PrivateSourceMaterializer(reader, async () => {}).prepare(f)
    expect(await new PrivateSourceMaterializer(reader, async () => {}).prepare(f)).toEqual(first)
    await expect(new PrivateSourceMaterializer(reader, async () => {}).prepare({ ...f, attempt: { ...f.attempt, attemptId: randomUUID() } })).rejects.toThrow()
  })
  it('rechecks authorization and exact attempt before execution', async () => {
    const f = await fixture(); let authorized = true
    const service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => { if (!authorized) throw new Error('revoked') })
    const receipt = await service.prepare(f)
    await expect(service.resolve(receipt, { ...f, attempt: { ...f.attempt, attemptId: randomUUID() } })).rejects.toThrow('accepted root')
    authorized = false; await expect(service.resolve(receipt, f)).rejects.toThrow('revoked')
  })
  it('rejects insufficient reserved disk without a ready materialization', async () => {
    const f = await fixture(); diskState.full = true
    const service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    await expect(service.prepare(f)).rejects.toThrow('reserved space')
  })
  it('rejects a swapped symlink parent at the actual write operation', async () => {
    const f = await fixture(), outside = await fixture()
    const manifest = createSourceManifest({ ...f.manifest, entries: [f.manifest.entries[0]!, { ...f.manifest.entries[0]!, path: 'src/second.ts' }] })
    const binding = { ...f.binding, manifestDigest: manifest.manifestDigest }; let reads = 0
    const service = new PrivateSourceMaterializer({ async read() {
      if (++reads === 2) {
        const id = (await readdir(f.root)).find((name) => !name.startsWith('binding-'))!
        const directory = join(f.root, id, 'staging')
        await rename(join(directory, 'src'), join(directory, 'old-src'))
        await symlink(outside.root, join(directory, 'src'))
      }
      return f.bytes
    } }, async () => {})
    await expect(service.prepare({ ...f, manifest, binding })).rejects.toThrow()
    expect(await readdir(outside.root)).toEqual([])
  })
  it('reports incomplete activation after restart without inventing ready state', async () => {
    const f = await fixture(), service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    const receipt = await service.prepare(f)
    await rename(join(f.root, receipt.materializationId, 'tree'), join(f.root, receipt.materializationId, 'staging'))
    await expect(new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {}).resolve(receipt, f)).rejects.toThrow()
  })
  it('rejects read-only/unqualified destination root', async () => {
    const f = await fixture(); await chmod(f.root, 0o500)
    const service = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    await expect(service.prepare(f)).rejects.toThrow('0700')
  })
})
describe('capture semantics', () => {
  it('captures explicitly approved binary/untracked/deletion overlay under exclusion', async () => {
    const target = sink(), bytes = Buffer.from([0, 255, 128]); let checks = 0
    const manifest = await captureExplicitSource({ capture: { approvedSourceId: randomUUID(), writerExcluded: true, async validateExclusion() { checks++ }, async read() { return bytes } },
      entries: [{ path: 'new.bin', executable: false }], deletions: ['old.txt'], overlayBaseDigest: 'b'.repeat(64), executablePolicy: 'strip', sink: target })
    expect(target.content.get('new.bin')).toEqual(bytes); expect(manifest.deletions).toEqual(['old.txt']); expect(checks).toBeGreaterThan(2)
  })
  it('rejects concurrent mutation rather than committing best effort bytes', async () => {
    const target = sink(); let checks = 0
    await expect(captureExplicitSource({ capture: { approvedSourceId: randomUUID(), writerExcluded: true, async validateExclusion() { if (++checks > 1) throw new Error('writer changed') }, async read() { return Buffer.from('data') } },
      entries: [{ path: 'data.txt', executable: false }], deletions: [], executablePolicy: 'strip', sink: target })).rejects.toThrow('writer changed')
    expect(target.committed).toHaveLength(0)
  })
  it('captures exact Git tree without export-ignore/subst or dirty working-tree changes', async () => {
    const f = await fixture(); await qualifiedGit(f.root, ['init', '--template='])
    await writeFile(join(f.root, '.gitattributes'), 'hidden.txt export-ignore\n')
    await writeFile(join(f.root, 'hidden.txt'), 'exact git bytes')
    await qualifiedGit(f.root, ['add', '.']); await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
    const commit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim()
    await writeFile(join(f.root, 'hidden.txt'), 'dirty bytes')
    const target = sink(), manifest = await captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: target })
    expect(target.content.get('hidden.txt')?.toString()).toBe('exact git bytes'); expect(manifest.git?.commit).toBe(commit)
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit: 'HEAD', executablePolicy: 'strip', sink: sink() })).rejects.toThrow('exact Git commit')
  })
  it('captures the complete approved Git tree including credential implementation code', async () => {
    const f = await fixture(); await qualifiedGit(f.root, ['init', '--template='])
    const modulePath = 'apps/api/src/modules/interactions/wave25/credentials.ts'
    await mkdir(join(f.root, 'apps/api/src/modules/interactions/wave25'), { recursive: true })
    const code = Buffer.from('export class CredentialService { readonly lifetime = 60 }\n')
    await writeFile(join(f.root, modulePath), code); await writeFile(join(f.root, 'README.md'), 'complete fixture tree\n')
    await qualifiedGit(f.root, ['add', '.']); await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
    const commit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim(), target = sink()
    const manifest = await captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: target })
    expect(manifest.entries.map(entry => entry.path)).toEqual(['README.md', modulePath])
    expect(target.content.get(modulePath)).toEqual(code); expect(target.committed).toEqual([manifest])
    const repeated = sink()
    const recaptured = await captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: repeated })
    expect(recaptured.entries).toEqual(manifest.entries)
    expect(repeated.committed).toEqual([recaptured])
  })
  it('rejects missing objects, LFS pointers and unqualified submodules', async () => {
    const f = await fixture(); await qualifiedGit(f.root, ['init', '--template='])
    await writeFile(join(f.root, 'asset.bin'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 99\n')
    await qualifiedGit(f.root, ['add', '.']); await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
    const commit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim()
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit: 'f'.repeat(40), executablePolicy: 'strip', sink: sink() })).rejects.toThrow()
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: sink() })).rejects.toThrow('LFS')
    await qualifiedGit(f.root, ['rm', 'asset.bin'])
    await writeFile(join(f.root, 'ordinary.txt'), 'ordinary source')
    await qualifiedGit(f.root, ['add', 'ordinary.txt'])
    await qualifiedGit(f.root, ['update-index', '--add', '--cacheinfo', '160000', commit, 'module'])
    await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'submodule'])
    const subCommit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim()
    const target = sink()
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit: subCommit,
      executablePolicy: 'strip', sink: target })).rejects.toThrow('submodules')
    expect(target.committed).toEqual([])
  })
  it('rejects corrupted Git objects even when the object filename still matches the accepted ref', async () => {
    const f = await fixture(); await qualifiedGit(f.root, ['init', '--template=']); await writeFile(join(f.root, 'data.txt'), 'good')
    await qualifiedGit(f.root, ['add', '.']); await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
    const commit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim(), object = (await qualifiedGit(f.root, ['rev-parse', 'HEAD:data.txt'])).toString().trim()
    const path = join(f.root, '.git', 'objects', object.slice(0, 2), object.slice(2))
    await chmod(path, 0o600); await writeFile(path, deflateSync(Buffer.from('blob 4\0evil')))
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: sink() })).rejects.toThrow('Git object bytes')
  })
  it('rejects tracked secrets and missing explicit inclusion rather than omitting them', async () => {
    const f = await fixture(); await qualifiedGit(f.root, ['init', '--template=']); await writeFile(join(f.root, '.env'), 'secret')
    await qualifiedGit(f.root, ['add', '.']); await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
    const commit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim()
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: sink() })).rejects.toThrow('credential')
  })
  it('aborts complete-tree capture for tracked credential data even when it is not approved', async () => {
    const f = await fixture(); await qualifiedGit(f.root, ['init', '--template='])
    await writeFile(join(f.root, 'credentials.ts'), 'export class CredentialService {}\n')
    await writeFile(join(f.root, 'credentials.json'), '{"token":"synthetic-placeholder"}\n')
    await qualifiedGit(f.root, ['add', '.']); await qualifiedGit(f.root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'source'])
    const commit = (await qualifiedGit(f.root, ['rev-parse', 'HEAD'])).toString().trim(), target = sink()
    await expect(captureGitSource({ root: f.root, approvedSourceId: randomUUID(), commit, executablePolicy: 'strip', sink: target })).rejects.toThrow('credential')
    expect(target.committed).toEqual([]); expect(target.content.size).toBe(0)
  })
})

describe('canonical source namespace and private repository', () => {
  it('persists immutable source bytes independently of document revision storage', async () => {
    const f = await fixture(), store = new PrivateSourceSnapshotStore(f.root)
    await store.write(f.manifest.snapshotId, f.manifest.entries[0]!, f.bytes)
    await store.commit(f.manifest)
    expect(await store.read(f.manifest, f.manifest.entries[0]!, new AbortController().signal)).toEqual(f.bytes)
    await expect(store.commit(f.manifest)).rejects.toThrow()
    await expect(store.write(f.manifest.snapshotId, f.manifest.entries[0]!, f.bytes)).rejects.toThrow('immutable')
    await expect(store.read({ ...f.manifest, manifestDigest: 'f'.repeat(64) }, f.manifest.entries[0]!, new AbortController().signal)).rejects.toThrow('exact approved')
  })
  it('creates the main CI repository through the installed host with exact live authority', async () => {
    const f = await fixture()
    const binding = { ...f.binding, deviceId: null, workerInstallationId: null }
    const attempt = { ...f.attempt, keyRevision: null, authorizationRevision: null }
    let authorized = true
    const revalidate = vi.fn(async () => { if (!authorized) throw new Error('revoked') })
    const authority: SourceAttemptAuthority = { authorize: revalidate, authorizeFinal: revalidate,
      revalidate, revalidateMaterialization: revalidate }
    const hosts = new InstalledSourceExecutionHosts(binding.mainId, { async read() { return f.bytes } }, authority,
      { verifyWorkingDirectory: async () => { throw new Error('Unexpected remote host') }, prepare: async () => { throw new Error('Unexpected remote host') }, verify: async () => { throw new Error('Unexpected remote host') }, releaseClaim: async () => { throw new Error('Unexpected remote host') }, privateRepository: async () => { throw new Error('Unexpected remote host') } })
    const receipt = await new PrivateSourceMaterializer({ async read() { return f.bytes } }, revalidate).prepare({ ...f, binding, attempt })
    const record: SourceMaterializationRecord = { receipt, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
      operationId: randomUUID(), reservationId: randomUUID(), sourceBindingHash: f.attempt.placementHash,
      finalDispatchBindingHash: null, state: 'prepared' }
    const repository = await hosts.privateRepository(record, f.manifest)
    expect((await qualifiedGit(repository.gitDirectory, ['show', 'HEAD:src/app.txt'])).toString()).toBe(f.bytes.toString())
    expect(await hosts.verify(record)).toBe(repository.workTree)
    expect(await hosts.privateRepository(record, f.manifest)).toEqual(repository)
    authorized = false
    await expect(hosts.privateRepository(record, f.manifest)).rejects.toThrow('revoked')
    expect(revalidate).toHaveBeenCalled()
  })
  it('creates usable isolated Git objects without copied config, hooks or shared .git', async () => {
    const f = await fixture(), materializer = new PrivateSourceMaterializer({ async read() { return f.bytes } }, async () => {})
    const receipt = await materializer.prepare(f)
    const repository = await createPrivateSourceRepository({ receipt, manifest: f.manifest, materializer, attempt: f.attempt })
    expect((await qualifiedGit(repository.gitDirectory, ['show', 'HEAD:src/app.txt'])).toString()).toBe(f.bytes.toString())
    expect(await readFile(join(repository.gitDirectory, 'config'), 'utf8')).not.toContain('credential')
    await expect(readFile(join(repository.gitDirectory, 'hooks', 'pre-commit'))).rejects.toThrow()
    await expect(readFile(join(repository.workTree, '.git'))).rejects.toThrow()
    expect(await materializer.resolve(receipt, f)).toBe(repository.workTree)
    expect(await createPrivateSourceRepository({ receipt, manifest: f.manifest, materializer, attempt: f.attempt })).toEqual(repository)
  })
})
