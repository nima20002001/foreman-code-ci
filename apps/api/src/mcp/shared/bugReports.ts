import {
  BugReportCreateInputSchema,
  BugReportCreateResultSchema,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import type { McpServer } from '@modelcontextprotocol/server'

import type { BugReportService } from '../../modules/bug-reports/service.js'
import type { toolFailure, toolResult } from './results.js'

export const BUG_REPORT_TOOL_DESCRIPTION = 'Report a Foreman Code feature or MCP tool that fails or is hard to use. '
  + 'Include title, tried.feature and tried.inputsSummary, happened.errorCode/message, expected, and severity. '
  + 'Summarize inputs without credentials or secrets; the server redacts recognized tokens and derives reporter, '
  + 'time and harness. Agent workspace/run/workflow come from the authenticated execution; Operator workspace '
  + 'must be supplied unless one authorized workspace is unambiguous. Retry the same commandId and input. '
  + 'A report whose title matches an existing report in the workspace (ignoring case and spacing) is not filed '
  + 'again: it increments that report\'s occurrenceCount, and outcome/message say it was already filed with its id '
  + 'and status. A repeat of a report closed as fixed reopens it as a regression (outcome reopened). Always available to workflow Agents regardless of '
  + 'saved tool choices. A match owned by another reporter returns only report.id, report.status and report.title. '
  + 'Requires the explicit bug_reports:report grant in scope.'

export function registerBugReportTool(server: McpServer, context: {
  principal: ManagementPrincipal
  service: BugReportService
  invoke: (work: () => Promise<unknown>) => Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolFailure>>
}): void {
  const inputSchema = context.principal.audience === 'worker'
    ? BugReportCreateInputSchema.omit({ workspaceId: true })
    : BugReportCreateInputSchema
  server.registerTool('bug_report', {
    description: BUG_REPORT_TOOL_DESCRIPTION,
    inputSchema,
    outputSchema: BugReportCreateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => context.invoke(() => context.service.report(
    context.principal, 'mcp', input,
  )))
}
