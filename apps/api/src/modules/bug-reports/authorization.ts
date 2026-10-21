import {
  ManagementPrincipalSchema,
  type BugReportCreateInput,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { assertWave25WorkerBinding } from '../interactions/wave25/credentialAuthority.js'
import { DomainError } from '../errors.js'
import { redactBugReportText } from './redaction.js'

export interface ReportContext {
  workspaceId: string
  workflowId?: string
  runId?: string
  harness: string | null
  reporter: { principalId: string; name: string; audience: 'worker' | 'operator' | 'user'; agentId?: string }
}

export async function liveBugReportPrincipal(
  sql: GraphSqlClient,
  snapshot: ManagementPrincipal,
): Promise<ManagementPrincipal> {
  if (snapshot.audience === 'operator') {
    const principal = await readLiveManagementPrincipal(sql, snapshot.id)
    const chat = (await sql.query<{ active: boolean }>(
      `select c.deleted_at is null and c.record->>'status'='open'
        and c.owner_principal_id=p.delegated_from as active
       from operator_chat_credentials credential join operator_conversations c on c.id=credential.conversation_id
       join management_principals p on p.id=credential.principal_id where p.id=$1 for share of c`,
      [snapshot.id],
    )).rows[0]
    if (chat && !chat.active) throw new DomainError('AUTH_REVOKED', 'The reporting Operator chat is no longer active.', 403)
    return principal
  }
  if (snapshot.audience !== 'worker') throw new DomainError('ACCESS_DENIED', 'Bug reports require an active caller.', 403)
  const row = (await sql.query<{
    id: string; name: string; audience: string; agent_id: string | null; grants: unknown;
    expires_at: Date; revoked_at: Date | null
  }>(`select id,name,audience,agent_id,grants,expires_at,revoked_at
      from management_principals where id=$1 for share`, [snapshot.id])).rows[0]
  if (!row || row.audience !== 'worker' || row.agent_id !== snapshot.agentId
    || row.revoked_at || row.expires_at.getTime() <= Date.now()) {
    throw new DomainError('AUTH_REVOKED', 'The reporting Agent is no longer active.', 403)
  }
  await assertWave25WorkerBinding(sql, snapshot.id)
  return ManagementPrincipalSchema.parse({
    id: row.id,
    name: row.name,
    audience: row.audience,
    agentId: row.agent_id,
    grants: row.grants,
    expiresAt: row.expires_at.toISOString(),
    revokedAt: null,
  })
}

function requireMatchingContext(input: BugReportCreateInput, context: ReportContext): void {
  for (const field of ['workspaceId', 'workflowId', 'runId'] as const) {
    if (input[field] !== undefined && input[field] !== context[field]) {
      throw new DomainError('ACCESS_DENIED', 'The report scope must match the caller and saved workflow context.', 403)
    }
  }
}

export async function reportingContext(
  sql: GraphSqlClient,
  principal: ManagementPrincipal,
  source: 'http' | 'mcp',
  input: BugReportCreateInput,
): Promise<ReportContext> {
  const reporter: ReportContext['reporter'] = {
    principalId: principal.id,
    name: redactBugReportText(principal.name),
    audience: principal.audience,
  }
  if (principal.audience === 'worker') {
    const binding = (await sql.query<{
      workspace_id: string; workflow_id: string; run_id: string; harness: string
    }>(`select b.workspace_id,b.workflow_id,b.run_id,c.record->'harness'->>'harness' as harness
        from worker_credential_bindings b join harness_executions e on e.id=b.execution_id
        join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
        where b.principal_id=$1 for share of b`, [principal.id])).rows[0]
    if (!binding || source !== 'mcp') throw new DomainError('ACCESS_DENIED', 'An active Agent binding is required.', 403)
    const context = {
      workspaceId: binding.workspace_id,
      workflowId: binding.workflow_id,
      runId: binding.run_id,
      harness: binding.harness,
      reporter: { ...reporter, agentId: principal.agentId! },
    }
    requireMatchingContext(input, context)
    const granted = principal.grants.some(grant => grant.actions.includes('bug_reports:report')
      && grant.scope.workspaceIds?.includes(context.workspaceId)
      && grant.scope.workflowIds?.includes(context.workflowId)
      && grant.scope.runIds?.includes(context.runId))
    if (!granted) throw new DomainError('ACCESS_DENIED', 'The Agent cannot report outside its granted execution.', 403)
    return context
  }
  const context = await operatorReportScope(sql, principal, input)
  requireAuthorization(principal, 'bug_reports:report', context)
  const operator = (await sql.query<{ harness: string }>(
    `select cfg.record->'harness'->>'harness' as harness
     from operator_chat_credentials credential
     join operator_conversations c on c.id=credential.conversation_id
     join operator_configuration_versions cfg on cfg.id=c.operator_configuration_version_id
     where credential.principal_id=$1 and c.deleted_at is null and c.record->>'status'='open'`,
    [principal.id],
  )).rows[0]
  if (source === 'http') {
    const local = await sql.query('select 1 from local_human_principal where principal_id=$1', [principal.id])
    if (local.rowCount === 1) reporter.audience = 'user'
  }
  return { ...context, reporter, harness: operator?.harness ?? null }
}

async function operatorReportScope(
  sql: GraphSqlClient,
  principal: ManagementPrincipal,
  input: BugReportCreateInput,
): Promise<Omit<ReportContext, 'reporter' | 'harness'>> {
  let workspaceId = input.workspaceId
  let workflowId = input.workflowId
  if (input.runId) {
    const run = (await sql.query<{ workspace_id: string; workflow_id: string }>(
      'select workspace_id,workflow_id from runs where id=$1', [input.runId],
    )).rows[0]
    if (!run) throw new DomainError('RUN_NOT_FOUND', 'The reported run was not found.', 404)
    if (workspaceId && workspaceId !== run.workspace_id || workflowId && workflowId !== run.workflow_id) {
      throw new DomainError('ACCESS_DENIED', 'The report scope must match the saved run.', 403)
    }
    workspaceId = run.workspace_id
    workflowId = run.workflow_id
  }
  if (workflowId) {
    const workflow = (await sql.query<{ workspace_id: string }>(
      'select workspace_id from workflows where id=$1', [workflowId],
    )).rows[0]
    if (!workflow) throw new DomainError('WORKFLOW_NOT_FOUND', 'The reported workflow was not found.', 404)
    if (workspaceId && workspaceId !== workflow.workspace_id) {
      throw new DomainError('ACCESS_DENIED', 'The report workspace must match the saved workflow.', 403)
    }
    workspaceId = workflow.workspace_id
  }
  if (!workspaceId) {
    const ids = new Set(principal.grants.filter(grant => grant.actions.includes('bug_reports:report'))
      .flatMap(grant => grant.scope.workspaceIds ?? []))
    if (ids.size === 1) workspaceId = [...ids][0]
  }
  if (!workspaceId) throw new DomainError('WORKSPACE_REQUIRED', 'Choose a workspace for this report.', 400)
  const workspace = await sql.query('select 1 from workspaces where id=$1', [workspaceId])
  if (!workspace.rowCount) throw new DomainError('WORKSPACE_NOT_FOUND', 'The report workspace was not found.', 404)
  return {
    workspaceId,
    ...(workflowId ? { workflowId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  }
}

export function readGrantFilter(principal: ManagementPrincipal, parameters: unknown[]): string {
  if (principal.audience !== 'operator') throw new DomainError('ACCESS_DENIED', 'Agents can only submit bug reports.', 403)
  const grants = principal.grants.filter(grant => grant.actions.includes('bug_reports:read'))
  if (!grants.length) throw new DomainError('ACCESS_DENIED', 'The caller cannot read bug reports.', 403)
  return grants.map(grant => {
    const conditions: string[] = []
    const dimensions = { workspaceIds: 'workspace_id', workflowIds: 'workflow_id', runIds: 'run_id' } as const
    for (const [field, column] of Object.entries(dimensions)) {
      const ids = grant.scope[field as keyof typeof dimensions]
      if (ids) {
        parameters.push(ids)
        conditions.push(`${column}=any($${parameters.length}::text[])`)
      }
    }
    return `(${conditions.join(' and ') || 'true'})`
  }).join(' or ')
}
