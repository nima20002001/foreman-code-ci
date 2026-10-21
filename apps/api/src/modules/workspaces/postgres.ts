import {
  AgentSchema,
  WorkspaceSchema,
  WorkflowRunSummarySchema,
  type Agent,
} from '@foreman-code/contracts'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { SavedWorkspaceDetailsSchema, type SavedWorkspaceDetails } from '@foreman-code/contracts/wave25'

import { DomainError } from '../errors.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { PostgresWorkflowRepository } from '../workflows/postgres.js'

function requireWorkspaceRead(principal: ManagementPrincipal, workspaceId: string): void {
  for (const action of ['workspaces:read', 'workflows:read', 'agents:read', 'runs:read'] as const) {
    requireAuthorization(principal, action, { workspaceId })
  }
}

interface SummaryRow {
  id: string
  workspace_id: string
  workflow_id: string
  execution_state: string
  summary: unknown
}

async function readRunSummaries(client: pg.PoolClient, workspaceId: string) {
  const rows = (await client.query<SummaryRow>(`
    select r.id,r.workspace_id,r.workflow_id,r.execution_state,
      jsonb_build_object('id',r.record->'id','workspaceId',r.record->'workspaceId',
        'workflowId',r.record->'workflowId','executionCondition',r.record->'executionCondition',
        'executionState',r.record->'executionState','outcome',r.record->'outcome',
        'authRequired',false,'browserWait',null,
        'cleanupPending',exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending),
        'runnerHealth',jsonb_build_object('status','healthy','checkedAt',$2::text))
      || case when r.record ? 'stopCause' then jsonb_build_object('stopCause',r.record->'stopCause') else '{}'::jsonb end
      || case when r.record ? 'startedAt' then jsonb_build_object('startedAt',r.record->'startedAt') else '{}'::jsonb end
      || case when r.record ? 'finishedAt' then jsonb_build_object('finishedAt',r.record->'finishedAt') else '{}'::jsonb end
      as summary
    from runs r where r.workspace_id=$1 and r.record->'executionSemanticsVersion'='3'::jsonb
      and (r.execution_state<>'completed'
        or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
        or r.id in (select recent.id from runs recent where recent.workspace_id=$1
          and recent.record->'executionSemanticsVersion'='3'::jsonb
          and recent.execution_state='completed'
          order by recent.created_at desc,recent.id desc limit 20))
    order by r.created_at desc,r.id desc limit 2000`, [workspaceId, new Date().toISOString()])).rows
  return rows.map((row) => {
    const summary = WorkflowRunSummarySchema.parse(row.summary)
    if (summary.id !== row.id || summary.workspaceId !== workspaceId || summary.workspaceId !== row.workspace_id
      || summary.workflowId !== row.workflow_id || summary.executionState !== row.execution_state) {
      throw new DomainError('RUN_PIN_CONFLICT', 'A Run summary does not match its persisted scope and state.', 409)
    }
    return summary
  })
}

export class PostgresWorkspaceRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly workflows: PostgresWorkflowRepository,
    _runs: PostgresRunRepository,
  ) { void _runs }

  async listAgents(workspaceId: string): Promise<Agent[]> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from agents where workspace_id = $1 and archived_at is null order by created_at, id',
      [workspaceId],
    )
    return result.rows.map((row) => AgentSchema.parse(row.record))
  }

  async getDetails(workspaceId: string, principal?: ManagementPrincipal): Promise<SavedWorkspaceDetails | undefined> {
    if (!principal) throw new DomainError('AUTH_REQUIRED', 'Workspace readback requires an authenticated management caller.', 401)
    requireWorkspaceRead(principal, workspaceId)
    // Independent reads run together; a missing workspace still answers undefined.
    const [result, agents, workflows, runs] = await Promise.all([
      this.pool.query<{ record: unknown }>('select record from workspaces where id = $1', [workspaceId]),
      this.listAgents(workspaceId),
      this.workflows.list(workspaceId),
      this.currentSummaries(workspaceId, principal),
    ])
    if (!result.rows[0]) return undefined
    return SavedWorkspaceDetailsSchema.parse({
      workspace: WorkspaceSchema.parse(result.rows[0].record),
      agents,
      workflows,
      runs,
      resources: [],
      runners: [{
        id: 'runner-local',
        name: 'Local Runner',
        health: { status: 'healthy', checkedAt: new Date().toISOString() },
      }],
    })
  }
  private async currentSummaries(workspaceId: string, principal: ManagementPrincipal) {
    return withTransaction(this.pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      requireWorkspaceRead(live, workspaceId)
      const summaries = await readRunSummaries(client, workspaceId)
      requireWorkspaceRead(principal, workspaceId)
      requireWorkspaceRead(live, workspaceId)
      return summaries
    })
  }

}
