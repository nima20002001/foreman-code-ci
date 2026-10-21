import {
  SourceApproveInputSchema, SourceApproveResultSchema, SourceGetInputSchema, ApprovedSourceSchema,
  SourceRootBindInputSchema, SourceRootBindResultSchema,
  SourceRootGetInputSchema, SourceRootRecordSchema, SourceRootListInputSchema, SourceRootListResultSchema,
  SourcePreparationGetInputSchema, SourcePreparationSchema, SourcePreparationReconcileInputSchema, SourcePreparationReconcileResultSchema,
} from '@foreman-code/contracts/source-admission'
import { OperatorSourceListInputSchema, OperatorSourceListResultSchema, SourceSummarySchema } from '@foreman-code/contracts/operator-mcp'
import { defineOperatorTool } from '../../mcp/operator/definition.js'

const annotations = (write: boolean) => ({ readOnlyHint: !write, destructiveHint: false, idempotentHint: true, openWorldHint: false })
export const sourceTools = [
  defineOperatorTool({
    name: 'source_preparation_get',
    requires: [['sources:read', 'workspace'], ['source_roots:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Read a Job or workflow source preparation reservation and its reconciliation evidence using operationId. Job preparations also accept the original Start commandId as startCommandId. Requires sources:read and source_roots:read in the workspace. Missing or ambiguous commands fail without substitution. No filesystem probe or caller closure assertion is accepted.',
    inputSchema: SourcePreparationGetInputSchema, outputSchema: SourcePreparationSchema, annotations: annotations(false),
    run: (context, input) => context.services.sources!.preparationGet(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'source_preparation_reconcile',
    requires: [['sources:reconcile', 'workspace'], ['source_roots:read', 'workspace'], ['sources:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Reconcile a failed Job preparation, source/native resources of a stopped workflow, or retained source of an admitted Job with confirmed terminal process closure and settled publication. Requires sources:reconcile, sources:read and source_roots:read; admitted Job recovery also requires jobs:cancel. Remote cleanup verifies the exact original worker owner and kernel boundaries. Each admitted Job recovery has a fresh bounded cleanup authorization and preserves saved execution deadlines. Archives only the original claim and retains evidence. Retry the same commandId after an unknown acknowledgment. Paths, PIDs, force flags and caller closure assertions are refused.',
    inputSchema: SourcePreparationReconcileInputSchema, outputSchema: SourcePreparationReconcileResultSchema, annotations: annotations(true),
    run: (context, input) => context.services.sources!.preparationReconcile(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'source_list',
    requires: [['sources:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'List approved workspace source snapshots and availability. Defaults to 10 compact summaries with source pins, Git identity and inventory counts. Pass detail: "full" for file entries and deletions, or source_get for one manifest. Follow nextSnapshotId using afterSnapshotId. No filesystem probe or Run/Agent is required.',
    inputSchema: OperatorSourceListInputSchema, outputSchema: OperatorSourceListResultSchema,
    annotations: annotations(false),
    run: async (context, input) => {
    const { detail, ...request } = input
    const result = await context.services.sources!.list(context.principal, 'mcp', request)
    if (detail === 'full') return result
    return { ...result, detail: 'compact', items: result.items.map(item => {
      const { entries, deletions, ...manifest } = item.manifest
      void entries
      void deletions
      return SourceSummarySchema.parse({ ...item, manifest, detailsOmitted: true })
    }) }
  },
  }),
  defineOperatorTool({
    name: 'source_get',
    requires: [['sources:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Read one exact approvedSourceId/snapshotId/manifestDigest in its workspace. Automatically released bytes fail with SOURCE_UNAVAILABLE; a newer snapshot is never substituted.',
    inputSchema: SourceGetInputSchema, outputSchema: ApprovedSourceSchema, annotations: annotations(false),
    run: (context, input) => context.services.sources!.get(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'source_approve',
    requires: [['source_roots:bind', 'workspace'], ['sources:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Capture the complete tracked tree of a pinned Git commit automatically, without path approvals. '
      + 'Rejects sensitive paths/content and enforces executable policy, entry/byte limits and manifest verification. '
      + 'The request and tracked inventory are audited. Capture runs from the workspace\'s persisted canonical location. '
      + 'Captures the configured repository and approved commit/tree objects so unpublished commits can reach other computers. '
      + 'Requires source root bind, source read and location read grants; no path, Run, Agent, hooks or credentials are accepted. '
      + 'Unused snapshots expire automatically after their retention window; qualified profiles and active work retain their source. '
      + 'Successful commandId retries preserve the exact snapshot, or fail with SOURCE_UNAVAILABLE after release. '
      + 'Concurrent captures wait separately from SQL query deadlines. COMMAND_LOCK_TIMEOUT and COMMAND_DATABASE_TIMEOUT '
      + 'are retryable with the original commandId and input. SOURCE_CAPTURE_TIMEOUT is retryable with a new explicit '
      + 'commandId; a failed command never resurrects its quarantined snapshot.',
    inputSchema: SourceApproveInputSchema, outputSchema: SourceApproveResultSchema, annotations: annotations(true),
    run: (context, input) => context.services.sources!.approve(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'source_root_list',
    requires: [['source_roots:read', 'workspace'], ['sources:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Read permitted persisted root bindings, including their canonical paths, for this workspace. Requires sources:read, source_roots:read and workspace_locations:read. This metadata read does not probe a host path or grant native execution or writes.',
    inputSchema: SourceRootListInputSchema, outputSchema: SourceRootListResultSchema, annotations: annotations(false),
    run: (context, input) => context.services.sources!.rootList(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'source_root_get',
    requires: [['source_roots:read', 'workspace'], ['sources:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Read one authorized workspace rootId/bindingRevision, its canonical path and source pins. Requires sources:read, source_roots:read and workspace_locations:read. A newer binding is never substituted.',
    inputSchema: SourceRootGetInputSchema, outputSchema: SourceRootRecordSchema, annotations: annotations(false),
    run: (context, input) => context.services.sources!.rootGet(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'source_root_bind',
    requires: [['source_roots:bind', 'workspace'], ['sources:read', 'workspace'], ['source_roots:read', 'workspace'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.sources,
    description: 'Revision-check and bind a retained source to an existing permitted host/root policy. Resolve workspace/host ownership before attestation. No caller filesystem path or manufactured Run/Agent is accepted; requested access cannot exceed root/harness policy.',
    inputSchema: SourceRootBindInputSchema, outputSchema: SourceRootBindResultSchema, annotations: annotations(true),
    run: (context, input) => context.services.sources!.bindRoot(context.principal, 'mcp', input),
  }),
]
