import { sourceMaterializationParent } from '@foreman-code/contracts/source-materialization'
import { verifyJobQuotaOwnership } from '../../jobs/quotaOwnership.js'
import { join } from 'node:path'
import { isDeepStrictEqual as same } from 'node:util'
import type { JobSourcePort } from '../../jobs/executor.js'
import type { RemoteOperationJournal } from './operationJournal.js'
import type { WorkerJobApplicationSink } from './workerJobApplicationSink.js'
import { PrivateSourceMaterializer } from '../../sources/materialization.js'
import { verifyPrivateSourceRepository, preparePrivateJobRepositoryMounts } from '../../sources/repository.js'
import { verifyMaterializedWorkingDirectory } from '../../sources/workingDirectory.js'
import { verifyApprovedRootAllowlist } from '../../sources/rootAttestation.js'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import type { JobApplicationConnection } from './jobApplicationBridge.js'

/** Main metadata and physical verification remain distinct. No source is created. */
export function createInstalledJobSource(input: { journal: RemoteOperationJournal; application: Pick<WorkerJobApplicationSink, 'resolveAcceptedSource'>;
  currentBinding(): JobApplicationConnection; approvedRoots(): Promise<ApprovedRootAllowlist> }): JobSourcePort<import('@foreman-code/contracts/job-verification').JobAcceptedSpecRecord> {
  return { async verify(spec, signal) {
    signal.throwIfAborted()
    const matches = (await input.journal.jobOperations()).filter(receipt => same(receipt.execution.acceptedSpec, spec))
    if (matches.length !== 1) throw new Error('Unique original Job source owner missing')
    const original = matches[0]!, binding = { ...input.currentBinding() }
    const accepted = await input.application.resolveAcceptedSource(original.intent)
    if(accepted.execution.id!==original.execution.id||accepted.execution.attemptId!==original.execution.attemptId
      ||accepted.execution.operationId!==original.execution.operationId||!same(accepted.execution.owner,original.execution.owner))throw new Error('Original accepted Job source owner changed')
    if (!same(accepted.execution.acceptedSpec, original.execution.acceptedSpec) || accepted.execution.workspaceId !== original.execution.workspaceId
      || !same(accepted.execution.workflow, original.execution.workflow)) throw new Error('Original accepted Job execution changed')
    const roots = await input.approvedRoots(), record = accepted.materialization, receipt = record.receipt
    const selected = roots.hostRef
    if (selected.mainId !== binding.mainId || roots.managedRuntimeRoot !== spec.target.destination.managedRuntimeRoot
      || receipt.binding.canonicalPath !== join(roots.managedRuntimeRoot, 'source-materializations', accepted.root.selection.rootPolicyId)) {
      throw new Error('Original Job source is outside its approved runtime root.')
    }
    if (selected.kind === 'device') {
      if (!('deviceId' in binding) || selected.deviceId !== binding.deviceId
        || roots.applicationInstallationId !== binding.workerInstallationId) {
        throw new Error('Original source belongs to another installed worker.')
      }
    } else if (!('kind' in binding) || binding.kind !== 'main'
      || roots.applicationInstallationId !== binding.mainInstallationId
      || spec.target.hostRef.kind !== 'main' || receipt.binding.deviceId !== null) {
      throw new Error('Original source belongs to another installed Main.')
    }
    await verifyApprovedRootAllowlist(roots)
    const recheck = async () => {
      signal.throwIfAborted()
      const refreshed = await input.application.resolveAcceptedSource(original.intent)
      if(refreshed.execution.id!==accepted.execution.id||refreshed.execution.attemptId!==accepted.execution.attemptId
        ||refreshed.execution.operationId!==accepted.execution.operationId||!same(refreshed.execution.owner,accepted.execution.owner))throw new Error('Original accepted Job source owner changed')
      if (!same(refreshed.materialization, accepted.materialization) || !same(refreshed.root, accepted.root) || refreshed.diskQuotaBytes !== accepted.diskQuotaBytes
        || !same(input.currentBinding(), binding) || !same(await input.approvedRoots(), roots)
        || !same(refreshed.execution.acceptedSpec, accepted.execution.acceptedSpec)) throw new Error('Original Job source authority changed')
      signal.throwIfAborted()
    }
    if (accepted.execution.schemaVersion === 2) {
      const qualified = await input.journal.qualifiedJobRuntime(accepted.execution)
      const fingerprint = qualified.candidate.fingerprint
      if (fingerprint.schemaVersion !== 3 || !fingerprint.quotaPool || !receipt.quota) {
        throw new Error('Original per-Job quota ownership is missing.')
      }
      await verifyJobQuotaOwnership({ pool: fingerprint.quotaPool, binding: receipt.binding,
        slot: receipt.quota, directory: sourceMaterializationParent(receipt), signal })
    }
    const attempt = { placementHash: receipt.placementHash, executionId: receipt.executionId, attemptId: receipt.attemptId,
      keyRevision: receipt.keyRevision, authorizationRevision: receipt.authorizationRevision }
    const repository = await verifyPrivateSourceRepository({ receipt, attempt, materializer: new PrivateSourceMaterializer(null, recheck) })
    const working = await verifyMaterializedWorkingDirectory(record, spec.relativeCwd ?? '', recheck)
    if (repository.workTree !== spec.target.destination.canonicalProjectRoot || repository.sourceCommit !== spec.source.commit
      || working.canonicalCwd !== spec.target.destination.canonicalCwd)
      throw new Error('Original private Job repository or working directory changed')
    const gitMounts=await preparePrivateJobRepositoryMounts({record,execution:accepted.execution,attempt,
      materializer:new PrivateSourceMaterializer(null,recheck),reauthorize:recheck})
    await recheck()
    return { privateRepositoryRoot: repository.workTree, directoryIdentityHash: spec.target.destination.directoryIdentityHash,
      privateGit: true, diskQuotaBytes: accepted.diskQuotaBytes,gitMounts }
  } }
}
