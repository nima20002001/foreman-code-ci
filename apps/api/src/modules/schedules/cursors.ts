import { z } from 'zod'
import { ScheduleGetInputSchema, ScheduleInstantSchema } from '@foreman-code/contracts/schedules'
import { DomainError } from '../errors.js'

export const OccurrenceCursorSchema = ScheduleGetInputSchema.extend({
  kind: z.literal('schedule-occurrences-v1'), beforeDueAt: ScheduleInstantSchema,
}).strict()
export const DueCursorSchema = z.object({
  kind: z.literal('due-schedules-v1'), throughUtc: ScheduleInstantSchema,
  nextOccurrenceAt: ScheduleInstantSchema, workflowId: ScheduleGetInputSchema.shape.workflowId,
}).strict()

export function encodeScheduleCursor(value: unknown): string {
  const cursor = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  if (cursor.length > 4096) throw new DomainError('INVALID_CURSOR', 'The schedule cursor is too large.', 400)
  return cursor
}

export function decodeScheduleCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  try {
    if (!cursor.length || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid encoding')
    const bytes = Buffer.from(cursor, 'base64url')
    if (bytes.toString('base64url') !== cursor) throw new Error('Non-canonical encoding')
    return schema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  } catch {
    throw new DomainError('INVALID_CURSOR', 'Use the cursor returned for this schedule query.', 400)
  }
}
