import { readConversationCredential } from './conversationCredentials.js'
import { assertWave25WorkerBinding } from '../interactions/wave25/credentialAuthority.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'

import { DomainError } from '../errors.js'
import { WORKER_BINDING_ELIGIBLE } from './workerEligibility.js'

export interface WorkerExecutionIdentity {
  execution_id: string
  run_id: string
  agent_id: string
  workspace_id: string
  workflow_id: string
  execution_record: unknown
  run_record: unknown
  execution_closed_at: Date | null
  run_closed_at: Date | null
  approval_stopped_at: Date | null
}

/** Every lifecycle transaction locks runs, executions, principals, then bindings. */
export async function lockWorkerExecution(
  client: pg.PoolClient,
  executionId: string,
  otherRunId?: string,
  lock: 'update' | 'share' = 'update',
): Promise<WorkerExecutionIdentity> {
  const found = await client.query<{ run_id: string }>(
    'select run_id from harness_executions where id=$1', [executionId],
  )
  const runId = found.rows[0]?.run_id
  if (!runId) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The accepted execution identity was not found.', 409)
  await client.query(
    `select id from runs where id=any($1::text[]) order by id for ${lock}`,
    [[...new Set([runId, ...(otherRunId ? [otherRunId] : [])])].sort()],
  )
  await client.query(`select id from harness_executions where id=$1 for ${lock}`, [executionId])
  // Read after acquiring the locks: a SELECT that waited can otherwise retain an
  // older joined-row snapshot under READ COMMITTED.
  const result = await client.query<WorkerExecutionIdentity>(
    `select he.id as execution_id, he.run_id, he.agent_id, r.workspace_id, r.workflow_id,
            he.record as execution_record, r.record as run_record,
            he.worker_credentials_closed_at as execution_closed_at,
            r.worker_credentials_closed_at as run_closed_at,
            s.stopped_at as approval_stopped_at
     from harness_executions he join runs r on r.id=he.run_id
     join agents a on a.id=he.agent_id and a.workspace_id=r.workspace_id
     left join approval_execution_state s on s.execution_id=he.id
     where he.id=$1`, [executionId],
  )
  const identity = result.rows[0]
  if (!identity) throw new DomainError('WORKER_EXECUTION_NOT_FOUND', 'The accepted execution identity was not found.', 409)
  const execution = HarnessExecutionSchema.parse(identity.execution_record)
  const run = AcceptedWorkflowRunV3Schema.parse(identity.run_record)
  if (execution.id !== identity.execution_id || execution.runId !== identity.run_id
    || execution.agentId !== identity.agent_id || run.id !== identity.run_id
    || run.workspaceId !== identity.workspace_id || run.workflowId !== identity.workflow_id) {
    throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'The durable execution identity is inconsistent.', 409)
  }
  return identity
}

export function requireActiveWorkerExecution(identity: WorkerExecutionIdentity): void {
  const execution = HarnessExecutionSchema.parse(identity.execution_record)
  const run = AcceptedWorkflowRunV3Schema.parse(identity.run_record)
  if (identity.execution_closed_at || identity.run_closed_at || identity.approval_stopped_at
    || !['starting', 'running', 'waiting'].includes(execution.state)
    || !['running', 'waiting'].includes(run.executionState)) {
    throw new DomainError('WORKER_EXECUTION_INACTIVE', 'The execution no longer accepts App credentials or decisions.', 409)
  }
}

/** Authentication also fails closed while terminal credential cleanup is retried. */
export async function requireActiveWorkerBinding(client: pg.ClientBase | pg.Pool, principalId: string): Promise<void> {
  if (await readConversationCredential(client, principalId)) return
  const active = await client.query(
    `select 1 from worker_credential_bindings b
     join management_principals p on p.id=b.principal_id and p.agent_id=b.agent_id
     join harness_executions he on he.id=b.execution_id and he.run_id=b.run_id and he.agent_id=b.agent_id
     join runs r on r.id=b.run_id and r.workspace_id=b.workspace_id and r.workflow_id=b.workflow_id
     where b.principal_id=$1 and p.expires_at>clock_timestamp()
       and ${WORKER_BINDING_ELIGIBLE}`, [principalId],
  )
  if (active.rowCount !== 1) throw new DomainError('AUTH_REVOKED', 'The credential is no longer active.', 401)
  await assertWave25WorkerBinding(client, principalId)
}

/** Shared parents fence Stop/closure while concurrent worker validations can proceed. */
export async function lockActiveWorkerPrincipal(
  client: pg.PoolClient,
  snapshot: ManagementPrincipal,
  targetRunId?: string,
  lock: 'share' | 'update' = 'share',
): Promise<ManagementPrincipal> {
  const binding = await client.query<{ execution_id: string; purpose: 'workflow' | 'reviewer' | 'consultation' }>(
    'select execution_id,purpose from worker_credential_bindings where principal_id=$1', [snapshot.id],
  )
  const acceptedBinding = binding.rows[0]
  const executionId = acceptedBinding?.execution_id
  if (!executionId) throw new DomainError('AUTH_REVOKED', 'The credential is no longer active.', 401)
  const identity = await lockWorkerExecution(client, executionId, targetRunId, lock)
  if (acceptedBinding.purpose === 'workflow') {
    try { requireActiveWorkerExecution(identity) } catch {
      throw new DomainError('AUTH_REVOKED', 'The credential is no longer active.', 401)
    }
  }
  const found = await client.query<{
    id: string; name: string; audience: string; agent_id: string | null; grants: unknown
    expires_at: Date; revoked_at: Date | null
  }>(
    `select id, name, audience, agent_id, grants, expires_at, revoked_at
     from management_principals where id=$1 for share`, [snapshot.id],
  )
  const row = found.rows[0]
  if (!row || row.audience !== 'worker' || row.agent_id !== identity.agent_id || row.revoked_at) {
    throw new DomainError('AUTH_REVOKED', 'The credential is no longer active.', 401)
  }
  if (row.expires_at.getTime() <= Date.now()) throw new DomainError('AUTH_EXPIRED', 'The credential has expired.', 401)
  await requireActiveWorkerBinding(client, row.id)
  return ManagementPrincipalSchema.parse({
    id: row.id, name: row.name, audience: row.audience, agentId: row.agent_id,
    grants: row.grants, expiresAt: row.expires_at.toISOString(), revokedAt: null,
  })
}
