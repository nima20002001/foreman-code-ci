import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { PrivateSourceMaterializer } from './materialization.js'
import { verifyPrivateSourceRepository } from './repository.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { openPrivateRoot, identity } from './privateFilesystem.js'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
const git = vi.hoisted(() => vi.fn())
vi.mock('./capture.js', () => ({ qualifiedGit: git }))
const roots: string[] = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp('/tmp/hrt-repository-'); roots.push(root)
  const bytes = Buffer.from('source fixture'), manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', entries: [{ path: 'app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const directory = await openPrivateRoot(root), filesystem = await identity(directory); await directory.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: root, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: 1, authorizationRevision: 1 }
  const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
  const receipt = await materializer.prepare({ manifest, binding, attempt }), reservation = join(root, receipt.materializationId), repository = join(reservation, 'repository')
  const generatedCommit = 'b'.repeat(40), config = Buffer.from('retained original unit configuration')
  await mkdir(repository, { mode: 0o700 }); await writeFile(join(repository, 'config'), config, { mode: 0o600 })
  const saved = { materializationId: receipt.materializationId, manifestDigest: manifest.manifestDigest, receiptDigest: sourceSha256(Buffer.from(JSON.stringify(receipt))), generatedCommit, configDigest: sourceSha256(config) }
  await writeFile(join(reservation, 'repository-receipt.json'), JSON.stringify(saved), { mode: 0o600 })
  // A read-only Git port double proves the consumer's command; no native Git or qualification runs.
  git.mockResolvedValue(Buffer.from(generatedCommit))
  return { root, reservation, repository, saved, generatedCommit, input: { receipt, attempt, materializer: new PrivateSourceMaterializer(null, async () => {}) } }
}
it('reads the exact retained private repository with no write command or filesystem mutation', async () => {
  const f = await fixture(), before = await readFile(join(f.reservation, 'repository-receipt.json'))
  expect(await verifyPrivateSourceRepository(f.input)).toEqual({ workTree: join(f.reservation, 'tree'), gitDirectory: f.repository, generatedCommit: f.generatedCommit, sourceCommit: null })
  expect(git).toHaveBeenCalledExactlyOnceWith(f.repository, ['rev-parse', 'HEAD'])
  expect(await readFile(join(f.reservation, 'repository-receipt.json'))).toEqual(before)
})
it.each(['missing', 'manifest', 'receipt', 'config', 'head'] as const)('refuses changed %s without initializing a replacement', async kind => {
  const f = await fixture()
  if (kind === 'missing') await rm(join(f.reservation, 'repository-receipt.json'))
  if (kind === 'manifest' || kind === 'receipt') await writeFile(join(f.reservation, 'repository-receipt.json'), JSON.stringify({ ...f.saved, [kind === 'manifest' ? 'manifestDigest' : 'receiptDigest']: 'c'.repeat(64) }))
  if (kind === 'config') await writeFile(join(f.repository, 'config'), 'changed')
  if (kind === 'head') git.mockResolvedValue(Buffer.from('c'.repeat(40)))
  const before = await readdir(f.reservation)
  await expect(verifyPrivateSourceRepository(f.input)).rejects.toThrow()
  expect(await readdir(f.reservation)).toEqual(before)
  expect(git.mock.calls.every(call => JSON.stringify(call[1]) === JSON.stringify(['rev-parse', 'HEAD']))).toBe(true)
})
