import { z } from 'zod'
import {
  ScheduleDisableInputSchema, ScheduleSaveResultSchema,
} from '@foreman-code/contracts/schedules'

export {
  MAX_OCCURRENCE_PAGE_SIZE, ScheduleOccurrenceListInputSchema, ScheduleOccurrencePageSchema,
  type ScheduleOccurrenceListInput, type ScheduleOccurrencePage,
} from '@foreman-code/contracts/schedules'

/** HTTP and Operator MCP share these command schemas. */
export const ScheduleEnableInputSchema = ScheduleDisableInputSchema
export const ScheduleEnableResultSchema = ScheduleSaveResultSchema.refine((result) => result.value.enabled, {
  path: ['value', 'enabled'], message: 'Enable must return the enabled persisted schedule',
})
export const ScheduleClearInputSchema = ScheduleDisableInputSchema
export const ScheduleClearResultSchema = z.object({ value: z.null(), replayed: z.boolean() }).strict()
