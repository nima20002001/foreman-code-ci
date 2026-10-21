import { RepeatRunReadInputSchema, RepeatRunReadbackSchema, type RepeatRunReadInput, type RepeatRunReadback } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient, type RequestOptions } from '../../shared/api/client'
export function createRepeatClient(client: ApiClient = apiClient) {
  return { async run(raw: RepeatRunReadInput, options?: RequestOptions): Promise<RepeatRunReadback> {
    const input = RepeatRunReadInputSchema.parse(raw), part = encodeURIComponent
    const query = new URLSearchParams({ limit: String(input.limit), includeResultData: String(input.includeResultData) })
    if (input.cursor) query.set('cursor', input.cursor)
    const value = await client.request(`/api/management/workspaces/${part(input.workspaceId)}/workflows/${part(input.workflowId)}/runs/${part(input.runId)}/repeats?${query}`,
      RepeatRunReadbackSchema, options)
    if (value.workspaceId !== input.workspaceId || value.workflowId !== input.workflowId || value.runId !== input.runId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Occurrence detail returned a different Run scope.' })
    return value
  } }
}
export type RepeatClient = ReturnType<typeof createRepeatClient>
export const repeatClient = createRepeatClient()
