import {
  ScheduleDisableInputSchema, ScheduleDisableResultSchema, ScheduleGetInputSchema, ScheduleGetResultSchema,
  ScheduleOccurrenceListInputSchema, ScheduleOccurrencePageSchema, ScheduleSaveInputSchema, ScheduleSaveResultSchema,
  type ScheduleDisableInput, type ScheduleGetInput, type ScheduleOccurrenceListInput, type ScheduleSaveInput,
} from '@foreman-code/contracts/schedules'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'

/** Transport seam only. See README.md: SCH-02 freezes payloads, not HTTP paths. */
export function schedulePath(scope: ScheduleGetInput): string {
  return `/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/schedule`
}

function checkScope(value: ScheduleGetInput | null, scope: ScheduleGetInput): void {
  if (value && (value.workspaceId !== scope.workspaceId || value.workflowId !== scope.workflowId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The schedule belongs to a different workflow.' })
  }
}

/** The route carries workspace/workflow; bodies are strict and must not repeat them. */
function withoutScope<T extends ScheduleGetInput>(value: T): Omit<T, 'workspaceId' | 'workflowId'> {
  const { workspaceId, workflowId, ...body } = value
  void workspaceId; void workflowId
  return body
}

/** No fetch, auth, response-shape, or automatic retry logic outside the shared client. */
export const scheduleApi = {
  async get(input: ScheduleGetInput, options?: RequestOptions) {
    const scope = ScheduleGetInputSchema.parse(input)
    const result = await apiClient.request(schedulePath(scope), ScheduleGetResultSchema, options)
    checkScope(result.schedule, scope)
    return result
  },
  async occurrences(input: ScheduleOccurrenceListInput, options?: RequestOptions) {
    const value = ScheduleOccurrenceListInputSchema.parse(input)
    const query = new URLSearchParams({ limit: String(value.limit) })
    if (value.cursor) query.set('cursor', value.cursor)
    const result = await apiClient.request(`${schedulePath(value)}/occurrences?${query}`, ScheduleOccurrencePageSchema, options)
    for (const item of result.items) checkScope(item, value)
    return result
  },
  async save(input: ScheduleSaveInput, options?: RequestOptions) {
    const value = ScheduleSaveInputSchema.parse(input)
    const result = await apiClient.request(schedulePath(value), ScheduleSaveResultSchema,
      { ...options, method: 'PUT', body: withoutScope(value) })
    checkScope(result.value, value)
    return result
  },
  async disable(input: ScheduleDisableInput, options?: RequestOptions) {
    const value = ScheduleDisableInputSchema.parse(input)
    const result = await apiClient.request(`${schedulePath(value)}/disable`, ScheduleDisableResultSchema,
      { ...options, method: 'POST', body: withoutScope(value) })
    checkScope(result.value, value)
    return result
  },
}
