import { optionalCommandId } from './commands.js'
import { z } from 'zod'
import { IdSchema, TimestampSchema } from '../schemaPrimitives.js'

export const BugReportStatusSchema = z.enum(['open', 'triaged', 'fixed', 'wont-fix', 'duplicate'])
/** Active reports need attention; closed reports are archived history. */
export const BugReportActiveStatusSchema = z.enum(['open', 'triaged'])
export const BugReportClosedStatusSchema = z.enum(['fixed', 'wont-fix', 'duplicate'])
export const BugReportViewSchema = z.enum(['active', 'history'])
export const BugReportSeveritySchema = z.enum(['low', 'medium', 'high', 'critical'])
const CommandId = z.string().trim().min(8).max(200)
const Text = z.string().trim().min(1).max(12000)

export const BugReportCreateInputSchema = z.object({
  commandId: optionalCommandId(CommandId),
  workspaceId: IdSchema.optional(),
  title: z.string().trim().min(1).max(300),
  tried: z.object({ feature: z.string().trim().min(1).max(300), inputsSummary: Text }).strict(),
  happened: z.object({ errorCode: z.string().trim().max(300).optional(), message: Text }).strict(),
  expected: Text,
  severity: BugReportSeveritySchema,
  runId: IdSchema.optional(),
  workflowId: IdSchema.optional(),
}).strict()

export const BugReportSchema = BugReportCreateInputSchema.omit({ commandId: true, workspaceId: true }).extend({
  id: IdSchema,
  workspaceId: IdSchema,
  status: BugReportStatusSchema,
  revision: z.number().int().positive(),
  reporter: z.object({
    principalId: IdSchema,
    name: z.string(),
    audience: z.enum(['operator', 'worker', 'user']),
    agentId: IdSchema.optional(),
  }).strict(),
  harness: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastReportedAt: TimestampSchema,
  occurrenceCount: z.number().int().positive(),
  /** The latest close. A reopened report keeps it so a regression shows what was fixed before. */
  resolution: z.object({
    status: BugReportClosedStatusSchema,
    note: z.string().max(1000).optional(),
    duplicateOfId: IdSchema.optional(),
    closedAt: TimestampSchema,
  }).strict().optional(),
}).strict()

export const BugReportListInputSchema = z.object({
  workspaceId: IdSchema.optional(),
  view: BugReportViewSchema.optional(),
  status: BugReportStatusSchema.optional(),
  severity: BugReportSeveritySchema.optional(),
  cursor: z.string().max(1000).optional(),
  limit: z.number().int().min(1).max(100).default(30),
}).strict()
export const BugReportPageSchema = z.object({
  items: z.array(BugReportSchema),
  pageInfo: z.object({ nextCursor: z.string().nullable() }).strict(),
}).strict()
export const BugReportGetInputSchema = z.object({ reportId: IdSchema }).strict()
export const BugReportUpdateInputSchema = BugReportGetInputSchema.extend({
  commandId: optionalCommandId(CommandId),
  expectedRevision: z.number().int().positive(),
  /** Closed statuses can only replay a command saved before batch closing was introduced. */
  status: BugReportActiveStatusSchema.or(BugReportClosedStatusSchema.exclude(['duplicate'])),
}).strict()
export const BugReportCloseInputSchema = z.object({
  commandId: optionalCommandId(CommandId),
  reports: z.array(z.object({
    reportId: IdSchema,
    expectedRevision: z.number().int().positive(),
  }).strict()).min(1).max(100),
  status: BugReportClosedStatusSchema,
  duplicateOfId: IdSchema.optional(),
  note: z.string().trim().min(1).max(1000).optional(),
}).strict()
export const BugReportCreateResultSchema = z.object({
  /** Reports owned by another caller expose only their summary. */
  report: BugReportSchema.or(BugReportSchema.pick({ id: true, status: true, title: true })),
  deduplicated: z.boolean(),
  /** created: a new report; repeat: counted on an existing report; reopened: a fixed report came back. */
  outcome: z.enum(['created', 'repeat', 'reopened']),
  message: z.string(),
  replayed: z.boolean(),
}).strict()
export const BugReportUpdateResultSchema = z.object({ report: BugReportSchema, replayed: z.boolean() }).strict()
export const BugReportCloseResultSchema = z.object({ reports: z.array(BugReportSchema), replayed: z.boolean() }).strict()

export type BugReport = z.infer<typeof BugReportSchema>
export type BugReportStatus = z.infer<typeof BugReportStatusSchema>
export type BugReportClosedStatus = z.infer<typeof BugReportClosedStatusSchema>
export type BugReportSeverity = z.infer<typeof BugReportSeveritySchema>
export type BugReportCreateInput = z.infer<typeof BugReportCreateInputSchema>
export type BugReportListInput = z.input<typeof BugReportListInputSchema>
export type BugReportPage = z.infer<typeof BugReportPageSchema>
export type BugReportUpdateInput = z.infer<typeof BugReportUpdateInputSchema>
export type BugReportCreateResult = z.infer<typeof BugReportCreateResultSchema>
export type BugReportUpdateResult = z.infer<typeof BugReportUpdateResultSchema>
export type BugReportCloseInput = z.infer<typeof BugReportCloseInputSchema>
export type BugReportCloseResult = z.infer<typeof BugReportCloseResultSchema>

export const BugsSettingsSearchSchema = z.object({
  view: BugReportViewSchema.optional(),
  status: BugReportStatusSchema.optional(),
  severity: BugReportSeveritySchema.optional(),
  reportId: IdSchema.optional(),
}).strict()
export type BugsSettingsSearch = z.infer<typeof BugsSettingsSearchSchema>
