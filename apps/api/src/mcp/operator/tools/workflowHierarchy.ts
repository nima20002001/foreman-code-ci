import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { WORKFLOW_HIERARCHY_TOOLS, WorkflowHierarchyReadInputSchema, WorkflowHierarchyReadResultSchema,
  WorkflowHierarchyUpdateInputSchema, WorkflowReportsReadInputSchema, WorkflowReportsPageSchema } from '@foreman-code/contracts'
import { WorkflowHierarchyUpdateResultSchema } from '@foreman-code/contracts/wave25'
import { currentWorkflowAvailable } from '../../../modules/workflows/currentWorkflowPolicy.js'
import type { ManagementPrincipal, ManagementScope } from '@foreman-code/contracts/management'
import { DomainError } from '../../../modules/errors.js'
import { toolFailure } from '../../shared/results.js'
import { invokeOperatorTool } from '../invoke.js'
import type { OperatorRequestContext } from '../types.js'

type HierarchyTool = typeof WORKFLOW_HIERARCHY_TOOLS[keyof typeof WORKFLOW_HIERARCHY_TOOLS]
function compatibleReportReads(principal: ManagementPrincipal): boolean {
  let candidates: ManagementScope[] = [{}]
  for (const action of ['workflows:read', 'graph:read', 'runs:read'] as const) {
    const grants = principal.grants.filter(grant => grant.actions.includes(action)
      && (action === 'runs:read' || !grant.scope.runIds)
      && !Object.values(grant.scope).some(ids => ids?.length === 0))
    const next: ManagementScope[] = []
    for (const candidate of candidates) for (const grant of grants) {
      const scope: ManagementScope = {}
      let compatible = true
      for (const key of ['workspaceIds', 'workflowIds', 'runIds'] as const) {
        const a = candidate[key], b = grant.scope[key], ids = a && b ? a.filter(id => b.includes(id)) : a ?? b
        if (ids?.length === 0) { compatible = false; break }
        if (ids) scope[key] = ids
      }
      if (compatible) next.push(scope)
    }
    candidates = next
    if (!candidates.length) return false
  }
  return true
}
export function workflowHierarchyToolAvailable(context: OperatorRequestContext, name: HierarchyTool): boolean {
  return !!context.services.workflowHierarchy && currentWorkflowAvailable(context.principal,
    name === WORKFLOW_HIERARCHY_TOOLS.update ? 'save' : 'saved')
    && (name !== WORKFLOW_HIERARCHY_TOOLS.reports || compatibleReportReads(context.principal))
}
export function registerWorkflowHierarchyTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.workflowHierarchy
  if (!service) return
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  if (workflowHierarchyToolAvailable(context, WORKFLOW_HIERARCHY_TOOLS.get)) server.registerTool(WORKFLOW_HIERARCHY_TOOLS.get, {
    description: 'Read saved Master/Orchestrator/Worker reporting membership with exact node and configuration identities. Optional Run or WorkflowVersion pins preserve historical membership; omitted pins read the current saved version. Requires workflow and graph reads, plus Run reads for a Run pin. Does not load transcripts or create a conversation.',
    inputSchema: WorkflowHierarchyReadInputSchema, outputSchema: WorkflowHierarchyReadResultSchema, annotations,
  }, input => invokeOperatorTool(context, WORKFLOW_HIERARCHY_TOOLS.get, () => service.read(context.principal, input)))
  if (workflowHierarchyToolAvailable(context, WORKFLOW_HIERARCHY_TOOLS.update)) server.registerTool(WORKFLOW_HIERARCHY_TOOLS.update, {
    description: 'Update only saved reporting hierarchy through the normal workflow publication authority. hierarchy:null removes reporting metadata and preserves Agents/routes; make any required role/entry edits through workflow_edit_v3 first. Optional expectedRevision checks the supplied revision; optional commandId makes retries exact. Invalid roles, routes, incomplete setup or unsettled executable edits fail without a partial save. Use full workflow_edit_v3 for staged Agent, route, role or entry changes.',
    inputSchema: WorkflowHierarchyUpdateInputSchema, outputSchema: WorkflowHierarchyUpdateResultSchema,
    annotations: { ...annotations, readOnlyHint: false },
  }, input => invokeOperatorTool(context, WORKFLOW_HIERARCHY_TOOLS.update, () => service.update(context.principal, 'mcp', input)))
  if (workflowHierarchyToolAvailable(context, WORKFLOW_HIERARCHY_TOOLS.reports)) server.registerTool(WORKFLOW_HIERARCHY_TOOLS.reports, {
    description: 'Read bounded committed hierarchy reports for one exact Run. parentNodeId returns each direct child’s latest report; workflowNodeId returns report history. Optional opaque cursor preserves scope/filter/snapshot; default 50 and maximum 100. Failure, cancellation and blocking remain distinct; reports are projections and never authorize acceptance. Requires Run, graph and workflow reads.',
    inputSchema: WorkflowReportsReadInputSchema, outputSchema: WorkflowReportsPageSchema, annotations,
  }, input => invokeOperatorTool(context, WORKFLOW_HIERARCHY_TOOLS.reports, () => service.reports(context.principal, input)))
}
const Call = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]), method: z.literal('tools/call'),
  params: z.object({ name: z.enum(Object.values(WORKFLOW_HIERARCHY_TOOLS)) }).passthrough() }).passthrough()
export async function unavailableWorkflowHierarchyToolCall(context: OperatorRequestContext, body: unknown) {
  const call = Call.safeParse(body)
  if (!call.success || workflowHierarchyToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  const error = context.services.workflowHierarchy
    ? new DomainError('ACCESS_DENIED', 'This hierarchy tool requires compatible scoped grants.', 403)
    : new DomainError('WORKFLOW_HIERARCHY_UNAVAILABLE', 'Workflow hierarchy services are unavailable.', 503)
  if (error.status === 403) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}
