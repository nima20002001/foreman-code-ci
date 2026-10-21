import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { PrivateSourceMaterializer } from './materialization.js'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('prepares directories concurrently and activates only after all approved bytes are verified', async () => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'source-start-'))
  roots.push(root)
  const bytes = Buffer.from('approved source\n')
  const manifest = createSourceManifest({
    version: 1,
    snapshotId: randomUUID(),
    approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1',
    executablePolicy: 'strip',
    entries: Array.from({ length: 12 }, (_, index) => ({
      path: `src/group-${Math.floor(index / 2)}/file-${String(index).padStart(2, '0')}.txt`,
      kind: 'file' as const,
      byteSize: bytes.length,
      sha256: sourceSha256(bytes),
      executable: false,
    })),
    deletions: [],
  })
  const handle = await openPrivateRoot(root)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = {
    version: 1,
    mainId: randomUUID(),
    deviceId: null,
    workerInstallationId: null,
    workspaceId: randomUUID(),
    rootId: randomUUID(),
    bindingRevision: 1,
    locationRevision: 1,
    canonicalPath: root,
    filesystem,
    accessMode: 'read-only',
    snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest,
  }
  const attempt = {
    placementHash: 'a'.repeat(64),
    executionId: randomUUID(),
    attemptId: randomUUID(),
    keyRevision: null,
    authorizationRevision: null,
  }
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const started: string[] = []
  const materializer = new PrivateSourceMaterializer({ async read(_pin, entry) {
    started.push(entry.path)
    await blocked
    return bytes
  } }, async () => {})
  const preparing = materializer.prepare({ manifest, binding, attempt })
  try {
    await expect.poll(() => started.length).toBe(4)
    expect(new Set(started.map(path => path.slice(0, path.lastIndexOf('/')))).size).toBe(4)
    const children = await readdir(root, { withFileTypes: true })
    const reservation = children.find(child => child.isDirectory())!
    expect(await readdir(join(root, reservation.name))).toEqual(['staging'])
  } finally {
    release()
    await preparing
  }
  const receipt = await preparing
  expect(receipt.verifiedEntries).toBe(manifest.totalEntries)
  expect(receipt.verifiedBytes).toBe(manifest.totalBytes)
  const tree = await materializer.resolve(receipt, { binding, attempt })
  for (const entry of manifest.entries) {
    expect(await readFile(join(tree, entry.path))).toEqual(bytes)
  }
  const changedFile = join(tree, manifest.entries[0]!.path)
  await chmod(changedFile, 0o600)
  await writeFile(changedFile, Buffer.alloc(bytes.length, 'x'))
  await chmod(changedFile, 0o400)
  await expect(materializer.resolve(receipt, { binding, attempt })).rejects.toMatchObject({
    code: 'SOURCE_BYTES_INVALID',
  })
})
