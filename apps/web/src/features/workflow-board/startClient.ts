import { WorkflowRunV3Schema, RunStartV3InputSchema, RunStartV3ResultSchema, RunStartResolutionResultSchema,
  sameWorkflowValue, type RunStartV3Input, type WorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient } from '../../shared/api/client'

export type BoardStartInput = RunStartV3Input
/** No negotiation, missing-tag default, retired-tag fallback or repeat projection. */
export function parseBoardStart(value: unknown): BoardStartInput { return RunStartV3InputSchema.parse(value) }
function checkAcceptedRun(run: WorkflowRunV3, input: BoardStartInput): void {
  if (!WorkflowRunV3Schema.safeParse(run).success || !run.executionLocation) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The admitted Run is missing accepted configuration or location pins. Reconcile the same command.' })
  }
  if (run.workspaceId !== input.workspaceId || run.workflowId !== input.workflowId
    || run.workflowVersionId !== input.workflowVersionId || run.executionSemanticsVersion !== 3
    || !sameWorkflowValue(run.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
    || !sameWorkflowValue(run.input, input.input)
    || run.executionLocation.locationRevision !== input.expectedLocationRevision) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The admitted Run did not match the retained Start pins. Reconcile the same command.' })
  }
}
export function createBoardStartClient(client: ApiClient = apiClient) {
  return {
    async start(raw: BoardStartInput) {
      const input = parseBoardStart(raw)
      const result = await client.request(
        `/api/management/workspaces/${encodeURIComponent(input.workspaceId)}/workflows/${encodeURIComponent(input.workflowId)}/runs`,
        RunStartV3ResultSchema, { method: 'POST', body: input })
      checkAcceptedRun(result.run, input)
      return result
    },
    async resolve(raw: BoardStartInput) {
      const input = parseBoardStart(raw)
      const result = await client.request(
        `/api/management/workspaces/${encodeURIComponent(input.workspaceId)}/workflows/${encodeURIComponent(input.workflowId)}/runs/start-resolution`,
        RunStartResolutionResultSchema, { method: 'POST', body: input })
      if (result.status === 'accepted') checkAcceptedRun(result.run, input)
      return result
    },
  }
}
export const boardStartClient = createBoardStartClient()
