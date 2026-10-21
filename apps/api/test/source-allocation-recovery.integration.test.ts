import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SourceOperationOwner, SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { PrivateSourceMaterializer } from '../src/modules/sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { reclaimSourceReservation } from '../src/modules/sources/reclaimSourceReservation.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { measureRetainedMaterializationFootprint } from '../src/modules/sources/retainedDirectoryUsage.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

const failures = vi.hoisted(() => ({ markerSync: false }))
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const handle = await original.open(...args)
    if (failures.markerSync && /worktree-[a-f0-9-]+\.json$/.test(String(args[0]))) {
      handle.sync = async () => { throw new Error('Worktree marker sync interrupted') }
    }
    return handle
  } }
})

const directories: string[] = []
afterEach(async () => {
  failures.markerSync = false
  for (const directory of directories.splice(0)) await removeFixtureDirectory(directory)
})
const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
  { cwd, encoding: 'utf8', env: gitFixtureEnvironment() }).trim()

async function fixture(mode: 'main-worktree' | 'worker-read-only' | 'worker-writable' = 'main-worktree') {
  const base = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!, 'source-allocation-'))
  directories.push(base)
  const origin = join(base, 'origin')
  const rootPath = join(base, 'sources')
  await mkdir(origin, { mode: 0o700 })
  await mkdir(rootPath, { mode: 0o700 })
  const bytes = Buffer.from('approved source\n')
  await writeFile(join(origin, 'app.txt'), bytes)
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Approved source')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', deletions: [],
    git: { repository: 'fixture/project', commit: git(origin, 'rev-parse', 'HEAD'),
      tree: git(origin, 'rev-parse', 'HEAD^{tree}'), objectFormat: 'sha1' },
    entries: [{ path: 'app.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const handle = await openPrivateRoot(rootPath)
  const filesystem = await identity(handle)
  await handle.close()
  const mainId = randomUUID()
  const deviceId = mode === 'main-worktree' ? null : randomUUID()
  const workerInstallationId = deviceId ? randomUUID() : null
  const root: SourceOperationOwner['root'] = { version: 1,
    source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest },
    selection: { hostRef: deviceId ? { kind: 'device', mainId, deviceId } : { kind: 'main', mainId }, rootPolicyId: randomUUID(),
      rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, mainId, deviceId, workerInstallationId, workspaceId: 'workspace',
      rootId: randomUUID(), bindingRevision: 1, locationRevision: 1, canonicalPath: rootPath, filesystem,
      accessMode: mode === 'worker-read-only' ? 'read-only' : 'exclusive-write',
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    registration: workerInstallationId ? { workerInstallationId, keyRevision: 1, authorizationRevision: 1 } : null,
    ownerPrincipalId: 'operator', authorizedByPrincipalId: 'operator',
    attestationId: randomUUID(), attestationDigest: 'a'.repeat(64), boundAt: new Date().toISOString() }
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  let failure: 'allocation' | 'copy' | 'marker' | undefined
  let allocationPath: string | undefined
  const ports: GitWorktreePorts = { cloneDirectory: repository => join(base, 'clones', ...repository.split('/')),
    async git(args, options) {
      const result = await system.git(args[0] === 'clone'
        ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options)
      if (args[0] === 'worktree' && args[1] === 'add' && result.code === 0) {
        allocationPath = args.at(-2)!
        if (failure === 'allocation') throw new Error('Lost worktree allocation reply')
        if (failure === 'copy') await mkdir(join(allocationPath, 'app.txt'), { mode: 0o700 })
      }
      return result
    } }
  function owner(): SourceOperationOwner {
    const operationId = randomUUID()
    const attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '',
      keyRevision: root.registration?.keyRevision ?? null, authorizationRevision: root.registration?.authorizationRevision ?? null }
    attempt.placementHash = sourceBindingHash(root, attempt, operationId)
    return { identity: { operationId, ownerPrincipalId: 'operator',
      expiresAt: new Date(Date.now() + 300_000).toISOString() }, root, source: root.source, attempt,
      record: null, physicalClosureConfirmed: false, preparationClosed: true }
  }
  const prepare = (original: SourceOperationOwner, authorize = async () => {}, worktree = true) =>
    new PrivateSourceMaterializer({ read: async () => bytes }, authorize, undefined, ports).prepare({
      binding: root.binding, manifest, attempt: original.attempt,
      ...(root.binding.accessMode === 'read-only' ? { sharedReadOnlyTree: true } : { sharedWritableTree: true }),
      ...(worktree ? { worktree: { repository: 'fixture/project', branch: 'foreman/recovery' } } : {}) })
  const grant = (original: SourceOperationOwner): SourceReservationReclamation => ({
    reservationId: randomUUID(), reclamationId: randomUUID(), operationId: original.identity.operationId,
    scopeId: 'source-filesystem', expiresAt: original.identity.expiresAt, roots: [root], owner: original })
  const reclaim = (request: SourceReservationReclamation, closed = true) => reclaimSourceReservation(request, {
    authorize: async () => {}, operationClosed: async () => closed, nativeClosed: async () => closed,
  }, AbortSignal.timeout(60_000))
  return { rootPath, root, manifest, ports, owner, prepare, grant, reclaim, bytes,
    failAllocation: (phase: 'allocation' | 'copy' | 'marker') => {
      failure = phase
      failures.markerSync = phase === 'marker'
    }, allocationPath: () => allocationPath }
}

it('reclaims an interrupted Worker reference while charging its retained read-only checkout and preserving a successor', async () => {
  const f = await fixture('worker-read-only')
  const original = f.owner()
  const receipt = await f.prepare(original, undefined, false)
  const otherOwner = f.owner()
  const other = await f.prepare(otherOwner, undefined, false)
  expect(other.sharedTree!.id).toBe(receipt.sharedTree!.id)
  const grant = f.grant(original)
  await expect(f.reclaim(grant, false)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  expect(await readFile(join(f.rootPath, receipt.materializationId, 'tree/app.txt'))).toEqual(f.bytes)
  const retained = await f.reclaim(grant)
  await expect(stat(join(f.rootPath, receipt.materializationId, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(retained.retained?.sharedTree).toMatchObject({ id: receipt.sharedTree!.id, bytes: expect.any(Number) })
  expect(retained.retained!.sharedTree!.bytes).toBeGreaterThan(0)
  expect(retained.retained!.retainedBytes).toBeGreaterThanOrEqual(retained.retained!.sharedTree!.bytes)
  expect(await readFile(join(f.rootPath, receipt.sharedTree!.id, 'tree/app.txt'))).toEqual(f.bytes)
  expect(await readFile(join(f.rootPath, other.materializationId, 'tree/app.txt'))).toEqual(f.bytes)
  expect(await f.prepare(otherOwner, undefined, false)).toEqual(other)
  expect(await f.reclaim(grant)).toEqual(retained)
})

it.each(['main-worktree', 'worker-writable'] as const)(
  'retains the immutable baseline and edited checkout of an abandoned writable preparation on %s', async mode => {
    const f = await fixture(mode)
    const original = f.owner()
    const receipt = await f.prepare(original, undefined, false)
    const reference = join(f.rootPath, receipt.materializationId, 'tree/app.txt')
    const working = join(f.rootPath, receipt.sharedTree!.id, 'tree/app.txt')
    await writeFile(working, 'Unintegrated workflow edit')
    const grant = f.grant(original)
    await expect(f.reclaim(grant, false)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(await readFile(reference)).toEqual(f.bytes)
    const retained = await f.reclaim(grant)
    expect(await readFile(reference)).toEqual(f.bytes)
    expect(await readFile(working, 'utf8')).toBe('Unintegrated workflow edit')
    expect(retained.retained).toEqual(await measureRetainedMaterializationFootprint(receipt))
    expect(retained.retained!.sharedTree!.bytes).toBeGreaterThan(0)
    const successorOwner = f.owner()
    const successor = await f.prepare(successorOwner, undefined, false)
    expect(await f.reclaim(grant)).toEqual(retained)
    expect(await readFile(reference)).toEqual(f.bytes)
    expect(await f.prepare(successorOwner, undefined, false)).toEqual(successor)
    expect(await readFile(working, 'utf8')).toBe('Unintegrated workflow edit')
  })

it.each(['allocation', 'copy', 'marker'] as const)(
  'charges a secondary Git allocation interrupted during %s and preserves unrelated work', async phase => {
  const f = await fixture()
  const original = f.owner()
  const other = await f.prepare(f.owner())
  f.failAllocation(phase)
  await expect(f.prepare(original)).rejects.toThrow()
  failures.markerSync = false
  const checkout = f.allocationPath()!
  await writeFile(join(checkout, 'uncommitted.txt'), 'preserve interrupted work')
  const grant = f.grant(original)
  await expect(f.reclaim(grant, false)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  const result = await f.reclaim(grant)
  expect(result.retained).toMatchObject({ retainedBytes: expect.any(Number), sharedTree: { bytes: expect.any(Number) } })
  expect(result.retained!.sharedTree!.bytes).toBeGreaterThan(0)
  expect(result.retained!.retainedBytes).toBeGreaterThanOrEqual(result.retained!.sharedTree!.bytes)
  expect(await readFile(join(checkout, 'uncommitted.txt'), 'utf8')).toBe('preserve interrupted work')
  expect(await readFile(join(f.rootPath, other.sharedTree!.id, 'tree', 'app.txt'), 'utf8')).toBe('approved source\n')
  expect(await f.reclaim(grant)).toEqual(result)
}, 60_000)

it('recovers only the closed owner of interrupted shared initialization on the same binding', async () => {
  const f = await fixture()
  const original = f.owner()
  let checks = 0
  await expect(f.prepare(original, async () => {
    checks += 1
    if (checks === 4) throw new Error('Initialization interrupted after copy')
  }, false)).rejects.toThrow('Initialization interrupted after copy')
  await expect(f.prepare(f.owner(), undefined, false)).rejects.toMatchObject({ code: 'SOURCE_MATERIALIZATION_UNCERTAIN' })
  const grant = f.grant(original)
  await expect(f.reclaim(grant, false)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  await f.reclaim(grant)
  const recovered = await f.prepare(f.owner(), undefined, false)
  expect(await readFile(join(f.rootPath, recovered.sharedTree!.id, 'tree', 'app.txt'), 'utf8')).toBe('approved source\n')
  expect((await readdir(f.rootPath)).filter(name => name.endsWith('.pending'))).toEqual([])
}, 60_000)


it.each(['', '{"version":1'])(
  'reclaims an interrupted readiness write containing %j without stranding the original owner', async readiness => {
    const f = await fixture()
    const original = f.owner()
    let checks = 0
    await expect(f.prepare(original, async () => {
      checks += 1
      if (checks === 4) throw new Error('Initializer stopped after copy')
    }, false)).rejects.toThrow('Initializer stopped after copy')
    const pending = (await readdir(f.rootPath)).find(name => name.endsWith('.json.pending'))!
    const allocation = JSON.parse(await readFile(join(f.rootPath, pending), 'utf8')) as { id: string }
    await writeFile(join(f.rootPath, `${pending}.ready`), readiness, { mode: 0o600 })
    await expect(f.prepare(f.owner(), undefined, false))
      .rejects.toMatchObject({ code: 'SOURCE_MATERIALIZATION_UNCERTAIN' })
    const grant = f.grant(original)
    await expect(f.reclaim(grant, false)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(await readFile(join(f.rootPath, `${pending}.ready`), 'utf8')).toBe(readiness)
    const reclaimed = await f.reclaim(grant)
    expect(await f.reclaim(grant)).toEqual(reclaimed)
    await expect(stat(join(f.rootPath, allocation.id))).rejects.toMatchObject({ code: 'ENOENT' })
    const recovered = await f.prepare(f.owner(), undefined, false)
    expect(await readFile(join(f.rootPath, recovered.sharedTree!.id, 'tree', 'app.txt'), 'utf8'))
      .toBe('approved source\n')
    expect((await readdir(f.rootPath)).filter(name => name.includes('.pending'))).toEqual([])
  }, 60_000)

it('reclaims a known closed owner beyond the root metadata scan limit', async () => {
  const f = await fixture()
  const original = f.owner()
  const receipt = await new PrivateSourceMaterializer({ read: async () => { throw new Error('Copy interrupted') } },
    async () => {}).prepare({ binding: f.root.binding, manifest: f.manifest, attempt: original.attempt })
    .then(() => { throw new Error('Expected interrupted preparation') }, error => error)
  expect(receipt.message).toBe('Copy interrupted')
  for (let offset = 0; offset < 8200; offset += 100) {
    await Promise.all(Array.from({ length: 100 }, () => mkdir(join(f.rootPath, randomUUID()), { mode: 0o700 })))
  }
  const result = await f.reclaim(f.grant(original))
  expect(result.retained).toBeUndefined()
  expect(result.closures).toEqual([expect.objectContaining({ executionId: original.attempt.executionId,
    childrenClosed: true, claimReleased: true })])
  await expect(stat(join(f.rootPath, result.closures[0]!.materializationId!))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readdir(f.rootPath)).length).toBeGreaterThan(8192)
}, 60_000)
