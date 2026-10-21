import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { PrivateSourceSnapshotStore } from './store.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { createSourceManifest } from './manifest.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim, releaseMaterializationClaimForCancellation } from './materialization.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { encodeMaterializationRecord } from './materializationRecord.js'
import { nearLimitManifest } from '../../../test/helpers/sourceManifest.js'

const manifestBudget = 2 * 1024 * 1024
const recordBudget = manifestBudget + 64 * 1024
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it.each(['copied', 'snapshot'] as const)('prepares, verifies, recovers and releases a near-limit %s record', async mode => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'materialization-record-'))
  roots.push(root)
  const destination = join(root, 'destination')
  await mkdir(destination, { mode: 0o700 })
  const origin = join(root, 'origin')
  await mkdir(origin)
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, encoding: 'utf8',
    env: gitFixtureEnvironment() }).trim()
  git('init', '-q', '-b', 'main')
  await writeFile(join(origin, 'source.txt'), 'approved')
  git('add', '.'); git('commit', '-qm', 'approved')
  const manifest = nearLimitManifest(mode === 'snapshot' ? {
    commit: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}'),
    objectFormat: 'sha1', repository: 'example/site',
  } : undefined)
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeGreaterThan(manifestBudget - 128)
  expect(manifest.deletions.length).toBeLessThan(8192)
  const handle = await openPrivateRoot(destination)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: 'workspace-record', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: destination, filesystem, accessMode: mode === 'snapshot' ? 'exclusive-write' : 'read-only', snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const attempt = { executionId: 'execution-record', attemptId: 'attempt-record', placementHash: 'a'.repeat(64),
    keyRevision: null, authorizationRevision: null }
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  const ports: GitWorktreePorts = { cloneDirectory: () => join(root, 'clone'),
    git: (args, options) => system.git(args[0] === 'clone' ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options) }
  const storePath = join(root, 'snapshots')
  await mkdir(storePath, { mode: 0o700 })
  const store = new PrivateSourceSnapshotStore(storePath)
  await store.write(manifest.snapshotId, manifest.entries[0]!, Buffer.from('approved'))
  await store.commit(manifest)
  const materializer = new PrivateSourceMaterializer(mode === 'snapshot' ? store : {
    read: async () => Buffer.from('approved'),
  }, async () => undefined, undefined, ports)
  const input = { manifest, binding, attempt, ...(mode === 'snapshot' ? {
    sharedWritableTree: true as const, worktree: { repository: 'example/site', branch: 'foreman/record' },
  } : {}) }
  const receipt = await materializer.prepare(input)
  const recordPath = join(destination, receipt.materializationId, 'receipt.json')
  expect(JSON.parse(await readFile(recordPath, 'utf8')).snapshotReference !== undefined).toBe(mode === 'snapshot')
  expect((await stat(recordPath)).size).toBeGreaterThan(manifestBudget)
  await expect(materializer.verify(receipt, { binding, attempt })).resolves.toBeUndefined()
  expect(await materializer.recover(binding, attempt)).toEqual(receipt)
  expect(await materializer.prepare(input)).toEqual(receipt)
  if (mode === 'snapshot') await releaseMaterializationClaim(receipt, async () => 'released')
  else await releaseMaterializationClaimForCancellation(receipt, filesystem, async () => 'released')
  expect(await readFile(join(destination, receipt.materializationId, 'released-claim.json'), 'utf8')).toContain(receipt.materializationId)
  const oversized = `${await readFile(recordPath, 'utf8')}${' '.repeat(recordBudget)}`
  await writeFile(recordPath, oversized, { mode: 0o600 })
  await expect(materializer.verify(receipt, { binding, attempt })).rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
})

it.each([false, true])('bounds the complete encoded record before readiness with snapshot reference %s', snapshot => {
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries: [], deletions: [] })
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const receipt = { version: 1 as const, materializationId: randomUUID(), binding: {
    version: 1 as const, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
    workspaceId: 'workspace-record', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: '/source', filesystem, accessMode: 'exclusive-write' as const,
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    executionId: 'execution-record', attemptId: 'attempt-record', placementHash: 'a'.repeat(64),
    keyRevision: null, authorizationRevision: null, verifiedManifestDigest: manifest.manifestDigest,
    verifiedEntries: 0, verifiedBytes: 0, verifiedAt: '2026-10-01T00:00:00.000Z', localTreeIdentity: filesystem,
    claimScope: 'execution' as const, sharedTree: { id: randomUUID(), referenceIdentity: filesystem },
    ...(snapshot ? { worktree: { repository: 'example/site', branch: 'foreman/agent', commit: 'a'.repeat(40) } } : {}) }
  const record = { receipt, manifest, ...(snapshot ? {
    snapshotReference: { canonicalStorePath: '/snapshots', storeIdentity: filesystem },
  } : {}) }
  const encoded = encodeMaterializationRecord(record)
  expect(JSON.parse(encoded)).toEqual(record)
  const remaining = recordBudget - Buffer.byteLength(encoded)
  const atLimit = { ...record, receipt: { ...receipt, binding: { ...receipt.binding,
    canonicalPath: receipt.binding.canonicalPath + 'x'.repeat(remaining) } } }
  expect(Buffer.byteLength(encodeMaterializationRecord(atLimit))).toBe(recordBudget)
  expect(() => encodeMaterializationRecord({ ...atLimit, receipt: { ...atLimit.receipt,
    binding: { ...atLimit.receipt.binding, canonicalPath: atLimit.receipt.binding.canonicalPath + 'x' } } }))
    .toThrow('materialization record')
})
