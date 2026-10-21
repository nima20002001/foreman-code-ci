# Live cross-computer CI acceptance

Run this against an already-running production Main and its paired Worker. All installation, preparation and execution
steps below belong to the orchestrator. The test author does not deploy or run any gate.

One Vitest test runs rounds 1 and 2 consecutively. Each round creates two workflows in each of two workspaces. Each
workflow has a coordinator followed by three parallel Codex Agents, each in its own product-managed Git worktree and
branch. Project `graphql` requests build, lint and integration; project `demo` requests build, lint and unit. All twelve
CI requests come from the Agents' authenticated `ci_run`, without a commit override or a computer selector. Integration
requests use two partitions; check and unit requests use the current automatic parts/shards. All tickets must pass.

Every scenario Agent uses `gpt-6-luna`, `reasoningEffort: medium`, standard tier and `sandbox: workspace-write`. There
are 32 scenario Agent executions across both rounds, plus the host profile checks. This consumes real model and CI usage.

## Production setup, in order

1. Integrate the acceptance commit and the intended runtime fixes into the production source. The orchestrator uses
   the existing installation procedure (`corepack pnpm production:install` from that source checkout). Read the
   production Main's installed revision and readiness. Through Operator MCP, update the paired Worker using
   `computers_maintenance_start` with `{commandId: <fresh UUID>, task: {kind: "update-worker"}, targets: [<current Worker provisioning target>]}`;
   follow `computers_maintenance_status` until its installed release matches Main and it reconnects. A provisioning
   target retains `{hostRef, applicationInstallationId, keyRevision, authorizationRevision}` from production readback.
   Do not change SSH, network, security or router configuration.
   Main must have qualified execution-semantics-3 Start/Stop support; the Worker must serve `ci-host-v1` and the native
   Agent dispatch protocols. Keep Main and the Worker running throughout both rounds.

2. Prepare two distinct GitHub repositories at known clean commits and two distinct workspace IDs on this Main.
   The first repository contains the production Foreman Code source, including integration tests. The second is a
   disposable, separate repository containing a working Foreman-compatible monorepo fixture. Current full Host CI
   parts invoke `@foreman-code/contracts`, `@foreman-code/api`, the web/worker packages, `test:scripts`,
   `scripts/ci-unit-files.mjs` and `scripts/ci-suite.sh prepare`; a single-package demo cannot exercise these parts.
   A separate sanitized copy of the same monorepo is sufficient for project 2. Both repositories need the pinned
   package manager, lockfile, real build/lint/unit scripts and unit tests. Push the commits to their configured default
   branches; keep the source workspace checkouts on those commits with no unrelated modifications.

3. Create the workspaces through `workspace_create` with a fresh `commandId`, a unique `name` and an existing approved
   `parentPath` on Main (or reuse the two intended workspaces). Read each with `workspace_get`. Set its repository with
   `workspace_update` using `workspaceId`, fresh `commandId`, the returned `expectedRevision`, and
   `repository: {provider: "github", owner: <runtime owner>, name: <runtime repository>, defaultBranch: <runtime branch>}`.
   Clone the appropriate repository into the newly created empty directory returned by `workspace_get` and check out
   the prepared commit, or retain the correct checkout when reusing a workspace. Read back the saved repository and
   location revision. Use workspace location validation to confirm a ready local checkout on Main; its Git origin
   and commit must match the repository. Main's authenticated GitHub account needs
   fetch and push access: `ci_run` publishes each Agent's current worktree snapshot for the runners to fetch.

4. Adopt each host's pairing-approved root configuration with
   `workspace_root_configuration_adopt({workspaceId, hostRef, commandId: <fresh ID>})` if not already persisted.
   Read `workspace_root_choices_list` and prepare a product-managed writable root for each workspace on each host.
   The location validate/set tools take `{workspaceId, hostRef, allowedBaseId, configurationRevision, relativePath,
   accessMode: "exclusive-write", expectedLocationRevision, expectedRootPolicyRevision}` from the approved
   choice/readback; set also takes a fresh `commandId`. For a new policy use `expectedRootPolicyRevision: 0`.
   Validate before setting. Return the primary workspace location to Main before approving/binding the source,
   then read its latest location revision. Approve the pinned tracked source with `source_approve`: supply `workspaceId`, a fresh
   `commandId`, `expectedLocationRevision` from `workspace_get`, the full commit SHA, and
   `executablePolicy: "preserve-approved"`. This preserves the ordinary sensitive-file and executable checks. Read
   `workspace_root_choices_list` for Main and the paired Worker. Bind the approved source on both hosts
   with `source_root_bind`: pass its returned `{approvedSourceId, snapshotId, manifestDigest}` as `source`, the current
   root choice's `{hostRef, rootPolicyId, rootPolicyRevision, locationRevision}` as `selection`, a fresh `commandId`,
   `expectedBindingRevision: 0` for a new binding (otherwise the saved revision), and `accessMode: "exclusive-write"`.
   Read `source_root_list`/`source_root_get` to confirm the repository, source and writable roots. Do this for BOTH
   workspaces. Resolve source quota, attestation or root failures through the supported setup; do not grant bypasses.

5. On Main and the Worker, install the supported Node/Corepack/Git/Codex toolchain, PostgreSQL tools, Docker/Podman
   prerequisites required by the repository, and a working user systemd session. Sign in to Codex locally on each
   computer. Verify `gpt-6-luna` and medium reasoning are available in its native model inventory. Read
   `harness_registry_get` for each host: the installed Codex fingerprint and application installation must be current,
   and the Worker connection phase must be `ready`. Copy the Worker's current connection `binding` fields
   `workerInstallationId`, `keyRevision`, `authorizationRevision` into the private input's `registration`.
   Main's registration is `null`. Do not copy native account files or credentials between computers.

6. Ensure GitHub CLI is authenticated in the actual Main/Worker service environment (use the product's computer
   GitHub login flow or `gh auth login` locally). Both accounts must be able to fetch the source repositories;
   Main must also push snapshots and mirrors. Read `build_computer_get` with the current provisioning target. Enable
   both build computers with `build_computer_update`, preserving the current target identity, using the read revision
   as `expectedRevision`, `buildEnabled: true`, an ordinary priority (for example 50) and an optional
   `commandId` (generated server-side when omitted).
   Read `ci_computers_list` for each workspace: both physical host refs must appear with `ready: true`. Host CI runs
   directly in runner Git worktrees under user systemd; retired verification-template qualification, OCI Job queue
   tickets and `build_computer_prepare` are not prerequisites for this Host CI acceptance.

7. For cloud coverage, provide a separate disposable PUBLIC CI mirror for each repository. Seed its `main` branch
   with the sanitized repository tree, `.github/workflows/ci.yml`, `.circleci/config.yml` and the matching
   `scripts/ci-suite.sh`/selection scripts. Enable GitHub Actions workflow dispatch, and follow the mirror project in
   CircleCI if using that provider. Update each workspace with revision-checked `workspace_update` and
   `ciMirror: {provider: "github", owner: <runtime owner>, name: <runtime mirror>}`; read the persisted result. Main must be signed in to
   the corresponding CLIs (`gh auth status`, and `circleci auth me` after local login) with mirror push/dispatch/read
   permission. CircleCI currently accepts integration partitions only. Keep provider capacity available for the
   concurrent requests. List the desired cloud host refs in that workspace's private `ciComputers`; the test requires
   them to be ready and requires at least one ticket per configured provider in that workspace. The scheduler chooses
   provider/slot automatically. Physical build computers are still required to perform work on at least two hosts.
   Main's mirror guard must accept the entire published tree: remove existing private identities from the source
   before using a public mirror. A guard rejection is a setup failure; never disable or weaken the guard.

8. The test creates and checks one host-local Codex profile per Agent computer through `harness_instance_save` and
   `harness_instance_check`, using `local-default:codex` and the configuration above. It then stages/saves each graph,
   reads `workflow_node_placement_choices` for every Agent, selects a ready placement matching that checked profile
   and host, and saves/readbacks the placements. Every node has its own Agent identity. No pre-created scenario
   Agents or workflows are needed. Source/root and native model readiness must be established in steps 4–5 first.

9. Issue a fresh manage Operator credential against the production Main database, plus a separate read-only
   credential. Use the installed Main's environment and credential CLI, with `--access manage` and `--access read-only`
   respectively and a lifetime covering the nine-hour maximum test duration. The writer requires both workspace
   scopes and the global harness read/update grants; a global manage credential provides these. A global read-only
   credential can read both workspaces but cannot Start or request CI. If using `operatorCredentials.ts`, redirect its
   one-time output into private files with `umask 077`; never print, paste into documentation, or commit the output.
   The denied `run_start` and `ci_run` calls must return `ACCESS_DENIED`, not an expired-token authentication failure.
   No Agent receives the Operator token: Start supplies normal Run-scoped Agent credentials and grants.

10. Host CI activity must use `job_work`, `refs.ciTicketId` and the initiating `refs.executionId`, with the
    correct Agent owner and Run scope. Each ticket needs queued activity followed by its terminal activity.
    Starting/running observations are optional: fast tickets can finish between reads. Ticket discovery uses
    Operator `ci_list` and activity references, and checks `ci_get` initiators; Agent reports contain judgments only.

## Private runtime input

Use the existing `CrossComputerCiInputSchema`, supplied by `FOREMAN_CODE_CROSS_COMPUTER_CI_INPUT`. Store the JSON outside
all source repositories and CI mirrors, in a private directory; the regular file must have mode 0600 and be under
64 KiB. Fill the following placeholders from production readbacks. The two `workspaceId`s and repository settings
must differ. Agent computers use only Main/device host refs; cloud slots are CI runners, not Agent placements.

```json
{
  "endpoint": "<production Main MCP URL ending in /mcp>",
  "token": "<manage Operator token>",
  "deniedToken": "<separate read-only Operator token>",
  "evidenceDirectory": "<absolute private evidence directory outside Git>",
  "workspaces": [
    {
      "workspaceId": "<project 1 workspace ID>",
      "project": "graphql",
      "computers": [
        {"name": "<Main display name>", "hostRef": {"kind": "main", "mainId": "<Main UUID>"}, "registration": null},
        {"name": "<Worker display name>", "hostRef": {"kind": "device", "mainId": "<Main UUID>", "deviceId": "<Worker UUID>"},
         "registration": {"workerInstallationId": "<Worker installation UUID>", "keyRevision": 1, "authorizationRevision": 1}}
      ],
      "ciComputers": [
        {"kind": "cloud", "mainId": "<Main UUID>", "provider": "github", "slot": 0},
        {"kind": "cloud", "mainId": "<Main UUID>", "provider": "circleci", "slot": 0}
      ]
    },
    {
      "workspaceId": "<project 2 workspace ID>",
      "project": "demo",
      "computers": [
        {"name": "<Main display name>", "hostRef": {"kind": "main", "mainId": "<Main UUID>"}, "registration": null},
        {"name": "<Worker display name>", "hostRef": {"kind": "device", "mainId": "<Main UUID>", "deviceId": "<Worker UUID>"},
         "registration": {"workerInstallationId": "<Worker installation UUID>", "keyRevision": 1, "authorizationRevision": 1}}
      ],
      "ciComputers": [{"kind": "cloud", "mainId": "<Main UUID>", "provider": "github", "slot": 0}]
    }
  ],
  "excludedComputers": []
}
```

Replace both displayed registration revisions with their live values. `ciComputers` is optional and defaults to `[]`;
omit a provider you did not configure. Cloud identity includes `provider` (`github` or `circleci`) and a zero-based
`slot`. Optional `excludedComputers` now uses `{workspaceId, hostRef, reason: "offline" | "refusing"}`; Host CI does
not consume an old Job target/root. Supply only computers already unavailable: the test observes their advertisement
and confirms they never execute its work; it does not disconnect or revoke a computer. Keep evidence out of Git:
it contains runtime identities, worktree locations and CI log text. Both input tokens are redacted from evidence.

## Orchestrator commands

If fresh credentials are needed, set the following variables from the installed production deployment and execute
on Main. These commands write their one-time credential output only to private files:

```sh
umask 077
mkdir -p "$SCENARIO_PRIVATE_DIRECTORY"
cd "$PRODUCTION_MAIN_API_DIRECTORY"
set -a
. "$PRODUCTION_MAIN_ENV_FILE"
set +a
node --import tsx src/cli/operatorCredentials.ts issue --name ci-scenario-writer --days 1 --access manage \
  > "$SCENARIO_PRIVATE_DIRECTORY/writer-credential.txt"
node --import tsx src/cli/operatorCredentials.ts issue --name ci-scenario-reader --days 1 --access read-only \
  > "$SCENARIO_PRIVATE_DIRECTORY/reader-credential.txt"
```

Populate the input tokens from those private files without printing them; protect the completed input with
`chmod 600 "$SCENARIO_INPUT_FILE"`. Use the CLI from the installed source checkout (or its equivalent installed
compiled CLI) and its existing production environment. Do not point it at the isolated test database.

From the integrated test checkout, prepare dependencies and compiled shared contracts once:

```sh
corepack pnpm install
corepack pnpm --filter @foreman-code/contracts build
```

Set the variable to the existing private input file without printing its contents, then run from the repository root:

```sh
export FOREMAN_CODE_CROSS_COMPUTER_CI_INPUT="$SCENARIO_INPUT_FILE"
corepack pnpm --filter @foreman-code/api exec vitest run --config vitest.cross-computer-ci.config.mjs
```

The dedicated config selects only `test/cross-computer-ci.acceptance.test.ts`; it has no local application startup,
test database provisioning, resource setup or default unit/integration suite. Run this command once: the one test
already runs the entire scenario twice consecutively and gives every round a fresh set of workflows/commands.

For the separate helper gate, the orchestrator can run these behavior tests with the ordinary API test environment:

```sh
corepack pnpm --filter @foreman-code/api exec vitest run test/cross-computer-ci-input.test.ts \
  test/cross-computer-ci-graph.test.ts test/cross-computer-ci-readback.test.ts \
  test/cross-computer-ci-activity.test.ts test/cross-computer-ci-tools.test.ts
```

Each round writes `cross-computer-ci-<invocation UUID>-round-<1 or 2>.json` with mode 0600, checkpointed every 30 seconds
and at completion/failure. It records workflow/version/Run IDs, placements, worktrees, Agent states and JSON reports,
every ticket's sampled state/computer timeline, complete terminal logs, group readbacks and paged Run activities.
Execution pages, accepted placements, CI lists, group log readbacks and workspace-isolation responses are included
in the same file. Collection waits for readiness and published activity/worktrees/logs with bounded deadlines.
The verifier requires successful workflows, one success per Agent, separate Agent branches and worktrees, CI on
at least two computers, correct ticket owners, quoted log lines and activity confined to its own Run. It collects
all verification failures before throwing. Concurrent queue and starting/running samples are not pass criteria.

Replay a saved round without credentials, a database, or a running application:

```sh
FOREMAN_CODE_CROSS_COMPUTER_CI_REPLAY="$SAVED_ROUND_FILE" \
  corepack pnpm --filter @foreman-code/api test:ci-scenario:replay
```

The dedicated replay config runs only the pure `verifyScenario(recorded)` checks, usually in seconds. With no
replay path it checks the small synthetic fixture. A passing live invocation requires two `status: passed` files
and a successful Vitest exit. On failure the scenario retains collected readbacks, stops its Runs, cancels
nonterminal tickets, records cleanup errors and closes its clients. Keep runtime JSON outside Git.

## CI PostgreSQL reuse

Host CI retains one disposable PostgreSQL Compose project per build computer.
`FOREMAN_CODE_CI_POSTGRES_CACHE` optionally selects a separate cache for a slot;
the default is the computer account's cache directory. Startup is serialized
with `flock`. The server keeps its disposable ownership labels and a random
loopback port. Cloud and isolated Job runtimes keep their existing database
startup paths. If the persistent server cannot start, Host CI uses its private
per-job server and removes it during job cleanup.

The cache stores templates by the SHA-256 of ordered migration versions and SQL
contents, separated by server endpoint. PostgreSQL advisory locks serialize
template creation. Templates retain their ownership markers and reject client
connections. Each job or integration slot clones a writable database and gets a
fresh application installation identity; cleanup drops these databases and
retains the template. Changed migrations create a different template, allowing
concurrent jobs on older commits to finish. An unavailable template cache falls
back to the job's migrated template.

The affected `ci-postgres-setup.integration.test.ts` benchmark logs
`before-db-setup`, `cold-db-setup`, and `after-db-setup` integration phases in
milliseconds. These include server startup, importing and applying migrations
when needed, and cloning one database. The separate `*-server-startup` phases
measure startup alone. Run this through Foreman CI on a build computer or a
Docker-capable cloud runner; do not run it on the Agent computer.

Repository hygiene is automatic: `test:scripts` discovers every `scripts/**/*.test.mjs`,
including nested helpers, and verification captures the same inventory. Application
migrations retain their stored versions and registration order; startup rejects
duplicate versions before acquiring a database connection. No migration ranges
need to be reserved between worktrees.

Test-file durations live in `ci_file_durations` and finished `ci_runs`. Host and
cloud runners receive the same database snapshot for planning; unmeasured files
use median or equal weights. Duration artifacts are transient report inputs and
outputs, including `scripts/ci-learned-durations.json` in generated cloud snapshots.
Do not commit timing measurements to the source repository. Operator MCP CI tools
use this automatically without additional input, grants, or manual updates.
