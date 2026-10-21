import { isDeepStrictEqual } from 'node:util'
import {
  RemoteJobAcceptedSourceReadoutRecordSchema,
  type RemoteJobDispatchIntent,
  type RemoteJobOperationReceiptRecord,
} from '@foreman-code/contracts/remote-job-execution'
import type { JobWorkerService } from '../../jobs/worker.js'

export interface WorkerJobApplicationChannel { request(namespace: 'execution-v1', payload: unknown): Promise<{ payload: unknown }> }
/** Worker callbacks use only narrow selected-main application RPC, not a DB handle. */
export class WorkerJobApplicationSink {
  constructor(private readonly channel: WorkerJobApplicationChannel) {}
  async resolveAcceptedSource(intent: RemoteJobDispatchIntent) {
    const result = RemoteJobAcceptedSourceReadoutRecordSchema.parse((await this.channel.request('execution-v1', { method: 'job-source', intent })).payload)
    if (result.execution.id !== intent.executionId || result.execution.operationId !== intent.operationId
      || result.execution.attemptId !== intent.attemptId || result.execution.acceptedSpec.bindingHash !== intent.bindingHash
      || `sha256:${result.execution.acceptedSpec.specDigest}` !== intent.inputDigest || !isDeepStrictEqual(result.execution.owner, intent.owner))
      throw new Error('Main source readback does not match the original Job operation')
    return result
  }
  async authorize(intent: RemoteJobDispatchIntent, action: 'start'|'read'|'control'|'publish') {
    const result = (await this.channel.request('execution-v1', { method: 'job-authorize', intent, action })).payload
    if (!result || typeof result !== 'object' || !('authorized' in result) || result.authorized !== true
      || !('operationId' in result) || result.operationId !== intent.operationId || !('attemptId' in result) || result.attemptId !== intent.attemptId
      || !('bindingHash' in result) || result.bindingHash !== intent.bindingHash || !('owner' in result) || !isDeepStrictEqual(result.owner, intent.owner)) throw new Error('Main did not authorize this exact job operation')
  }
  async observeReceipt(receipt: RemoteJobOperationReceiptRecord) {
    const result = (await this.channel.request('execution-v1', { method: 'job-report', receipt })).payload
    if (!result || typeof result !== 'object' || !('persistedSequence' in result) || result.persistedSequence !== receipt.sequence) throw new Error('Main job receipt acknowledgment uncertain')
  }
  async appendLog(intent: RemoteJobDispatchIntent, chunk: Parameters<JobWorkerService['appendLog']>[3]) {
    const result = (await this.channel.request('execution-v1', { method: 'job-log', intent, chunk })).payload
    if (!result || typeof result !== 'object' || !('persistedSequence' in result) || typeof result.persistedSequence !== 'number' || result.persistedSequence < chunk.sequence) throw new Error('Main did not persist this log sequence')
  }
}
