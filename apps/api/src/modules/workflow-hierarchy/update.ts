import { randomUUID } from 'node:crypto'
import { WorkflowHierarchyUpdateInputSchema } from '@foreman-code/contracts'
import { CurrentWorkflowSavedSchema, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { WorkflowManagementService } from '../workflows/management.js'
import { requireCurrentWorkflowAccess } from '../workflows/currentWorkflowPolicy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { readSavedWorkflowDefinition, readImmutableWorkflowVersion, IMMUTABLE_WORKFLOW_VERSION_COLUMNS,
  type ImmutableWorkflowVersionRow } from '../workflows/immutableRead.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { DomainError } from '../errors.js'

/** The existing publication authority owns validation, immutable versions and active-Run checks. */
export async function updateWorkflowHierarchy(commands: PostgresCommandCoordinator, workflows: WorkflowManagementService,
  principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown) {
  const input = WorkflowHierarchyUpdateInputSchema.parse(raw)
  requireCurrentWorkflowAccess(principal, 'save', input)
  let live = principal
  const commandId = input.commandId ?? randomUUID()
  const result = await commands.execute({ principal, source, operation: 'workflow.hierarchy.update', commandId,
    targetKey: `workflow:${input.workflowId}:hierarchy`, payload: { ...input, commandId: null },
    replayResult: value => CurrentWorkflowSavedSchema.parse(value),
    authorize: async client => {
      live = await readLiveManagementPrincipal(client, principal.id)
      requireCurrentWorkflowAccess(live, 'save', input)
    },
    perform: async client => {
      await lockActiveWorkspace(client, input.workspaceId)
      const row = (await client.query<{ id: string; workspace_id: string; record: unknown;
        revision: string; current_version_id: string | null; archived_at: Date | null }>(
        'select id,workspace_id,record,revision::text,current_version_id,archived_at from workflows where workspace_id=$1 and id=$2 for update',
        [input.workspaceId, input.workflowId])).rows[0]
      if (!row || row.archived_at) throw new DomainError('WORKFLOW_NOT_FOUND', 'This workflow is unavailable.', 404)
      if (input.expectedRevision !== undefined && input.expectedRevision !== Number(row.revision)) {
        throw new DomainError('REVISION_CONFLICT', 'The workflow changed. Inspect the latest saved workflow before reapplying your hierarchy.', 409)
      }
      const graph = readSavedWorkflowDefinition(row, input)
      const savedRow = row.current_version_id ? (await client.query<ImmutableWorkflowVersionRow>(
        `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
        [row.current_version_id, input.workspaceId, input.workflowId])).rows[0] : undefined
      const saved = savedRow ? readImmutableWorkflowVersion(savedRow, input) : undefined
      if (row.current_version_id && !saved) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The saved workflow version is unavailable.', 409)
      if (saved && sameWorkflowValue(graph.hierarchy ?? null, input.hierarchy)) {
        return CurrentWorkflowSavedSchema.parse({ workspaceId: input.workspaceId, workflowId: input.workflowId,
          revision: Number(row.revision), currentVersionId: saved.id, version: saved, presentation: graph })
      }
      if (input.hierarchy) { graph.hierarchy = input.hierarchy; graph.entryNodeId = input.hierarchy.masterNodeId }
      else delete graph.hierarchy
      const agentIds = [...new Set(graph.nodes.flatMap(node => node.kind === 'job' ? [] : [node.agentId]))]
      const configurations = (await client.query<{ id: string; current_configuration_version_id: string | null }>(
        'select id,current_configuration_version_id from agents where workspace_id=$1 and id=any($2::text[]) and archived_at is null for share',
        [input.workspaceId, agentIds])).rows
      const expectedAgentConfigurationVersionIds = saved?.agentConfigurationVersionIds ?? Object.fromEntries(
        configurations.flatMap(agent => agent.current_configuration_version_id ? [[agent.id, agent.current_configuration_version_id]] : []))
      return workflows.current.saveInitial(client, live, source, {
        workspaceId: input.workspaceId, workflowId: input.workflowId, executionSemanticsVersion: 3,
        commandId: `hierarchy-save-${randomUUID()}`, expectedRevision: Number(row.revision),
        expectedWorkflowVersionId: row.current_version_id, expectedAgentConfigurationVersionIds, graph,
      })
    },
  })
  return { ...result, commandId }
}
