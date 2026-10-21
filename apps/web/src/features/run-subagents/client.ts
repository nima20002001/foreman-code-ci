import { z } from 'zod'
import {
  RunSubagentsListInputSchema, RunSubagentGetInputSchema, RunSubagentItemsInputSchema,
  RunSubagentsPageSchema, RunSubagentDetailSchema, RunSubagentMessagesPageSchema,
  RunSubagentToolsPageSchema, RunSubagentInputSchema, RunSubagentInterruptSchema,
  RunSubagentCommandReceiptSchema, RunSubagentRespondSchema,
} from '@foreman-code/contracts/subagents'
import { ApiError, apiClient, type RequestOptions } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

const basePath = (input: z.input<typeof RunSubagentsListInputSchema>) =>
  `/api/management/workspaces/${encodeURIComponent(input.workspaceId)}/runs/${encodeURIComponent(input.runId)}/subagents`
const childPath = (input: z.input<typeof RunSubagentGetInputSchema>) => `${basePath(input)}/${encodeURIComponent(input.subagentId)}`
const pageSearch = (input: z.output<typeof RunSubagentsListInputSchema>) => {
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor !== undefined) params.set('cursor', input.cursor)
  return params
}
function assertOwner(input: z.input<typeof RunSubagentGetInputSchema>, value: { workspaceId: string; runId: string; id: string }) {
  if (value.workspaceId !== input.workspaceId || value.runId !== input.runId || value.id !== input.subagentId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Subagent evidence belongs to a different Run or child.' })
  }
}
async function read<T>(path: string, schema: z.ZodType<T>, options?: RequestOptions & { method?: string; body?: unknown }): Promise<T> {
  const generation = sessionGeneration()
  const result = await apiClient.request(path, schema, options)
  assertSession(generation)
  return result
}
export const subagentsApi = {
  async list(input: z.input<typeof RunSubagentsListInputSchema>, options?: RequestOptions) {
    const parsed = RunSubagentsListInputSchema.parse(input)
    const page = await read(`${basePath(parsed)}?${pageSearch(parsed)}`, RunSubagentsPageSchema, options)
    for (const { subagent } of page.items) assertOwner({ ...parsed, subagentId: subagent.id }, subagent)
    return page
  },
  async detail(input: z.input<typeof RunSubagentGetInputSchema>, options?: RequestOptions) {
    const parsed = RunSubagentGetInputSchema.parse(input)
    const detail = await read(childPath(parsed), RunSubagentDetailSchema, options)
    assertOwner(parsed, detail.subagent)
    return detail
  },
  async messages(input: z.input<typeof RunSubagentItemsInputSchema>, options?: RequestOptions) {
    const parsed = RunSubagentItemsInputSchema.parse(input)
    const page = await read(`${childPath(parsed)}/messages?${pageSearch(parsed)}`, RunSubagentMessagesPageSchema, options)
    if (page.items.some((item) => item.subagentId !== parsed.subagentId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Messages belong to a different subagent.' })
    return page
  },
  async tools(input: z.input<typeof RunSubagentItemsInputSchema>, options?: RequestOptions) {
    const parsed = RunSubagentItemsInputSchema.parse(input)
    const page = await read(`${childPath(parsed)}/tools?${pageSearch(parsed)}`, RunSubagentToolsPageSchema, options)
    if (page.items.some((item) => item.subagentId !== parsed.subagentId)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Tools belong to a different subagent.' })
    return page
  },
  async input(input: z.input<typeof RunSubagentInputSchema>, options?: RequestOptions) {
    const parsed = RunSubagentInputSchema.parse(input)
    const receipt = await read(`${childPath(parsed)}/input`, RunSubagentCommandReceiptSchema, { ...options, method: 'POST', body: parsed })
    assertReceipt(parsed, receipt, 'run_subagent_input_v1')
    return receipt
  },
  async interrupt(input: z.input<typeof RunSubagentInterruptSchema>, options?: RequestOptions) {
    const parsed = RunSubagentInterruptSchema.parse(input)
    const receipt = await read(`${childPath(parsed)}/interrupt`, RunSubagentCommandReceiptSchema, { ...options, method: 'POST', body: parsed })
    assertReceipt(parsed, receipt, 'run_subagent_interrupt_v1')
    return receipt
  },
  async respond(input: z.input<typeof RunSubagentRespondSchema>, options?: RequestOptions) {
    const parsed = RunSubagentRespondSchema.parse(input)
    const receipt = await read(`${childPath(parsed)}/responses`, RunSubagentCommandReceiptSchema,
      { ...options, method: 'POST', body: parsed })
    assertReceipt(parsed, receipt, 'run_subagent_respond_v1')
    return receipt
  },
}
function assertReceipt(input: z.input<typeof RunSubagentInterruptSchema>, receipt: z.output<typeof RunSubagentCommandReceiptSchema>, operation: z.output<typeof RunSubagentCommandReceiptSchema>['operation']) {
  assertOwner(input, { ...receipt, id: receipt.subagentId })
  if (receipt.commandId !== input.commandId || receipt.expectedRevision !== input.expectedRevision || receipt.operation !== operation) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The receipt belongs to a different subagent command.' })
  }
}
