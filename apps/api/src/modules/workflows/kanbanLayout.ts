import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  DEFAULT_WORKFLOW_KANBAN_LAYOUT, WorkflowKanbanLayoutReadSchema, WorkflowKanbanLayoutSetInputSchema, WorkflowKanbanScopeSchema,
  type WorkflowKanbanLayoutRead,
} from '@foreman-code/contracts'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'

/** Position, size and visibility of a workflow's Kanban object on its Board. Last write wins, like
 * other Board layout; it never touches the workflow record, its revision, versions or memory cards. */
export class WorkflowKanbanLayoutService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  async get(principal: ManagementPrincipal, input: unknown): Promise<WorkflowKanbanLayoutRead> {
    const scope = WorkflowKanbanScopeSchema.parse(input)
    requireAuthorization(principal, 'workflows:read', scope)
    const row = (await this.pool.query<{ kanban_layout: unknown }>(
      'select kanban_layout from workflows where workspace_id = $1 and id = $2 and archived_at is null',
      [scope.workspaceId, scope.workflowId])).rows[0]
    if (!row) throw missing(scope.workflowId)
    return WorkflowKanbanLayoutReadSchema.parse({ ...scope, layout: row.kanban_layout ?? DEFAULT_WORKFLOW_KANBAN_LAYOUT })
  }

  async set(principal: ManagementPrincipal, source: 'http' | 'mcp', input: unknown): Promise<WorkflowKanbanLayoutRead> {
    const { layout, ...scope } = WorkflowKanbanLayoutSetInputSchema.parse(input)
    requireAuthorization(principal, 'workflows:update', scope)
    const row = (await this.pool.query<{ kanban_layout: unknown }>(
      `update workflows set kanban_layout = $3::jsonb
       where workspace_id = $1 and id = $2 and archived_at is null returning kanban_layout`,
      [scope.workspaceId, scope.workflowId, JSON.stringify(layout)])).rows[0]
    if (!row) throw missing(scope.workflowId)
    await this.commands.recordAudit(principal.id, source, 'workflow.kanban_layout.set',
      `workflow:${scope.workflowId}:kanban-layout`, 'succeeded', { visible: layout.visible })
    return WorkflowKanbanLayoutReadSchema.parse({ ...scope, layout: row.kanban_layout })
  }
}

const missing = (workflowId: string) => new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${workflowId}' was not found.`, 404)
