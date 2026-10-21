import {
  BugReportActiveStatusSchema,
  BugReportClosedStatusSchema,
  BugReportSchema,
  type BugReport,
  type BugReportPage,
  type BugReportListInput,
} from '@foreman-code/contracts/management'
import { IdSchema, TimestampSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

const CursorSchema = z.object({ createdAt: TimestampSchema, id: IdSchema }).strict()

export async function readBugReport(sql: GraphSqlClient, id: string, lock?: 'update'): Promise<BugReport> {
  const row = (await sql.query<{ record: unknown }>(
    `select record from bug_reports where id=$1${lock === 'update' ? ' for update' : ''}`, [id],
  )).rows[0]
  if (!row) throw new DomainError('BUG_REPORT_NOT_FOUND', 'The bug report was not found.', 404)
  return BugReportSchema.parse(row.record)
}

export async function saveBugReport(sql: GraphSqlClient, report: BugReport): Promise<void> {
  await sql.query(
    'update bug_reports set record=$2::jsonb,status=$3,revision=$4 where id=$1',
    [report.id, JSON.stringify(report), report.status, report.revision],
  )
}

export type BugReportOutcome = 'created' | 'repeat' | 'reopened'

/** The repeat key: a report's title, ignoring case and whitespace. */
export function bugReportTitleKey(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

async function lockBugReport(sql: GraphSqlClient, where: string, parameters: unknown[]): Promise<BugReport | undefined> {
  const row = (await sql.query<{ record: unknown }>(
    `select record from bug_reports where ${where} for update`, parameters,
  )).rows[0]
  return row ? BugReportSchema.parse(row.record) : undefined
}

/**
 * Count a repeat on the workspace report with the same title, preferring an active one and following a
 * duplicate to the report it names. A repeat of a fixed report reopens it. Otherwise insert the new report.
 */
export async function recordBugReport(
  sql: GraphSqlClient,
  report: BugReport,
): Promise<{ report: BugReport; outcome: BugReportOutcome }> {
  const titleKey = bugReportTitleKey(report.title)
  await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`bug-report:${report.workspaceId}:${titleKey}`])
  let previous = await lockBugReport(sql,
    `workspace_id=$1 and title_key=$2
     order by status in ('open','triaged') desc, created_at desc, id desc limit 1`,
    [report.workspaceId, titleKey])
  const seen = new Set<string>()
  while (previous?.status === 'duplicate' && previous.resolution?.duplicateOfId && !seen.has(previous.id)) {
    seen.add(previous.id)
    previous = await lockBugReport(sql, 'id=$1', [previous.resolution.duplicateOfId]) ?? previous
  }
  if (previous) {
    const reopened = previous.status === 'fixed'
    const updated: BugReport = {
      ...previous,
      ...(reopened ? { status: 'open' as const } : {}),
      occurrenceCount: previous.occurrenceCount + 1,
      lastReportedAt: report.lastReportedAt,
      updatedAt: report.updatedAt,
      revision: previous.revision + 1,
    }
    await saveBugReport(sql, updated)
    return { report: updated, outcome: reopened ? 'reopened' : 'repeat' }
  }
  await sql.query(
    `insert into bug_reports(id,workspace_id,workflow_id,run_id,title_key,status,severity,revision,record,created_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [report.id, report.workspaceId, report.workflowId ?? null, report.runId ?? null, titleKey,
      report.status, report.severity, report.revision, JSON.stringify(report), report.createdAt],
  )
  return { report, outcome: 'created' }
}

export async function listBugReports(
  sql: GraphSqlClient,
  input: BugReportListInput,
  grantFilter: string,
  parameters: unknown[],
): Promise<BugReportPage> {
  const conditions = [`(${grantFilter})`]
  if (input.view || !input.status) {
    parameters.push(input.view === 'history' ? BugReportClosedStatusSchema.options : BugReportActiveStatusSchema.options)
    conditions.push(`status=any($${parameters.length}::text[])`)
  }
  for (const [field, column] of Object.entries({ workspaceId: 'workspace_id', status: 'status', severity: 'severity' })) {
    const value = input[field as 'workspaceId' | 'status' | 'severity']
    if (value) {
      parameters.push(value)
      conditions.push(`${column}=$${parameters.length}`)
    }
  }
  if (input.cursor) {
    let cursor: z.infer<typeof CursorSchema>
    try {
      cursor = CursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')))
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) {
        throw new DomainError('INVALID_CURSOR', 'The bug report cursor is invalid.', 400, undefined, { cause: error })
      }
      throw error
    }
    parameters.push(cursor.createdAt, cursor.id)
    conditions.push(`(created_at,id)<($${parameters.length - 1}::timestamptz,$${parameters.length})`)
  }
  const limit = input.limit ?? 30
  parameters.push(limit + 1)
  const rows = (await sql.query<{ record: unknown }>(
    `select record from bug_reports where ${conditions.join(' and ')}
     order by created_at desc,id desc limit $${parameters.length}`, parameters,
  )).rows
  const items = rows.slice(0, limit).map(row => BugReportSchema.parse(row.record))
  const last = items.at(-1)
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString('base64url')
    : null
  return { items, pageInfo: { nextCursor } }
}
