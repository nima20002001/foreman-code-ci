import { describe, expect, it } from 'vitest'
import {
  BugReportCloseInputSchema,
  BugReportCreateInputSchema,
  BugReportCreateResultSchema,
  BugReportListInputSchema,
  BugReportSchema,
  BugReportUpdateInputSchema,
  type BugReportCreateInput,
} from '../src/management/bugReports.js'

const input = {
  commandId: 'report-command',
  title: 'Context request failed',
  tried: { feature: 'context_get', inputsSummary: 'Read the current workflow context.' },
  happened: { errorCode: 'CONTEXT_UNAVAILABLE', message: 'The saved context was unavailable.' },
  expected: 'Return the workflow context.',
  severity: 'high',
} as const

describe('bug report contracts', () => {
  it('accepts a repeat summary containing only the report id, status and title', () => {
    const result = {
      report: { id: 'bug-report-one', status: 'open', title: input.title },
      deduplicated: true, outcome: 'repeat', message: 'Already filed.', replayed: false,
    }
    expect(BugReportCreateResultSchema.parse(result)).toEqual(result)
    expect(BugReportCreateResultSchema.safeParse({
      ...result, report: { ...result.report, tried: input.tried },
    }).success).toBe(false)
  })

  it('accepts reports without caller-selected scope and rejects forged reporter metadata', () => {
    expect(BugReportCreateInputSchema.parse(input)).toEqual(input)
    expect(BugReportCreateInputSchema.safeParse({ ...input, reporter: { name: 'Someone else' } }).success).toBe(false)
    expect(BugReportCreateInputSchema.safeParse({ ...input, harness: 'codex' }).success).toBe(false)
    expect(BugReportCreateInputSchema.safeParse({ ...input, severity: 'urgent' }).success).toBe(false)
  })

  it('supports revision-checked statuses and bounded list filters', () => {
    for (const status of ['open', 'triaged']) {
      expect(BugReportUpdateInputSchema.parse({
        reportId: 'bug-report-one', commandId: 'status-command', expectedRevision: 1, status,
      }).status).toBe(status)
    }
    expect(BugReportUpdateInputSchema.safeParse({
      reportId: 'bug-report-one', commandId: 'status-command', expectedRevision: 1, status: 'fixed',
    }).success).toBe(true)
    expect(BugReportUpdateInputSchema.safeParse({
      reportId: 'bug-report-one', commandId: 'status-command', expectedRevision: 1, status: 'duplicate',
    }).success).toBe(false)
    for (const status of ['fixed', 'wont-fix', 'duplicate']) {
      expect(BugReportCloseInputSchema.parse({
        commandId: 'close-command', status, reports: [{ reportId: 'bug-report-one', expectedRevision: 1 }],
      }).status).toBe(status)
    }
    expect(BugReportCloseInputSchema.safeParse({ commandId: 'close-command', status: 'fixed', reports: [] }).success)
      .toBe(false)
    expect(BugReportListInputSchema.safeParse({ view: 'archived' }).success).toBe(false)
    expect(BugReportListInputSchema.parse({ status: 'open', severity: 'critical' }).limit).toBe(30)
    expect(BugReportListInputSchema.safeParse({ limit: 101 }).success).toBe(false)
    expect(BugReportUpdateInputSchema.safeParse({
      reportId: 'bug-report-one', commandId: 'status-command', expectedRevision: 0, status: 'fixed',
    }).success).toBe(false)
  })

  it('returns persisted server metadata for local human reporters', () => {
    const content: Partial<BugReportCreateInput> = { ...input }
    delete content.commandId
    expect(BugReportSchema.parse({
      ...content,
      id: 'bug-report-one',
      workspaceId: 'workspace-one',
      status: 'open',
      revision: 1,
      reporter: { principalId: 'principal-local-human', name: 'Local human', audience: 'user' },
      harness: null,
      createdAt: '2026-10-10T12:00:00.000Z',
      updatedAt: '2026-10-10T12:00:00.000Z',
      lastReportedAt: '2026-10-10T12:00:00.000Z',
      occurrenceCount: 1,
    }).reporter.audience).toBe('user')
  })
})
