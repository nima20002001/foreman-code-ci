import { workflowChatGrants } from './workflowChatGrants.js'
import { canonicalJson, CoordinatorConsultationBindingSchema, HarnessExecutionSchema, WorkflowRunSchema,
  type CoordinatorConsultationBinding } from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'

import { databaseCredentialDeadline } from './credentialLifetime.js'
import { DomainError } from '../errors.js'
import type { ChildProcessEnvironment } from '../harnesses/port.js'
import type { PostgresAccessService } from './postgres.js'
import { lockActiveWorkerPrincipal, lockWorkerExecution, requireActiveWorkerExecution } from './workerLifecycle.js'
import { WORKER_BINDING_ELIGIBLE } from './workerEligibility.js'
import { readCoordinatorCredentialAuthority, readConsultationCredentialSubject } from './consultationAuthority.js'

export const APP_MCP_TOKEN_ENVIRONMENT_VARIABLE = 'GRAPHQL_MCP_TOKEN'
export const DEFAULT_WORKER_CREDENTIAL_TTL_MS = 15 * 60 * 1000
export { WORKER_CREDENTIAL_EXPIRY_MARGIN_MS } from './credentialLifetime.js'
/** Main renews the execution credential this early so every dependent Worker relay and launcher route,
 * which renew inside their final two minutes, always reads an already extended expiry. */
export const WORKER_CREDENTIAL_RENEWAL_WINDOW_MS = 5 * 60_000

export interface IssuedWorkerCredential {
  principalId: string
  environment: ChildProcessEnvironment
  expiresAt: string
  renewalDeadline?: number
  nativeLifetimeGeneration?: string
}

/** Issues only from durable execution/run identity; callers cannot supply alternate scope. */
export class WorkerCredentialService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly access: PostgresAccessService,
    readonly ttlMs = DEFAULT_WORKER_CREDENTIAL_TTL_MS,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 2147483647) {
      throw new RangeError('Worker credential TTL must be at least one minute.')
    }
  }

  private async transaction<T>(perform: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, perform, { conflictRetries: 2 })
  }

  issueForExecution(executionId: string): Promise<IssuedWorkerCredential> {
    return this.issue(executionId, 'workflow')
  }

  issueForReviewer(executionId: string): Promise<IssuedWorkerCredential> {
    return this.issue(executionId, 'reviewer')
  }

  /** A consultation borrows its retained native session, never its closed graph credential. */
  issueForConsultation(input: CoordinatorConsultationBinding): Promise<IssuedWorkerCredential> {
    const binding = CoordinatorConsultationBindingSchema.parse(input)
    return this.transaction(async client => {
      const authority = await readCoordinatorCredentialAuthority(client, binding, true)
      const expiry = await this.issueExpiry(client)
      const issued = await this.access.issue({ name: `consultation:${binding.consultationId}`,
        audience: 'worker', agentId: authority.subject.agent.agentId,
        grants: [...await workflowChatGrants(client, authority.source_execution_id), { actions: ['bug_reports:report', 'interactions:read'], scope: {
          workspaceIds: [authority.workspace_id], workflowIds: [authority.workflow_id], runIds: [binding.runId],
        } }], expiresAt: expiry.expiresAt }, client)
      await client.query(`insert into worker_credential_bindings
        (principal_id,execution_id,run_id,workspace_id,workflow_id,agent_id,environment_variable,purpose,
          consultation_id,consultation_binding)
        values($1,$2,$3,$4,$5,$6,$7,'consultation',$8,$9::jsonb)`,
      [issued.principal.id, authority.source_execution_id, binding.runId, authority.workspace_id,
        authority.workflow_id, authority.subject.agent.agentId, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE,
        binding.consultationId, canonicalJson(binding)])
      return { principalId: issued.principal.id, expiresAt: issued.principal.expiresAt,
        renewalDeadline: expiry.renewalDeadline, environment: { agentId: authority.subject.agent.agentId,
          variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: issued.token } } }
    })
  }

  /** Renew only while this exact consultation still owns the live mailbox. */
  renewForConsultation(input: CoordinatorConsultationBinding,
    credential: Pick<IssuedWorkerCredential, 'principalId' | 'nativeLifetimeGeneration'>): Promise<string> {
    const binding = CoordinatorConsultationBindingSchema.parse(input)
    return this.transaction(async client => {
      await readCoordinatorCredentialAuthority(client, binding, true)
      await client.query('select id from management_principals where id=$1 for update', [credential.principalId])
      const subject = await readConsultationCredentialSubject(client, credential.principalId)
      if (subject.kind !== 'coordinator_consultation' || canonicalJson(subject.binding) !== canonicalJson(binding)) {
        throw new DomainError('WORKER_CREDENTIAL_IDENTITY_CONFLICT', 'The credential belongs to another consultation.', 409)
      }
      const requestedAt = performance.now()
      const row = (await client.query<{ expires_at: Date; database_now: Date }>(`update management_principals p
        set expires_at=greatest(p.expires_at,clock_timestamp()+($3::integer*interval '1 millisecond'))
        from worker_credential_bindings b where p.id=$1 and b.principal_id=p.id
          and b.purpose='consultation' and b.consultation_binding=$2::jsonb
          and b.revoked_at is null and p.revoked_at is null and p.expires_at>clock_timestamp()
        returning p.expires_at,clock_timestamp() as database_now`,
      [credential.principalId, canonicalJson(binding), this.ttlMs])).rows[0]
      if (!row) throw new DomainError('WORKER_CREDENTIAL_NOT_RENEWABLE', 'The consultation credential is no longer active.', 409)
      Object.assign(credential, { renewalDeadline: databaseCredentialDeadline(row.expires_at, row.database_now, requestedAt) })
      return row.expires_at.toISOString()
    })
  }

  /** Reuse the actual retained token after reconnect; never mint a replacement from history. */
  async restoreForConsultation(input: CoordinatorConsultationBinding,
    environment: ChildProcessEnvironment): Promise<IssuedWorkerCredential> {
    const binding = CoordinatorConsultationBindingSchema.parse(input)
    const keys = Object.keys(environment.variables), token = environment.variables[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]
    if (keys.length !== 1 || keys[0] !== APP_MCP_TOKEN_ENVIRONMENT_VARIABLE || !token) {
      throw new DomainError('WORKER_CREDENTIAL_IDENTITY_CONFLICT', 'The retained consultation environment is invalid.', 409)
    }
    const principal = await this.access.authenticate(token, 'worker')
    return this.transaction(async client => {
      await readCoordinatorCredentialAuthority(client, binding, true)
      const current = await lockActiveWorkerPrincipal(client, principal)
      const subject = await readConsultationCredentialSubject(client, current.id)
      if (subject.kind !== 'coordinator_consultation' || canonicalJson(subject.binding) !== canonicalJson(binding)
        || subject.agent.agentId !== environment.agentId || current.agentId !== environment.agentId) {
        throw new DomainError('WORKER_CREDENTIAL_IDENTITY_CONFLICT', 'The retained credential belongs to another consultation.', 409)
      }
      const requestedAt = performance.now()
      const clock = (await client.query<{ expires_at: Date; database_now: Date }>(
        'select expires_at,clock_timestamp() as database_now from management_principals where id=$1', [current.id])).rows[0]!
      return { principalId: current.id, expiresAt: clock.expires_at.toISOString(),
        renewalDeadline: databaseCredentialDeadline(clock.expires_at, clock.database_now, requestedAt),
        environment: structuredClone(environment) }
    })
  }

  protected async issueExpiry(client: pg.ClientBase): Promise<{ expiresAt: Date; renewalDeadline: number }> {
    const requestedAt = performance.now()
    const row = (await client.query<{ expires_at: Date; database_now: Date }>(
      `select clock_timestamp()+($1::integer*interval '1 millisecond') as expires_at,
        clock_timestamp() as database_now`, [this.ttlMs])).rows[0]!
    return { expiresAt: row.expires_at,
      renewalDeadline: databaseCredentialDeadline(row.expires_at, row.database_now, requestedAt) }
  }

  /** Recover only the original live credential retained by a detached native process. */
  async restoreForExecution(executionId: string, environment: ChildProcessEnvironment): Promise<IssuedWorkerCredential> {
    const keys = Object.keys(environment.variables)
    const token = environment.variables[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]
    if (keys.length !== 1 || keys[0] !== APP_MCP_TOKEN_ENVIRONMENT_VARIABLE || !token) {
      throw new DomainError('WORKER_CREDENTIAL_IDENTITY_CONFLICT', 'The retained worker environment is invalid.', 409)
    }
    const principal = await this.access.authenticate(token, 'worker')
    return this.transaction(async client => {
      const current = await lockActiveWorkerPrincipal(client, principal)
      const binding = (await client.query<{ execution_id: string; agent_id: string; purpose: string;
        environment_variable: string }>(`select execution_id,agent_id,purpose,environment_variable
        from worker_credential_bindings where principal_id=$1 for share`, [current.id])).rows[0]
      if (!binding || binding.execution_id !== executionId || binding.agent_id !== environment.agentId
        || current.agentId !== environment.agentId || binding.purpose !== 'workflow'
        || binding.environment_variable !== APP_MCP_TOKEN_ENVIRONMENT_VARIABLE) {
        throw new DomainError('WORKER_CREDENTIAL_IDENTITY_CONFLICT',
          'The retained credential belongs to another execution or Agent.', 409)
      }
      const requestedAt = performance.now()
      const clock = (await client.query<{ expires_at: Date; database_now: Date }>(
        'select expires_at,clock_timestamp() as database_now from management_principals where id=$1', [current.id])).rows[0]!
      return { principalId: current.id, expiresAt: clock.expires_at.toISOString(),
        renewalDeadline: databaseCredentialDeadline(clock.expires_at, clock.database_now, requestedAt),
        environment: structuredClone(environment) }
    })
  }

  private async issue(executionId: string, purpose: 'workflow' | 'reviewer'): Promise<IssuedWorkerCredential> {
    return this.transaction(async (client) => {
      const identity = await lockWorkerExecution(client, executionId)
      const execution = HarnessExecutionSchema.parse(identity.execution_record)
      const run = WorkflowRunSchema.parse(identity.run_record)
      if (purpose === 'workflow') requireActiveWorkerExecution(identity)
      else {
        if (identity.run_closed_at || !['running', 'waiting'].includes(run.executionState) || run.outcome !== 'pending') {
          throw new DomainError('REVIEWER_EXECUTION_NOT_READY', 'The Run no longer accepts reviewer credentials.', 409)
        }
        const ready = await client.query(
          `select s.execution_id from execution_native_sessions s
           join harness_executions he on he.id=s.execution_id
           join agent_configuration_versions c on c.id=he.record->>'agentConfigurationVersionId'
           where s.execution_id=$1 and s.workflow_finalized_at is not null
             and s.reference->>'nativeSessionId'=he.record->>'nativeSessionId'
             and c.record->>'productRole' in ('master','orchestrator')`, [executionId],
        )
        if (execution.state !== 'completed' || run.approval?.handler !== 'orchestrator'
          || run.approval.designatedOrchestratorAgentId !== execution.agentId || !ready.rowCount) {
          throw new DomainError('REVIEWER_EXECUTION_NOT_READY', 'Only the finalized designated Orchestrator session can receive Run-lifetime review credentials.', 409)
        }
      }
      const expiry = await this.issueExpiry(client)
      const issued = await this.access.issue({
        name: `execution:${identity.execution_id}`,
        audience: 'worker',
        agentId: identity.agent_id,
        grants: [...await workflowChatGrants(client, executionId), {
          actions: [
            'bug_reports:report',
            'interactions:read',
            ...(run.approval?.handler === 'orchestrator'
              && run.approval.designatedOrchestratorAgentId === identity.agent_id
              ? ['interactions:respond' as const] : []),
          ],
          scope: {
            workspaceIds: [identity.workspace_id],
            workflowIds: [identity.workflow_id],
            runIds: [identity.run_id],
          },
        }],
        expiresAt: expiry.expiresAt,
      }, client)
      await client.query(
        `insert into worker_credential_bindings
          (principal_id, execution_id, run_id, workspace_id, workflow_id, agent_id, environment_variable, purpose)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [issued.principal.id, identity.execution_id, identity.run_id, identity.workspace_id,
          identity.workflow_id, identity.agent_id, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, purpose],
      )
      return {
        principalId: issued.principal.id,
        environment: {
          agentId: identity.agent_id,
          variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: issued.token },
        },
        expiresAt: issued.principal.expiresAt,
        renewalDeadline: expiry.renewalDeadline,
      }
    })
  }

  /** Extend the same principal/token only while its exact execution lease remains valid. */
  async renewForExecution(executionId: string, credential: Pick<IssuedWorkerCredential, 'principalId' | 'nativeLifetimeGeneration'>): Promise<string> {
    const requestedAt = performance.now()
    const result = await this.pool.query<{ expires_at: Date; database_now: Date }>(
      `update management_principals p
       set expires_at=greatest(p.expires_at,clock_timestamp()+($3::bigint * interval '1 millisecond'))
       from worker_credential_bindings b
       join harness_executions he on he.id=b.execution_id and he.agent_id=b.agent_id and he.run_id=b.run_id
       join runs r on r.id=b.run_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
       join agents a on a.id=b.agent_id and a.workspace_id=b.workspace_id
       join approval_execution_state s on s.execution_id=he.id
       where p.id=$1 and b.principal_id=p.id and b.execution_id=$2
         and p.audience='worker' and p.agent_id=b.agent_id
         and b.environment_variable=$4 and p.revoked_at is null and b.revoked_at is null
         and p.expires_at>clock_timestamp()
         and he.record->>'id'=he.id and he.record->>'runId'=r.id and he.record->>'agentId'=b.agent_id
         and r.record->>'id'=r.id and r.record->>'workspaceId'=b.workspace_id and r.record->>'workflowId'=b.workflow_id
         and ((b.purpose='workflow' and he.record->>'state' in ('running','waiting')
           and s.active_elapsed_ms + coalesce(extract(epoch from (now()-s.active_started_at))*1000,0) < s.active_timeout_ms)
           or (b.purpose='reviewer' and p.expires_at > clock_timestamp() and he.record->>'state'='completed'
             and r.record->'approval'->>'handler'='orchestrator'
             and r.record->'approval'->>'designatedOrchestratorAgentId'=b.agent_id
             and exists (select 1 from execution_native_sessions ns where ns.execution_id=he.id
               and ns.workflow_finalized_at is not null and ns.reference->>'nativeSessionId'=he.record->>'nativeSessionId')))
         and r.record->>'executionState' in ('running','waiting') and r.record->>'outcome'='pending'
         and ${WORKER_BINDING_ELIGIBLE}
       returning p.expires_at,clock_timestamp() as database_now`,
      [credential.principalId, executionId, this.ttlMs, APP_MCP_TOKEN_ENVIRONMENT_VARIABLE],
    )
    if (!result.rows[0]) {
      throw new DomainError('WORKER_CREDENTIAL_NOT_RENEWABLE', 'The worker credential is revoked, mismatched, or its execution is no longer active.', 409)
    }
    const row = result.rows[0]
    Object.assign(credential, { renewalDeadline: databaseCredentialDeadline(row.expires_at, row.database_now, requestedAt) })
    return row.expires_at.toISOString()
  }

  private async lockParents(client: pg.PoolClient, executionId: string,
    lockWait: 'wait' | 'nowait' = 'wait'): Promise<void> {
    const found = await client.query<{ run_id: string }>(
      `select run_id from harness_executions where id=$1
       union select run_id from worker_credential_bindings where execution_id=$1`, [executionId],
    )
    const lock = lockWait === 'nowait' ? 'nowait' : ''
    await client.query(`select id from runs where id=any($1::text[]) order by id for update ${lock}`,
      [found.rows.map((row) => row.run_id).sort()])
    await client.query(`select id from harness_executions where id=$1 for update ${lock}`, [executionId])
  }

  private async revokeIds(client: pg.PoolClient, principalIds: string[]): Promise<void> {
    if (principalIds.length === 0) return
    await client.query('select id from management_principals where id=any($1::text[]) order by id for update', [principalIds])
    await client.query(
      'update management_principals set revoked_at=coalesce(revoked_at,now()) where id=any($1::text[])', [principalIds],
    )
    // Use exactly the captured IDs on BOTH sides, including repair of old
    // binding-revoked/principal-active inconsistencies from earlier versions.
    await client.query(
      'update worker_credential_bindings set revoked_at=coalesce(revoked_at,now()) where principal_id=any($1::text[])', [principalIds],
    )
  }

  async revoke(credential: Pick<IssuedWorkerCredential, 'principalId'>): Promise<void> {
    await this.transaction(async (client) => {
      const found = await client.query<{ execution_id: string }>(
        'select execution_id from worker_credential_bindings where principal_id=$1', [credential.principalId],
      )
      if (found.rows[0]) await this.lockParents(client, found.rows[0].execution_id)
      await this.revokeIds(client, [credential.principalId])
    })
  }

  /** Revoke replaceable process credentials without terminally closing the execution. */
  async revokeSupersededForExecution(executionId: string): Promise<number> {
    return this.transaction(async (client) => {
      await this.lockParents(client, executionId)
      const active = await client.query<{ principal_id: string }>(
        `select b.principal_id from worker_credential_bindings b
         left join management_principals p on p.id=b.principal_id
         where b.execution_id=$1 and b.purpose<>'consultation'
           and (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
         order by b.principal_id`, [executionId],
      )
      const principalIds = active.rows.map((row) => row.principal_id)
      await this.revokeIds(client, principalIds)
      return principalIds.length
    })
  }

  /** Terminal/Stop cleanup permanently closes this execution to new issuance. */
  async revokeForExecution(executionId: string): Promise<number> {
    return this.transaction(async (client) => {
      await this.lockParents(client, executionId)
      await client.query(
        'update harness_executions set worker_credentials_closed_at=coalesce(worker_credentials_closed_at,now()) where id=$1',
        [executionId],
      )
      const active = await client.query<{ principal_id: string }>(
        `select b.principal_id from worker_credential_bindings b
         left join management_principals p on p.id=b.principal_id
         where b.execution_id=$1 and b.purpose<>'consultation'
           and (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
         order by b.principal_id`, [executionId],
      )
      const principalIds = active.rows.map((row) => row.principal_id)
      await this.revokeIds(client, principalIds)
      return principalIds.length
    })
  }

  /** The run barrier also blocks credentials for executions created during Stop. */
  async revokeForRun(runId: string, transactionClient?: pg.PoolClient): Promise<number> {
    const perform = async (client: pg.PoolClient): Promise<number> => {
      await client.query('select id from runs where id=$1 for update', [runId])
      await client.query(
        'update runs set worker_credentials_closed_at=coalesce(worker_credentials_closed_at,now()) where id=$1', [runId],
      )
      await client.query('select id from harness_executions where run_id=$1 order by id for update', [runId])
      await client.query(
        'update harness_executions set worker_credentials_closed_at=coalesce(worker_credentials_closed_at,now()) where run_id=$1', [runId],
      )
      const active = await client.query<{ principal_id: string }>(
        `select b.principal_id from worker_credential_bindings b
         left join management_principals p on p.id=b.principal_id
         where b.run_id=$1 and (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
         order by b.principal_id`, [runId],
      )
      const principalIds = active.rows.map((row) => row.principal_id)
      await this.revokeIds(client, principalIds)
      return principalIds.length
    }
    // Management Stop already owns a transaction/lease. Do not request a
    // second pool connection or commit that caller's transaction here.
    return transactionClient ? perform(transactionClient) : this.transaction(perform)
  }

  /** Durable terminal records + bindings are the retry queue; no in-memory token is needed. */
  async reconcileTerminalCredentials(): Promise<void> {
    const ineligible = `from worker_credential_bindings b
      left join harness_executions he on he.id=b.execution_id
      left join runs r on r.id=b.run_id
      left join management_principals p on p.id=b.principal_id
      where (b.revoked_at is null or (p.id is not null and p.revoked_at is null))
        and not coalesce((${WORKER_BINDING_ELIGIBLE}),false)`
    const pending = await this.pool.query<{ execution_id: string; principal_id: string }>(
      `select b.execution_id,b.principal_id ${ineligible} order by b.principal_id limit 100`,
    )
    let failure: unknown
    for (const row of pending.rows) {
      try {
        await this.transaction(async (client) => {
          await this.lockParents(client, row.execution_id, 'nowait')
          await client.query('select id from management_principals where id=$1 for update nowait', [row.principal_id])
          await client.query(
            'select principal_id from worker_credential_bindings where principal_id=$1 for update nowait',
            [row.principal_id],
          )
          // Recheck after locking. A stale sweep observation must not revoke a valid reviewer.
          const current = await client.query(`select b.principal_id ${ineligible} and b.principal_id=$1`, [row.principal_id])
          if (current.rowCount) await this.revokeIds(client, [row.principal_id])
        })
      } catch (error) {
        // Contended rows are retried from persisted eligibility on the next sweep.
        if (error && typeof error === 'object' && 'code' in error && error.code === '55P03') continue
        failure ??= error
      }
    }
    // Heal unbound worker principals left by the old non-atomic issuer as well.
    await this.pool.query(
      `update management_principals p set revoked_at=now()
       where p.audience='worker' and p.revoked_at is null
         and not exists (select 1 from worker_credential_bindings b where b.principal_id=p.id)`,
    )
    if (failure) throw failure
  }
}
