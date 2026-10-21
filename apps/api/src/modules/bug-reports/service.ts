import {
  BugReportCloseInputSchema,
  BugReportActiveStatusSchema,
  BugReportCreateInputSchema,
  BugReportListInputSchema,
  BugReportSchema,
  BugReportUpdateInputSchema,
  type BugReport,
  type BugReportCloseInput,
  type BugReportCloseResult,
  type BugReportCreateInput,
  type BugReportCreateResult,
  type BugReportListInput,
  type BugReportUpdateInput,
  type BugReportUpdateResult,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { requireAuthorization, type AuthorizedResource } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { liveBugReportPrincipal, readGrantFilter, reportingContext, type ReportContext } from './authorization.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import {
  listBugReports, readBugReport, recordBugReport, saveBugReport, type BugReportOutcome,
} from './repository.js'
import { redactBugReportText } from './redaction.js'
import { replayCloseReceipt, replayReportReceipt } from './receipts.js'
import { detectStuckExecutions } from './stuckExecutions.js'

type CommandSource = 'http' | 'mcp'

function safeReportInput(input: BugReportCreateInput): BugReportCreateInput {
  return {
    ...input,
    commandId: commandInputHash(input.commandId),
    title: redactBugReportText(input.title),
    tried: {
      feature: redactBugReportText(input.tried.feature),
      inputsSummary: redactBugReportText(input.tried.inputsSummary),
    },
    happened: {
      message: redactBugReportText(input.happened.message),
      ...(input.happened.errorCode === undefined ? {} : { errorCode: redactBugReportText(input.happened.errorCode) }),
    },
    expected: redactBugReportText(input.expected),
  }
}

function reportMessage(report: BugReport, outcome: BugReportOutcome): string {
  if (outcome === 'created') return `Filed as ${report.id}.`
  if (outcome === 'reopened') {
    return `Already filed as ${report.id} and closed as fixed; this repeat reopened it as a regression.`
  }
  const state = report.status === 'open' || report.status === 'triaged' ? `is ${report.status}` : `was closed as ${report.status}`
  return `Already filed as ${report.id}, which ${state}. Counted as occurrence ${report.occurrenceCount}; `
    + 'no new report was created.'
}

function reportScope(report: BugReport): AuthorizedResource {
  return {
    workspaceId: report.workspaceId,
    ...(report.workflowId === undefined ? {} : { workflowId: report.workflowId }),
    ...(report.runId === undefined ? {} : { runId: report.runId }),
  }
}

function reportForCaller(
  report: BugReportCreateResult['report'],
  principalId: string,
): BugReportCreateResult['report'] {
  if ('reporter' in report && report.reporter.principalId === principalId) return report
  return { id: report.id, status: report.status, title: report.title }
}

export class BugReportService {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator) {}

  detectStuckExecutions(idleMs: number, now = new Date()): Promise<number> {
    return detectStuckExecutions(this.pool, idleMs, now)
  }

  async report(
    principal: ManagementPrincipal,
    source: CommandSource,
    raw: BugReportCreateInput,
  ): Promise<BugReportCreateResult> {
    const accepted = BugReportCreateInputSchema.parse(raw)
    let current = await this.liveCaller(principal, source, 'bug_reports.report')
    let context: ReportContext
    try {
      context = await reportingContext(this.pool, current, source, accepted)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'bug_reports.report', 'bug-reports')
      }
      throw error
    }
    const input = safeReportInput({
      ...accepted,
      workspaceId: context.workspaceId,
      ...(context.workflowId ? { workflowId: context.workflowId } : {}),
      ...(context.runId ? { runId: context.runId } : {}),
    })
    const result = await this.commands.execute({
      principal: current,
      source,
      operation: 'bug_reports.report',
      commandId: input.commandId,
      targetKey: `bug-reports:${context.workspaceId}`,
      payload: { input, originalInputHash: commandInputHash(accepted) },
      replayResult: value => replayReportReceipt(value, reportMessage),
      authorize: async sql => {
        current = await liveBugReportPrincipal(sql, principal)
        context = await reportingContext(sql, current, source, input)
      },
      perform: async sql => {
        const now = new Date().toISOString()
        const content: Partial<BugReportCreateInput> = { ...input }
        delete content.commandId
        const report = BugReportSchema.parse({
          ...content,
          ...context,
          id: `bug-report-${randomUUID()}`,
          status: 'open',
          revision: 1,
          createdAt: now,
          updatedAt: now,
          lastReportedAt: now,
          occurrenceCount: 1,
        })
        const recorded = await recordBugReport(sql, report)
        return {
          report: reportForCaller(recorded.report, current.id),
          deduplicated: recorded.outcome !== 'created',
          outcome: recorded.outcome,
          message: reportMessage(recorded.report, recorded.outcome),
        }
      },
    })
    return {
      ...result.value,
      report: reportForCaller(result.value.report, current.id),
      replayed: result.replayed,
    }
  }

  async list(principal: ManagementPrincipal, raw: BugReportListInput) {
    const input = BugReportListInputSchema.parse(raw)
    const current = await liveBugReportPrincipal(this.pool, principal)
    const parameters: unknown[] = []
    const filter = readGrantFilter(current, parameters)
    return listBugReports(this.pool, input, filter, parameters)
  }

  async get(principal: ManagementPrincipal, reportId: string) {
    const current = await liveBugReportPrincipal(this.pool, principal)
    if (current.audience !== 'operator') throw new DomainError('ACCESS_DENIED', 'Agents can only submit bug reports.', 403)
    const report = await readBugReport(this.pool, reportId)
    requireAuthorization(current, 'bug_reports:read', reportScope(report))
    return report
  }

  async update(
    principal: ManagementPrincipal,
    source: CommandSource,
    raw: BugReportUpdateInput,
  ): Promise<BugReportUpdateResult> {
    const accepted = BugReportUpdateInputSchema.parse(raw)
    const current = await this.liveCaller(principal, source, 'bug_reports.update')
    if (current.audience !== 'operator') {
      await this.commands.recordDenied(principal.id, source, 'bug_reports.update', 'bug-reports')
      throw new DomainError('ACCESS_DENIED', 'Agents can only submit bug reports.', 403)
    }
    const report = await readBugReport(this.pool, accepted.reportId)
    try {
      requireAuthorization(current, 'bug_reports:update', reportScope(report))
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'bug_reports.update', report.id)
      }
      throw error
    }
    const input = { ...accepted, commandId: commandInputHash(accepted.commandId) }
    const result = await this.commands.execute({
      principal: current,
      source,
      operation: 'bug_reports.update',
      commandId: input.commandId,
      targetKey: report.id,
      payload: input,
      authorize: async sql => {
        const live = await liveBugReportPrincipal(sql, principal)
        const saved = await readBugReport(sql, report.id, 'update')
        requireAuthorization(live, 'bug_reports:update', reportScope(saved))
      },
      perform: async sql => {
        if (!BugReportActiveStatusSchema.safeParse(input.status).success) {
          throw new DomainError('INVALID_INPUT',
            'Close reports with bug_reports_close; closed-status updates only replay saved commands.', 400)
        }
        const previous = await readBugReport(sql, report.id, 'update')
        if (previous.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The bug report changed. Read it again before updating its status.', 409)
        }
        const updated = {
          ...previous,
          status: input.status,
          revision: previous.revision + 1,
          updatedAt: new Date().toISOString(),
        }
        await saveBugReport(sql, updated)
        return updated
      },
    })
    return { report: result.value, replayed: result.replayed }
  }

  async close(
    principal: ManagementPrincipal,
    source: CommandSource,
    raw: BugReportCloseInput,
  ): Promise<BugReportCloseResult> {
    const accepted = BugReportCloseInputSchema.parse(raw)
    const ids = accepted.reports.map(item => item.reportId)
    if (new Set(ids).size !== ids.length) throw new DomainError('INVALID_INPUT', 'List each bug report once.', 400)
    if ((accepted.status === 'duplicate') !== (accepted.duplicateOfId !== undefined)) {
      throw new DomainError('INVALID_INPUT', 'Name duplicateOfId exactly when closing reports as duplicate.', 400)
    }
    if (accepted.duplicateOfId && ids.includes(accepted.duplicateOfId)) {
      throw new DomainError('INVALID_INPUT', 'A report cannot be a duplicate of a report closed in the same call.', 400)
    }
    const current = await this.liveCaller(principal, source, 'bug_reports.close')
    try {
      await authorizeClose(this.pool, current, accepted)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'bug_reports.close', 'bug-reports')
        error.denialAudited = true
      }
      throw error
    }
    const input = {
      ...accepted,
      commandId: commandInputHash(accepted.commandId),
      ...(accepted.note === undefined ? {} : { note: redactBugReportText(accepted.note) }),
    }
    const originalInputHash = commandInputHash(accepted)
    const result = await this.commands.execute({
      principal: current,
      source,
      operation: 'bug_reports.close',
      commandId: input.commandId,
      targetKey: `bug-reports:close:${commandInputHash([...ids].sort())}`,
      payload: input,
      replayResult: value => replayCloseReceipt(value, originalInputHash),
      authorize: async sql => {
        const live = await liveBugReportPrincipal(sql, principal)
        if (input.duplicateOfId) {
          const target = await readBugReport(sql, input.duplicateOfId)
          requireAuthorization(live, 'bug_reports:read', reportScope(target))
          await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`bug-report-duplicates:${target.workspaceId}`])
        }
        await authorizeClose(sql, live, input)
      },
      perform: async sql => {
        await requireAcyclicDuplicate(sql, input)
        const now = new Date().toISOString()
        const resolution = {
          status: input.status,
          closedAt: now,
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.duplicateOfId === undefined ? {} : { duplicateOfId: input.duplicateOfId }),
        }
        const closed = new Map<string, BugReport>()
        for (const item of [...input.reports].sort((a, b) => a.reportId.localeCompare(b.reportId))) {
          const previous = await readBugReport(sql, item.reportId, 'update')
          if (previous.revision !== item.expectedRevision) {
            throw new DomainError('REVISION_CONFLICT',
              `Bug report ${previous.id} changed. Read it again before closing it.`, 409)
          }
          const updated = { ...previous, status: input.status, resolution, revision: previous.revision + 1, updatedAt: now }
          await saveBugReport(sql, updated)
          closed.set(updated.id, updated)
        }
        return { reports: ids.map(id => closed.get(id)!), originalInputHash }
      },
    })
    return { reports: result.value.reports, replayed: result.replayed }
  }

  private async liveCaller(principal: ManagementPrincipal, source: CommandSource, action: string) {
    try {
      return await liveBugReportPrincipal(this.pool, principal)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, action, 'bug-reports')
      }
      throw error
    }
  }
}

async function authorizeClose(sql: GraphSqlClient, principal: ManagementPrincipal, input: BugReportCloseInput) {
  if (principal.audience !== 'operator') throw new DomainError('ACCESS_DENIED', 'Agents can only submit bug reports.', 403)
  const target = input.duplicateOfId === undefined ? undefined : await readBugReport(sql, input.duplicateOfId)
  if (target) requireAuthorization(principal, 'bug_reports:read', reportScope(target))
  for (const item of input.reports) {
    const report = await readBugReport(sql, item.reportId)
    requireAuthorization(principal, 'bug_reports:read', reportScope(report))
    requireAuthorization(principal, 'bug_reports:update', reportScope(report))
    if (target && target.workspaceId !== report.workspaceId) {
      throw new DomainError('INVALID_INPUT', 'A duplicate must name a report in the same workspace.', 400)
    }
  }
}

async function requireAcyclicDuplicate(sql: GraphSqlClient, input: BugReportCloseInput) {
  if (!input.duplicateOfId) return
  const seen = new Set(input.reports.map(report => report.reportId))
  let targetId: string | undefined = input.duplicateOfId
  while (targetId) {
    if (seen.has(targetId)) {
      throw new DomainError('INVALID_INPUT', 'Duplicate reports must point to a report without creating a cycle.', 400)
    }
    seen.add(targetId)
    const target = await readBugReport(sql, targetId)
    targetId = target.status === 'duplicate' ? target.resolution?.duplicateOfId : undefined
  }
}
