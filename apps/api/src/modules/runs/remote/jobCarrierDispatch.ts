import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { JobRepository } from '../../jobs/repository.js'
import {
  RemoteJobOperationReceiptRecordSchema,
  type RemoteJobDispatchIntent,
  type RemoteJobDispatchRecordPort,
  type RemoteJobOperationStatusRecord,
  type RemoteJobOwnerControl,
} from '@foreman-code/contracts/remote-job-execution'
import type { JobExecutionRecord } from '@foreman-code/contracts/job-verification'
import type { RemoteJobExecutionHost } from './jobExecutionHost.js'
export interface JobApplicationChannel {
  request(deviceId: string, namespace: 'execution-v1', payload: unknown): Promise<{ payload: unknown }>
}
/** Uses CI-B's actual accepted row and W07 channel. It grants neither scheduling nor SQL to workers. */
export class RemoteJobCarrierDispatch implements RemoteJobDispatchRecordPort {
  private readonly repository = new JobRepository()
  constructor(private readonly pool: pg.Pool, private readonly channel: JobApplicationChannel, private readonly local: Pick<RemoteJobExecutionHost, 'handle'> | undefined) {}
  private async execution(intent: RemoteJobDispatchIntent) {
    const sql = await this.pool.connect()
    try {
      const execution = await this.repository.execution(sql, intent.subject.workspaceId, intent.executionId)
      if (execution.operationId !== intent.operationId || execution.attemptId !== intent.attemptId || execution.acceptedSpec.bindingHash !== intent.bindingHash
        || !isDeepStrictEqual(execution.owner, intent.owner)) throw new Error('Actual job row does not own this dispatch')
      return execution
    } finally { sql.release() }
  }
  private async send(intent: RemoteJobDispatchIntent, execution: JobExecutionRecord, frame: unknown): Promise<RemoteJobOperationStatusRecord> {
    const target = execution.acceptedSpec.target.hostRef
    let raw: unknown
    if (target.kind === 'device') raw = (await this.channel.request(target.deviceId, 'execution-v1', frame)).payload
    else { if (!this.local) throw new Error('Accepted main has no qualified job executor'); raw = await this.local.handle(frame) }
    if (raw && typeof raw === 'object' && 'status' in raw && raw.status === 'unknown') return { status: 'unknown', reason: 'journal_absence_requires_reconciliation' }
    if (!raw || typeof raw !== 'object' || !('status' in raw) || raw.status !== 'known' || !('receipt' in raw)) throw new Error('Malformed job receipt status')
    const receipt = RemoteJobOperationReceiptRecordSchema.parse(raw.receipt)
    if (!isDeepStrictEqual(receipt.intent, intent)) throw new Error('Job carrier response binding mismatch')
    return { status: 'known', receipt }
  }
  async deliver(intent: RemoteJobDispatchIntent, execution: JobExecutionRecord) { return this.send(intent, execution, { method: 'job-dispatch', intent, execution }) }
  async reconcile(intent: RemoteJobDispatchIntent) {
    const execution = await this.execution(intent)
    const status = await this.send(intent, execution, { method: 'job-status', intent })
    return status.status === 'unknown' ? this.deliver(intent, execution) : status
  }
  async control(command: RemoteJobOwnerControl) {
    const sql = await this.pool.connect()
    let intent: RemoteJobDispatchIntent
    try { const row = (await sql.query<{ intent: RemoteJobDispatchIntent }>('select intent from job_dispatch_intents where execution_id=$1', [command.executionId])).rows[0]; if (!row) throw new Error('Job dispatch missing'); intent = row.intent }
    finally { sql.release() }
    const execution = await this.execution(intent)
    return this.send(intent, execution, { method: 'job-control', intent, execution, command })
  }
}
