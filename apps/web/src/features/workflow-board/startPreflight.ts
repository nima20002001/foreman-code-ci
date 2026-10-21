import { useQuery } from '@tanstack/react-query'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { CurrentManagedWorkflowSchema, CurrentWorkflowCapabilitiesSchema, CurrentWorkflowVersionDetailSchema,
  CURRENT_WORKFLOW_ROUTES, RunStartV3InputSchema, sameExecutableWorkflow, sameWorkflowValue,
  workflowRequiresWorkspaceDirectory,
  type GraphDraftV3, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../shared/api/client'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
const part = encodeURIComponent
const mismatch = (message: string) => new ApiError({ code: 'START_PREFLIGHT_CONFLICT', message }, 409)

/** Generic saved V3 reads, irrespective of optional repeat. These are not native admission authority. */
export function createBoardPreflightClient(client: ApiClient = apiClient) {
  return async (displayed: GraphDraftV3, options?: RequestOptions) => {
    const { workspaceId, workflowId } = displayed
    const workflowPath = `/api/management/workspaces/${part(workspaceId)}/workflows/${part(workflowId)}`
    // The Board draft is local; Start pins come only from saved server reads.
    const [workflow, workspace, capabilities] = await Promise.all([
      client.request(workflowPath, CurrentManagedWorkflowSchema, options),
      client.request(`/api/management/workspaces/${part(workspaceId)}`, ManagedWorkspaceSchema, options),
      client.request(CURRENT_WORKFLOW_ROUTES.capabilities, CurrentWorkflowCapabilitiesSchema, options),
    ])
    if (workflow.workflow.id !== workflowId || workflow.workflow.workspaceId !== workspaceId || workspace.workspace.id !== workspaceId) {
      throw mismatch('Saved Start readback belongs to a different scope.')
    }
    const detail = workflow.currentVersionId ? await client.request(
      `${workflowPath}/versions/${part(workflow.currentVersionId)}`, CurrentWorkflowVersionDetailSchema, options) : undefined
    const version = detail?.version
    if (version && (version.id !== workflow.currentVersionId || version.workspaceId !== workspaceId || version.workflowId !== workflowId)) {
      throw mismatch('Immutable workflow readback returned a different saved version.')
    }
    return { workflow, workspace, capabilities, version }
  }
}
export const readBoardStartPreflight = createBoardPreflightClient()
export type BoardStartPreflight = Awaited<ReturnType<typeof readBoardStartPreflight>>
export type BoardStartPins = Pick<RunStartV3Input, 'workflowVersionId' | 'expectedWorkflowRevision' |
  'expectedAgentConfigurationVersionIds' | 'expectedLocationRevision'>

export function boardStartPins(displayed: GraphDraftV3, facts: BoardStartPreflight): BoardStartPins {
  const { workflow, workspace, capabilities, version } = facts
  if (!capabilities.runtimeAdmission || !capabilities.persistedReadback) {
    throw new Error(`Current workflow Start is unavailable on this deployment${capabilities.reasons.length ? `: ${capabilities.reasons.join(', ')}` : '.'}`)
  }
  if (!version || !displayed.baseWorkflowVersionId) throw new Error('Save the workflow before starting a Run.')
  const folderUnavailable = workflowRequiresWorkspaceDirectory(version.definition)
    && workspace.locationValidation.status !== 'ready'
  const locationUnavailable = !workspace.executionLocation || workspace.locationValidation.status === 'restricted'
  if (workflow.archivedAt || workspace.archivedAt || locationUnavailable || folderUnavailable) {
    throw new Error('The workspace, workflow or execution folder is unavailable.')
  }
  const publishedGraph = { ...version.definition,
    name: workflow.workflow.name, description: workflow.workflow.description }
  if (displayed.publishedRevision !== displayed.revision || displayed.revision !== workflow.revision
    || version.id !== displayed.baseWorkflowVersionId || version.id !== workflow.currentVersionId
    || !sameExecutableWorkflow(publishedGraph, displayed.graph)) {
    throw mismatch('The displayed draft is not the exact published workflow. Save or explicitly reload before Start.')
  }
  // Metadata labels may have changed since the immutable version. They do not
  // replace executable fields, and the displayed workflow revision remains pinned.
  if (!sameExecutableWorkflow(version.definition, { ...workflow.workflow, name: version.definition.name, description: version.definition.description })) {
    throw mismatch('Saved executable meaning changed. Reload before Start.')
  }
  return { workflowVersionId: version.id, expectedWorkflowRevision: workflow.revision,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: workspace.locationRevision }
}
export function sameBoardStartPins(a: BoardStartPins, b: BoardStartPins) { return sameWorkflowValue(a, b) }
export function currentBoardStartRequest(displayed: GraphDraftV3, facts: BoardStartPreflight, commandId: string): RunStartV3Input {
  return RunStartV3InputSchema.parse({ executionSemanticsVersion: 3, workspaceId: displayed.workspaceId,
    workflowId: displayed.workflowId, ...boardStartPins(displayed, facts), commandId, input: {} })
}
export function useBoardStartPreflight(draft: GraphDraftV3, options: { enabled: boolean } = { enabled: true }) {
  return useQuery({ queryKey: ['workbench', 'board-start-preflight', sessionGeneration(), draft.workspaceId, draft.workflowId,
    draft.id, draft.revision, draft.baseWorkflowVersionId],
    queryFn: ({ signal }) => readBoardStartPreflight(draft, { signal }), enabled: options.enabled,
    retry: false, staleTime: 1000,
    refetchOnReconnect: 'always', refetchOnWindowFocus: true,
    refetchInterval: (state) => !options.enabled
      || ApiError.is(state.state.error) && [401, 403, 404].includes(state.state.error.status ?? 0) ? false : 3000,
  })
}
