import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { PrivateSourceMaterializer } from './materialization.js'
import { createPrivateSourceRepository, preparePrivateJobRepositoryMounts,
  verifyPrivateSourceRepository, verifyPrivateJobRepositoryMounts } from './repository.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceMaterializationDigest } from './bindingHash.js'
import { nearLimitManifest } from '../../../test/helpers/sourceManifest.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { jobExecution } from '../../../test/helpers/jobFixture.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['main', 'worker'] as const)('uses a near-limit source record for an installed %s Job', async host => {
  const root = await mkdtemp(join(persistentFixtureRoot, 'private-repository-record-'))
  roots.push(root)
  const destination = join(root, 'sources')
  await mkdir(destination, { mode: 0o700 })
  const execution = jobExecution()
  const manifest = nearLimitManifest({ commit: execution.acceptedSpec.source.commit,
    tree: 'b'.repeat(40), objectFormat: 'sha1' })
  const handle = await openPrivateRoot(destination)
  const filesystem = await identity(handle)
  await handle.close()
  const binding: RootBinding = { version: 1, mainId: execution.acceptedSpec.target.mainId,
    deviceId: host === 'worker' ? randomUUID() : null,
    workerInstallationId: host === 'worker' ? randomUUID() : null,
    workspaceId: execution.workspaceId, rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: destination, filesystem, accessMode: 'exclusive-write',
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  const attempt = { executionId: execution.id, attemptId: execution.attemptId, placementHash: 'a'.repeat(64),
    keyRevision: host === 'worker' ? 1 : null, authorizationRevision: host === 'worker' ? 1 : null }
  const materializer = new PrivateSourceMaterializer({ read: async () => Buffer.from('approved') }, async () => {})
  const receipt = await materializer.prepare({ manifest, binding, attempt })
  const recordPath = join(destination, receipt.materializationId, 'receipt.json')
  expect((await stat(recordPath)).size).toBeGreaterThan(2 * 1024 * 1024)
  const repository = await createPrivateSourceRepository({ receipt, manifest, materializer, attempt })
  await expect(verifyPrivateSourceRepository({ receipt, materializer, attempt })).resolves.toEqual(repository)
  const record: SourceMaterializationRecord = { receipt, operationId: execution.operationId,
    reservationId: randomUUID(), sourceBindingHash: attempt.placementHash,
    finalDispatchBindingHash: execution.acceptedSpec.bindingHash,
    rootPolicyId: execution.acceptedSpec.target.destination.rootPolicyId, rootPolicyRevision: '1', state: 'prepared' }
  execution.acceptedSpec.source = { ...execution.acceptedSpec.source,
    materializationId: receipt.materializationId, materializationDigest: sourceMaterializationDigest(record) }
  execution.acceptedSpec.target.destination.canonicalProjectRoot = repository.workTree
  execution.acceptedSpec.target.destination.canonicalCwd = repository.workTree
  const mounts = await preparePrivateJobRepositoryMounts({ record, execution, attempt, materializer,
    reauthorize: async () => {} })
  await expect(verifyPrivateJobRepositoryMounts(execution, mounts)).resolves.toBeUndefined()
  expect(await preparePrivateJobRepositoryMounts({ record, execution, attempt, materializer,
    reauthorize: async () => {} })).toEqual(mounts)
  expect(await readFile(join(repository.workTree, 'source.txt'), 'utf8')).toBe('approved')
  const before = await readFile(recordPath, 'utf8')
  await writeFile(recordPath, before + ' '.repeat(64 * 1024), { mode: 0o600 })
  await expect(verifyPrivateSourceRepository({ receipt, materializer, attempt }))
    .rejects.toMatchObject({ code: 'SOURCE_RECEIPT_INVALID' })
})
