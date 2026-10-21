import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../../infrastructure/transaction.js'
import type pg from 'pg'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import {
  RemoteJobMainRpcRequestRecordSchema,
  RemoteJobDispatchIntentSchema,
  type RemoteJobDispatchIntent, type RemoteJobConnectionIdentity,
} from '@foreman-code/contracts/remote-job-execution'
import { JobRepository } from '../../jobs/repository.js'
import type { PostgresJobDispatch } from '../../jobs/dispatch.js'
import type { JobWorkerService } from '../../jobs/worker.js'
import type { JobPublicationAuthority } from '../../jobs/authority.js'
import { readLiveManagementPrincipal } from '../../access/liveManagementPrincipal.js'
import { readAcceptedJobSource, type AcceptedJobSourceReadout } from './jobAcceptedSource.js'
import { requireAuthorization } from '../../access/policy.js'

export type JobApplicationConnection = Readonly<DeviceSessionBinding>
  | Extract<RemoteJobConnectionIdentity, { kind: 'main' }>

/** Authenticated W07 handler invokes this with trusted carrier binding, never payload identity. */
export class JobApplicationBridge {
  private readonly repository = new JobRepository()
  constructor(private readonly pool: pg.Pool, private readonly dispatch: Pick<PostgresJobDispatch, 'require'|'requireLaunch'|'requireControl'|'requireEvidence'|'observeReceipt'>,
    private readonly workers: Pick<JobWorkerService, 'appendLog'>, private readonly publication: Pick<JobPublicationAuthority, 'authorizePublication'>) {}
  private async authorize(intent: RemoteJobDispatchIntent, binding: JobApplicationConnection, action: 'start'|'read'|'control'|'publish') {
    return withTransaction(this.pool, async (sql) => {
      const execution = await this.authorizeInSql(sql, intent, binding, action)
      return execution
    })
  }
  private async authorizeInSql(sql: pg.PoolClient, intent: RemoteJobDispatchIntent, binding: JobApplicationConnection, action: 'start'|'read'|'control'|'publish') {
    let execution = await this.repository.execution(sql, intent.subject.workspaceId, intent.executionId)
    if (action === 'publish') {
      if (execution.workflow) await sql.query('select id from runs where id=$1 for share', [execution.workflow.runId])
      execution = await this.repository.execution(sql, intent.subject.workspaceId, intent.executionId, true)
    }
    const target = execution.acceptedSpec.target
    if (target.mainId !== binding.mainId) throw new Error('Accepted Job belongs to another Main.')
    if (target.hostRef.kind === 'device') {
      if (!('deviceId' in binding) || target.hostRef.deviceId !== binding.deviceId
        || target.registration?.workerInstallationId !== binding.workerInstallationId
        || target.registration.keyRevision !== binding.keyRevision
        || target.registration.authorizationRevision !== binding.authorizationRevision) {
        throw new Error('Authenticated worker does not own the accepted Job target.')
      }
    } else if (!('kind' in binding) || binding.kind !== 'main'
      || target.mainInstallationId !== binding.mainInstallationId || target.registration !== null) {
      throw new Error('Installed Main does not own the accepted Job target.')
    }
    const accepted = (await sql.query<{ intent: unknown }>('select intent from job_dispatch_intents where execution_id=$1', [execution.id])).rows[0]
    if (!accepted || !isDeepStrictEqual(RemoteJobDispatchIntentSchema.parse(accepted.intent), intent)) throw new Error('Unaccepted or stale job operation')
    if (action === 'start' || action === 'publish') {
      const actor = (await sql.query<{ accepted_by: string }>('select accepted_by from job_executions where id=$1', [execution.id])).rows[0]
      if (!actor) throw new Error('Accepted job principal missing')
      const principal = await readLiveManagementPrincipal(sql, actor.accepted_by)
      requireAuthorization(principal, execution.workflow ? 'runs:start' : 'jobs:start', { workspaceId: execution.workspaceId, ...(execution.workflow ? { workflowId: execution.workflow.workflowId, runId: execution.workflow.runId } : {}) })
    }
    const fence = { attemptId: intent.attemptId, owner: intent.owner }
    if (action === 'control') await this.dispatch.requireControl(sql, execution, fence)
    else if (action === 'read') await this.dispatch.requireEvidence(sql, execution, fence)
    else if (action === 'start') await this.dispatch.requireLaunch(sql, execution, fence)
    else await this.dispatch.require(sql, execution, fence)
    if (action === 'publish') await this.publication.authorizePublication(sql, { workspaceId: execution.workspaceId, executionId: execution.id, attemptId: intent.attemptId, owner: intent.owner })
    return execution
  }
  /** Metadata-only original source readback. Physical W09 verification and fresh
   * start authority remain separate and mandatory on the selected worker. */
  async resolveAcceptedSource(raw: RemoteJobDispatchIntent, binding: JobApplicationConnection): Promise<AcceptedJobSourceReadout> {
    const intent = RemoteJobDispatchIntentSchema.parse(raw)
    return withTransaction(this.pool, async (sql) => {
      const execution = await this.authorizeInSql(sql, intent, binding, 'read')
      return readAcceptedJobSource(sql, execution)
    })
  }
  async handle(raw: unknown, binding: JobApplicationConnection) {
    const frame = RemoteJobMainRpcRequestRecordSchema.parse(raw)
    const intent = frame.method === 'job-report' ? frame.receipt.intent : frame.intent
    if (frame.method === 'job-source') return this.resolveAcceptedSource(intent, binding)
    const execution = await this.authorize(intent, binding, frame.method === 'job-authorize' ? frame.action : 'read')
    if (frame.method === 'job-authorize') return { authorized: true, operationId: intent.operationId, attemptId: intent.attemptId, bindingHash: intent.bindingHash, owner: intent.owner }
    if (frame.method === 'job-log') return this.workers.appendLog(execution.workspaceId, execution.id, { attemptId: intent.attemptId, owner: intent.owner }, frame.chunk)
    const reporter = frame.receipt.connection
    if ('deviceId' in binding) {
      if (!('deviceId' in reporter) || reporter.deviceId !== binding.deviceId
        || reporter.workerInstallationId !== binding.workerInstallationId
        || reporter.keyRevision !== binding.keyRevision || reporter.authorizationRevision !== binding.authorizationRevision) {
        throw new Error('Job report does not match this authorized worker.')
      }
    } else if (!('kind' in reporter) || !isDeepStrictEqual(reporter, binding)) {
      throw new Error('Job report does not match this installed Main.')
    }
    await this.dispatch.observeReceipt(execution.workspaceId, execution.id, frame.receipt)
    return { persistedSequence: frame.receipt.sequence }
  }
}
export { WorkerJobApplicationSink, type WorkerJobApplicationChannel } from './workerJobApplicationSink.js'
