import { z } from 'zod'
import { createHash } from 'node:crypto'
import type pg from 'pg'
import { AgentIdentitySchema, WorkflowHierarchyReadInputSchema, WorkflowHierarchyReadResultSchema,
  WorkflowReportsReadInputSchema, WorkflowReportsPageSchema, WorkflowHierarchyChangeSchema,
  type AgentIdentity, type WorkflowHierarchyReadResult, type WorkflowReportsReadInput } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { withTransaction } from '../../infrastructure/transaction.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { WorkflowManagementService } from '../workflows/management.js'
import { IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableWorkflowVersion, readPinnedAgentConfigurations,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow } from '../workflows/immutableRead.js'
import { updateWorkflowHierarchy } from './update.js'
import { readHierarchyCoordinationLocked } from '../runs/hierarchyCoordinationRead.js'

type Scope = { workspaceId: string; workflowId: string; runId?: string | undefined }
function authorize(principal: ManagementPrincipal, scope: Scope) {
  requireAuthorization(principal, 'workflows:read', { workspaceId: scope.workspaceId, workflowId: scope.workflowId })
  requireAuthorization(principal, 'graph:read', { workspaceId: scope.workspaceId, workflowId: scope.workflowId })
  if (scope.runId) requireAuthorization(principal, 'runs:read', { ...scope, runId: scope.runId })
}
const CursorSchema = z.object({ workspaceId: z.string(), workflowId: z.string(), runId: z.string(),
  parentNodeId: z.string().nullable(), workflowNodeId: z.string().nullable(),
  before: z.number().int().positive(), revision: z.number().int().nonnegative() }).strict()
function decodeCursor(input: WorkflowReportsReadInput) {
  if (!input.cursor) return undefined
  try {
    const cursor = CursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString()))
    if (cursor.workspaceId !== input.workspaceId || cursor.workflowId !== input.workflowId || cursor.runId !== input.runId
      || cursor.parentNodeId !== (input.parentNodeId ?? null) || cursor.workflowNodeId !== (input.workflowNodeId ?? null)) throw new Error('scope')
    return cursor
  } catch { throw new DomainError('INVALID_CURSOR', 'Use this report cursor with its original Run and filters.', 400) }
}
function encodeCursor(input: WorkflowReportsReadInput, before: number, revision: number) {
  return Buffer.from(JSON.stringify({ workspaceId: input.workspaceId, workflowId: input.workflowId, runId: input.runId,
    parentNodeId: input.parentNodeId ?? null, workflowNodeId: input.workflowNodeId ?? null, before, revision })).toString('base64url')
}

export class WorkflowHierarchyService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly workflows: WorkflowManagementService) {}

  update(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
    return updateWorkflowHierarchy(this.commands, this.workflows, principal, source, raw)
  }

  async read(principal: ManagementPrincipal, raw: unknown) {
    const input = WorkflowHierarchyReadInputSchema.parse(raw)
    authorize(principal, input)
    return withTransaction(this.pool, async client => {
      authorize(await readLiveManagementPrincipal(client, principal.id), input)
      const workflow = (await client.query<{ revision: string; current_version_id: string | null }>(
        'select revision::text,current_version_id from workflows where workspace_id=$1 and id=$2 for share',
        [input.workspaceId, input.workflowId])).rows[0]
      if (!workflow) throw new DomainError('WORKFLOW_NOT_FOUND', 'This workflow is unavailable.', 404)
      let versionId = input.workflowVersionId ?? workflow.current_version_id
      let run: WorkflowHierarchyReadResult['run']
      if (input.runId) {
        const row = (await client.query<{ workflow_version_id: string; execution_state: string }>(
          'select workflow_version_id,execution_state from runs where id=$1 and workspace_id=$2 and workflow_id=$3 for share',
          [input.runId, input.workspaceId, input.workflowId])).rows[0]
        if (!row) throw new DomainError('RUN_NOT_FOUND', 'This Run is unavailable in the selected workflow.', 404)
        if (input.workflowVersionId && input.workflowVersionId !== row.workflow_version_id) {
          throw new DomainError('WORKFLOW_VERSION_PIN_MISMATCH', 'The selected version does not belong to this Run.', 409)
        }
        versionId = row.workflow_version_id
        run = { runId: input.runId, state: row.execution_state }
      }
      if (!versionId) return WorkflowHierarchyReadResultSchema.parse({ ...input,
        workflowVersionId: null, hierarchy: null, agents: [], revision: Number(workflow.revision) })
      const row = (await client.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
        from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
      [versionId, input.workspaceId, input.workflowId])).rows[0]
      if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The exact saved workflow version is unavailable.', 404)
      const version = readImmutableWorkflowVersion(row, { id: versionId, ...input })
      if (run) {
        const coordination = await readHierarchyCoordinationLocked(client, run.runId, version)
        if (coordination) run = { ...run, coordination }
      }
      const configurations = (await client.query<ImmutableAgentConfigurationRow>(
        'select id,workspace_id,agent_id,version,record from agent_configuration_versions where id=any($1::text[])',
        [Object.values(version.agentConfigurationVersionIds)])).rows
      const pins = new Map(readPinnedAgentConfigurations(version, configurations).map(config => [config.agentId, config]))
      const agents: AgentIdentity[] = version.definition.nodes.flatMap(node => {
        if (node.kind === 'job') return []
        const config = pins.get(node.agentId)
        if (!config?.productRole && !version.definition.hierarchy) return []
        return [AgentIdentitySchema.parse({ workspaceId: input.workspaceId, workflowId: input.workflowId,
          workflowNodeId: node.id, agentId: node.agentId, productRole: config?.productRole,
          configurationVersionId: config?.id, displayName: node.name ?? node.label ?? node.id })]
      })
      return WorkflowHierarchyReadResultSchema.parse({ workspaceId: input.workspaceId, workflowId: input.workflowId,
        workflowVersionId: version.id, revision: Number(workflow.revision), hierarchy: version.definition.hierarchy ?? null,
        agents, ...(run ? { run } : {}) })
    })
  }

  async reports(principal: ManagementPrincipal, raw: unknown) {
    const input = WorkflowReportsReadInputSchema.parse(raw), cursor = decodeCursor(input)
    authorize(principal, input)
    return withTransaction(this.pool, async client => {
      authorize(await readLiveManagementPrincipal(client, principal.id), input)
      const run = (await client.query<{ workflow_version_id: string }>(
        'select workflow_version_id from runs where id=$1 and workspace_id=$2 and workflow_id=$3 for share',
        [input.runId, input.workspaceId, input.workflowId])).rows[0]
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'This Run is unavailable in the selected workflow.', 404)
      const latest = (await client.query<{ revision: string }>(
        'select sequence::text as revision from run_hierarchy_reports where run_id=$1 order by sequence desc limit 1', [input.runId])).rows[0]
      const revision = cursor?.revision ?? Number(latest?.revision ?? 0)
      let rows: { sequence: string; record: unknown }[]
      if (input.parentNodeId && !input.workflowNodeId) {
        const versionRow = (await client.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
          from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
        [run.workflow_version_id, input.workspaceId, input.workflowId])).rows[0]
        if (!versionRow) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The exact saved workflow version is unavailable.', 404)
        const version = readImmutableWorkflowVersion(versionRow, { id: run.workflow_version_id,
          workspaceId: input.workspaceId, workflowId: input.workflowId })
        const children = version.definition.hierarchy?.parents.filter(member => member.parentNodeId === input.parentNodeId)
          .map(member => member.workflowNodeId) ?? []
        // One indexed latest-report lookup per saved direct child, independent of history length.
        rows = (await client.query<{ sequence: string; record: unknown }>(`
          select latest.sequence::text,latest.record from unnest($3::text[]) child(workflow_node_id)
          cross join lateral (
            select sequence,record from run_hierarchy_reports
            where run_id=$1 and workflow_version_id=$2 and workflow_node_id=child.workflow_node_id
              and parent_node_id=$4 and sequence<=$5 order by sequence desc limit 1
          ) latest where ($6::bigint is null or latest.sequence<$6) order by latest.sequence desc limit $7`,
        [input.runId, run.workflow_version_id, children, input.parentNodeId, revision, cursor?.before ?? null, input.limit + 1])).rows
      } else {
        const nodeFilter = input.workflowNodeId ? 'and workflow_node_id=$3::text' : 'and $3::text is null'
        const parentFilter = input.parentNodeId ? 'and parent_node_id=$4::text' : 'and $4::text is null'
        rows = (await client.query<{ sequence: string; record: unknown }>(`
          select sequence::text,record from run_hierarchy_reports
          where run_id=$1 and workflow_version_id=$2 ${nodeFilter} ${parentFilter}
            and sequence<=$5 and ($6::bigint is null or sequence<$6) order by sequence desc limit $7`,
        [input.runId, run.workflow_version_id, input.workflowNodeId ?? null, input.parentNodeId ?? null,
          revision, cursor?.before ?? null, input.limit + 1])).rows
      }
      const page = rows.slice(0, input.limit), hasMore = rows.length > input.limit
      return WorkflowReportsPageSchema.parse({ workspaceId: input.workspaceId, workflowId: input.workflowId,
        runId: input.runId, workflowVersionId: run.workflow_version_id, items: page.map(row => row.record),
        nextCursor: hasMore ? encodeCursor(input, Number(page.at(-1)!.sequence), revision) : null, hasMore, revision })
    })
  }

  /** One bounded committed snapshot, independent of child-report publication. */
  async changes(principal: ManagementPrincipal, raw: unknown) {
    const input = WorkflowReportsReadInputSchema.pick({ workspaceId: true, workflowId: true, runId: true }).parse(raw)
    authorize(principal, input)
    return withTransaction(this.pool, async client => {
      authorize(await readLiveManagementPrincipal(client, principal.id), input)
      const run = (await client.query<{ workflow_version_id: string; execution_state: string; revision: string }>(
        `select workflow_version_id,execution_state,activity_record_revision::text as revision from runs
          where id=$1 and workspace_id=$2 and workflow_id=$3`,
        [input.runId, input.workspaceId, input.workflowId])).rows[0]
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'This Run is unavailable in the selected workflow.', 404)
      const row = (await client.query<ImmutableWorkflowVersionRow>(`select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS}
        from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
      [run.workflow_version_id, input.workspaceId, input.workflowId])).rows[0]
      if (!row) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The exact saved workflow version is unavailable.', 404)
      const version = readImmutableWorkflowVersion(row, { id: run.workflow_version_id,
        workspaceId: input.workspaceId, workflowId: input.workflowId })
      const revisions = (await client.query<{ head: string | null; reports: string | null; activity: string | null }>(`
        select (select head_sequence::text from run_graph_heads where run_id=$1) as head,
          (select sequence::text from run_hierarchy_reports where run_id=$1 order by sequence desc limit 1) as reports,
          (select sequence::text from run_activity where run_id=$1 order by sequence desc limit 1) as activity`, [input.runId])).rows[0]!
      const group = version.definition.hierarchy ? (await client.query<{ group_id: string; state: string; continuation_activation_id: string }>(`
        select group_id,state,continuation_activation_id from run_hierarchy_groups where run_id=$1 and parent_node_id=$2
          order by created_at desc,group_id desc limit 1`, [input.runId, version.definition.hierarchy.masterNodeId])).rows[0] : undefined
      // A direction release can change only its wait/activation rows. Reading the
      // canonical coordination here observes that boundary even when Run/report revisions do not move.
      const coordination = await readHierarchyCoordinationLocked(client, input.runId, version)
      const executions = [coordination?.sourceExecution?.executionId, coordination?.direction?.execution.executionId].filter(Boolean)
      const executionRevisions = (await client.query<{ id: string; revision: string }>(
        'select id,activity_record_revision::text as revision from harness_executions where run_id=$1 and id=any($2::text[]) order by id',
        [input.runId, executions])).rows
      const cursor = `sha256:${createHash('sha256').update(canonicalGraphJson({ run, revisions,
        group: group ?? null, coordination: coordination ?? null, executions: executionRevisions })).digest('hex')}`
      return WorkflowHierarchyChangeSchema.parse({ runId: input.runId, workflowVersionId: version.id,
        revision: Number(revisions.reports ?? 0), cursor })
    }, { isolation: 'repeatable read' })
  }
}
