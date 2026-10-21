import { jobLifecycleSignal } from '../../jobs/lifecycle.js'
import { createHash } from 'node:crypto'
import type { JobArtifact } from '@foreman-code/contracts/jobs'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { TransferIntent, ByteTransferPort } from '@foreman-code/contracts/byte-transfer'
import type { JobOutputPublicationInput } from '@foreman-code/contracts/job-output-transfer'
import { JobOutputCollectionError, readDeclaredJobOutputs, readAvailableVerificationOutputs } from '../../jobs/executorOutputs.js'
import { TransferExpiredError } from '../../byte-transfer/service.js'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { WorkerJobOutputApplication, WorkerJobOutputReceiver, type WorkerJobOutputChannel } from '../../files/jobs/outputChannel.js'
import { ResumableByteTransferSender, type TransferSenderConnection } from '../../byte-transfer/sender.js'
import type { RemoteOperationJournal } from './operationJournal.js'

/** Worker metadata and sealed bytes share its existing selected-main signed carrier. */
export function createWorkerJobOutputCollector(channel: WorkerJobOutputChannel, connection: TransferSenderConnection, journal: RemoteOperationJournal,rsync?:WorkerJobOutputRsyncPort) {
  const collect = createRemoteJobOutputCollector(new WorkerJobOutputReceiver(channel), connection, new WorkerJobOutputApplication(channel), journal,rsync)
  return async (execution: JobExecutionRecord) => {
    try {
      await collect(execution)
    } catch (error) {
      if (error instanceof TransferExpiredError || error instanceof DeviceApplicationError && error.code === 'job-output-expired') {
        throw new JobOutputCollectionError('The output transfer expired before publication.', { cause: error })
      }
      throw error
    }
  }
}

export interface WorkerJobOutputRsyncPort {
  published(intent:TransferIntent,signal:AbortSignal):Promise<JobArtifact|undefined>
  register(execution:JobExecutionRecord,input:JobOutputPublicationInput,intent:TransferIntent,bytes:Uint8Array,signal:AbortSignal):Promise<void>
  stage(intent:TransferIntent,signal:AbortSignal):Promise<void>
}

export interface JobOutputApplicationPort {
  /** Main mints and persists the output intent under genuine job publication authority.
   * An expired original intent is returned only for a finalized retained canonical
   * allocation; publication replay rechecks that authority without worker bytes. */
  admit(input: JobOutputPublicationInput, signal?: AbortSignal): Promise<TransferIntent>
  publish(input: JobOutputPublicationInput, signal?: AbortSignal): Promise<JobArtifact>
}
/** Only called after main's physical closure acknowledgement. Reads real sealed declared bytes. */
export function createRemoteJobOutputCollector(receiver: ByteTransferPort, connection: TransferSenderConnection, main: JobOutputApplicationPort, journal: RemoteOperationJournal,rsync?:WorkerJobOutputRsyncPort) {
  return async (execution: JobExecutionRecord) => {
    if (execution.acceptedSpec.target.hostRef.kind !== 'device') throw new Error('Remote job outputs require their actual registered device')
    const signal = jobLifecycleSignal(execution, 'publication')
    signal.throwIfAborted()
    const spec = execution.acceptedSpec
    const outputs = execution.schemaVersion === 2
      ? await readAvailableVerificationOutputs(spec.target.destination.canonicalProjectRoot, execution.acceptedSpec)
      : await readDeclaredJobOutputs(spec.target.destination.canonicalProjectRoot, spec)
    for (const output of outputs) {
      signal.throwIfAborted()
      const declared = execution.acceptedSpec.outputs.find(value => value.path === output.path)
      if (!declared) throw new Error('Undeclared job output')
      const bytes = Buffer.from(output.bytes), sha256 = createHash('sha256').update(bytes).digest('hex')
      const input: JobOutputPublicationInput = { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: execution.attemptId,
        owner: execution.owner, commandId: await journal.jobOutputCommand(execution.operationId, { path: output.path, mediaType: declared.mediaType, sha256, byteSize: bytes.length }), path: output.path, mediaType: declared.mediaType, sha256, byteSize: bytes.length }
      const intent = await main.admit(input, signal)
      if (intent.executionId !== execution.id || intent.attemptId !== execution.attemptId || intent.direction !== 'to-main' || intent.byteClass !== 'artifact'
        || intent.placementHash !== execution.acceptedSpec.bindingHash || intent.manifestDigest !== execution.acceptedSpec.outputSpecDigest
        || intent.sha256 !== sha256 || intent.byteSize !== bytes.length || intent.mainId !== execution.acceptedSpec.target.mainId) throw new Error('Main output admission does not bind these exact bytes')
      // Main admits an expired original intent only for an already finalized,
      // retained canonical allocation. Reconcile through its freshly authorized
      // publication readback; never reopen an expired byte attempt.
      if(rsync){
        const published=await rsync.published(intent,signal)
        if(!published&&Date.parse(intent.expiresAt)>Date.now()){
          await rsync.register(execution,input,intent,bytes,signal)
          await rsync.stage(intent,signal)
        }
      }else if (Date.parse(intent.expiresAt) > Date.now()) await new ResumableByteTransferSender(receiver, { read: async (accepted, offset, length) => {
        if (accepted.transferId !== intent.transferId || accepted.sha256 !== sha256 || offset < 0 || offset + length > bytes.length) throw new Error('Sealed output transfer binding changed')
        return bytes.subarray(offset, offset + length)
      } }, connection).send(intent, signal)
      const artifact = await main.publish(input, signal)
      if (artifact.executionId !== execution.id || artifact.sha256 !== sha256 || artifact.byteSize !== bytes.length || artifact.path !== output.path
        || artifact.state !== 'available') throw new Error('Canonical output publication readback conflict')
    }
    if (spec.outputs.some(declaration => declaration.required && !outputs.some(output => output.path === declaration.path))) {
      throw new JobOutputCollectionError('Available failure artifacts were published; required outputs remain incomplete.')
    }
  }
}
