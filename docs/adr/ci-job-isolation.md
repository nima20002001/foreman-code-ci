# CI job executor and isolation qualification

CI-A owns `apps/api/src/modules/jobs/executor*.ts` and the three
`scripts/fixtures/ci-*.mjs` fixtures. The executor accepts the shared immutable
JobExecution; it does not create an Agent, provider session, scheduler, database
or remote connection. W07 supplies the surviving worker service and carrier;
W08 supplies durable claims, cancellation, current authority and attempt/owner
fencing; W09 verifies private Git source and publishes declared output bytes.
Lane B composes these ports and its durable result/log sink into production.

`createJobWorkerHandler` is the carrier entry. Its settlement callback must
check attempt and owner and persist observed process outcome independently of
publication. A reconciliation claim returns recoveryRequired with no spawn;
missing container evidence is uncertainty. A lost launched receipt does not
erase an observed exit. A terminal execution cannot be launched again.

The sole implemented isolation profile is qualified offline rootless Podman.
There is no installed or qualified profile implied by this source change.
Physical qualification is now produced by `modules/jobs/qualification.ts`
through the actual reserved HRT spawn/exit/cleanup primitives. The Ubuntu/ext4
storage profile and exact H2 review manifest are in
[ci-ext4-runtime-profile.md](ci-ext4-runtime-profile.md). Ordinary unbounded
ext4 and the earlier XFS proposal cannot qualify this active profile.
The controller supplies an absolute verified runtime path, allowlisted
controller environment and a persisted, human-approved qualification record
with exact Podman/OCI/kernel/toolchain/image versions and tested cgroup v2,
filesystem quota, process containment, CPU/memory/pids/disk controls. W07/W08
recheck current identity/capability/revocation against the accepted placement.
W09 source verification must prove a private usable Git repository, accepted
canonical directory identity, inputs/source digests, and enforced disk quota.
No external Git common directory, hooks, helpers or credentials may enter it.

The actual Node CLI adapter uses closed stdin and piped stdout/stderr. Podman
create pins an existing image digest (`--pull=never`), private namespaces,
read-only image, one quota-bound private source mount, bounded tmpfs, dropped
capabilities, no-new-privileges, no network, finite CPU/memory/pids limits,
cleared default environment and no restart. Controller/transfer authority stays
outside this mount. Approved dependency network access or secret environment
scopes are unsupported and fail closed; they need a separately qualified
profile rather than a fallback. Local repository development installation is
separate from any real worker installation/preparation approval.

Each launch has a deterministic name and exact spec/attempt labels. Inspect,
wait and stop use the immutable container ID and validate its labels; no bare
PID is killed. Terminal cancellation/timeout and resource release require
positive stopped-container evidence under the qualified descendant-containment
contract. Unknown state retains ownership for W08 reconciliation. No container
is automatically removed; W08 releases retained evidence after durable receipts.

Worker timeout runs independently of the main connection. UTF8 logs are bounded
and serialized into the durable sink. Half of the accepted spool byte budget
is reserved for bounded retained OCI logs, half for sink chunks. Runtime log
rotation/control framing and root quota must be included in qualification.
Reconciliation conservatively exposes `logGapPossible` until W08/B recovers
retained logs with an acknowledged cursor; it never claims lossless replay.
Log or output storage errors preserve the observed process exit. W09 output
collection only follows positive quiescence; the local helper opens directory
components and regular files no-follow, rejects hard links/special files, and
bounds aggregate bytes. It does not publish a canonical file revision.

Tests use supervisor/CLI doubles and temporary output files. They are focused
contract tests, not live isolation, reboot/reconnect or laptop qualification.
Only the orchestrator runs integration/laptop acceptance after explicit human
installation, source/root, capacity, runtime/image and readiness gates.

## Offline verification runtime

Verification keeps the same rootless Podman controller, original OCI identity,
command-release gate, journal ownership, watchdog and descendant closure. Its
executor retains the full version 2 execution and accepted spec. Versioned
digest validation and W09 physical Git/input validators are mandatory injected
ports; no security fields are discarded to use build-only adapters. The same
supervision function handles cancellation, timeout, logs and output collection
for build and verification executions.

The verification image has a reviewed, immutable dependency seed. Corepack
checks committed dependency inputs and effective strict 48-hour policy before
commands. Installs are offline/frozen and include dev dependencies, with a
private writable store and registry cache. A missing entry fails preparation.
There is no dependency acquisition in a Job or network-mode fallback.

Small control `/tmp` stays private, nosuid/nodev/noexec and explicitly sized.
Workload scratch, package extraction and fresh HOME/XDG state use a private
`job-scratch` sibling in the accepted quota namespace. Its bind preserves
nosuid/nodev, with execution allowed only by the reviewed resource request.
Private IPC and explicit shm size charge shared memory to the Job cgroup.
CPU/memory/pids/swap limits remain enforced; host homes, sockets, IPC and
network namespaces are never added. The admitted observation tool checks actual
mount flags, namespace separation, cgroup limits, scratch execution, effective
package policy and controller sentinel absence. A declared flag is not evidence.

Report capacity is physically allocated outside container mounts before entry.
After persisted positive closure and publication authorization, an interruption
writer emits an honest partial summary for timeout/cancel or missing failed
reports. Existing valid first-pass failure counts are retained. It never creates
a passing result. The original reserve inode and terminal timestamp are reused
on publication retries, and bytes return through the existing Job output path.
Collectors enforce both per-output and aggregate byte limits. Publication
failure preserves the observed process result and retained storage ownership.

Installed worker composition accepts report preparation/publication callbacks;
the versioned source/carrier/journal integration must persist their reserve
identity and original publication/cleanup deadlines. Transfer cancellation must
use those deadlines, including reconnects. No UI/MCP capability is advertised
by merely adding runtime ports. Real rootless ordinary suites, quota pressure,
timeout/cancel with descendants, and failed-report publication remain required
integration gates; unit observations do not satisfy them.
