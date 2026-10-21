import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { afterEach, expect, it } from 'vitest'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from './materialization.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { measureRetainedMaterializationFootprint } from './retainedDirectoryUsage.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(accessMode: RootBinding['accessMode']) {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'worker-reference-'))
  roots.push(root)
  await chmod(root, 0o700)
  const bytes = Buffer.alloc(64 * 1024, 's')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
    entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length,
      sha256: sourceSha256(bytes), executable: false }], deletions: [] })
  const handle = await openPrivateRoot(root)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: randomUUID(),
    workerInstallationId: randomUUID(), workspaceId: randomUUID(), rootId: randomUUID(),
    bindingRevision: 1, locationRevision: 1, canonicalPath: root, filesystem, accessMode,
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1 }
  const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
  const input = { manifest, binding, attempt,
    ...(accessMode === 'exclusive-write' ? { sharedWritableTree: true as const } : {}) }
  return { root, bytes, materializer, input }
}

it.each(['read-only', 'exclusive-write'] as const)(
  'retires a closed Worker reference in %s mode while retaining its receipt and any shared working tree', async mode => {
    const f = await fixture(mode)
    const receipt = await f.materializer.prepare(f.input)
    const directory = join(f.root, receipt.materializationId)
    const before = await measureRetainedMaterializationFootprint(receipt)
    const stored = await readFile(join(directory, 'receipt.json'))
    await releaseMaterializationClaim(receipt, async () => 'released')
    await expect(stat(join(directory, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(directory, 'receipt.json'))).toEqual(stored)
    expect((await measureRetainedMaterializationFootprint(receipt)).retainedBytes)
      .toBeLessThan(before.retainedBytes - f.bytes.length / 2)
    const successorInput = { ...f.input, attempt: { ...f.input.attempt,
      executionId: randomUUID(), attemptId: randomUUID() } }
    const successor = await f.materializer.prepare(successorInput)
    await releaseMaterializationClaim(receipt, async () => 'released')
    expect(await f.materializer.prepare(successorInput)).toEqual(successor)
    if (receipt.sharedTree) {
      expect(await readFile(join(f.root, receipt.sharedTree.id, 'tree/source.txt'))).toEqual(f.bytes)
    }
  },
)

it.each(['owned', 'uncertain'] as const)('keeps Worker source bytes while native closure is %s', async closure => {
  const f = await fixture('exclusive-write')
  const receipt = await f.materializer.prepare(f.input)
  await expect(releaseMaterializationClaim(receipt, async () => closure))
    .rejects.toMatchObject({ code: 'SOURCE_ROOT_OWNED' })
  expect(await readFile(join(f.root, receipt.materializationId, 'tree/source.txt'))).toEqual(f.bytes)
  expect(await f.materializer.prepare(f.input)).toEqual(receipt)
})
