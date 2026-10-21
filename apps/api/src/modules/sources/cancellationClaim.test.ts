import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MaterializationReceiptSchema, type RootBinding } from '@foreman-code/contracts/source-materialization'
import { createSourceManifest, sourceSha256 } from './manifest.js'
import { sourceMaterializationClaimName } from './quotaClaims.js'
import { openPrivateRoot, identity } from './privateFilesystem.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim,
  releaseMaterializationClaimForCancellation } from './materialization.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const directory = await mkdtemp('/tmp/job-restored-claim-')
  roots.push(directory)
  const namespace = join(directory, 'source')
  await mkdir(namespace, { mode: 0o700 })
  const handle = await openPrivateRoot(namespace), filesystem = await identity(handle)
  await handle.close()
  const bytes = Buffer.from('original verified source\n')
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
    capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const binding: RootBinding = { version: 1, mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: namespace, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
    placementHash: '1'.repeat(64) }
  const original = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => {}).prepare({ manifest, binding, attempt })
  // Simulate retained pre-remount metadata. The current filesystem identity is
  // independently read from the actual protected descriptors above.
  const receipt = MaterializationReceiptSchema.parse({ ...original,
    binding: { ...original.binding, filesystem: { ...filesystem, mountId: '999999' } },
    localTreeIdentity: { ...original.localTreeIdentity, mountId: '999999' } })
  const claimPath = join(namespace, sourceMaterializationClaimName(binding, attempt, receipt.quota, receipt.claimScope))
  const materialization = join(namespace, receipt.materializationId)
  const claim = { version: 1, materializationId: receipt.materializationId, binding: receipt.binding, attempt }
  await writeFile(claimPath, JSON.stringify(claim), { mode: 0o600 })
  await writeFile(join(materialization, 'receipt.json'), JSON.stringify({ receipt, manifest }), { mode: 0o600 })
  return { filesystem, receipt, claimPath, materialization }
}
it('keeps ordinary release strict when the retained kernel mount identity differs', async () => {
  const f = await fixture()
  await expect(releaseMaterializationClaim(f.receipt, async () => 'released')).rejects.toMatchObject({ code: 'SOURCE_ROOT_CHANGED' })
  expect(JSON.parse(await readFile(f.claimPath, 'utf8')).binding).toEqual(f.receipt.binding)
})
it('archives only the original claim with explicit current filesystem identity and unchanged source bytes', async () => {
  const f = await fixture()
  const stored = await readFile(join(f.materialization, 'receipt.json'))
  await releaseMaterializationClaimForCancellation(f.receipt, f.filesystem, async () => 'released')
  const archived = JSON.parse(await readFile(join(f.materialization, 'released-claim.json'), 'utf8'))
  expect(archived.binding).toEqual(f.receipt.binding)
  expect(await readFile(join(f.materialization, 'receipt.json'))).toEqual(stored)
  await expect(readFile(f.claimPath)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects a replaced source root inode and changed original source bytes without releasing ownership', async () => {
  const f = await fixture()
  await expect(releaseMaterializationClaimForCancellation(f.receipt, { ...f.filesystem, inode: '999999' },
    async () => 'released')).rejects.toMatchObject({ code: 'SOURCE_ROOT_CHANGED' })
  await writeFile(join(f.materialization, 'tree', 'source.txt'), 'tampered original source\n')
  await expect(releaseMaterializationClaimForCancellation(f.receipt, f.filesystem,
    async () => 'released')).rejects.toThrow()
  expect(JSON.parse(await readFile(f.claimPath, 'utf8')).materializationId).toBe(f.receipt.materializationId)
})
