import {
  WorkflowOrderSchema, WorkflowReorderInputSchema,
  type ManagementPrincipal, type WorkflowReorderInput,
} from '@foreman-code/contracts/management'
import type pg from 'pg'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { authorizationPrincipal, requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

function requireReorderAccess(principal: ManagementPrincipal, input: WorkflowReorderInput): void {
  const snapshot = authorizationPrincipal(principal)
  for (const workflowId of input.workflowIds) {
    const resource = { workspaceId: input.workspaceId, workflowId }
    requireAuthorization(snapshot, 'workflows:read', resource)
    requireAuthorization(snapshot, 'workflows:update', resource)
  }
}

export class WorkflowOrderService {
  constructor(private readonly commands: PostgresCommandCoordinator) {}

  async reorder(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: WorkflowReorderInput) {
    const input = WorkflowReorderInputSchema.parse(raw)
    requireReorderAccess(principal, input)
    return this.commands.execute({
      principal, source, operation: 'workflow.reorder', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:workflows:order`, payload: input,
      replayResult: (value) => WorkflowOrderSchema.parse(value),
      authorize: async (client) => {
        requireReorderAccess(await readLiveManagementPrincipal(client, principal.id), input)
      },
      perform: (client) => this.save(client, input),
    })
  }

  private async save(client: pg.PoolClient, input: WorkflowReorderInput) {
    await lockActiveWorkspace(client, input.workspaceId)
    const workspace = await client.query<{ workflow_order_revision: string }>(
      'select workflow_order_revision from workspaces where id = $1 for update', [input.workspaceId],
    )
    const orderRevision = Number(workspace.rows[0]!.workflow_order_revision)
    if (orderRevision !== input.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 'The workflow order changed. Reload the list and try again.', 409,
        { currentRevision: orderRevision })
    }
    const selected = await client.query<{ id: string; order_position: string; archived_at: Date | null }>(
      `select id, order_position, archived_at from workflows
       where workspace_id = $1 and id = any($2::text[]) order by order_position, id for update`,
      [input.workspaceId, input.workflowIds],
    )
    if (selected.rows.length !== input.workflowIds.length) {
      throw new DomainError('WORKFLOW_NOT_FOUND', 'A selected workflow was not found in this workspace.', 404)
    }
    if (selected.rows.some((row) => row.archived_at !== null)) {
      throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot be reordered.', 409)
    }
    const positions = selected.rows.map((row) => row.order_position)
    await client.query('set constraints workflow_order_position_unique deferred')
    await client.query(
      `update workflows set order_position = selection.position
       from unnest($2::text[], $3::bigint[]) as selection(id, position)
       where workspace_id = $1 and workflows.id = selection.id`,
      [input.workspaceId, input.workflowIds, positions],
    )
    const updated = await client.query<{ workflow_order_revision: string }>(
      `update workspaces set workflow_order_revision = workflow_order_revision + 1
       where id = $1 returning workflow_order_revision`, [input.workspaceId],
    )
    return WorkflowOrderSchema.parse({
      workspaceId: input.workspaceId, workflowIds: input.workflowIds,
      orderRevision: Number(updated.rows[0]!.workflow_order_revision),
    })
  }
}
