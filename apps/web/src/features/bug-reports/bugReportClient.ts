import {
  BugReportCloseInputSchema,
  BugReportCloseResultSchema,
  BugReportListInputSchema,
  BugReportPageSchema,
  BugReportSchema,
  BugReportUpdateInputSchema,
  BugReportUpdateResultSchema,
  type BugReportCloseInput,
  type BugReportListInput,
  type BugReportUpdateInput,
} from '@foreman-code/contracts/management'
import { apiClient, type RequestOptions } from '../../shared/api/client'

const root = '/api/management/bug-reports'

export const bugReportClient = {
  list(input: BugReportListInput, options?: RequestOptions) {
    const request = BugReportListInputSchema.parse(input)
    const query = new URLSearchParams({ limit: String(request.limit) })
    if (request.view) query.set('view', request.view)
    if (request.status) query.set('status', request.status)
    if (request.severity) query.set('severity', request.severity)
    if (request.cursor) query.set('cursor', request.cursor)
    return apiClient.request(`${root}?${query}`, BugReportPageSchema, options)
  },
  get(reportId: string, options?: RequestOptions) {
    return apiClient.request(`${root}/${encodeURIComponent(reportId)}`, BugReportSchema, options)
  },
  update(input: BugReportUpdateInput) {
    return apiClient.request(`${root}/${encodeURIComponent(input.reportId)}/status`, BugReportUpdateResultSchema, {
      method: 'POST',
      body: BugReportUpdateInputSchema.parse(input),
    })
  },
  close(input: BugReportCloseInput) {
    return apiClient.request(`${root}/close`, BugReportCloseResultSchema, {
      method: 'POST',
      body: BugReportCloseInputSchema.parse(input),
    })
  },
}
