import { runHistoryCapabilityLimit } from './runHistory.js'
import { OperatorCompactCapabilitiesSchema } from '@foreman-code/contracts/operator-mcp'
import { OperatorCapabilityInputSchema } from '@foreman-code/contracts/management'
import { catalogToolAvailable, catalogToolRequirements } from '../catalogDiscovery.js'
import { ScheduleOperatorCapabilitiesSchema, workflowScheduleCapabilities } from './workflowSchedules.js'
import { jobCapabilities, JOB_QUEUE_CAPABILITY_DETAIL } from './jobs.js'
import { defineOperatorTool, type OperatorToolDefinition } from '../definition.js'
import type { OperatorRequestContext } from '../types.js'
import { placementCapabilityLimit } from '../../../modules/placement/transports.js'
import { readOperationalFailures } from '../../../modules/diagnostics/logger.js'

export const OPERATOR_RUNTIME_LIMITS = [
  { feature: 'operational_failure_status', state: 'limited',
    detail: 'operator_get_capabilities includes operationalFailures with sanitized causes, counts and failure times since Main startup. computers_maintenance_status includes the same history from each computer. Known retry schedules and repair durations are included. Counts reset on process restart; history does not assert that a previous failure is still active. '
      + 'computers_maintenance_status status.services reports each background loop as ok, idle, failing or stalled. '
      + 'In-between states have maximum ages: CI tickets fail with CI_QUEUE/START/RUN/COLLECTION_DEADLINE_EXCEEDED '
      + '(ci_get run.deadlineExceeded; a running executor keeps its slot until it confirms the stop), Run cleanup records '
      + 'RUN_CLEANUP_DEADLINE_EXCEEDED in Run activity while native ownership stays retained.' },
  { feature: 'native_tool_loading', state: 'protected',
    detail: 'agent_defaults_get/update reads and replaces role nativeTools policies with global settings grants. '
      + 'agent_create copies them; agent_update overrides them with scoped agents:update and revision checks. '
      + 'Read agent_get for the saved policy: mcpServers is a native server allowlist, apps controls apps/connectors '
      + 'and Claude SDK plugins, {} inherits host settings. Foreman Code retains its role and access grants. '
      + 'Changes apply to new sessions; accepted Runs keep immutable configuration pins. '
      + 'Claude external MCP connections remain unsupported.' },
  { feature: 'run_start_source', state: 'protected',
    detail: 'In a GitHub workspace, run_start fetches the configured default branch and automatically approves its '
      + 'tracked tree under the existing source policy and audit. All Run Agents retain that commit; unchanged '
      + 'commits reuse a snapshot. Requires workspace-scoped sources:approve, sources:read, source_roots:bind, '
      + 'source_roots:read and workspace_locations:read in addition to runs:start. Missing grants remain denied. '
      + 'ci_run without commit tests unchanged Agent files at that Run-start commit without uploading a bundle.' },
  { feature: 'run_start_contention', state: 'limited',
    detail: 'Concurrent run_start calls serialize on the command, runner and workspace locks. '
      + 'Each Start shares a 30-second deadline for those locks; RUN_START_BUSY means '
      + 'retry the same commandId and input. Ordinary SQL query deadlines and scoped Start grants still apply.' },
  { feature: 'run_start_recovery', state: 'protected',
    detail: 'run_start_resolve serializes with Start using the original commandId and complete input. '
      + 'It returns the accepted Run, or permanently cancels an unaccepted command before a new explicit Start. '
      + 'Uncertain or contradictory persisted success evidence blocks cancellation. Live Start and location read grants apply.' },
  { feature: 'circleci_accounts', state: 'limited',
    detail: 'CircleCI login metadata uses global settings:read/settings:update through circle_accounts_list, '
      + 'circle_account_add and circle_account_remove. Local human setup provisions API tokens in private CLI '
      + 'profiles outside Foreman. Tokens and profile paths are never accepted or returned by these tools.' },
  {feature:'provider_accounts',state:'limited',detail:'Named account slots belong to one computer/application installation. Read/page/get/status/models require explicit provider_accounts:read; registration/rename/default/removal/auth prepare/cancel require provider_accounts:manage as well. Defaults apply only to new work without a saved account/profile. Accepted Runs and chats retain their original binding; removal preserves history. Authentication is reserved before native dispatch and reconciles the same operation after an unknown response. Only qualified native installations support authentication/models; browser authorization is human-only. MCP receives no credentials or challenges. Existing API-key provisioning remains local-human-only. Foreign installations are unavailable unless their owning Worker account service and advertised narrow transport are explicitly composed.'},
  { feature: 'agent_profile_placements', state: 'protected',
    detail: 'agent_update returns affectedWorkflowIds. Re-save each workflow with the returned configuration version IDs; '
      + 'workflow_validate_v3 and workflow_save_v3 reconcile explicit Agent node placements to harnessProfileSelection '
      + 'on the same computer, preserving source/root/CWD. A host mismatch returns a node-specific '
      + 'AGENT_PROFILE_PLACEMENT_CONFLICT issue. Historical WorkflowVersions and Runs retain their placements. '
      + 'Existing Agent, graph, harness and location grants still apply.' },
  { feature: 'operator_read_detail', state: 'limited', detail: 'source_list defaults to 10 compact source summaries and run_get to compact status with at most 25 executions and 25 activities. Both accept detail: "full". Compact reads omit file inventories and execution bodies; use source_get or paged Run inspection for more detail. workflow_save_v3 fills omitted graph.createdAt, graph.updatedAt and graph.version from the revision-checked workflow; the workflow revision and immutable version/configuration references remain required, without a location baseline.' },
  { feature: 'workspace_repository_import', state: 'protected', detail: 'workspace_repository_add prepares a pinned supported tracked GitHub snapshot on Main in the existing app-managed Workspaces base, composing repository metadata, root location, source approval and binding. Read workspace_repository_get for readiness and incomplete progress. Discovery requires the complete scoped read/provision/update/approve/bind grant combination. Retry unknown acknowledgment with the original commandId and input; quarantined capture failures require a new import. Existing project folders, saved workflow versions and historical Runs remain retained.' },
  { feature: 'worker_updates', state: 'limited',
    detail: 'Paired Workers automatically match Main through the authenticated device connection. '
      + 'Worker targets advance only after GitHub assets are published and download-verified. Updates download only from GitHub '
      + 'Placement and new Agent work, conversation turns, Jobs and host CI require a matching published target bundle; '
      + 'computers_maintenance_status exposes workerReadiness with expected/running identities and update phase. '
      + 'with backoff, and fail visibly with WORKER_RELEASE_ASSET_UNAVAILABLE when the asset is unavailable. '
      + 'computers_maintenance_status includes workerPublication and its failure reason, plus observation '
      + 'with unavailable status, lastError, failedAt, lastSuccess and consecutiveFailures when a maintenance read fails. '
      + 'Updates wait for active work to drain, verify the artifact and install side-by-side; '
      + 'Bundle downloads have a ten-minute deadline and retry after timeouts. CI smoke remains available before archive publication. '
      + 'A failed release rolls back and reports its phase, readiness failure and available stderr tail. '
      + 'computers_maintenance_status requires global settings:read '
      + 'and exposes current/target versions, update state and last error. It defaults to compact task summaries '
      + '(newest 5 tasks, newest first), without outputTail. taskLimit accepts 1-50; running and queued tasks are always '
      + 'included and tasksOmitted counts excluded retained tasks per computer. Use detail: "full" for output '
      + 'with the same limit, optionally filtered by taskId. computers_maintenance_start with update-worker '
      + 'requires global settings:update; omitted targets select paired Workers only. Reuse the original commandId '
      + 'and input to recover the saved task, or a new commandId to retry. Older Workers without worker-update-v1 '
      + 'need one human installation of an updater-enabled Worker first. Main is updated with production:install.' },
  {feature:'source_approval',state:'protected',detail:'source_approve captures the complete pinned tracked tree automatically without path approvals. Git acquisition first reserves capacity on the cache filesystem and accounts retained objects; cache-capacity failures preserve worktrees and result branches and permit retry. Captures only the pinned commit tree, retains sensitive-path/content rejection, executable policy and source limits, and persists the request and tracked inventory. Requires source_roots:bind, sources:read and workspace_locations:read in the workspace.'},
  { feature: 'workflow_create_initial_save', state: 'protected',
    detail: 'workflow_create accepts initialSave {graph, expectedAgentConfigurationVersionIds}. '
      + 'Creation supplies workflow identity, name, description, defaultWorktree and timestamps. '
      + 'Create, validation, immutable save, receipts and audits commit together; failure leaves no workflow. '
      + 'Omitting initialSave still creates an unsaved workflow with workflows:create alone. '
      + 'initialSave additionally requires workflows:read/update, graph:read/edit/save, agents:read and workspace_locations:read '
      + 'in the workspace without workflow-ID restrictions, plus referenced skill/harness/source grants. '
      + 'Retry the same commandId and input; changed input conflicts. Read the saved version with workflow_saved_get_v3.' },
  {feature:'current_workflow_semantics',state:'limited',detail:'One semantics-3 authoring/read/Start contract covers ordinary, parallel/all-required, conditional/approval and optional bounded repeat. Ordinary definitions omit repeat. Read workflow_authoring_capabilities_v3 for separately composed native Start/Stop readiness. Authoring checks the workflow revision and selects immutable version/configuration references; later Agent heads or workspace location revisions do not reject edits. Names and layout use last write wins without presentation or geometry baselines. Stage/Discard do not execute; Stop-and-save waits for settlement.'},
  {feature:'general_questions_and_forms',state:'limited',detail:'Codex supports typed questions, offered choices, free-text answers and schema-validated MCP forms through operator_chat_respond or agent_chat_respond. Responses require the original owned native session/callback and the chat respond grant; read access does not grant response authority. User answers must be supplied explicitly. Other providers and arbitrary untyped forms are not implied; read harness_get interactionSupport for provider-specific support.'},
  {feature:'agent_output_schema',state:'limited',detail:'Agent deliverable contract: optional node.outputSchema (JSON Schema 2020-12, local $ref only, at most 16 KiB; a string property with "x-foreman-reference": "ciTicket" must hold the ID of a CI run that this same execution started). Without it the default applies: a plain final answer must not be blank and a handoff or repeat-exit latestDeliverable must not be null. Every Agent execution except interval checks is checked after its final answer; a failing deliverable gets at most two repair turns in the same native session listing the exact errors, then the attempt fails with OUTPUT_SCHEMA_MISMATCH or OUTPUT_REFERENCE_UNKNOWN (not retried). Repair turns need a Main-placed node; remote placements fail on the first repair. Codex receives the schema as native structured output for plain-answer nodes when it is strict (additionalProperties false, every property required). Save with workflow_save_v3 or workflow_edit_v3; read back with workflow_saved_get_v3.'},
  {feature:'agent_skills',state:'limited',detail:'Per-node skills: node.skills {add?: [{skillId, version}], remove?: [skillId]} changes that node\'s skills only: remove names skills its Agent assigns, add pins exact live workspace skill versions the Agent does not assign (skill_list/skill_get). The Agent configuration is unchanged; each execution of the node receives the resolved skill instructions. Save with workflow_save_v3 or workflow_edit_v3; read back with workflow_saved_get_v3.'},
  {feature:'agent_interval_checks',state:'limited',detail:'Agent loops: node.interval {everySeconds, prompt?} (off by default; range in workflow_authoring_capabilities_v3 agentInterval) re-activates that Agent while its Run is active, after its first finished execution, with prompt as what to do on each loop or a default Run check. Loops are separate from workflow schedules, which start Runs. Loops continue the node session when the node keeps its working directory (a placed node gets a fresh checkout), never route the graph, use the execution budget or consume maxParallelism slots, serialize with work on the same node, stop with the Run, continue after graph work settles until user Stop, resume after an API restart (agentInterval.maximumChecksPerRun is null: unlimited), and give that node a read-only, Run-scoped run_status_get tool. They need approval handler native or a Codex Agent with approvalPolicy never and are rejected inside repeat blocks and on Agents with artifactOutputs. Save with workflow_save_v3 or workflow_edit_v3; read back with workflow_saved_get_v3.'},
  {feature:'named_workflow_routing',state:'limited',detail:'Explicit named outcomes, acyclic execution relationships and all-required joins share the current validator. Return routing may omit requestId when replying to a single open received request; the app resolves it. With several open requests, requestId is required. An explicit unmatched ID is rejected, and repair instructions list the valid IDs verbatim. Arbitrary cycles, nested repeats, inferred routes and unknown outcomes are rejected. Valid authoring is not native admission.'},
  {feature:'run_pause_node_retry_and_steering',state:'unsupported',detail:'Pause, selected-node retry, single-execution Stop, and live worker steering are not implemented. A deliberate new full Run uses the current pinned run_start contract; the old unpinned retry adapter is retired.'},
  {feature:'checkpoint_resume',state:'limited',detail:'Automatic current checkpoint continuation requires A’s exact native approval receipts. The old manual run_resume adapter is retired; no caller can skip approval.'},
  {feature:'process_exit_confirmation',state:'limited',detail:'run_stop recovers interrupted native lifetimes only with positive closure evidence under the Run owner fence. Live or unconfirmed owners stay pending; domain errors permit retry with the same commandId and input. Run Stop also cancels its Agents’ non-terminal CI tickets and their provider runs, with audit; CI failures retain pending cleanup for retry. This subordinate cleanup requires runs:stop, without an additional jobs:cancel grant. Stop acceptance is not native-process-exit proof; processStopped remains conservative.'},
  {feature:'historical_runs',state:'limited',detail:'Restore history into a new validated current version before running it. Old immutable versions are never edited.'},
  {feature:'resource_deletion',state:'protected',detail:'Workspace archive retains workflow/run history and deletes app-created project folders. Archive rejects queued or active Agent chat messages; cleanup protects their folders, accepted Run directories and pending cleanup even after workspace location changes. Shared Git metadata required by other workspaces or queued or active chats remains protected after Runs finish; damaged repositories retain their known metadata dependencies. workspace_storage_folder_delete explicitly deletes an unregistered direct-child folder and its contents using its listed identity and global archive/provision/location-read grants. Registered locations, unfinished repository import reservations, defaults, active runs, roots and symlinks are protected.'},
  {feature:'remote_runners_and_host_browsing',state:'limited',detail:'workspace_create provisions a local folder under the selected parentPath with provisioning, location-update and location-read grants. Workspace locations and directory browsing support folders under the user’s home directory, including symlinked projects. Deletion remains contained in configured workspace storage. Managed runtime overlap is rejected for execution locations. Remote execution requires its configured services and source/root authority.'},
  {feature:'approval_reassignment',state:'protected',detail:'Read permissions span handlers; response authority stays with the accepted handler. Changing a draft does not take over a running request.'},
  {feature:'trusted_device_connections',state:'protected',detail:'Operator can discover, inspect, check and read trusted device connections with global settings:read. Global settings:update permits direct connection configuration and revocation for paired devices through HTTP and MCP. Device and consent revisions, caller scopes and read-only restrictions remain enforced; connection settings do not grant agent execution permissions.'},
  {feature:'operator_self_authorization',state:'protected',detail:'No tools are added for the Operator to answer its own human gates or manage its delegated credential.'},
  {feature:'native_mcp_provisioning',state:'protected',detail:'Native MCP connections can be read with harnesses:read and changed directly with harnesses:update plus harnesses:read through Operator MCP or bearer HTTP. Supported changes include installation, removal, disabling and enabling of Foreman Code and read-only Linear presets. Changes retain revision checks when supplied, scoped grants and reconciliation of uncertain writes. Optional hostRef targets paired Worker devices for Foreman Code installation, native MCP listing and detection (Codex and Claude). Pairing approves automatic managed MCP setup and missing-entry repair before Agent inspection. Computer cards show state read-only; Operator changes it. Connection changes do not download packages or expose credentials.'},
  {feature:'fleet_mcp_sync',state:'limited',detail:'computers_maintenance_start sync-mcp requires settings:update and maintenance protocol 2, and uses the same sync service as Settings. Reuse the original commandId and input after an unknown response; Main retains the selected targets/catalogs and receivers retain command outcomes across restarts. Unsafe definitions, disabled servers, native tool allow/deny lists and stdio environment-name references are skipped and reported. Intentional credential skips do not fail a task. Automatic sync retries failed tasks after 5 minutes with exponential backoff capped at one hour; a manual start with a new commandId retries immediately. Existing Worker entries for skipped definitions are preserved; only fleet-managed entries deleted from an available Main catalog are removed. Missing harnesses leave nonempty MCP sync pending. Configure unsupported settings separately on each computer. Read persisted task outcomes with computers_maintenance_status using settings:read.'},
  { feature: 'fleet_destination_sync', state: 'limited', detail: 'MCP stdio executables, explicit filesystem operands and interpreter script operands are checked on each destination before native config equality counts as synced. Container and package identifiers and interpreter inline/module modes are preserved. Independent entries are kept before validation; a failed entry does not block other servers. Acknowledgements predating script validation are re-delivered without rewriting historical tasks. Plugin fingerprints include reported versions. Versioned releases are acquired and checked in an isolated native home. Codex activates only the selected managed plugin using its staged marketplace after taking a backup. Native-filesystem backups restore plugin caches by rename after activation failure. Native readback must match Main before success. Independently installed plugins are preserved. Plugins without a reported version can only be reconciled by ID. Uses the same settings:update authority and maintenance service through UI and MCP, with no additional approval steps.' },
  { feature: 'settings_revisions', state: 'limited', detail: 'App settings, creation defaults, host profile saves, file retention, computer sync, Claude plugins and native MCP changes accept optional expectedRevision. Omit it for last write wins; supplied stale revisions return REVISION_CONFLICT. Writes retain commandId retry identity, scope checks and read-only caller restrictions. Host qualification still checks the saved profile revision.' },
  {feature:'claude_configuration',state:'limited',detail:'Claude supports only the explicitly pinned app HTTP MCP connection; external MCP servers are rejected because their tool manifests are not supported. claude_setup_options_get reads this API’s Foreman Code endpoint; harness_defaults_update and harness_instance_save persist configuration with their existing grants; expectedRevision is optional for last write wins. Enabled saves start Claude profile qualification automatically; they do not grant tools or change native login/configuration files. Claude accepts only Full access; saving or starting Read only or Workspace write configuration returns a validation error. Detected defaults remain incomplete until Full access is explicitly selected. harness_instance_check rejects a profile directory that differs from the host process CLAUDE_CONFIG_DIR before any paid turn, then runs explicit local subscription qualification with Write and app tool-policy checks. Execution requires the checked host, configuration, sandbox and native lifecycle.'},
  {feature:'codex_plugins',state:'protected',detail:'Installed and available Codex plugins and verified bundle contents can be read through Operator MCP. codex_plugin_change installs or removes a plugin with harnesses:update and harnesses:read; bearer HTTP uses the same service. Revision conflicts, artifact validation and read-only caller restrictions remain. Reconcile uncertain changes with codex_plugin_reconcile without repeating the native write.'},
  { feature: 'harness_model_discovery', state: 'protected', detail: 'harness_options_get and harness_options_refresh require harnesses:read. Optional hostRef selects Main or an authenticated Worker; accountBinding selects a managed account profile on that installation and retains target-scoped provider_accounts:read checks. Without accountBinding, discovery uses that computer’s native login. HTTP uses the same selectors and service. Catalog reads do not qualify execution or create model turns.' },
  {feature:'harness_installation_updates',state:'limited',detail:'Codex compatibility records installed versions and runtime contract verification results without a release catalog or exact version pin. Enabled profile saves start native checks automatically. Start and placement choices also check missing or stale results, deduplicated per instance revision. Main and Workers refresh installed harness inventory and automatically requalify previously qualified enabled profiles after payload changes. Startup inspection timeouts keep Main profile checks pending and retry automatically. Automatic qualification retries invalid version output up to three times with backoff only for an unchanged previously qualified binary; exhaustion persists a failure. Compatibility retries do not qualify execution. harness_instances_list requires harnesses:read and reports qualifying or a persisted qualificationFailure. New Run starts return HARNESS_PROFILE_CHECK_PENDING while checks run; retry the same Start command once qualified. Running native processes retain their original installation and qualification under their existing owner checks. Explicit checks still require harnesses:read and harnesses:update; automatic checks do not change grants, sandbox policy or saved WorkflowVersion and Run facts.'},
  {feature:'schedule_delivery',state:'unsupported',detail:'Retired unpinned trigger admission is not active. This current delivery exposes only explicit pinned manual run_start; no scheduled or event Start is promised.'},
  {feature:'skills',state:'limited',detail:'Skills are workspace-owned Markdown instruction text managed with skill_list/get/versions_list/create/update/archive. Every save creates an immutable version; Agents pin exact versions through agent_create/agent_update or the board and never follow later edits. Skill text is delivered as native Agent instructions, never as tool grants. Packages, folders, scripts, URLs and includes are not supported. Persistent instructions plus skills are limited to 512 KiB per Agent.'},
] as const

export const capabilityTools = [defineOperatorTool({
  name: 'operator_get_capabilities',
  requires: [['capabilities:read', 'caller']],
  description: 'Read operational failures since startup and inspect your grants, compatible tool permissions, optional resource scope, and explicit runtime limits. Supply a complete workspace/workflow/run hierarchy for resource checks. Defaults to compact; detail:full returns all requirements and runtime instructions. This is not a grant or a promise that a specific object exists.',
  inputSchema: OperatorCapabilityInputSchema,
  outputSchema: ScheduleOperatorCapabilitiesSchema.or(OperatorCompactCapabilitiesSchema),
  annotations: {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  run: async (context, input, { extra, catalog, tools: registry }) => {
    if (!catalog) throw new Error('Operator discovery requires the registered catalog.')
    const registered = await catalog(extra)
    const capabilities = operatorCapabilities(context, input, registry, registered.map(tool => tool.name))
    if (input.detail === 'full') return capabilities
    const { requirements: _requirements, ...compact } = capabilities
    void _requirements
    return { ...compact, detail: 'compact' as const,
      detailsTool: 'operator_tool_schema_get' as const, fullDetailArguments: { detail: 'full' as const },
      runtimeLimits: capabilities.runtimeLimits.map((entry) => ({ ...entry,
        detail: compactRuntimeDetails[entry.feature] ?? entry.detail,
      })),
    }
  },
})]

/** Names come from the authenticated tools/list catalog, including direct registrars. */
export function operatorCapabilities(context: OperatorRequestContext, input: {
  workspaceId?: string | undefined; workflowId?: string | undefined; runId?: string | undefined;
}, registry: readonly OperatorToolDefinition[], registeredNames: readonly string[]) {
    const resource={...(input.workspaceId?{workspaceId:input.workspaceId}:{}),...(input.workflowId?{workflowId:input.workflowId}:{}),...(input.runId?{runId:input.runId}:{})}
    const tools = registeredNames.filter(name => catalogToolAvailable(context, name, registry, resource))
    const requirements = catalogToolRequirements(context, registry, tools, resource)
    const schedules = workflowScheduleCapabilities(context, resource)
    const jobs = jobCapabilities(context, resource)
    const scheduleRuntime = context.services.runs?.scheduleAvailability?.()
    const runtimeLimits = OPERATOR_RUNTIME_LIMITS.map((limit) =>
      limit.feature === 'schedule_delivery' && scheduleRuntime?.configured
        ? { feature: limit.feature, state: 'limited' as const,
          detail: 'The API dispatcher uses the same pinned Start and engine as manual Runs. It admits only the latest due occurrence within five minutes, skips overlapping scheduled Runs, and pins the latest saved workflow. Live owner grants and native runtime readiness are rechecked. Retired unpinned triggers and event Start remain unavailable. '
            + (scheduleRuntime.runtimeAdmission ? 'Timed Run admission is available.'
              : 'Timed Run admission is paused until native runtime readiness returns.') }
        : limit)
    return {endpoint:'/mcp',audience:'operator',protocol:'2026-07-28',tools,
      operationalFailures: readOperationalFailures(),
      principal:{id:context.principal.id,name:context.principal.name,expiresAt:context.principal.expiresAt},
      grants:context.principal.grants,requestedResource:resource,
      requirements,
      runtimeLimits:[...runtimeLimits, { ...runHistoryCapabilityLimit(context),
        ...(context.services.runs?.history ? { detail: 'Run summaries and immutable Board snapshots are discoverable with their structured requirements. Live runs:read and the persisted hierarchy are rechecked; Run-only grants see only their Runs. Older Runs may have no Board capture.' } : {}),
      },
        placementCapabilityLimit(Boolean(context.services.runPlacements && context.services.placementChoices)),
        ...(jobs.length ? [{ feature: 'ci_jobs', state: 'limited' as const,
        detail: JOB_QUEUE_CAPABILITY_DETAIL + ' Only listed operations are available to this caller. '
          + 'Launch requires an approved source/root and current host-bound CI qualification. '
          + 'Connecting a computer or listing tools is not qualification. '
          + 'Job management tools remain Operator-only; Agents use the CI tools to choose computers, run, poll, read logs/artifacts and cancel in their Run workspace. '
          + 'Revoked-Worker cleanup requires separate local-human approval; MCP cannot approve itself or enable execution.'
      }] : []), ...(schedules.length ? [{ feature: 'schedule_persistence', state: 'limited' as const,
        detail: 'Schedule CRUD and bounded occurrence history have HTTP/MCP parity. '
          + (scheduleRuntime?.configured ? 'Timed Run admission is composed; see schedule_delivery for policy and readiness. '
            : 'This persistence-only composition has no dispatcher or timed Run admission. ')
          + 'Clear/paging/discovery compositions await shared-contract follow-up.' }] : []), ...(context.services.fileReferences ? [{
        feature: 'permanent_reference_files', state: 'limited' as const,
        detail: 'Permanent references support reference_files_list, reference_file_read, reference_file_add and reference_file_remove through tools/list. Read requires the scope-specific workspaces:read or workflows:read grant; add/remove additionally require the matching update grant. Worker access is not granted. Discovery includes caller-filtered schemas and structured permission requirements. Agent access resolution is separate.',
      }] : [])],
      workerToolsMcp:{implemented:context.services.workerToolsMcpImplemented===true,endpoint:'/mcp'}}
}

const compactRuntimeDetails: Record<string, string> = {
  worker_updates: 'Workers drain, verify and match Main automatically; failures roll back. Read status with settings:read; '
    + 'trigger/retry update-worker with settings:update. Older Workers need an initial updater-enabled installation. '
    + 'Main uses production:install.',
  current_workflow_semantics: 'Semantics 3; optional finite repeat. Read workflow_authoring_capabilities_v3 for native readiness.',
  general_questions_and_forms: 'Codex typed questions and MCP forms use chat respond tools with the original session/callback and respond grant. Explicit user input required; see harness_get interactionSupport for provider limits.',
  agent_interval_checks: 'Agent loops: node.interval {everySeconds, prompt?} re-activates an Agent while its Run is active; off by default, never routes or consumes maxParallelism slots, serializes with same-node work, gives run_status_get.',
  named_workflow_routing: 'Named acyclic routes and all-required joins. Return requestId may be omitted for one open received request; required for several. Explicit unmatched IDs are rejected and repair lists valid IDs.',
  run_pause_node_retry_and_steering: 'No pause, node retry, per-execution Stop or live steering.',
  checkpoint_resume: 'Automatic continuation requires accepted native approvals; no manual bypass.',
  process_exit_confirmation: 'Stop acceptance does not confirm native process exit.',
  historical_runs: 'Restore history into a new validated version before running; historical versions stay immutable.',
  run_board_history: 'Run history needs composed services and live runs:read. Run-only grants read their Runs; legacy Runs may lack snapshots.',
  resource_deletion: 'Archive retains history. Folder deletion protects registered locations, active runs, defaults and links.',
  remote_runners_and_host_browsing: 'Browse and select home folders, including symlinked projects, with location grants. Folder deletion stays inside workspace storage.',
  approval_reassignment: 'Only the accepted handler can respond to a running approval.',
  trusted_device_connections: 'Pairing authorizes connection changes. Read with global settings:read; configure or revoke directly with global settings:update and current device/consent revisions.',
  operator_self_authorization: 'Operator cannot approve its own gates or manage its delegated credential.',
  native_mcp_provisioning: 'Operator applies native MCP changes directly with harnesses:update and harnesses:read. Rediscover existing plans with harness_mcp_plans_list; apply or reject their IDs with harness_mcp_change_decide. Uncertain writes require reconciliation.',
  claude_configuration: 'Pinned app MCP only; Full access required. Saving is not qualification; host-bound checking is required.',
  codex_plugins: 'Read Codex plugins; install/remove with codex_plugin_change and harnesses:update plus harnesses:read. Recover original commandId and requestedBy with codex_plugin_operations_list under the same recovery grants, then use codex_plugin_reconcile.',
  skills: 'Workspace Markdown skills pin immutable versions; 512 KiB instructions limit. No packages/scripts/URLs or tool grants.',
  ci_jobs: 'Approved source/root and host CI qualification required. Revoked-Worker cleanup requires local-human approval.',
  permanent_reference_files: 'Scope read grants required; add/remove also need matching update grants. Operator-only.',
}
