import { workflowCreationWorktree, validateWorkflowWorktrees, requireWorkflowWorktreeReads } from './worktreeSettings.js'
import { randomUUID } from 'node:crypto'

import { WorkflowDefinitionV3Schema as WorkflowDefinitionSchema, CurrentWorkflowCreateInputSchema, type CurrentWorkflowCreateInput } from '@foreman-code/contracts/wave25'
import { requireCurrentWorkflowAccess } from './currentWorkflowPolicy.js'
import { CurrentWorkflowAuthoring, type WorkflowAuthoringOptions } from './currentAuthoring.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { SavedWorkflowDefinitionSchema as CurrentDefinitionSchema, SavedManagedWorkflowSchema as ManagedWorkflowSchema,
  type SavedManagedWorkflow as ManagedWorkflow } from '@foreman-code/contracts/wave25'
import {
  WorkflowUpdateInputSchema, WorkflowArchiveInputSchema, type ManagementPrincipal,
  WorkflowBatchArchiveInputSchema, type WorkflowBatchArchiveInput, type WorkflowReorderInput,
} from '@foreman-code/contracts/management'
import type pg from 'pg'

import { hasAction, requireAuthorization } from '../access/policy.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { WorkflowScheduleService } from '../schedules/service.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { readSavedWorkflowDefinition } from './immutableRead.js'
import { assertMeaningfulSaveAdmitted } from '../graph-drafts/saveAdmission.js'
import { WorkflowOrderService } from './order.js'
import { WorkflowKanbanLayoutService } from './kanbanLayout.js'
import { decodeWorkflowOrderCursor, encodeWorkflowOrderCursor } from './orderCursor.js'

interface WorkflowRow { id: string; workspace_id: string; record: unknown; revision: string; current_version_id: string | null; archived_at: Date | null }

function managed(row: WorkflowRow): ManagedWorkflow {
  return ManagedWorkflowSchema.parse({
    workflow: readSavedWorkflowDefinition(row, { workspaceId: row.workspace_id, workflowId: row.id }),
    revision: Number(row.revision), currentVersionId: row.current_version_id,
    archivedAt: row.archived_at?.toISOString() ?? null,
  })
}

export class WorkflowManagementService {
  readonly current: CurrentWorkflowAuthoring
  readonly schedules: WorkflowScheduleService
  readonly kanban: WorkflowKanbanLayoutService
  private readonly order: WorkflowOrderService
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly options: WorkflowAuthoringOptions = {}) {
    this.current = new CurrentWorkflowAuthoring(pool, commands, options)
    this.schedules = new WorkflowScheduleService(pool, commands)
    this.kanban = new WorkflowKanbanLayoutService(pool, commands)
    this.order = new WorkflowOrderService(commands)
  }

  async list(principal: ManagementPrincipal, input: {
    workspaceId: string; cursor?: string | undefined; limit: number; includeArchived: boolean
  }) {
    if (!hasAction(principal, 'workflows:read')) requireAuthorization(principal, 'workflows:read')
    const grants = principal.grants.filter((grant) => grant.actions.includes('workflows:read')
      && (!grant.scope.workspaceIds || grant.scope.workspaceIds.includes(input.workspaceId))
      && Object.entries(grant.scope).every(([key, value]) =>
        key === 'workspaceIds' || key === 'workflowIds' || value === undefined))
    const allowedIds = grants.some((grant) => grant.scope.workflowIds === undefined)
      ? null : [...new Set(grants.flatMap((grant) => grant.scope.workflowIds ?? []))].sort()
    const scope = { workspaceId: input.workspaceId, includeArchived: input.includeArchived, workflowIds: allowedIds }
    const cursor = decodeWorkflowOrderCursor(scope, input.cursor)
    const rows = await this.pool.query<WorkflowRow & { workflow_order_revision: string; order_position: string }>(
      `select workspace.workflow_order_revision, list.* from workspaces workspace
       left join lateral (
         select id, workspace_id, record, revision, current_version_id, archived_at, order_position from workflows
         where workspace_id = workspace.id and ($2::bigint is null or order_position > $2)
         and ($3 or archived_at is null) and ($5::text[] is null or id = any($5))
         and ($6::bigint is null or workspace.workflow_order_revision = $6)
         order by order_position, id limit $4
       ) list on true where workspace.id = $1
       and ($5::text[] is null or exists (
         select 1 from workflows where workspace_id = workspace.id and id = any($5::text[])
       )) order by list.order_position, list.id`,
      [input.workspaceId, cursor?.position ?? null, input.includeArchived, input.limit + 1,
        allowedIds, cursor?.orderRevision ?? null],
    )
    const orderRevision = Number(rows.rows[0]?.workflow_order_revision ?? 0)
    if (cursor && cursor.orderRevision !== orderRevision) {
      throw new DomainError('REVISION_CONFLICT', 'The workflow order changed. Reload the list to continue.', 409,
        { currentRevision: orderRevision })
    }
    const workflows = rows.rows.filter((row) => row.id !== null)
    const page = workflows.slice(0, input.limit)
    const nextCursor = workflows.length > input.limit
      ? encodeWorkflowOrderCursor(scope, orderRevision, page.at(-1)!.order_position) : null
    return { items: page.map(managed), pageInfo: { nextCursor }, orderRevision }
  }

  reorder(principal: ManagementPrincipal, source: 'http' | 'mcp', input: WorkflowReorderInput) {
    return this.order.reorder(principal, source, input)
  }

  async get(principal: ManagementPrincipal, workspaceId: string, workflowId: string): Promise<ManagedWorkflow> {
    requireAuthorization(principal, 'workflows:read', { workspaceId, workflowId })
    const result = await this.pool.query<WorkflowRow>(
      `select id, workspace_id, record, revision, current_version_id, archived_at from workflows
       where workspace_id = $1 and id = $2`, [workspaceId, workflowId],
    )
    if (!result.rows[0]) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${workflowId}' was not found.`, 404)
    readSavedWorkflowDefinition(result.rows[0], { workspaceId, workflowId })
    return managed(result.rows[0])
  }

  async create(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: CurrentWorkflowCreateInput) {
    const input = CurrentWorkflowCreateInputSchema.parse(raw)
    requireAuthorization(principal, 'workflows:create', { workspaceId: input.workspaceId })
    if (input.defaultWorktree) requireWorkflowWorktreeReads(principal, input.workspaceId)
    if (input.initialSave) requireCurrentWorkflowAccess(principal, 'save', { workspaceId: input.workspaceId })
    let livePrincipal = principal
    return this.commands.execute({
      principal, source, operation: 'workflow.create', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:workflows:new`, payload: input,
      replayResult: (value) => {
        const saved = ManagedWorkflowSchema.parse(value)
        if (saved.workflow.defaultWorktree) {
          requireWorkflowWorktreeReads(principal, input.workspaceId)
          requireWorkflowWorktreeReads(livePrincipal, input.workspaceId)
        }
        return saved
      },
      authorize: async (client) => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        livePrincipal = live
        requireAuthorization(live, 'workflows:create', { workspaceId: input.workspaceId })
        if (input.initialSave) requireCurrentWorkflowAccess(live, 'save', { workspaceId: input.workspaceId })
        if (input.defaultWorktree) requireWorkflowWorktreeReads(live, input.workspaceId)
      },
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const defaults = await new PostgresFoundationSettingsRepository(this.pool).getWorkflowDefaults(client)
        const live = await readLiveManagementPrincipal(client, principal.id)
        const defaultWorktree = await workflowCreationWorktree({ sql: client, principal,
          workspaceId: input.workspaceId, requested: input.defaultWorktree, services: this.options.worktrees })
        if (defaultWorktree) requireWorkflowWorktreeReads(live, input.workspaceId)
        const now = new Date().toISOString()
        const workflow = WorkflowDefinitionSchema.parse({
          id: `workflow-${randomUUID()}`, workspaceId: input.workspaceId, name: input.name,
          ...(input.description !== undefined ? { description: input.description } : {}),
          approval: { handler: defaults.value.approvalHandler },
          executionSemanticsVersion: 3, entryNodeId: null,
          handoffs: { contractVersion: 1 },
          ...(defaultWorktree ? { defaultWorktree } : {}),
          executionCondition: { kind: 'manual' }, nodes: [], edges: [], createdAt: now, updatedAt: now,
        })
        await validateWorkflowWorktrees({ sql: client, principal, definition: workflow, services: this.options.worktrees })
        const result = await client.query<WorkflowRow>(
          `insert into workflows (id, workspace_id, record) values ($1, $2, $3::jsonb)
           returning id, workspace_id, record, revision, current_version_id, archived_at`,
          [workflow.id, input.workspaceId, JSON.stringify(workflow)],
        )
        const created = managed(result.rows[0]!)
        if (!input.initialSave) return created
        await this.current.saveInitial(client, live, source, {
          workspaceId: input.workspaceId, workflowId: workflow.id, commandId: randomUUID(),
          executionSemanticsVersion: 3, expectedRevision: created.revision, expectedWorkflowVersionId: null,
          expectedAgentConfigurationVersionIds: input.initialSave.expectedAgentConfigurationVersionIds,
          graph: {
            ...input.initialSave.graph,
            id: workflow.id, workspaceId: workflow.workspaceId, name: workflow.name,
            ...(workflow.description === undefined ? {} : { description: workflow.description }),
            ...(workflow.defaultWorktree === undefined ? {} : { defaultWorktree: workflow.defaultWorktree }),
            ...(workflow.version === undefined ? {} : { version: workflow.version }),
            createdAt: workflow.createdAt, updatedAt: workflow.updatedAt,
            approval: input.initialSave.graph.approval ?? workflow.approval,
          },
        })
        const saved = await client.query<WorkflowRow>(
          `select id, workspace_id, record, revision, current_version_id, archived_at from workflows
           where workspace_id=$1 and id=$2`, [input.workspaceId, workflow.id],
        )
        return managed(saved.rows[0]!)
      },
    })
  }

  async update(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; commandId: string; expectedRevision: number;
    name?: string | undefined; description?: string | null | undefined
  }) {
    input = WorkflowUpdateInputSchema.parse(input)
    requireAuthorization(principal, 'workflows:update', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'workflow.update', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}`, payload: input,
      replayResult: (value) => ManagedWorkflowSchema.parse(value),
      authorize: async (client) => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(live, 'workflows:update', { workspaceId: input.workspaceId, workflowId: input.workflowId })
      },
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const current = await client.query<WorkflowRow>(
          `select id, workspace_id, record, revision, current_version_id, archived_at from workflows
           where workspace_id = $1 and id = $2 for update`, [input.workspaceId, input.workflowId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${input.workflowId}' was not found.`, 404)
        if (row.archived_at) throw new DomainError('WORKFLOW_ARCHIVED', 'Archived workflows cannot be edited.', 409)
        if (Number(row.revision) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The workflow changed since it was read.', 409, { currentRevision: Number(row.revision) })
        }
        const previous = readSavedWorkflowDefinition(row, { workspaceId: input.workspaceId, workflowId: input.workflowId })
        const workflow = CurrentDefinitionSchema.parse({
          ...previous,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description === null ? { description: undefined }
            : input.description !== undefined ? { description: input.description } : {}),
          updatedAt: new Date().toISOString(),
        })
        const result = await client.query<WorkflowRow>(
          `update workflows set record = $3::jsonb, revision = revision + 1
           where workspace_id = $1 and id = $2 returning id, workspace_id, record, revision, current_version_id, archived_at`,
          [input.workspaceId, input.workflowId, JSON.stringify(workflow)],
        )
        return managed(result.rows[0]!)
      },
    })
  }

  async archiveBatch(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: WorkflowBatchArchiveInput) {
    const input = WorkflowBatchArchiveInputSchema.parse(raw)
    for (const item of input.workflows) {
      requireAuthorization(principal, 'workflows:archive', { workspaceId: input.workspaceId, workflowId: item.workflowId })
    }
    const ids = input.workflows.map((item) => item.workflowId).sort()
    return this.commands.execute({
      principal, source, operation: 'workflow.batch_archive', commandId: input.commandId,
      targetKey: `workspace:${input.workspaceId}:workflows`, payload: input,
      authorize: async (client) => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        for (const item of input.workflows) requireAuthorization(live, 'workflows:archive', { workspaceId: input.workspaceId, workflowId: item.workflowId })
      },
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const current = await client.query<{ id: string; revision: string }>(
          `select id, revision from workflows where workspace_id = $1 and id = any($2::text[])
           order by id for update`, [input.workspaceId, ids],
        )
        if (current.rows.length !== ids.length) throw new DomainError('WORKFLOW_NOT_FOUND', 'A selected workflow was not found. Nothing was deleted.', 404)
        const revisions = new Map(input.workflows.map((item) => [item.workflowId, item.expectedRevision]))
        if (current.rows.some((row) => Number(row.revision) !== revisions.get(row.id))) {
          throw new DomainError('REVISION_CONFLICT', 'A selected workflow changed. Nothing was deleted. Reload the list and select again.', 409)
        }
        const active = await client.query(
          `select 1 from runs where workspace_id = $1 and workflow_id = any($2::text[])
           and execution_state <> 'completed' limit 1`, [input.workspaceId, ids],
        )
        if (active.rows.length) throw new DomainError('ARCHIVE_BLOCKED_BY_ACTIVE_RUN', 'A selected workflow has active runs. Nothing was deleted. Settle active work and try again.', 409)
        await client.query(
          `update workflows set archived_at = coalesce(archived_at, now()), revision = revision + 1
           where workspace_id = $1 and id = any($2::text[])`, [input.workspaceId, ids],
        )
        return { workflowIds: ids }
      },
    })
  }

  async archive(principal: ManagementPrincipal, source: 'http' | 'mcp', input: {
    workspaceId: string; workflowId: string; commandId: string; expectedRevision: number
  }) {
    input = WorkflowArchiveInputSchema.parse(input)
    requireAuthorization(principal, 'workflows:archive', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    return this.commands.execute({
      principal, source, operation: 'workflow.archive', commandId: input.commandId,
      targetKey: `workflow:${input.workflowId}`, payload: input,
      replayResult: (value) => ManagedWorkflowSchema.parse(value),
      authorize: async (client) => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(live, 'workflows:archive', { workspaceId: input.workspaceId, workflowId: input.workflowId })
      },
      perform: async (client) => {
        await lockActiveWorkspace(client, input.workspaceId)
        const current = await client.query<WorkflowRow>(
          `select id, workspace_id, record, revision, current_version_id, archived_at from workflows
           where workspace_id = $1 and id = $2 for update`, [input.workspaceId, input.workflowId],
        )
        const row = current.rows[0]
        if (!row) throw new DomainError('WORKFLOW_NOT_FOUND', `Workflow '${input.workflowId}' was not found.`, 404)
        if (Number(row.revision) !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The workflow changed since it was read.', 409, { currentRevision: Number(row.revision) })
        }
        const definition = readSavedWorkflowDefinition(row, { workspaceId: input.workspaceId, workflowId: input.workflowId })
        void definition
        await assertMeaningfulSaveAdmitted(client, { workspaceId: input.workspaceId, workflowId: input.workflowId, stagedAgentIds: [] })
        const active = await client.query<{ count: string }>(
          `select count(*) from runs where workspace_id = $1 and workflow_id = $2 and execution_state <> 'completed'`,
          [input.workspaceId, input.workflowId],
        )
        if (Number(active.rows[0]?.count ?? 0) > 0) {
          throw new DomainError('ARCHIVE_BLOCKED_BY_ACTIVE_RUN', 'Settle active work before archiving the workflow.', 409)
        }
        const result = await client.query<WorkflowRow>(
          `update workflows set archived_at = coalesce(archived_at, now()), revision = revision + 1
           where workspace_id = $1 and id = $2 returning id, workspace_id, record, revision, current_version_id, archived_at`,
          [input.workspaceId, input.workflowId],
        )
        return managed(result.rows[0]!)
      },
    })
  }
}
