import type pg from 'pg'
import { databaseCredentialDeadline } from '../../access/credentialLifetime.js'
import { beginTransaction, commitTransaction, rollbackAfterFailure } from '../../../infrastructure/transaction.js'
import { WorkerCredentialService, type IssuedWorkerCredential, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../../access/workerCredentials.js'
import type { PostgresAccessService } from '../../access/postgres.js'
import { fail, isCurrentApprovalRun, runFor } from './context.js'
import { credentialAuthority, assertWave25WorkerBinding } from './credentialAuthority.js'
import { ReviewJobSchema, type ReviewJob } from '@foreman-code/contracts'
import type { SessionWriteLease } from '../sessionWriter.js'
import { requireReviewerCredential } from '../reviewerCredential.js'
import { readRetainedRemoteReviewer } from '../retainedRemoteReviewer.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
type Purpose = 'workflow' | 'reviewer'

export class Wave25WorkerCredentialService extends WorkerCredentialService {
  private sweepAfter: string | null = null
  constructor(private readonly approvalPool: pg.Pool, private readonly approvalAccess: PostgresAccessService, ttlMs?: number) {
    super(approvalPool, approvalAccess, ttlMs)
  }
  private async subject(executionId: string) { return isCurrentApprovalRun(this.approvalPool, await runFor(this.approvalPool, 'execution', executionId)) }
  private async locked<T>(executionId: string, work: (client: pg.PoolClient) => Promise<T>,
    lockWait: 'wait' | 'nowait' = 'wait'): Promise<T> {
    const client = await this.approvalPool.connect()
    let broken = false
    let committing = false
    try {
      await beginTransaction(client)
      const runId = await runFor(client, 'execution', executionId)
      const lock = lockWait === 'nowait' ? 'nowait' : ''
      await client.query(`select id from runs where id=$1 for no key update ${lock}`, [runId])
      await client.query(`select id from harness_executions where id=$1 for update ${lock}`, [executionId])
      if (await runFor(client, 'execution', executionId) !== runId) return fail('AUTH_REVOKED')
      const value = await work(client)
      committing = true
      await commitTransaction(client)
      return value
    } catch (error) {
      broken = committing
      if (await rollbackAfterFailure(client)) broken = true
      throw error
    } finally { client.release(broken) }
  }
  private async issueV2(executionId: string, purpose: Purpose): Promise<IssuedWorkerCredential> {
    return this.locked(executionId, async (client) => {
      const a = await credentialAuthority(client, executionId, purpose)
      const expiry = await this.issueExpiry(client)
      const issued = await this.approvalAccess.issue({ name: `execution:${executionId}`, audience: 'worker', agentId: a.execution.agentId,
        grants: [{ actions: ['bug_reports:report', 'interactions:read', ...(a.canRespond ? ['interactions:respond' as const] : [])],
          scope: { workspaceIds: [a.run.workspaceId], workflowIds: [a.run.workflowId], runIds: [a.run.id] } }],
        expiresAt: expiry.expiresAt }, client)
      const jobs = purpose === 'reviewer' ? (await client.query<{ id: string; lease_fence: string }>(
        `select id,lease_fence::text from review_jobs where execution_id=$1 and lease_expires_at>clock_timestamp()
         and state in ('leased','submitted','acknowledged','uncertain') order by id limit 2`, [executionId])).rows : []
      if (jobs.length > 1) return fail('REVIEWER_AUTHORITY_AMBIGUOUS')
      await client.query(`insert into worker_credential_bindings(principal_id,execution_id,run_id,workspace_id,workflow_id,agent_id,
        environment_variable,purpose,approval_native_session_id,approval_connection_generation,approval_review_job_id,approval_review_lease_fence)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint,$11,$12::bigint)`, [issued.principal.id, executionId, a.run.id, a.run.workspaceId,
        a.run.workflowId, a.execution.agentId, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, purpose, a.nativeSessionId, a.generation, jobs[0]?.id ?? null, jobs[0]?.lease_fence ?? null])
      return { principalId: issued.principal.id, expiresAt: issued.principal.expiresAt,
        renewalDeadline: expiry.renewalDeadline,
        environment: { agentId: a.execution.agentId, variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: issued.token } } }
    })
  }
  override async issueForExecution(id: string): Promise<IssuedWorkerCredential> { return await this.subject(id) ? this.issueV2(id, 'workflow') : super.issueForExecution(id) }
  override async issueForReviewer(id: string): Promise<IssuedWorkerCredential> { return await this.subject(id) ? this.issueV2(id, 'reviewer') : super.issueForReviewer(id) }
  async bindReviewerJob(executionId: string, credential: Pick<IssuedWorkerCredential, 'principalId'>,
    supplied: ReviewJob, lane?: SessionWriteLease): Promise<void> {
    await this.locked(executionId, async client => {
      const authority = await credentialAuthority(client, executionId, 'reviewer')
      await requireReviewerCredential(client, credential.principalId, { agentId: authority.execution.agentId,
        workspaceId: authority.run.workspaceId, workflowId: authority.run.workflowId, runId: authority.run.id })
      const row = (await client.query<{ record: unknown; lease_fence: string; execution_id: string; live: boolean }>(
        `select record,lease_fence::text,execution_id,lease_expires_at>clock_timestamp() as live
         from review_jobs where id=$1 for update`, [supplied.id])).rows[0]
      const job = ReviewJobSchema.parse(row?.record)
      if (!row?.live || row.execution_id !== executionId || job.leaseToken !== supplied.leaseToken
        || job.correlationId !== supplied.correlationId || job.nativeSessionId !== authority.nativeSessionId
        || job.reviewerAgentId !== authority.execution.agentId) return fail('REVIEWER_AUTHORITY_LOST')
      await lane?.guard.check()
      const updated = await client.query(`update worker_credential_bindings b set purpose='reviewer',
        approval_review_job_id=$3,approval_review_lease_fence=$4::bigint,approval_connection_generation=$5::bigint
        from management_principals p where b.principal_id=$1 and b.execution_id=$2 and p.id=b.principal_id
        and b.purpose in ('workflow','reviewer')
        and b.revoked_at is null and p.revoked_at is null and p.expires_at>clock_timestamp()
        and b.approval_native_session_id=$6 and b.agent_id=$7 returning b.principal_id`,
      [credential.principalId, executionId, job.id, row.lease_fence, authority.generation,
        authority.nativeSessionId, authority.execution.agentId])
      if (updated.rowCount !== 1) return fail('REVIEWER_CREDENTIAL_LOST')
    })
  }
  override async renewForExecution(id: string, credential: Pick<IssuedWorkerCredential, 'principalId' | 'nativeLifetimeGeneration'>): Promise<string> {
    if (!await this.subject(id)) return super.renewForExecution(id, credential)
    const lease = await this.locked(id, async (client) => {
      await client.query('select id from management_principals where id=$1 for update', [credential.principalId])
      const binding = await client.query<{ purpose: Purpose | 'consultation' }>(
        'select principal_id,purpose from worker_credential_bindings where principal_id=$1 for update', [credential.principalId])
      if (!binding.rows[0] || binding.rows[0].purpose === 'consultation') return fail('WORKER_CREDENTIAL_NOT_RENEWABLE')
      try { await assertWave25WorkerBinding(client, credential.principalId) }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'REVIEWER_BINDING_REBIND_REQUIRED') throw error
        const row = (await client.query<{ record: unknown }>('select record from harness_executions where id=$1', [id])).rows[0]
        const retained = row && await readRetainedRemoteReviewer(client, HarnessExecutionSchema.parse(row.record))
        if (retained?.principalId !== credential.principalId) throw error
      }
      if (credential.nativeLifetimeGeneration && binding.rows[0]?.purpose === 'workflow') {
        const lifetime = await client.query(`select 1 from execution_native_closures c
          where c.execution_id=$1 and c.generation=$2::bigint and c.closed_at is null and c.detached_at is null
          and not exists(select 1 from execution_native_closures successor
            where successor.execution_id=c.execution_id and successor.generation>c.generation)`,
        [id, credential.nativeLifetimeGeneration])
        if (lifetime.rowCount !== 1) return fail('AUTH_REVOKED')
      }
      const requestedAt = performance.now()
      const result = await client.query<{ expires_at: Date; database_now: Date }>(`update management_principals p
        set expires_at=greatest(p.expires_at,clock_timestamp()+($3::integer*interval '1 millisecond'))
        from worker_credential_bindings b where p.id=$1 and b.principal_id=p.id and b.execution_id=$2
          and p.revoked_at is null and b.revoked_at is null and p.expires_at>clock_timestamp() returning p.expires_at,clock_timestamp() as database_now`,
      [credential.principalId, id, this.ttlMs])
      if (!result.rows[0]) return fail('WORKER_CREDENTIAL_NOT_RENEWABLE')
      const row = result.rows[0]
      return { expiresAt: row.expires_at.toISOString(),
        renewalDeadline: databaseCredentialDeadline(row.expires_at, row.database_now, requestedAt) }
    })
    Object.assign(credential, { renewalDeadline: lease.renewalDeadline })
    return lease.expiresAt
  }
  override async reconcileTerminalCredentials(): Promise<void> {
    const rows = (await this.approvalPool.query<{ principal_id: string; execution_id: string }>(`select b.principal_id,b.execution_id
      from worker_credential_bindings b join runs r on r.id=b.run_id
      join workflow_versions v on v.id=r.workflow_version_id join management_principals p on p.id=b.principal_id
      where v.execution_semantics_version=3 and (b.revoked_at is null or p.revoked_at is null)
        and ($1::text is null or b.principal_id>$1) order by b.principal_id limit 100`, [this.sweepAfter])).rows
    for (const row of rows) {
      try {
        await this.locked(row.execution_id, async (client) => {
          await client.query('select id from management_principals where id=$1 for update nowait', [row.principal_id])
          await client.query('select principal_id from worker_credential_bindings where principal_id=$1 for update nowait', [row.principal_id])
          try { await assertWave25WorkerBinding(client, row.principal_id) }
          catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'REVIEWER_BINDING_REBIND_REQUIRED') return
            if (!(error instanceof Error) || !('code' in error) || ![
              'AUTH_REVOKED', 'REVIEWER_EXECUTION_NOT_READY', 'APPROVAL_REVIEWER_BOOTSTRAP_INTERACTIVE',
              'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED', 'APPROVAL_REVIEWER_APP_MCP_REQUIRED',
            ].includes(String(error.code))) throw error
            // Recheck and revoke under the same parent/principal/binding locks;
            // never act on a stale sweep snapshot or on a database outage.
            await client.query('update management_principals set revoked_at=coalesce(revoked_at,clock_timestamp()) where id=$1', [row.principal_id])
            await client.query('update worker_credential_bindings set revoked_at=coalesce(revoked_at,clock_timestamp()) where principal_id=$1', [row.principal_id])
          }
        }, 'nowait')
      } catch (error) {
        // Busy credentials remain persisted for the next sweep; authentication still validates them.
        if (!(error && typeof error === 'object' && 'code' in error && error.code === '55P03')) throw error
      }
    }
    // Pagination position only, not permission/lease state. Restart scans safely.
    this.sweepAfter = rows.length === 100 ? rows.at(-1)!.principal_id : null
    await super.reconcileTerminalCredentials()
  }
}
