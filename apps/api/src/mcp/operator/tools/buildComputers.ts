import { z } from 'zod'
import { ComputerActivityListSchema, ComputerRenameInputSchema, ComputerRenameResultSchema } from '@foreman-code/contracts/computer-activity'
import { ComputerMaintenanceOperatorListSchema, ComputerMaintenanceOperatorListInputSchema, ComputerMaintenanceStartInputSchema,
  ComputerMaintenanceStartResultSchema } from '@foreman-code/contracts/computer-maintenance'
import { ComputerAccountsListInputSchema, ComputerAccountsListSchema, ComputerSyncReadInputSchema,
  ComputerSyncUpdateInputSchema, ComputerSyncStatusSchema, ComputerGitHubInputSchema,
  ComputerGitHubLogoutInputSchema, ComputerGitHubStatusInputSchema,
  GitHubLoginStateSchema } from '@foreman-code/contracts/computer-accounts'
import { BuildComputerReadSchema, BuildComputerUpdateSchema, BuildComputerStatusSchema,
  BuildComputerBatchUpdateSchema, BuildComputerBatchResultSchema } from '@foreman-code/contracts/build-computers'
import { maintenanceReadResult } from '../../../modules/computers/maintenanceSummary.js'
import { defineOperatorTool } from '../definition.js'

const writeAnnotations = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true }
const annotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
export const buildComputerTools = [
  defineOperatorTool({
    name: 'computer_activity_list',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerActivity,
    description: 'Read current computer presence, running CI Jobs and placed workflow agent executions, and the cloud '
      + 'CI services Main is logged in to with how many of their machines run CI now. '
      + 'Failed cloud readiness checks stay visible with observation.lastError and failure counts. '
      + 'Requires global settings:read. Job and agent names are filtered by jobs:read and runs:read scopes. '
      + 'Read-only, at most 101 computers and 200 entries per activity kind; truncated and activityComplete '
      + 'describe coverage. No telemetry permissions are implied; use resource_telemetry tools for utilization.',
    inputSchema: z.object({}).strict(), outputSchema: ComputerActivityListSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context) => context.services.computerActivity!.list(context.principal, 'mcp'),
  }),
  defineOperatorTool({
    name: 'computer_rename',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerActivity,
    description: 'Give Main or a paired computer a new name. The name is trimmed, 1 to 60 characters, and shows everywhere '
      + 'computers are listed: the sidebar, Settings → Computers, CI computer labels and execution-location choices. '
      + 'Requires global settings:update. Supply target exactly as devices_list and computer_activity_list report it. '
      + 'Last write wins; reuse commandId for an uncertain save. Read the persisted name back from computer_activity_list.',
    inputSchema: ComputerRenameInputSchema, outputSchema: ComputerRenameResultSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => context.services.computerActivity!.rename(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'computer_accounts_list',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerAccounts,
    description: 'Read which harness (Codex, Claude), GitHub CLI accounts each paired computer '
      + 'has installed and is signed in to. Requires global settings:read. Identity strings only (email, username, provider names); '
      + 'no tokens. Results are cached for 30 seconds unless refresh is true; an offline computer reports null accounts. '
      + 'Supply target to read one current installation independently; target cannot be combined with cursor. '
      + 'Each fleet page includes up to 100 paired computers; Main appears only on the first page. Continue with nextCursor as cursor until null.',
    inputSchema: ComputerAccountsListInputSchema, outputSchema: ComputerAccountsListSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => input.target
        ? context.services.computerAccounts!.readTarget(context.principal, 'mcp', input)
        : context.services.computerAccounts!.list(context.principal, 'mcp', input.refresh === true, input.cursor),
  }),
  defineOperatorTool({
    name: 'computers_maintenance_status',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerMaintenance,
    description: 'Read maintenance status for Main and every paired computer: installed and latest Codex/Claude versions, pending OS '
      + 'package updates (including phased or held packages), whether a restart is needed, passwordless sudo and free disk. '
      + 'Returns the newest 5 tasks per computer by default, newest first. Optional taskLimit is an integer from 1 to 50. '
      + 'Running and queued tasks are always included even beyond the limit; tasksOmitted counts excluded retained tasks per computer. '
      + 'Default detail is compact, with summaries capped at 300 characters and no outputTail. '
      + 'Use detail: "full" for outputTail with the same history limit; optionally supply taskId with full detail '
      + 'to select one retained task independently of the limit. '
      + 'Paired Workers also report current and target application versions, update state and the last update error, '
      + 'including rollback. '
      + 'workerPublication reports the matching Main release\'s GitHub publication state and failure reason, even for offline computers. '
      + 'Pending publication past its deadline reads as failed with WORKER_PUBLICATION_DEADLINE_EXCEEDED. '
      + 'status.services lists each background loop of that computer (CI dispatch and observation, state-deadline sweeper, '
      + 'run reconciliation, enrollment, schedules, telemetry collector, Worker publication unit, fleet sync) with '
      + 'lastStartedAt, lastSuccessAt, lastError, nextDueAt, inFlightSince and status ok, idle, failing or stalled; stalled '
      + 'means in flight past its deadline or past its next due time. Running tasks older than 60 minutes fail with '
      + 'MAINTENANCE_TASK_DEADLINE_EXCEEDED. '
      + 'workerReadiness reports WORKER_VERSION_SKEW, WORKER_BUNDLE_UNPUBLISHED or WORKER_UPDATING, with expected/running '
      + 'bundle identities, updatePhase and publicationError. New work requires the published bundle for that Worker target. '
      + 'connections gives the same sign-in and MCP facts the Computers page shows as chips: connections.accounts lists '
      + 'Codex, Claude and GitHub CLI with installed and signedIn (null when unreadable or the computer did not answer), and '
      + 'connections.mcp.codex / connections.mcp.claude give the Foreman Code MCP state on that harness (installed, missing, '
      + 'disabled, mismatch, inherited or legacy; null when the caller lacks harnesses:read or the configuration is unreadable). '
      + 'Requires global settings:read. Supply target to read one current installation independently. '
      + 'Successful settled status is cached for 20 seconds unless refresh is true; pending probes are shared. '
      + 'Failed observations report null status with observation.status unavailable, lastError, failedAt, lastSuccess and '
      + 'consecutiveFailures. Failed observations are retried on the next read.',
    inputSchema: ComputerMaintenanceOperatorListInputSchema, outputSchema: ComputerMaintenanceOperatorListSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: async (context, input) => {
    const result = input.target
      ? await context.services.computerMaintenance!.readTarget(context.principal, 'mcp', {
        target: input.target, refresh: input.refresh,
      })
      : await context.services.computerMaintenance!.list(context.principal, 'mcp', input.refresh === true)
    return maintenanceReadResult(result, input)
  },
  }),
  defineOperatorTool({
    name: 'computers_maintenance_start',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerMaintenance,
    description: 'Start one maintenance task on the given computers. With targets omitted, update-worker and sync tasks select '
      + 'paired computers; other tasks select Main and every paired computer: '
      + 'update-harnesses (install or update Codex/Claude to the latest version), update-system (sudo apt-get update and a '
      + 'non-interactive upgrade with new dependencies, respecting phased rollout and explicit holds; re-reads pending updates), '
      + 'update-worker (download only from GitHub with backoff after Main verifies publication of every release asset; '
      + 'unpublished targets and unavailable GitHub assets fail visibly with WORKER_RELEASE_ASSET_UNAVAILABLE; '
      + 'verify checksums, drain active work, install the matching Main version, then restart through the Worker supervisor; '
      + 'enabled build computers must pass a tiny integration CI smoke within 160 seconds after readiness; '
      + 'failed releases roll back and report the error; Main uses production:install), restart (sudo reboot; targets are required), '
      + 'sync-mcp (add Main\'s user-level Codex and Claude MCP '
      + 'servers that other computers lack; secret values are not copied, those servers need a login on each computer), or '
      + 'sync-plugins (install Main\'s Codex and Claude plugins, reconcile fleet-managed versions with native readback, '
      + 'add Main\'s Git marketplaces first and match enabled state for fleet-managed Claude plugins). '
      + 'MCP stdio commands must be executable, and filesystem and interpreter script operands must resolve on the destination. An unavailable server does not block independent entries. Versioned plugins are verified in staging; Codex activates only the selected managed plugin from that staged marketplace after backup. Failed activation restores the cache by native-filesystem rename. '
      + 'Sync preserves pre-existing computer-owned entries and removes only fleet-managed entries absent from an available Main catalog. '
      + 'Unsafe or unsupported MCP definitions and unreadable catalogs are skipped and reported; existing Worker entries for skipped definitions are preserved. '
      + 'Intentional credential skips do not fail a task. Automatic sync failures retry after 5 minutes with exponential '
      + 'backoff capped at one hour; a manual start with a new commandId retries immediately. '
      + 'Disabled servers, native tool allow/deny lists and stdio environment-name references cannot be copied by this sync path. '
      + 'Tasks run in the background; read their outcome with computers_maintenance_status. Equivalent requests share only the latest queued task; different requests of the same kind queue. '
      + 'Task status survives application restarts; unfinished tasks report interruption. Check every returned computer error; '
      + 'Main shutdown refuses new maintenance tasks and drains accepted Main work before releasing runtime ownership. '
      + 'unavailable targets are not updated. Harness updates verify the selected runtime meets the published version observed at start; '
      + 'a newer stable release installed during the update also succeeds. '
      + 'Main and Workers select the installed Codex update and retain qualification checks. Requires global '
      + 'settings:update. Reuse commandId with the original input to recover the saved targets, source catalogs and receiver tasks, including after Main stops before recording its result. '
      + 'Use a new commandId with update-worker to trigger an update check or retry a failed update. '
      + 'Older Workers without worker-update-v1 require an initial updater-enabled Worker installation on that computer. '
      + 'Receivers require maintenance protocol 2. Restart stays running until the reboot command returns; success reports command acceptance, not confirmed reconnection. '
      + 'A missing harness leaves nonempty MCP sync pending for a later retry.',
    inputSchema: ComputerMaintenanceStartInputSchema, outputSchema: ComputerMaintenanceStartResultSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: true },
    run: (context, input) => context.services.computerMaintenance!.start(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'computer_github_login_start',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Start GitHub CLI sign-in (github.com) on Main or a paired computer. Returns a one-time device code and '
      + 'https://github.com/login/device; the owner enters the code in a browser. Requires global settings:update. The token stays '
      + 'on that computer. A pending sign-out finishes before this sign-in starts; a later sign-out cancels a pending start. '
      + 'Follow with computer_github_login_status; git-setup-failed means sign-in succeeded but Git setup needs retry.',
    inputSchema: ComputerGitHubInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'login-start' }),
  }),
  defineOperatorTool({
    name: 'computer_github_login_status',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Read an active GitHub sign-in on that computer: waiting (with its code), signed-in (with the username), '
      + 'git-setup-failed, failed or expired. Requires global settings:update.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'login-status', loginId: input.loginId }),
  }),
  defineOperatorTool({
    name: 'computer_github_setup_git',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Retry Git credential setup after GitHub sign-in without restarting login. Requires global settings:update. '
      + 'Use the loginId from computer_github_login_status when its state is git-setup-failed.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'setup-git', loginId: input.loginId }),
  }),
  defineOperatorTool({
    name: 'computer_github_logout',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Remove the expected active GitHub account on that computer and verify the resulting status. '
      + 'Read computer_accounts_list first and supply expectedAccount (null only if signed out). '
      + 'Reuse the original expectedAccount on uncertain retries; a changed active account causes a conflict without removal. '
      + 'If another saved account becomes active, returns signed-in; unknown status or failed removal returns an error. '
      + 'Requires global settings:update.',
    inputSchema: ComputerGitHubLogoutInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { ...writeAnnotations, destructiveHint: true },
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'logout', expectedAccount: input.expectedAccount }),
  }),
  defineOperatorTool({
    name: 'computer_sync_status',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerSync,
    description: 'Read Syncthing shared file status on Main or a paired computer: installed, running, connected peers, '
      + 'workspace participation, enabled preferences and revisions, local folder paths, idle/syncing/error and conflicts. '
      + 'Requires global settings:read. Paths do not grant harness write access.',
    inputSchema: ComputerSyncReadInputSchema, outputSchema: ComputerSyncStatusSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => context.services.computerSync!.read(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'computer_sync_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerSync,
    description: 'Enable or disable one workspace shared folder on one computer. Requires global settings:update. '
      + 'Omit expectedRevision for last write wins; supply it to reject a stale revision. Reuse commandId for uncertain saves. '
      + 'Syncthing installs automatically, pairs through the app and uses Tailscale with Main as hub and simple versioning. '
      + 'Only computers selected for workspace Agents receive the folder; enabled preferences apply when they participate. '
      + 'Unavailable enabled peers defer folder replacement; saved preferences retry when they reconnect. '
      + 'Disabling preserves local files. Main off stops sharing through the hub. Read persisted preferences with computer_sync_status.',
    inputSchema: ComputerSyncUpdateInputSchema, outputSchema: ComputerSyncStatusSchema,
    annotations: { ...writeAnnotations, idempotentHint: true },
    run: (context, input) => context.services.computerSync!.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'build_computer_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.buildComputers,
    description: 'Read persisted build participation, priority, build allowance, revision and derived readiness for this Main/computer installation. New paired computers default to enabled builds, priority 50 and allowance 100. Re-pairing refreshes the target identity and advances the revision while preserving saved choices, including disabled builds. Readiness uses Job admission capacity, saved build allowance and fresh remote available memory; reasons distinguish reserved capacity, unavailable memory, insufficient memory and an allowance too small for the runtime. Requires global settings:read. Pairing approves product-managed root setup; runtime qualification and the Main startup execution gate remain separate.',
    inputSchema: BuildComputerReadSchema, outputSchema: BuildComputerStatusSchema, annotations,
    run: (context, input) => context.services.buildComputers!.read(context.principal, input, 'mcp'),
  }),
  defineOperatorTool({
    name: 'build_computer_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.buildComputers,
    description: 'Revision-check build participation, priority (0–100; after a preferred computer, builds try computers from the highest priority down) and build allowance (10–100 percent of the computer CPU and memory that builds may use; an omitted allowance keeps its saved value). Requires global settings:update. Edits affect future launches; running Jobs retain cancellation/recovery and artifacts. commandId is optional and generated server-side when omitted. Supply the same commandId and input for an uncertain save. Does not install, pair, approve a runtime or enable the Main startup execution gate.',
    inputSchema: BuildComputerUpdateSchema, outputSchema: BuildComputerStatusSchema,
    annotations: { ...annotations, readOnlyHint: false },
    run: (context, input) => context.services.buildComputers!.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'build_computers_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.buildComputers,
    description: 'Atomically update build participation, priority and allowance for one or more computers on Main. '
      + 'Checks every expectedRevision before changing any computer. Requires global settings:update. '
      + 'commandId is optional and generated server-side when omitted. '
      + 'Reuse the same commandId and updates to resolve an uncertain save; replay returns the original result. '
      + 'Read build_computer_get afterwards for current settings. Changes affect future placement; running Jobs keep their computer.',
    inputSchema: BuildComputerBatchUpdateSchema, outputSchema: BuildComputerBatchResultSchema,
    annotations: { ...annotations, readOnlyHint: false },
    run: (context, input) => context.services.buildComputers!.updateBatch(context.principal, 'mcp', input),
  }),
]
