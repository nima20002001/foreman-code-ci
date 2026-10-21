import { randomUUID } from 'node:crypto'
import type { JobExecution } from '@foreman-code/contracts/jobs'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import type { RootBinding } from '@foreman-code/contracts/source-materialization'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { createSourceManifest, sourceSha256 } from '../../src/modules/sources/manifest.js'
import { PrivateSourceMaterializer } from '../../src/modules/sources/materialization.js'
import { identity, openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'
import { sourceMaterializationDigest } from '../../src/modules/sources/bindingHash.js'
import { createPrivateSourceRepository, preparePrivateJobRepositoryMounts }
  from '../../src/modules/sources/repository.js'

/** Prepare genuine private source/Git receipts before the test admits its Job. */
export async function prepareJobRepositoryFixture(execution: JobExecution, root: string, runtimeRoot: string) {
  const spec = execution.acceptedSpec
  const bytes = Buffer.from('Approved fixture source\n')
  const manifest = createSourceManifest({
    version: 1, approvedSourceId: spec.source.approvedSourceId, snapshotId: spec.source.snapshotId,
    capturePolicy: 'git-tree-v1', executablePolicy: 'strip', deletions: [],
    git: { commit: spec.source.commit, tree: '3'.repeat(40), objectFormat: 'sha1' },
    entries: [{ path: 'fixture.txt', kind: 'file', executable: false, byteSize: bytes.length,
      sha256: sourceSha256(bytes) }],
  })
  const parent = await openPrivateRoot(root)
  let filesystem
  try { filesystem = await identity(parent) } finally { await parent.close() }
  const binding: RootBinding = {
    version: 1, mainId: spec.target.mainId, deviceId: null, workerInstallationId: null,
    workspaceId: execution.workspaceId, rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
    canonicalPath: root, filesystem, accessMode: 'exclusive-write',
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest,
  }
  const attempt = { executionId: execution.id, attemptId: execution.attemptId,
    placementHash: 'a'.repeat(64), keyRevision: null, authorizationRevision: null }
  const reauthorize = async () => {}
  const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, reauthorize)
  const receipt = await materializer.prepare({ manifest, binding, attempt })
  const sourceRoot = await materializer.resolve(receipt, { binding, attempt })
  const tree = await openPrivateRoot(sourceRoot)
  let sourceIdentity
  try { sourceIdentity = await identity(tree) } finally { await tree.close() }
  const record: SourceMaterializationRecord = {
    receipt, operationId: execution.operationId, reservationId: randomUUID(),
    sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null,
    rootPolicyId: spec.target.destination.rootPolicyId,
    rootPolicyRevision: spec.target.destination.rootPolicyRevision, state: 'prepared',
  }
  Object.assign(spec.source, {
    manifestDigest: manifest.manifestDigest, materializationId: receipt.materializationId,
    materializationDigest: sourceMaterializationDigest(record),
  })
  Object.assign(spec.target.destination, {
    canonicalProjectRoot: sourceRoot, canonicalCwd: sourceRoot, managedRuntimeRoot: runtimeRoot,
    directoryIdentityHash: sourceSha256(Buffer.from(JSON.stringify(sourceIdentity))),
  })
  Object.assign(spec, jobSpecDigests(spec, spec.workflowInput))
  record.finalDispatchBindingHash = spec.bindingHash
  await createPrivateSourceRepository({ receipt, manifest, materializer, attempt })
  const gitMounts = await preparePrivateJobRepositoryMounts({ record, execution, attempt, materializer, reauthorize })
  return { sourceRoot, gitMounts }
}
