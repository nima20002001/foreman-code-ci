# Operator MCP v1

Operator MCP is the authenticated local product-management interface delivered by NIM-2579 through NIM-2587. It runs inside the existing API process at `POST /mcp`, the one Foreman Code MCP endpoint that also serves workflow agents; an Operator credential selects the Operator role. See [`graphql-mcp.md`](./graphql-mcp.md).

The transport uses MCP protocol `2026-07-28` with the official TypeScript SDK packages `@modelcontextprotocol/server`, `@modelcontextprotocol/node`, `@modelcontextprotocol/fastify`, and the acceptance-test `@modelcontextprotocol/client`, all pinned at `2.0.0`. The packages require Node 20 or newer; this repository requires Node 22. The published packages use Zod 4-compatible standard schemas. Their July 27, 2026 publication date satisfies the repository's strict 48-hour package-age policy.

## Settings writes

`expectedRevision` is optional for app preferences, prompts, workspace/agent/workflow/harness defaults,
host harness profile saves, file retention, computer sync, Claude plugin and marketplace changes,
and native MCP changes or reconciliation. Omit it to apply the write to current state without a
preceding read. Supply it for an optimistic concurrency check: a stale value returns
`REVISION_CONFLICT` (HTTP 409). Accepted writes still advance persisted revisions.

Reuse the same `commandId` and input after an uncertain response; a retry returns the original
result rather than applying the write again. Readback returns current persisted state. Scope
checks, read-only caller restrictions, sensitive-path and credential validation still apply.
Workflow graph/version pins and host qualification checks retain their required revisions.
Native MCP changes capture the observed configuration revision internally before applying.

## Start and migrate

```sh
corepack pnpm install
corepack pnpm db:up
cp apps/api/.env.example apps/api/.env
corepack pnpm dev:api
```

API startup applies the application migrations, including principals, command receipts, management audit, revisions, archive state, durable graph drafts, and workspace execution locations. Existing workspace, workflow, agent configuration, run, execution, and activity records are retained. Existing workspaces migrate with no configured execution location, and historical runs do not receive invented paths.

Startup acquires exclusive runtime ownership before applying either migration set and retains it through startup and shutdown. The migration and credential CLIs use the same database lock; stop the API before running those commands, then restart it afterward. A command targeting an owned database fails before changing its schema.

The API remains loopback-bound by default. Operator HTTP and MCP requests validate Host and Origin. Public deployment and OAuth interoperability are out of scope for this local credential mode.

## Issue and revoke credentials

Credential issuance and revocation are trusted local owner commands; neither is an MCP tool. The plaintext token is displayed once and only its SHA-256 digest is stored.

```sh
corepack pnpm --filter @foreman-code/api credential issue --name local-owner
corepack pnpm --filter @foreman-code/api credential issue --name workspace-operator --days 7 --workspace workspace-1
corepack pnpm --filter @foreman-code/api credential revoke principal-UUID
```

Operator credentials default to no expiry and remain revocable. Use `--days` only for an explicitly finite lifetime (1–365 days). The timestamp `9999-12-31T23:59:59.999Z` represents no expiry in stored records and MCP responses. Accepted Run authority is independent of the starter token’s expiry; owner revocation, live scope checks, Stop and completion still apply. Operator chat credentials last for the conversation and are revoked on release; an explicitly expiring owner remains subject to its chosen lifetime.

The default `--access manage` preset includes the local human’s full supported action catalog, including provider accounts, host telemetry and CI priority. `--access read-only` retains narrow read access and excludes host telemetry, provider accounts and CI mutations. `--grant <action>` accepts any supported management action and adds it to the selected preset. Removed device-provisioning actions are rejected. Explicit grants use the credential’s selected workspace scope; workspace-scoped credentials cannot access global-only tools.

CI start and cancellation require one workspace-scoped `ci` action; high priority needs no additional action. CI reads retain the job, log and artifact read actions. Agents remain limited to their active Run workspace.

The optional `--audience worker` flag creates a Worker-audience credential. At `/mcp` it is limited to the Agent tools of its bound role; it cannot call Operator tools.

To enroll the browser, open Settings and paste the one-time-visible token into Operator access. The API validates it and sets a SameSite Strict, HttpOnly cookie. The token is not written to Vite configuration or localStorage. Real mode is enabled with:

```sh
corepack pnpm dev
```

## Client configuration

`ci_run`, `ci_cancel`, `ci_enrollment_update`, `build_computer_prepare`, `build_computer_update`, and
`build_computers_update` accept an optional `commandId`. Omit it for a new operation; the server generates
an ID. Supply the same ID and unchanged input to replay an uncertain request. Explicit IDs reused with
different input still reject with `COMMAND_ID_CONFLICT`; omit the ID when changing the request.

`ci_enrollment_get` returns persisted enrollment controls and per-template results for each build computer.
An enabled, connected computer in a workspace without active runtime profiles reports `templates-required`,
including before enrollment has been enabled explicitly. Save a verification profile with
`job_runtime_profile_save` to provide the template that automatic enrollment derives and prepares.
Verification clones keep the template's resource envelope, including disk, scratch and inode budgets.
A computer that cannot fit that envelope reports `storage-required` for the template instead of a smaller clone.
Other templates continue enrollment and preparation; mixed results use computer state `partial`.

Ordinary Job templates report `not-enrolled-automatically`. Their protected runtime configuration uses a different
installed format from verification runtimes, and automatic enrollment does not select or prepare that configuration.
Use the existing explicit protected runtime setup and qualification workflow for ordinary Jobs.
`ci_enrollment_update` retains its preparation grants, revision checks and idempotent commands; disable serializes
with new placement while preserving selections already accepted. Enrollment reads require `job_definitions:read`.

`source_approve` automatically captures the complete tracked tree of the pinned Git commit
without a path inventory or approval flag. It requires `source_roots:bind`, `sources:read`,
and `workspace_locations:read` in the workspace; read-only callers cannot capture.
Capture excludes later commits, index changes, and untracked files, and retains
sensitive-path and private-key rejection, executable policy, source size and entry
limits, and manifest verification. The request and resolved inventory are audited.
Read back the retained manifest with `source_get`. Source validation failures return their
public `SOURCE_*` code and message through MCP and the corresponding status through HTTP.

Use an environment variable for the token; do not place a literal credential in a checked-in file.

The managed **Add Foreman Code MCP** preset in Harness Settings is the normal setup. For a fixed manual entry, Codex CLI `0.154.0` supports Streamable HTTP and an environment-backed bearer token:

```sh
export FOREMAN_CODE_MCP_TOKEN='token-shown-by-the-issue-command'
codex mcp add foreman-code \
  --url http://127.0.0.1:3000/mcp \
  --bearer-token-env-var FOREMAN_CODE_MCP_TOKEN
```

Claude uses the saved harness configuration's `mcpServers` entry for the app
endpoint. Read `claude_setup_options_get`, select the explicitly authorized
Full access profile, and save through Harness Settings or the shared Operator
MCP services. Credentials are issued for the accepted native process.

MCP tool input schemas accept and strip unknown fields at every typed object
level before invoking domain services. Known fields, grants, scope, revisions
and command conflicts are still validated. Open record/map payloads keep their
keys; HTTP, output and persisted schemas retain their existing validation.
`tools/list` and `operator_tool_schema_get` advertise this input behavior.

## Workflow Agent approval defaults

New Codex workflow Agents use `approvalPolicy: "never"`. Workflows can save and
Start with native handling and no routed approval handler, through both the UI and Operator
MCP. Omitted Codex advanced settings use this same default without rewriting
saved configuration snapshots. Existing explicit approval policies are retained.
An Agent explicitly configured with `on-request` and user review still needs a
routed handler; automatic review remains an explicit alternative.

`never` changes approval prompts only. The saved sandbox, sensitive-path
rejection, credential protection, scoped MCP access and read-only Agent limits
still apply. Operator tool schemas expose the shared approval-policy contract;
`run_start` uses the same admission service as the UI.

## Tool catalog

Device provisioning, repair, resource-policy application, and runtime approval have no
Operator implementation and are not advertised as tools. There is no `devices:provision`
grant or once-per-device runtime approval requirement. Existing device pairing, connection,
and build-computer tools retain their supported contracts and scope checks.

`computers_maintenance_start` with `sync-mcp` uses the same fleet service as
Settings and requires global `settings:update`. It copies supported user-level
definitions without inline secrets. Disabled servers, native tool allow/deny
lists, and stdio environment-name references are unsupported because this sync
path does not restore those settings. Such definitions are skipped with a task
warning; their existing Worker entries are preserved. Configure these settings
on each computer separately. Only fleet-managed entries genuinely absent from
an available Main catalog are removed. Read persisted task outcomes through
`computers_maintenance_status` with global `settings:read`.

Maintenance uses device namespace `computer-maintenance-v2`, version 2. Main
refuses requests to a computer advertising only the previous namespace before
dispatching native work. An unresolved maintenance request must reuse its
original `commandId` and input: Main retains its target selection and source
catalogs before dispatch, and each receiver saves the command before native
work. Interrupted work is reported rather than automatically repeated. The
receiver retains command receipts separately from its 20 recent tasks.
Equivalent requests share only the latest queued task. Worker CI refresh waits
for accepted maintenance and rejects new maintenance starts while draining;
status remains readable. A nonempty MCP catalog cannot be marked delivered
while its harness is absent. A restart task remains running during the delay;
success means the reboot command was accepted, and reconnection must still be
checked in computer status.

Native MCP settings reads reuse unchanged user configuration for at most five
minutes. Expired reads wait for inspection and return its failure if it cannot
complete; Settings shows the error and disables writes until a successful read.
HTTP workspace diagnostics and `harness_mcp_detection_get` both validate the
saved directory identity before inspecting native configuration.

- Context: `operator_get_capabilities`
- Harnesses: `harness_list`, `harness_get`, `harness_defaults_update`
- Workspaces: `workspace_list`, `workspace_get`, `workspace_create`, `workspace_update`, `workspace_archive`, `workspace_batch_archive`, `workspace_location_validate`, `workspace_location_set`
- Workflows: `workflow_list`, `workflow_get`, `workflow_create`, `workflow_update`, `workflow_reorder`, `workflow_archive`, `workflow_batch_archive`
- Agents: `agent_list`, `agent_get`
- Graph: `graph_draft_open`, `graph_draft_get`, `graph_draft_apply`, `graph_validate`, `graph_save`, `graph_draft_discard`
- Runs: `run_list`, `run_get`, `run_events_list`, `run_start`, `run_stop`

Tool discovery is caller-specific. Every call rechecks the live credential, audience, action, and resource scope. MCP annotations are descriptive client hints and never authorization. Host-path inspection and updates use the separate `workspace_locations:read`, `workspace_locations:validate`, and `workspace_locations:update` grants; ordinary workspace read/rename authority does not grant them.

## Workspace execution locations

Each executable workspace owns `{ runnerId, rootPath }` plus a location revision. Only the stable local runner ID `runner-local` is supported in this release. Validate and save an existing directory in Workspace Settings or with `workspace_location_validate` followed by `workspace_location_set`. Validation runs in the API process on the runner machine, resolves symlinks, stores the canonical destination, checks directory access, and never creates, moves, deletes, changes permissions on, or runs hooks inside the selected folder.

New runs require the current location revision. Start atomically stores the exact saved workflow version, canonical runner directory, location revision, directory identity, and accepting authority with the Run. A settings change affects future runs only. Every node in an accepted run—including nodes launched later—uses that snapshot; a missing, replaced, inaccessible, or no-longer-authorized location fails explicitly without falling back to the API directory, home, or temporary storage.

The selected project directory is the harness `workingDirectory`. Foreman Code scratch data remains under `HARNESS_WORKSPACE_ROOT` as a distinct `runtimeDirectory` keyed by workspace, run, node, and attempt. Project and runtime roots may not contain one another. Cleanup and cancellation never delete the selected project directory.

This establishes where native agents start; it is not a filesystem sandbox. Codex/Claude native permissions and future runner isolation remain separate controls. The Settings copy states this explicitly.

`graph_draft_apply` accepts typed agent, node, edge, execution-limit, and required-agent-count operations. A workflow may declare `requiredAgentCount`; validation, Save, and Start then reject any graph whose number of distinct referenced agents differs. Batches and Save require the expected revision. Save creates an immutable workflow version but does not Start. Start requires that exact current saved version and the expected workspace location revision, and returns a durable Run ID before asynchronous execution.

Current `workflow_save_v3`, `workflow_validate_v3` and `workflow_edit_v3` check `expectedRevision` for workflow concurrency. Immutable workflow version and Agent configuration IDs select the authored snapshots; later Agent heads do not invalidate them. Node names, labels and layout use last write wins and require no presentation, geometry or workspace location baseline. Staged shared-Agent mutations check the base revision of only the Agents being changed. Command retries, scope checks and affected Run settlement still apply. `workflow_create.initialSave` accepts `{graph, expectedAgentConfigurationVersionIds}` without a location revision.

Workspace and workflow navigation and directory lists show 5 items initially; each “Show more” request adds 10 items. MCP callers use `workspace_list` / `workflow_list` with `limit` and pass `pageInfo.nextCursor` as `cursor` until it is null. The active navigation selection can also be read directly by ID without fetching intervening pages.

Workspace detail returns the newest 2,000 eligible Run summaries (unfinished Runs, pending cleanup, and the 20 most recent completed Runs). A larger set is truncated without changing stored Runs. Use `run_list` and its cursor to read older Runs through Operator MCP. Current node projections read at most 2,000 resolution rows, newest first. Internal native checkpoints keep the newest operations within 120,000 bytes instead of rejecting a read or valid event; truncated evidence reports unknown activity until a complete native view repairs it. Scope checks and structured-field validation still apply.

`workflow_list` returns workflows in their saved workspace order and includes `orderRevision` in compact and full pages. New workflows append to that order. Workflow creation, archive, restore, deletion and reorder change the order revision; metadata and graph edits retain it. Workflow cursors are bound to the workspace, archive filter, access scope and order revision. A changed revision returns `REVISION_CONFLICT`; restart pagination without a cursor.

`workflow_reorder` accepts `{ workspaceId, commandId, expectedRevision, workflowIds }` for at least two unique active workflows. Use `workflow_list.orderRevision` as `expectedRevision`; this revision is separate from each workflow's metadata or graph revision. The submitted IDs replace only their existing positions in the requested order, preserving omitted workflows' slots, including hidden and unloaded items. Every submitted workflow requires both `workflows:read` and `workflows:update`. Archived, missing, cross-workspace or stale selections reject the entire command. The result is `{ value: { workspaceId, workflowIds, orderRevision }, replayed }` and contains only the submitted IDs. Read back with `workflow_list`, starting a fresh page sequence. Retry an uncertain reply with the same command ID and input. The HTTP equivalent is `PUT /api/management/workspaces/:workspaceId/workflows/order`.

`workflow_batch_archive` accepts `{ workspaceId, commandId, workflows: [{ workflowId, expectedRevision }] }` for 1–100 unique workflows. It requires `workflows:archive` for every selected workflow and removes the whole selection atomically. Missing workflows, stale revisions, or active runs reject the entire batch. Reuse the same command ID and input after an uncertain response; read back with `workflow_get` or `workflow_list`. The UI labels this operation “Delete selected” and explains history retention in its confirmation. The HTTP equivalent is `POST /api/management/workspaces/:workspaceId/workflows/batch-archive`.

`workspace_batch_archive` accepts `{ commandId, workspaces: [{ workspaceId, expectedRevision }] }` for 1–100 unique workspaces. It requires `workspaces:archive` for every selection, locks workspace admission in stable order, and checks all revisions and active runs before one atomic update. It retains workflows and history, then removes app-created project folders with `workspace_locations:provision`; externally selected folders remain. Cleanup protects accepted Run directories and pending cleanup even after a workspace changes location. A cleanup failure retains folder ownership for retry with the same command ID and input; the archive may already be committed. The UI uses the same selection and confirmation flow. Read back with `workspace_get` or `workspace_list`. The HTTP equivalent is `POST /api/management/workspaces/batch-archive`.

Archive retains versions, configurations, runs, results, and activity. Active work blocks archive; archive never silently cancels work. Stop reports `accepted`, `already_terminal`, or `not_owner`; an accepted request does not claim that the child process has already exited.

## Verification and limitations

`corepack pnpm test:integration` uses the official SDK client against the real Fastify Streamable HTTP endpoint and PostgreSQL. It covers the complete discovered catalog, credential audience and scope isolation, command replay/conflicts, concurrent duplicate Start, location validation and canonical persistence, stale location writes, HTTP/MCP parity, immutable Run locations, migration, batch rollback, explicit Save/Start, archive blocking, bad Origin, revocation, and legacy HTTP mutation-bypass prevention. Process fixtures—not model output—prove both adapters receive the accepted project CWD and separate runtime storage. `corepack pnpm test:acceptance` is the separately reported live Codex/Claude gate.

The current local credential mechanism is not OAuth. Worker Tools MCP, board-agent credential delivery, remote/public access, a full Operator chat UI, memory, Files, Kanban, browser services, scheduling, and remote runners remain deferred. See [the access ADR](./adr/operator-and-worker-mcp-access.md).

### Browser editing continuity

The Board retains its private, per-tab workflow draft and unfinished agent-settings
fields across reloads and application navigation. This recovery checkpoint is browser
interaction state, not a saved WorkflowVersion or an Operator-readable shared draft.
It does not publish edits or grant permissions. Operator authoring continues through
the authenticated shared Stage/Save/read services; browser recovery adds no MCP action.

CI affected selections use safe repository-relative paths, with no file-count cap or
repository-root allowlist. Root files, `docs/`, `.github/`, and other repository
layouts are accepted by the shared file-selection schema. Absolute paths, backslashes,
NUL bytes, and empty, `.` or `..` path segments are rejected. Suite-specific file
rules still apply. Large runner-derived selections remain affected selections rather
than falling back to the full suite because of their size.

## Cleanup and large local inputs

Operators with workspace-scoped `jobs:cancel` can use
`job_cancellation_recovery_propose`, `job_cancellation_recovery_approve`, and
`job_cancellation_recovery_get`, then import the signed closure with `job_cancel`.
Browser ownership and a separate human decision are not required. Authorization
returns a five-minute signed grant tied to the original cancelled Job, revoked
Worker installation, journal digest and source claim. Live scope checks, command
retry identity and signed no-entry closure verification remain enforced; recovery
cannot start a process or restore ordinary revoked Worker access.

Native MCP configuration edits follow same-user configuration directory and file
symlinks. Backups and native writes use the resolved target, preserving the link.
Foreign-owned targets, credential storage, hard-linked files and nonregular files
remain rejected; configuration values are not exposed in tool results.

`agent_chat_send` accepts up to 1,048,576 characters of message text, including
pasted logs, through the shared HTTP/MCP contract. `workspace_folders_list` returns
100 folders per cursor page and scans at most 20,000 directory entries. Larger
folders return a partial listing with `truncated: true`; cursor pages cover that
scanned subset. Select a more specific folder to browse its contents. Allowed-root
checks and the exclusion of hidden and symlink entries remain enforced.

CI tools learn test-file durations in the CI database and pass a shared snapshot
to host and cloud runners. Operators do not maintain duration JSON files or supply
timing inputs; existing CI input schemas and scope checks apply. Script-test
inventory follows recursive discovery rather than a manually curated list.
