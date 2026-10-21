import { CurrentWorkflowCreateInputSchema } from '@foreman-code/contracts/wave25'
import { SavedManagedWorkflowCommandResultSchema as ManagedWorkflowCommandResultSchema,
  SavedManagedWorkflowPageSchema as ManagedWorkflowPageSchema, SavedManagedWorkflowSchema as ManagedWorkflowSchema } from '@foreman-code/contracts/wave25'

import {
  WorkflowBatchArchiveInputSchema, WorkflowBatchArchiveResultSchema,
  WorkflowReorderInputSchema, WorkflowReorderResultSchema,
  WorkflowArchiveInputSchema, WorkflowGetInputSchema,
  WorkflowUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { OperatorWorkflowListInputSchema, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import { defineOperatorTool } from '../definition.js'

export const workflowTools = [
  defineOperatorTool({
    name: 'workflow_list',
    requires: [['workflows:read', 'resource']],
    enabled: s => !!s.workflows,
    description: 'List authorized workflow summaries in saved workspace order, including empty workflows (10 by default). '
      + 'Use detail:full or workflow_get for the saved definition. Each page includes orderRevision for workflow_reorder. '
      + 'orderRevision is 0 when no read grant applies to this workspace. '
      + 'Pass pageInfo.nextCursor as cursor; null means the end. Restart pagination after order or membership changes.',
    inputSchema: OperatorWorkflowListInputSchema,
    outputSchema: WorkflowSummaryPageSchema.or(ManagedWorkflowPageSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { detail, ...input }) => {
    const page = await context.services.workflows.list(context.principal, input)
    if (detail === 'full') return page
    return {
      detail: 'compact', pageInfo: page.pageInfo, orderRevision: page.orderRevision,
      items: page.items.map(({ workflow, ...item }) => ({
        ...item, workflow: { id: workflow.id, workspaceId: workflow.workspaceId, name: workflow.name },
        detailsOmitted: true,
      })),
    }
  },
  }),
  defineOperatorTool({
    name: 'workflow_get',
    requires: [['workflows:read', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Read a workflow and its current saved version reference.', inputSchema: WorkflowGetInputSchema,
    outputSchema: ManagedWorkflowSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.get(context.principal, input.workspaceId, input.workflowId),
  }),
  defineOperatorTool({
    name: 'workflow_create',
    requires: [['workflows:create', 'workspace']],
    enabled: s => !!s.workflows,
    description: 'Create a named semantics-3 workflow using global workflow defaults. '
      + 'The built-in approval handler is native; saved global defaults take precedence. '
      + 'Omit initialSave for an unsaved workflow, or provide initialSave '
      + '{graph, expectedAgentConfigurationVersionIds} to atomically create and save. '
      + 'Omitted graph.approval uses the workflow creation default; explicit orchestrator handling requires a designated reviewer. '
      + 'The graph omits workflow identity, name, description, defaultWorktree and timestamps; '
      + 'creation supplies those fields. Invalid graphs or configuration references leave no workflow. '
      + 'Initial save additionally requires workflows:read/update, graph:read/edit/save, agents:read '
      + 'and workspace_locations:read, and referenced skill/harness/source grants, '
      + 'scoped to the workspace without workflow-ID restrictions. '
      + 'Read back with workflow_saved_get_v3; retry the same commandId and input after an uncertain reply. '
      + 'Use workflow_validate_v3 and workflow_save_v3 for later graph edits, with or without repeat. '
      + 'Omit defaultWorktree to copy the ready workspace project root; pass null to opt out '
      + 'or {rootBinding,branchPrefix?} to select an approved immutable Git source. '
      + 'Worktree selection requires sources:read, source_roots:read and workspace_locations:read. '
      + 'Agents inherit that root unless node.placement overrides it; each writable execution gets '
      + 'its own directory and uniquely suffixed branch.',
    inputSchema: CurrentWorkflowCreateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.create(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_update',
    requires: [['workflows:update', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Revision-check and rename or describe a workflow. For current graph and workflow settings use workflow_validate_v3 and workflow_save_v3 with exact pins; unresolved staged edits require their existing Stop-and-save/Discard protocol. Global workflow_defaults_update affects only future workflows.', inputSchema: WorkflowUpdateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_reorder',
    requires: [['workflows:update', 'workflow'], ['workflows:read', 'workflow']],
    enabled: s => !!s.workflows,
    description: 'Persist the order of at least two unique active workflows in one workspace. '
      + 'Pass workflow_list.orderRevision as expectedRevision; workflow revisions remain unchanged. '
      + 'The submitted IDs replace only their existing slots, preserving omitted workflows, including hidden or unloaded items. '
      + 'Requires workflows:read and workflows:update for every submitted workflow. '
      + 'Stale order revisions, archived workflows or foreign/missing IDs reject the whole command. '
      + 'Returns only the submitted IDs in saved order. Retry the same commandId and input after an uncertain reply, '
      + 'then restart workflow_list pagination to read the persisted result.',
    inputSchema: WorkflowReorderInputSchema, outputSchema: WorkflowReorderResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.reorder(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_batch_archive',
    requires: [['workflows:archive', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Atomically delete (archive) 1–100 selected workflows, retaining versions and runs. Requires archive permission for every workflow and its expected revision. Active runs or any conflict reject the entire batch. Retry an uncertain outcome with the same commandId and input.',
    inputSchema: WorkflowBatchArchiveInputSchema, outputSchema: WorkflowBatchArchiveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.archiveBatch(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_archive',
    requires: [['workflows:archive', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Archive a settled workflow while retaining versions and runs.', inputSchema: WorkflowArchiveInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.archive(context.principal, 'mcp', input),
  }),
]
