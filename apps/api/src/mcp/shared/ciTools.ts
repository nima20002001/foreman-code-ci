import { collectBoundTools, type BoundTool } from './catalog.js'
import type { McpServer } from '@modelcontextprotocol/server'
import { CiRunInputSchema, OperatorCiRunInputSchema, CiRunOutputSchema,
  CiGetInputSchema, OperatorCiGetInputSchema, CiGetOutputSchema,
  CiCancelInputSchema, OperatorCiCancelInputSchema, CiCancelOutputSchema,
  CI_LOG_MAX_BYTES, CiLogsInputSchema, OperatorCiLogsInputSchema, CiLogsOutputSchema, CiComputersOutputSchema,
  OperatorCiListInputSchema, CiListOutputSchema } from '@foreman-code/contracts'
import { z } from 'zod'
import type { ManagementPrincipal, ManagementAction } from '@foreman-code/contracts/management'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../../modules/jobs/ciAuthority.js'
import type { HostCiService } from '../../modules/ci-host/service.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { DomainError, databaseConnectionFailure } from '../../modules/errors.js'
import { toolFailure, toolResult } from './results.js'
import { logOperatorToolFailure } from '../operator/invoke.js'
import { deviceBusyFailure } from '../../modules/devices/deviceBusyError.js'

/** What each CI tool does. Agents act on this text, so keep it short and true to the code. */
export const CI_TOOL_DESCRIPTIONS = {
  ci_run: 'Run one suite (install, typecheck, lint, unit, build or integration) of the workspace GitHub repository on '
    + 'build computers and cloud runners. Enabled idle build computers pre-warm queued commits offline in persistent '
    + 'checkouts without holding CI slots; real CI takes priority. Commit: the given one; otherwise an Agent\u2019s edited files (published to GitHub '
    + 'first, snapshot up to 32 MiB) or its Run-start commit; otherwise the default branch head. scope defaults to affected: '
    + 'the files you pass, or the files changed since baseCommit (a full SHA ancestor) or since the merge-base with the '
    + 'default branch. Integration uses ancestor execution coverage with conservative static fallbacks; '
    + 'infrastructure changes run everything. ci_run returns the initial selection; ci_get run.selection '
    + 'retains the runner selection and its coverage commit or fallback reason. '
    + 'Repositories without affected test selection default to full when scope and files are omitted. '
    + 'Explicit scope=affected or files on those repositories fails with CI_SELECTION_UNSUPPORTED (409); '
    + 'request scope=full and omit files. '
    + 'scope=full runs everything. After test failures, rerun only the failed test files: scope=affected, '
    + 'files=ci_get.failedFiles (or paths from testStatus=[failed] / failureHistory), with an explicit commit and the same suite. '
    + 'For multi-suite gates, separate failed files by suite. '
    + 'Repositories without affected test selection must rerun with scope=full and no files. '
    + 'Integration splits into parts of about four minutes of measured test time; omit '
    + 'partitions to let CI size them (2\u201364 caps the count). Slow integration files start after the fast tier passes. '
    + 'Affected unit/integration runs with explicit files reuse matching results from earlier passed tickets (cachedFiles), '
    + 'including unchanged files on the same commit; full runs bypass this cache. '
    + 'gate=true (Operators only; integration, scope full, no files or partitions) runs typecheck, lint, unit and '
    + 'integration across every computer; one gate runs at a time. priority is normal or high. A newer descendant commit '
    + 'from the same requester on the same branch or Agent execution cancels its older active tickets of the same suite '
    + 'unless noSupersede=true; ci_get then reports supersededBy. commandId is optional; repeating it with the same input '
    + 'returns the original tickets. An identical request (same workspace, repository, commit, suite, scope, baseCommit, '
    + 'files, partitions and gate) made while one is queued or running joins it instead of queueing new tickets: it returns '
    + 'the same tickets with joined=true and sharedWith (other requesters still attached), and every requester reads the '
    + 'same result. Joining needs the same CI grants as a new request. Returns ticketId and, for multi-part runs, '
    + 'partitions: wait for the group with one ci_get waitUntil=group-terminal call on any ticket, not by polling.',
  ci_get: 'Read one CI ticket. reassignment retains its cause, previous host, time and cumulative count. '
    + 'mirrorPublication.repair retains clone repair cause, source, duration and count. '
    + 'observation reports whether live state is available, its last successful read, '
    + 'sanitized lastError, consecutiveFailures and nextAttemptAt. Retained state is not a confirmed live observation. '
    + 'transport reports REST/CLI source, fallback reason and count when available. '
    + 'State (queued, starting, running, passed, failed, canceled, lost), step, computer, part '
    + 'and shard, exit code, message, a 32 KiB log tail, its group\u2019s partitions and group state, queue position and '
    + 'reason while queued, expectedDurationMs, cachedFiles, and supersededBy (follow the replacement ticket and its '
    + 'partitions). Gate tickets add per-computer and per-suite expected and actual durations. testStatus (passed, failed, '
    + 'skipped) adds structured test results, each failure with its message and path:line:column. A failed group adds '
    + 'failedFiles across all parts, independent of testStatus; an empty list means no failed test files were reported. '
    + 'Rerun only failed files with ci_run scope=affected, files=failedFiles, an explicit commit and the same suite '
    + '(separate files by suite for multi-suite gates). Repositories without affected test selection require scope=full '
    + 'and no files. testStatus=[failed] and failureHistory also name failed files. '
    + 'Explicit affected unit/integration selections reuse matching results from earlier passed tickets, including unchanged '
    + 'files on the same commit (cachedFiles); full runs bypass this cache. A background dispatcher '
    + 'refreshes healthy state about every second; unavailable observations use bounded backoff. To wait, make one call '
    + 'with waitUntil=group-terminal, waitSeconds=1800 and logTail=false on any ticket of the group instead of polling: '
    + 'it returns wait.status settled once every ticket of the group is terminal and its results are collected '
    + '(partitions then lists each final ticket), or still-running with tickets and settledTickets when the budget ends; '
    + 'call again to keep waiting. The managed bridge holds the call open across bounded chunks; a direct HTTP call '
    + 'answers within 60 seconds. Read logs once at the end with ci_logs_read. Without waitUntil, waitSeconds waits at '
    + 'most 60 seconds for this ticket’s state or step to change or a terminal state; request cancellation '
    + 'ends any wait. A part fails after 180 seconds without output or after '
    + 'max(3 \u00d7 expectedDurationMs, 120 seconds); a cloud part that fails before its first test is retried once on another '
    + 'slot (setupRetry). A failed ticket adds failureHistory: how many of the latest gate runs that ran each failed '
    + 'test also failed it, so a known flake is recognized. sharing lists every requester (principalId, executionId, '
    + 'initiator, active) when identical requests joined the group. Agents with ci_get read every ticket of their workspace. '
    + 'Malformed or unknown ticketId returns CI_RUN_NOT_FOUND with up to five recent groups you requested or joined, '
    + 'scoped to your execution when present, '
    + 'in the message and details.recentTickets (lead ticketId, suite, scope, group state, createdAt in UTC).',
  ci_computers_list: 'CircleCI rows retain account as the GitHub org owner and use circleAccountId for the login; '
    + 'schedulingRole reports active, standby or exhausted independently of authentication readiness. '
    + 'Estimated usage is sampled at most every three hours, usable for four hours from export window end; '
    + 'Only an explicit CircleCI credit refusal exhausts an org. Usage reports never block standby eligibility. '
    + 'After five minutes, creditProbeAvailable permits one coordinated recovery build while the replacement '
    + 'remains active. Normal admission resumes only after CircleCI starts that probe job. '
    + 'List the computers CI can use: readiness and its reasons (GitHub login, git, corepack, user '
    + 'systemd), saved buildAllowancePercent, allowedCpuCount, CPU and memory within that allowance, '
    + 'used and total CI slots, available memory, running tickets, and up to 500 queued tickets with priority, '
    + 'queue position and reason (queueTruncated reports more). Read participation and priority with build_computer_get. '
    + 'CircleCI entries add credits {total, used, remaining, asOf}: an estimate of that one org\u2019s credits left this '
    + 'month for compute reporting only, its configured monthly allowance (circle_credit_allowance_get/update; default 400,000, the Free plan\u2019s '
    + 'open-source Linux credits per org) minus the org\u2019s compute usage (excluding storage and other charges), or '
    + 'credits=null with creditsUnavailable when that org\u2019s read failed. '
    + 'Each further CircleCI org is its own set of cloud slots (hostRef.account names its GitHub owner); Main adds one '
    + 'by itself once that GitHub organization has a copy of the CI mirror followed in CircleCI, which is set up '
    + 'outside Foreman (docs/runbooks/add-circleci-org.md).',
  ci_cancel: 'Cancel a queued or running CI ticket by ticketId. Optional commandId is recorded once in the audit, so a '
    + 'retry is safe. CI_CANCEL_PENDING means remote cleanup is unconfirmed and still retrying. A requester of a group '
    + 'that joined identical requests share only detaches (detached.remainingRequesters) while others remain; the '
    + 'tickets are canceled once no requester remains. run_stop cancels every open ticket of that Run\u2019s Agents '
    + 'that no other requester still shares. Malformed or unknown ticketId returns CI_RUN_NOT_FOUND with your recent '
    + 'tickets in the message and details.recentTickets.',
  ci_logs_read: 'Read a CI ticket\u2019s log from its computer, or its labeled saved tail on Main when the completed '
    + `executor is unavailable. Omit afterOffset for the last maxBytes (at most ${CI_LOG_MAX_BYTES}), `
    + 'source=saved-tail uses byte cursors within that saved snapshot; restart at 0 when source changes, '
    + 'or page forward with nextOffset. group=true pages every part of the ticket\u2019s group within the same budget. '
    + 'Queued tickets return CI_NOT_STARTED. Malformed or unknown ticketId returns CI_RUN_NOT_FOUND with up to five '
    + 'recent groups you requested or joined, '
    + 'scoped to your execution when present, in the message and details.recentTickets '
    + '(lead ticketId, suite, scope, group state, createdAt in UTC). '
    + 'Saved tails expire with confirmed executor cleanup after three days, keeping the newest 200 tickets per computer. '
    + 'Ticket results and history remain available.',
  ci_list: 'List CI tickets the Agents of one Run requested or joined as identical requests, newest first (at most 500). '
    + 'Optional executionId filters before the limit. Each ticket includes suite, part, '
    + 'partition, scope, state, step, computer and placement (host, github or circleci), timing, the requesting '
    + 'Agent\u2019s executionId, agentId and workflow node, and passed/failed/skipped test counts once reported. '
    + 'Read a ticket\u2019s tests with ci_get testStatus and its log with ci_logs_read. Requires runs:read on the Run.',
} as const

export const CI_TOOLS = ['ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read', 'ci_list'] as const
type CiTool = typeof CI_TOOLS[number]
interface CiContext {
  principal: ManagementPrincipal
  signal?: AbortSignal
  services: { ci?: HostCiService; commands: PostgresCommandCoordinator }
}
const actions: Record<CiTool, ManagementAction[]> = {
  ci_run: CI_RUN_ACTIONS,
  ci_get: CI_GET_ACTIONS,
  ci_computers_list: CI_GET_ACTIONS,
  ci_cancel: CI_RUN_ACTIONS,
  ci_logs_read: CI_GET_ACTIONS,
  ci_list: [...CI_GET_ACTIONS, 'runs:read'],
}
export function ciCapabilities(context: CiContext, resource: AuthorizedResource) {
  if (!context.services.ci) return []
  return CI_TOOLS.filter(name => actions[name].every(action =>
    Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action)))
    .map(name => ({ name, actions: actions[name], detail: CI_TOOL_DESCRIPTIONS[name] }))
}

const catalogs = new WeakMap<object, {
  ci: HostCiService; roles: Map<string, BoundTool<CiContext>[]>
}>()

export function registerCiTools(server: McpServer, context: CiContext): void {
  const ci = context.services.ci
  if (!ci) return
  let cached = catalogs.get(context.services)
  if (!cached || cached.ci !== ci) {
    cached = { ci, roles: new Map() }
    catalogs.set(context.services, cached)
  }
  const audience = context.principal.audience
  let tools = cached.roles.get(audience)
  if (!tools) {
    tools = collectBoundTools(context, registerCiToolDefinitions)
    cached.roles.set(audience, tools)
  }
  const available = audience === 'operator' ? new Set(ciCapabilities(context, {}).map(tool => tool.name)) : undefined
  for (const tool of tools) {
    if (!available || available.has(tool.name as CiTool)) tool.register(server, context)
  }
}

function registerCiToolDefinitions(server: McpServer, context: CiContext): void {
  const ci = context.services.ci
  if (!ci) return
  const operator = context.principal.audience === 'operator'
  const invoke = async (name: CiTool, work: () => Promise<unknown>) => {
    try { return toolResult(await work()) }
    catch (caughtError) {
      const error = databaseConnectionFailure(deviceBusyFailure(caughtError))
      logOperatorToolFailure(name, caughtError)
      if (error instanceof DomainError && [401, 403, 404].includes(error.status)) {
        await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
      } else {
        try {
          await context.services.commands.recordAudit(context.principal.id, 'mcp', name, `mcp:${name}`, 'failed', {
            code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
          })
        } catch (auditError) {
          if (!(error instanceof DomainError) || error.code !== 'DATABASE_BUSY') throw auditError
          // A second unavailable connection must not replace the caller's retry instructions.
          logOperatorToolFailure(name, auditError)
        }
      }
      return toolFailure(error)
    }
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  server.registerTool('ci_run', {
    description: CI_TOOL_DESCRIPTIONS.ci_run,
    inputSchema: operator ? OperatorCiRunInputSchema : CiRunInputSchema,
    outputSchema: CiRunOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, input => invoke('ci_run', () => ci.run(context.principal, input)))
  server.registerTool('ci_get', {
    description: CI_TOOL_DESCRIPTIONS.ci_get,
    inputSchema: operator ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiGetOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, (input, extra) => invoke('ci_get', () => ci.get(context.principal, input,
    context.signal ? AbortSignal.any([context.signal, extra.mcpReq.signal]) : extra.mcpReq.signal)))
  server.registerTool('ci_computers_list', {
    description: CI_TOOL_DESCRIPTIONS.ci_computers_list,
    inputSchema: operator ? OperatorCiGetInputSchema.pick({ workspaceId: true }) : z.object({}).strict(),
    outputSchema: CiComputersOutputSchema, annotations: read,
  }, input => invoke('ci_computers_list', () => ci.computers(context.principal, input)))
  server.registerTool('ci_cancel', {
    description: CI_TOOL_DESCRIPTIONS.ci_cancel,
    inputSchema: operator ? OperatorCiCancelInputSchema : CiCancelInputSchema,
    outputSchema: CiCancelOutputSchema,
    annotations: { ...read, readOnlyHint: false, destructiveHint: true },
  }, input => invoke('ci_cancel', () => ci.cancel(context.principal, input)))
  server.registerTool('ci_logs_read', {
    description: CI_TOOL_DESCRIPTIONS.ci_logs_read,
    inputSchema: operator ? OperatorCiLogsInputSchema : CiLogsInputSchema,
    outputSchema: CiLogsOutputSchema, annotations: read,
  }, input => invoke('ci_logs_read', () => ci.logs(context.principal, input)))
  // A Run's whole CI list is for the Operator; Agents read workspace tickets with ci_get.
  if (operator) server.registerTool('ci_list', {
    description: CI_TOOL_DESCRIPTIONS.ci_list,
    inputSchema: OperatorCiListInputSchema, outputSchema: CiListOutputSchema, annotations: read,
  }, input => invoke('ci_list', () => ci.list(context.principal, input)))
}
