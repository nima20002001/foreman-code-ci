import {
  ListInteractionsResponseSchema, RespondToInteractionRequestSchema, type DurableInteraction,
} from '@foreman-code/contracts'
import { LocalHumanAccessSchema, InteractionListInputSchema, ManagedWorkspaceSchema,
  type ManagementAction } from '@foreman-code/contracts/management'
import {
  CURRENT_WORKFLOW_ROUTES, CurrentManagedWorkflowSchema, RunRecordDetailSchema, CurrentRunVersionSnapshotSchema,
  CurrentWorkflowCapabilitiesSchema, RunExecutionDetailSchema, RunExecutionsPageSchema,
  RunStartV3InputSchema, RunVersionDetailSchema, sameExecutableWorkflow, sameWorkflowValue,
  type RepeatGraphScopeV3, type RunExecutionSummary,
} from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../../shared/api/client'
import { canUseBoardAction } from '../permissions'
import { scopeForBoardRun } from '../client'
import type { BoardStartInput } from '../startClient'

export type RunActionSelection = Pick<RepeatGraphScopeV3, 'workspaceId' | 'workflowId' | 'runId'>
const part = encodeURIComponent
const invalid = (message: string) => new ApiError({ code: 'INVALID_RESPONSE', message })
const conflict = (message: string) => new ApiError({ code: 'RUN_ACTION_CONFLICT', message }, 409)
const path = (scope: RunActionSelection) => `/api/management/workspaces/${part(scope.workspaceId)}/runs/${part(scope.runId)}`

export function assertActionScope(actual: RepeatGraphScopeV3, selected: RunActionSelection & Partial<RepeatGraphScopeV3>): void {
  if (actual.workspaceId !== selected.workspaceId || actual.workflowId !== selected.workflowId
    || actual.runId !== selected.runId || actual.executionSemanticsVersion !== 3
    || selected.workflowVersionId !== undefined && actual.workflowVersionId !== selected.workflowVersionId) {
    throw invalid('The response does not belong to the selected Run and immutable version. No action is authorized by this response.')
  }
}
export function assertInteractionScope(interaction: DurableInteraction, scope: RunActionSelection): void {
  if (interaction.workspaceId !== scope.workspaceId || interaction.workflowId !== scope.workflowId
    || interaction.runId !== scope.runId || interaction.approval.handler !== 'user') {
    throw invalid('This human approval belongs to a different Run or approval handler.')
  }
}

/** Existing shared schemas and routes only. Metadata refresh never follows a cursor,
 * reads private inputs/results, or loads a complete historical graph. */
export function createRunActionsClient(client: ApiClient = apiClient) {
  const capabilities = (options?: RequestOptions) => client.request(CURRENT_WORKFLOW_ROUTES.capabilities,
    CurrentWorkflowCapabilitiesSchema, options)
  const authorize = async (action: ManagementAction, scope: { workspaceId: string; workflowId: string; runId?: string }, options?: RequestOptions) => {
    const access = await client.request('/api/local-human', LocalHumanAccessSchema, options)
    if (Date.parse(access.principal.expiresAt) <= Date.now() || !canUseBoardAction(access.principal.grants, action, scope)) {
      throw new ApiError({ code: 'ACCESS_DENIED', message: `${action} permission is unavailable for this exact scope.` }, 403)
    }
    return access
  }
  const executions = async (scope: RunActionSelection & Partial<RepeatGraphScopeV3>, cursor: string | null, limit = 10, options?: RequestOptions) => {
    const query = new URLSearchParams({ limit: String(limit) })
    if (cursor !== null) query.set('cursor', cursor)
    const page = await client.request(`${path(scope)}/executions?${query}`, RunExecutionsPageSchema, options)
    assertActionScope(page.run, scope)
    if (page.items.length > limit || new Set(page.items.map((row) => row.executionId)).size !== page.items.length
      || cursor !== null && page.pageInfo.nextCursor === cursor) throw invalid('Execution paging did not respect its bound or cursor.')
    return page
  }
  const status = async (scope: RunActionSelection & Partial<RepeatGraphScopeV3>, options?: RequestOptions) =>
    (await executions(scope, null, 1, options)).run
  const execution = async (scope: RepeatGraphScopeV3, executionId: string, options?: RequestOptions, summary?: RunExecutionSummary) => {
    const value = await client.request(`${path(scope)}/executions/${part(executionId)}`, RunExecutionDetailSchema, options)
    assertActionScope(value.run, scope)
    const row = value.execution
    if (row.executionId !== executionId || summary && (row.workflowNodeId !== summary.workflowNodeId
      || (row.kind==='job'?summary.kind!=='job'||row.jobDefinitionId!==summary.jobDefinitionId||row.jobDefinitionVersionId!==summary.jobDefinitionVersionId:summary.kind==='job'||row.agentId!==summary.agentId||row.agentConfigurationVersionId!==summary.agentConfigurationVersionId)
      || row.attempt !== summary.attempt || !sameWorkflowValue(row.occurrence ?? null, summary.occurrence ?? null))) {
      throw invalid('Execution detail did not match its exact node, attempt, occurrence and configuration identity.')
    }
    return value
  }
  const version = async (scope: RepeatGraphScopeV3, options?: RequestOptions) => {
    const value = await client.request(`${path(scope)}/version`, RunVersionDetailSchema, options)
    assertActionScope(value.scope, scope)
    if (value.version.id !== scope.workflowVersionId || value.version.workspaceId !== scope.workspaceId
      || value.version.workflowId !== scope.workflowId) throw invalid('The saved definition does not match this Run’s immutable pin.')
    return value
  }
  const approvals = async (scope: RepeatGraphScopeV3, cursor: string | null, options?: RequestOptions) => {
    const input = InteractionListInputSchema.parse({ workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      runId: scope.runId, handler: 'user', limit: 10, ...(cursor === null ? {} : { cursor }) })
    const query = new URLSearchParams(Object.entries(input).map(([key, value]) => [key, String(value)]))
    // This is the EXISTING human inbox route. Unlike the convenience management
    // client, it supports the shared runId filter. No workflow-wide client scan.
    const page = await client.request(`/api/user/interactions?${query}`, ListInteractionsResponseSchema, options)
    page.items.forEach((item) => assertInteractionScope(item, scope))
    if (page.items.length > input.limit || new Set(page.items.map((item) => item.id)).size !== page.items.length
      || cursor !== null && page.nextCursor === cursor) throw invalid('Approval paging did not respect its bound or cursor.')
    return page
  }
  const approval = async (scope: RepeatGraphScopeV3, id: string, options?: RequestOptions) => {
    const value = await client.getUserInteraction(id, options)
    assertInteractionScope(value.interaction, scope)
    if (value.interaction.id !== id) throw invalid('Approval detail returned a different interaction.')
    // Interactions have no WorkflowVersion field. Resolve their exact execution
    // through authenticated inspection instead of borrowing the current draft.
    const detail = await execution(scope, value.interaction.executionId, options)
    if (detail.execution.kind==='job'||detail.execution.agentId !== value.interaction.requestingAgentId) throw invalid('Approval requester does not match the pinned execution.')
    return { ...value, execution: detail.execution }
  }
  const respond = async (scope: RepeatGraphScopeV3, expected: DurableInteraction,
    input: Parameters<ApiClient['respondToUserInteraction']>[0], options?: RequestOptions) => {
    const request = RespondToInteractionRequestSchema.parse(input)
    assertInteractionScope(expected, scope)
    if (request.interactionId !== expected.id) throw invalid('The response targets a different interaction.')
    await authorize('interactions:respond', scope, options)
    const [fresh, currentRun] = await Promise.all([approval(scope, expected.id, options), status(scope, options)])
    if (currentRun.executionState === 'completed' && fresh.interaction.status === 'pending') throw conflict('This Run is terminal. No new human decision will be sent.')
    if (fresh.canRespond !== true) throw new ApiError({ code: 'ACCESS_DENIED', message: 'Human response permission is unavailable for this interaction.' }, 403)
    if (fresh.interaction.executionId !== expected.executionId || fresh.interaction.nativeRequestId !== expected.nativeRequestId
      || fresh.interaction.nativeSessionId !== expected.nativeSessionId) throw invalid('The original approval request identity changed.')
    // Do not replace expectedRevision on a retry. The service reconciles the exact
    // original interaction/option/revision tuple, including a lost response.
    const result = await client.respondToUserInteraction(request, options)
    assertInteractionScope(result.interaction, scope)
    if (result.interaction.id !== expected.id || result.interaction.executionId !== expected.executionId
      || result.interaction.nativeRequestId !== expected.nativeRequestId || result.interaction.nativeSessionId !== expected.nativeSessionId
      || result.interaction.selectedOptionId !== request.optionId || result.interaction.revision < request.expectedRevision) {
      throw invalid('The approval receipt did not match the exact response. Refresh or reconcile that same response.')
    }
    return result
  }
  const record = async (scope: RepeatGraphScopeV3, options?: RequestOptions) => {
    const detail = await client.request(`${path(scope)}/record`, RunRecordDetailSchema, options)
    assertActionScope(scopeForBoardRun(detail.run), scope)
    return detail
  }
  const runResult = async (scope: RepeatGraphScopeV3, options?: RequestOptions) => {
    // Explicit Run-only disclosure, never aggregate execution/activity history.
    const detail = await record(scope, options)
    return { scope: scopeForBoardRun(detail.run), result: detail.run.result,
      executionState: detail.run.executionState, outcome: detail.run.outcome, stopCause: detail.run.stopCause }
  }
  return { authorize, capabilities, status, executions, execution, version, approvals, approval, respond, record, runResult }
}
export const runActionsClient = createRunActionsClient()

/** Explicit user preflight, not a polling pipeline. Read the exact old Run input
 * from the bounded Run-only route, independently of execution-history size.
 * No local draft is read, saved, discarded, retagged or supplied as a Start pin. */
export async function prepareNewFullRun(scope: RepeatGraphScopeV3, commandId: string, options?: RequestOptions) {
  const workflowPath = `/api/management/workspaces/${part(scope.workspaceId)}/workflows/${part(scope.workflowId)}`
  const [detail, pinned, workflow, workspace, capabilities] = await Promise.all([
    runActionsClient.record(scope, options),
    runActionsClient.version(scope, options),
    apiClient.request(workflowPath, CurrentManagedWorkflowSchema, options),
    apiClient.request(`/api/management/workspaces/${part(scope.workspaceId)}`, ManagedWorkspaceSchema, options),
    runActionsClient.capabilities(options),
    // A grant limited to an existing Run does NOT grant creation of another Run.
    runActionsClient.authorize('runs:start', { workspaceId: scope.workspaceId, workflowId: scope.workflowId }, options),
  ])
  assertActionScope(scopeForBoardRun(detail.run), scope)
  CurrentRunVersionSnapshotSchema.parse({ run: detail.run, version: pinned.version })
  if (detail.run.executionState !== 'completed' || !['failed', 'canceled'].includes(detail.run.outcome)
    || detail.cleanupPending !== false) throw conflict('A new full Run requires a failed or canceled Run with confirmed cleanup settlement.')
  if (workflow.workflow.id !== scope.workflowId || workflow.workflow.workspaceId !== scope.workspaceId
    || workspace.workspace.id !== scope.workspaceId) throw invalid('Fresh Start pins belong to a different workspace or workflow.')
  if (workflow.currentVersionId !== scope.workflowVersionId) {
    throw conflict('Retrying this older saved version is unavailable: normal Start accepts only the current saved version. The current version will not be substituted.')
  }
  if (!capabilities.runtimeAdmission) throw conflict('Native Start is unavailable on this deployment.')
  if (workflow.archivedAt || workspace.archivedAt || workspace.locationValidation.status !== 'ready' || !workspace.executionLocation) {
    throw conflict('The workspace, workflow or current execution folder is unavailable.')
  }
  if (!sameExecutableWorkflow(pinned.version.definition, { ...workflow.workflow,
    name: pinned.version.definition.name, description: pinned.version.definition.description })) {
    throw conflict('The saved executable definition changed. No replacement definition will be started.')
  }
  const request: BoardStartInput = RunStartV3InputSchema.parse({ workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: 3, commandId,
    expectedWorkflowRevision: workflow.revision, expectedAgentConfigurationVersionIds: pinned.version.agentConfigurationVersionIds,
    expectedLocationRevision: workspace.locationRevision, input: detail.run.input })
  return { request, location: workspace.executionLocation }
}
