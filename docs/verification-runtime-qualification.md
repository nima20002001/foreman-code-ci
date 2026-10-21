# Verification runtime qualification

Verification profiles retain an approved source commit, immutable image and
toolchain, offline dependency receipt, independent project quotas and a reviewed
resource envelope. A paired computer captures its installed runtime and qualifies
it directly; there is no approval step. Qualification lasts 24 hours. A Job may run
any commit whose dependency files match the qualification commit; changed
dependency files wait for a qualification with a matching offline seed.

The installed host runs install, typecheck, lint, unit and build inside rootless
containers with private network namespaces and no network. Dependencies must be
pre-seeded with the strict 2,880-minute package release-age policy. The qualifier
checks effective pnpm settings, owner-home isolation, resource usage and physical
byte/inode quota denial.

The container launcher reports `FOREMAN_CODE_VERIFICATION_ENVIRONMENT=isolated-job-v1`.
The shared `verificationEnvironment` contract describes this runtime as providing
Job-private PostgreSQL, delegated child cgroups and separately mounted read-only
Git metadata. Verification containers use Podman's systemd mode with a private
cgroup namespace. Qualification enters a child cgroup, kills a detached descendant
through `cgroup.kill`, checks its empty population, and verifies that the workload
cannot write the outer Job's memory, swap, PID or CPU limits. It rejects a shared
cgroup namespace, read-only delegation or extra cgroup mounts. Container capabilities
remain dropped and no-new-privileges remains enabled.

The image has no Docker Compose or installed Worker host
(`installedWorkerHost=false`). The Debian Job image is not an approved Worker
packaging target, and its ephemeral root does not satisfy Worker storage persistence
policy. The smoke controller reads the fixed Git mount for checkout identity and
builds; application processes retain their isolated environment.

The unit verification runner reads the same contract. Recovery-owned native outcome,
launch abandonment, process runtime, recovery, idle recovery, qualification lifecycle
and Codex protocol files run through the delegated Job subtree. Their required
inventory and completeness checks remain enforced.

The integration runner reads this contract before scheduling tests. Native
local-human isolation and Operator file-delivery/management suites require
`nativeCgroupDelegation`; the database-startup test requires `testDatabaseStartup`.
Inside a Job, `scripts/test-db.mjs up` verifies the private server's data directory
and both disposable ownership markers, then reuses it without restarting it.
Repeated startup from a copied checkout preserves active sessions and rows.
The runtime owns shutdown; checkout-level `stop` and `down` are refused. On the host,
startup continues to use the ownership-checked Compose server. The computer workflow-save regression, remote production review,
Worker chat-profile qualification and Worker profile requalification suites require
`installedWorkerHost`: a host matching an approved Worker packaging target's OS,
release, architecture, libc and Node version, with persistent root, home and
disposable-test state storage. Outside a Job the runner uses the Worker's host-fact
probe and the committed packaging targets to determine this capability, and probes
existing delegation and Docker availability without starting or configuring
services. Job declarations are read without host probing. Worker target and
persistence policy remain unchanged. Its `summary.json`
records the environment, every required file, and each unavailable file's missing
capabilities. Unavailable files have no test results, are not marked skipped or
passed, and keep the full run **incomplete with a nonzero exit**. Explicit file
selection cannot turn an unavailable file into success. Run those same files on
a host with the required capabilities to obtain their coverage; an image-only
result is not a full integration gate. The original protected test inventory and
publication completeness checks still apply. Operators can read these diagnostics
from the published logs archive using the existing scoped artifact tools.

Host integration runs started from an ordinary SSH session may have a supported
Worker packaging target and no delegated cgroup. Use
`corepack pnpm test:integration:delegated --files <integration files...>` on hosts
with an available systemd user manager. This explicit entry point runs the existing
runner in a transient user scope with `Delegate=yes`; systemd collects the scope
after the invocation. It changes no persistent service, ownership or permission
settings. Hosts already running the suite in a delegated service can use the
ordinary entry point. Native containment remains required in both cases. A refused
guardian launch reports `NATIVE_CONTAINMENT_UNAVAILABLE`; an uncontained CLI command
succeeding by hand does not establish native qualification.

Each ordinary suite closes its original container before reports are finalized
and published through the canonical Job file store. Publication verifies the
declared byte limits and reads retained bytes back by file ID, revision and hash.
Exit zero or a report left in the workspace does not qualify a profile.

Additional diagnostics run an ordinary suite, exhaust the same Job quota, and
remain active for cancellation and the original execution deadline. The host
stops their owned container and descendants. The shared Job finalizer reclaims
only the closed workload's caches and consumes a protected report reservation.
Partial counts, failures and cancellation/timeout outcomes remain visible in
bounded summary, JUnit, Vitest and log artifacts. Storage capacity is released
only after the original qualification owner has closed and reclaimed its quota.

Operator MCP can save/request/run/read qualification using the existing tools.
Verification qualification requires `job_definitions:write`, `jobs:start` and
`job_artifacts:read`. Measured qualification records
include diagnostic execution IDs and canonical artifact references. Operators
read them through `job_get`, `job_artifacts_list` and `job_artifact_read`; ordinary
verification Jobs use `job_choices_get`, `job_definition_save` and `job_start`.
The separate host CI tools run repository scripts directly on build computers:
`ci_run` starts a suite, `ci_get` reads its state and optional log tail,
`ci_computers_list` reads readiness, `ci_logs_read` pages log text, and
`ci_cancel` stops a run. Workflow Agents use these tools within their Run workspace.
While waiting, use `ci_get` with `waitSeconds: 60` and `logTail: false`. The server
waits for the ticket’s state or step to change, returns terminal tickets immediately,
and otherwise returns at the deadline. Canceling the MCP request ends the wait.
Omitting these inputs keeps immediate reads with the 32 KiB log tail. Read logs once
at the end with `ci_logs_read`.
Generated qualification definitions retain historical diagnostic commands and
reports; create ordinary verification Jobs from the authoring templates.

The physical acceptance file is
`apps/api/test/job-verification-qualification.acceptance.test.ts`. Its protected
inputs are `FOREMAN_CODE_VERIFICATION_QUALIFICATION_CONFIGURATION`,
`FOREMAN_CODE_VERIFICATION_QUALIFICATION_PROFILE` and
`FOREMAN_CODE_VERIFICATION_QUALIFICATION_QUEUE`. These identify an installed
image, offline seed, actual enforced quota pool and approved source/profile
configuration. Run it through the root acceptance runner on the approved host.
It also exercises authenticated MCP denial, creation, execution, cancellation and
persisted report readback. Fixture tests do not establish physical qualification.

Installer capture is covered by
`apps/api/test/installed-verification-runtime-capture.acceptance.test.ts`, using
`FOREMAN_CODE_VERIFICATION_QUALIFICATION_CAPTURE_INPUT` and the protected profile
input. It reads actual kernel quota state, hashes the selected binaries and seed,
and checks metadata restoration after host restart. It does not substitute a
quota observation or mutate the installed seed.

Single-device physical qualification belongs to Phase 2. The two-computer
Codex-to-Codex gate belongs to Phase 5. Claude two-computer cases remain
untested. Provider credentials stay on their original computers; real Claude
qualification or acceptance turns explicitly use `claude-haiku-4-5-20251001`.

Runtime timing and retention follow these policies:

- Main compares the authenticated Worker's clock with its own at connection and heartbeat.
  An offset greater than two minutes blocks new qualification and readiness; the connection,
  harness registry, runtime qualification, and build-computer readback expose the reason.
  Worker qualification deadlines and measurement timestamps use Main's clock, advanced by
  elapsed time between observations. Recovery may close already admitted operations while
  new entry remains blocked.
- Completed Jobs and qualifications leave the bounded Worker/Main journal after 30 days,
  once native processes and containers are closed, logs are acknowledged, and source and quota
  ownership are released. Retirement runs on journal open and mutations. Worker retirement
  waits for a Main clock observation after startup or disconnection. Cold records retain
  historical results and identity tombstones for duplicate commands and current runtime
  references, without keeping their images in the pruning set. Existing qualifications without
  a finish timestamp start their retention period when their completed state is first observed.
- Both CI image-build stages have explicit CPU and memory limits of half the computer's
  available CPUs and memory. Builds run one stage at a time; swap cannot enlarge the memory
  budget. `build_computer_prepare_get` returns these values as `preparationLimits` and retains
  them across Main restarts.
- A queued ordinary Job keeps its captured commit, snapshot, and root binding when the root
  head advances. Current authorization, registration, root policy, and runtime qualification
  are still checked before materialization and admission.
- Agent attempts with a committed native non-submission seal are refunded from the workflow
  execution limit. Launched and uncertain attempts continue to count. Historical execution
  records remain available after a refund.
