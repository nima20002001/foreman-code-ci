
import {
  RunEventsListInputSchema, RunStopInputSchema,
  RunEventsPageSchema, RunStopResultSchema,
} from '@foreman-code/contracts/management'
import { OperatorRunListInputSchema, OperatorRunGetInputSchema, OperatorRunGetResultSchema } from '@foreman-code/contracts/operator-mcp'
import { compactRunDetails } from '../runSummary.js'
import { ManualRunStartInputSchema, ManualRunStartResultSchema, RunStartResolutionResultSchema, SavedRunPageSchema,
  RunActivitiesInputSchema, RunActivitiesPageSchema, RunHandoffsReadInputSchema,
  RunHandoffsReadSchema } from '@foreman-code/contracts/wave25'
import { defineOperatorTool } from '../definition.js'

export const runTools = [
  defineOperatorTool({
    name: 'run_list',
    requires: [['runs:read', 'resource']],
    enabled: s => !!s.runs,
    description: 'List authorized execution-semantics-3 Runs newest-first by creation time and ID. '
      + 'Retained historical Runs remain readable through run_board_snapshot_get. '
      + 'Returns 10 by default. Use this paged read for older Runs omitted from the newest 2000 workspace summaries. '
      + 'Pass nextCursor unchanged; it is scoped to this workspace and optional workflow filter.', inputSchema: OperatorRunListInputSchema,
    outputSchema: SavedRunPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.list(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_get',
    requires: [['runs:read', 'resource']],
    enabled: s => !!s.runs,
    description: 'Read an authorized Run, including Git worktree paths, branches and retained-change status when workspace location read is granted, from one backend snapshot. Defaults to compact status and the latest 25 executions and activities. '
      + 'Omission counts cover this snapshot; use run_activities_get_v1 for paged history. Pass detail: "full" for input, result, execution bodies and the full snapshot. '
      + 'Source capacity failures include error.details with the host/filesystem scope, exhausted limits, usage, measurements and retryability. '
      + 'Current execution semantics 3 only; compact metadata is available from run_graph_snapshot_v1 (graph protocol 1). '
      + 'Native activity summaries identify messages, reasoning, commands, file edits and tool calls without exposing bodies or arguments. '
      + 'Execution summaries include continuedFromExecutionId when a node resumes a closed native session in this Run. '
      + 'Executions waiting for startup capacity or workflow parallelism include a live queueReason with kind, since and limit; host capacity also names hostKey. It clears on admission or cancellation. '
      + 'Includes persisted failure codes (including EXECUTION_ACTIVE_TIMEOUT and WORK_RUN_EXECUTION_BUDGET_EXHAUSTED), '
      + 'failure messages, Stop causes and cleanup status. '
      + 'A Run waiting for approval may still have progressing sibling executions. '
      + 'Reads use a committed snapshot without waiting for Run writers; DATABASE_READ_TIMEOUT is retryable.',
    inputSchema: OperatorRunGetInputSchema,
    outputSchema: OperatorRunGetResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, input) => {
    const details = await context.services.runs.get(context.principal, input.workspaceId, input.runId)
    return input.detail === 'full' ? details : compactRunDetails(details)
  },
  }),
  defineOperatorTool({
    name: 'run_events_list',
    requires: [['runs:read', 'resource']],
    enabled: s => !!s.runs,
    description: 'Read a bounded page of existing persisted run activity from a committed snapshot. '
      + 'DATABASE_READ_TIMEOUT is retryable.', inputSchema: RunEventsListInputSchema,
    outputSchema: RunEventsPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.events(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_handoffs_get_v1',
    requires: [['runs:read', 'resource'], ['workflows:read', 'workflow']],
    enabled: s => !!s.runs,
    description: 'Read the exact saved work connections, Run-wide usage, nullable limits, named route availability, notice delivery and unresolved work. Requires scoped runs:read and workflows:read. A listed route still requires live admission; this read grants no execution authority.',
    inputSchema: RunHandoffsReadInputSchema, outputSchema: RunHandoffsReadSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.handoffs.read(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_activities_get_v1',
    requires: [['runs:read', 'resource']],
    enabled: s => !!s.runs,
    description: 'Read a bounded, redacted public Activities page for an exact authorized Run. '
      + 'Execution references include continuedFromExecutionId for same-node session continuity. '
      + 'Includes persisted Host CI lifecycle states with ciTicketId, ciGroupId, originating Agent execution, part, partition and computer. '
      + 'Native summaries identify messages, reasoning, commands, file edits and tool calls; details include safe counts, message phase and command exit code. '
      + 'Work result and needs-direction activities include redacted latestDeliverable, remainingFindings and outcome. '
      + 'Failed executions include their redacted failure code and reason in activity details. '
      + 'Pages may return fewer items than limit to fit the 128 KiB public-page budget; follow the returned cursors. '
      + 'Use run_get for execution and normalized activity snapshots. '
      + 'Use nextCursor for incremental catch-up and olderCursor for earlier retained history; '
      + 'an expired cursor requires a fresh initial read. Pending approvals remain in the authorized inbox. '
      + 'Reads use a committed snapshot; DATABASE_READ_TIMEOUT is retryable.',
    inputSchema: RunActivitiesInputSchema, outputSchema: RunActivitiesPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.activities.read(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_start',
    requires: [['runs:start', 'workflow'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.runs,
    description: 'Request one Run of the explicit saved version. Accepted Run authority survives starter-token expiry; '
      + 'Source admission reclaims eligible closed copies from completed Runs when byte capacity is full. '
      + 'Active writer pressure retries with backoff; run_get exposes persisted capacity diagnostics. '
      + 'owner revocation, current scopes, Stop and completion still apply. Every new workflow uses semantics 3, with or without '
      + 'repeat. Default Codex Agents use approvalPolicy never and need no routed workflow approval handler; sandbox restrictions '
      + 'still apply. Pin 3 plus the current workflow revision, exact Agent configuration map and location revision. In '
      + 'mixed-computer workflows, Agents without a saved computer choice resolve to the authorized Main source, '
      + 'root and matching qualified harness. Saved computer choices name a host, root policy, harness instance '
      + 'and cwd; Start resolves their current revisions and rebinds a stale root to its current approved source. '
      + 'The same enabled instance on the same host uses its current revision. Each Run retains its exact resolved '
      + 'placement facts. For a GitHub '
      + 'workspace, Start fetches the configured default branch once, approves its tracked tree, and persists that '
      + 'source for every Agent in this Run. Unchanged commits reuse an approval. '
      + 'Concurrent captures wait separately from SQL query deadlines. COMMAND_LOCK_TIMEOUT and '
      + 'COMMAND_DATABASE_TIMEOUT are retryable; retain the original commandId and input. This requires '
      + 'workspace-scoped sources:approve, sources:read, source_roots:bind and source_roots:read; it does not '
      + 'grant those permissions. Start refreshes only the Agent execution hosts required by this version. '
      + 'Failed, unavailable or busy required-host discovery returns HARNESS_INVENTORY_UNAVAILABLE before a Run '
      + 'is created; cached qualification does not replace a successful inventory refresh. '
      + 'Start automatically checks enabled profiles with missing or stale results. '
      + 'Checks can return HARNESS_PROFILE_CHECK_PENDING; retry the same command after the profiles '
      + 'selected by this Run finish checking. Other profiles on the same computer do not block Start. '
      + 'Production installation rejects new Starts with RUN_START_MAINTENANCE; retry the same command '
      + 'after installation. Verified receipt readback remains available. Concurrent Starts share a 30-second '
      + 'deadline for command, runner and workspace locks; RUN_START_BUSY is retryable with the same commandId and '
      + 'input. WORKER_STATUS_UNAVAILABLE means a Worker did not report its running bundle; retry the same command. '
      + 'Explicit invalid placements are rejected. New v3 Start remains unavailable until native lifecycle '
      + 'qualification; graph read support is not admission. Retry only the same command for verified receipt '
      + 'readback, never a blind restart.', inputSchema: ManualRunStartInputSchema,
    outputSchema: ManualRunStartResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.start(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'run_start_resolve',
    requires: [['runs:start', 'workflow'], ['workspace_locations:read', 'workspace']],
    enabled: s => !!s.runs,
    description: 'Resolve the original Start using its unchanged commandId and complete input. Under the Start command lock, '
      + 'returns the original accepted Run or permanently cancels a command that has no accepted receipt. '
      + 'A canceled command can never admit a Run, including delayed submissions from another tab. '
      + 'After cancellation, read current settings and require a new explicit Start with a new commandId. '
      + 'Missing or contradictory success evidence remains an error; retain the original command and retry resolution. '
      + 'Requires live workflow-scoped runs:start and workspace location read, including replay.',
    inputSchema: ManualRunStartInputSchema, outputSchema: RunStartResolutionResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.resolveStart(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'run_stop',
    requires: [['runs:stop', 'resource']],
    enabled: s => !!s.runs,
    description: 'commandId is optional and generated when omitted; supply the same ID and input for replay. Stop an authorized Run, including recovery after an API or worker restart when the original native lifetime has positive closure evidence. Live or unconfirmed owners remain fenced. If cleanup cannot be confirmed, retry the same commandId and input using the returned domain error. Every non-terminal CI ticket its Agents created and its assigned provider run is canceled with audit under runs:stop; failed CI cleanup remains pending for retry. A receipt or terminal record is not process-exit proof; processStopped remains false.', inputSchema: RunStopInputSchema,
    outputSchema: RunStopResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.runs.stop(context.principal, 'mcp', input),
  }),
]
