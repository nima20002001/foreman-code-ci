import {
  RunDropdownListInputSchema, RunDropdownPageSchema,
  RunBoardSnapshotGetInputSchema, RunBoardSnapshotGetResultSchema,
  type RunDropdownListInput, type RunBoardSnapshotGetInput,
} from '@foreman-code/contracts/run-snapshots'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import type { RunsSelectorScope } from './types'

/** Transport spellings need SCH-05 confirmation; the frozen contract supplies shapes, not paths. */
const runsPath = ({ workspaceId, workflowId }: RunsSelectorScope) =>
  `/api/management/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/runs`
export const runSummariesPath = (scope: RunsSelectorScope) => `${runsPath(scope)}/summaries`
export const runSnapshotPath = (input: RunBoardSnapshotGetInput) =>
  `${runsPath(input)}/${encodeURIComponent(input.runId)}/snapshot`

export const runsSelectorApi = {
  async list(input: RunDropdownListInput, options?: RequestOptions) {
    const parsed = RunDropdownListInputSchema.parse(input)
    const params = new URLSearchParams({ limit: String(parsed.limit) })
    if (parsed.cursor !== undefined) params.set('cursor', parsed.cursor)
    const result = await apiClient.request(`${runSummariesPath(parsed)}?${params}`, RunDropdownPageSchema, options)
    if (result.items.length > parsed.limit) {
      throw new ApiError({ code: 'RUN_PAGE_TOO_LARGE', message: 'The Run page exceeds its requested limit.' }, 502)
    }
    return result
  },
  async snapshot(input: RunBoardSnapshotGetInput, options?: RequestOptions) {
    const parsed = RunBoardSnapshotGetInputSchema.parse(input)
    const result = await apiClient.request(runSnapshotPath(parsed), RunBoardSnapshotGetResultSchema, options)
    const { snapshot } = result
    if (snapshot.workspaceId !== parsed.workspaceId || snapshot.workflowId !== parsed.workflowId || snapshot.runId !== parsed.runId) {
      throw new ApiError({ code: 'RUN_SELECTION_MISMATCH', message: 'The response belongs to another Run.' }, 409)
    }
    return result
  },
}
