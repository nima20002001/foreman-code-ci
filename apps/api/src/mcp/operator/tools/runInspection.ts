import { registerRunHistoryTools, unavailableRunHistoryToolCall } from './runHistory.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ManagementAction, ManagementScope } from '@foreman-code/contracts/management'
import {
  RUN_INSPECTION_TOOLS, RunInspectionToolNameSchema, type RunInspectionToolName,
  RunRecordGetInputSchema, RunRecordDetailSchema,
  RunExecutionsListInputSchema, RunExecutionsPageSchema, RunExecutionGetInputSchema, RunExecutionDetailSchema,
  RunExecutionBindingsListInputSchema, RunExecutionBindingsPageSchema, RunVersionGetInputSchema, RunVersionDetailSchema,
} from '@foreman-code/contracts/wave25'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../../modules/access/policy.js'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure } from '../../shared/results.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

export function runInspectionRequirements(name: RunInspectionToolName): ManagementAction[] {
  return name === RUN_INSPECTION_TOOLS.version ? ['runs:read', 'workflows:read'] : ['runs:read']
}
const usable = (scope: ManagementScope) => !Object.values(scope).some((ids) => ids?.length === 0)
const overlap = (a: string[] | undefined, b: string[] | undefined) => !a || !b || a.some((id) => b.includes(id))
/** Discovery is conservative, not authorization. The service rechecks the LIVE
 * principal and concrete persisted hierarchy on the same transaction as the read. */
export function runInspectionToolAvailable(context: OperatorRequestContext, name: RunInspectionToolName,
  resource?: AuthorizedResource): boolean {
  if (!context.services.runs?.inspection || !hasAction(context.principal, 'runs:read')) return false
  if (resource && Object.keys(resource).length) return isAuthorized(context.principal, 'runs:read', resource)
    && (name !== RUN_INSPECTION_TOOLS.version || isAuthorized(context.principal, 'workflows:read', {
      ...(resource.workspaceId ? { workspaceId: resource.workspaceId } : {}),
      ...(resource.workflowId ? { workflowId: resource.workflowId } : {}),
    }))
  const runs = context.principal.grants.filter((grant) => grant.actions.includes('runs:read') && usable(grant.scope))
  if (name !== RUN_INSPECTION_TOOLS.version) return runs.length > 0
  if (!hasAction(context.principal, 'workflows:read')) return false
  const versions = context.principal.grants.filter((grant) => grant.actions.includes('workflows:read')
    && !grant.scope.runIds && usable(grant.scope))
  for (const run of runs) for (const version of versions) {
    if (overlap(run.scope.workspaceIds, version.scope.workspaceIds)
      && overlap(run.scope.workflowIds, version.scope.workflowIds)) return true
  }
  return false
}
export function registerRunInspectionTools(server: McpServer, context: OperatorRequestContext): void {
  registerRunHistoryTools(server, context)
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const reads = context.services.runs?.inspection
  if (!reads) return
  if (runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.record)) server.registerTool(RUN_INSPECTION_TOOLS.record, {
    description: 'Read one committed WorkflowRunV3 snapshot while a native publication is in progress: original input, recorded result, lifecycle, Stop-request and cleanup-pending facts, and immutable pins. No executions, activity, native events or workflow definition. Maximum 6 MiB; oversized records fail, never truncate. Requires runs:read on the Run; location is redacted without live workspace_locations:read. Use for result disclosure or full-Run retry preflight, not aggregate run_get.',
    inputSchema: RunRecordGetInputSchema, outputSchema: RunRecordDetailSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_INSPECTION_TOOLS.record, () => reads.record(context.principal, input)))
  if (runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.executions)) server.registerTool(RUN_INSPECTION_TOOLS.executions, {
    description: 'Read a bounded page of current V3 Run executions, optionally filtered by node and real repeat occurrence. Default 25, maximum 100; newest creation time then ID. Replay opaque cursors with unchanged scope/filters. Includes recorded Run and execution failure codes and explanations, including EXECUTION_ACTIVE_TIMEOUT. Metadata only: no input/output/native bodies; use this, not aggregate run_get, for inspector refresh.',
    inputSchema: RunExecutionsListInputSchema, outputSchema: RunExecutionsPageSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_INSPECTION_TOOLS.executions, () => reads.executions(context.principal, input)))
  if (runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.execution)) server.registerTool(RUN_INSPECTION_TOOLS.execution, {
    description: 'Read one exact V3 execution and accepted input (maximum 4 MiB), verifying durable identity and canonical receipts. Includes the accepted tick index and interval for a loop execution, and continuedFromExecutionId for a resumed same-node activation. Accepted successful result is distinct from an unaccepted terminal report (maximum 64 KiB). Private authorized detail only; never raw native events, credentials or session paths.',
    inputSchema: RunExecutionGetInputSchema, outputSchema: RunExecutionDetailSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_INSPECTION_TOOLS.execution, () => reads.executionDetail(context.principal, input)))
  if (runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.bindings)) server.registerTool(RUN_INSPECTION_TOOLS.bindings, {
    description: 'Page one execution\'s exact accepted predecessor/external/carry bindings and source results. Default 10, maximum 25, immutable ordinal order. Loop executions return their accepted input digest with an empty binding page. Source identities and accepted-result receipts are checked in the same Run. No synthetic occurrence for ordinary work; no recursive history expansion.',
    inputSchema: RunExecutionBindingsListInputSchema, outputSchema: RunExecutionBindingsPageSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_INSPECTION_TOOLS.bindings, () => reads.bindings(context.principal, input)))
  if (runInspectionToolAvailable(context, RUN_INSPECTION_TOOLS.version)) server.registerTool(RUN_INSPECTION_TOOLS.version, {
    description: 'Read the exact immutable WorkflowVersionV3 topology pinned to a Run, not the current workflow head. Requires runs:read on the Run AND workflows:read on its workflow. Ordinary versions omit repeat. Reuses immutable version readers; saving or adding/removing repeat never rewrites this response.',
    inputSchema: RunVersionGetInputSchema, outputSchema: RunVersionDetailSchema, annotations,
  }, async (input) => invokeOperatorTool(context, RUN_INSPECTION_TOOLS.version, () => reads.version(context.principal, input)))
}
const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: RunInspectionToolNameSchema }).passthrough() }).passthrough()
/** Invoked only AFTER Host/Origin validation and Operator authentication. */
export async function unavailableRunInspectionToolCall(context: OperatorRequestContext, body: unknown) {
  const history = await unavailableRunHistoryToolCall(context, body)
  if (history) return history
  const call = ToolCall.safeParse(body)
  if (!call.success || runInspectionToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  const error = context.services.runs?.inspection
    ? new DomainError('ACCESS_DENIED', 'The Run inspection tool is not permitted by compatible scoped grants.', 403)
    : new DomainError('RUN_INSPECTION_UNAVAILABLE', 'Run inspection services are not composed in this application.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}
