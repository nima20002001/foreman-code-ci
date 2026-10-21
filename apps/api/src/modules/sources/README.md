# Exact source materialization v1

The source namespace is separate from FileRevision, document upload policy and native journals. `captureGitSource` reads only exact approved Git objects with `cat-file`, verifying each commit/tree/blob against its Git object hash before deriving the SHA-256 file manifest, never archive export filters or the mutable working tree. Every tree path must be explicitly approved; secrets, symlinks, submodules and LFS pointers fail. Git history/bundle intake is unsupported in v1 rather than importing unqualified prerequisites or repository configuration. `captureExplicitSource` requires a qualified writer-exclusion adapter; it never asserts that a best-effort directory walk is coherent. Its entries describe the complete approved resulting tree; deletions and overlayBaseDigest record provenance.

`PrivateSourceSnapshotStore` is the main-only canonical byte reader/sink. Allocate its canonical mode-0700 root separately from execution roots, transfer staging and recovery. Capture failure and interrupted commit are quarantined, never exposed as ready. `PostgresSourceService` persists the accepted approval/manifest and uses existing authenticated commands/live grants/audit; this filesystem class alone does not confer API access or worker database authority. Source approvals and accepted snapshots have no backward fallback to a branch, working-copy head or latest file revision. No existing location or Run record is rewritten, and existing runner-local behavior is unchanged.

`PrivateSourceMaterializer` accepts the immutable manifest, a destination-owned RootBinding and exact W08 attempt pins. Its mandatory authorization callback must validate current W07 identity/auth revisions, placement/attempt ownership, root revisions, access mode and source approval; caller-supplied paths are never sufficient authorization. Linux procfs directory descriptors anchor component operations, with mode-0700 roots owned by the worker and ancestors protected against replacement by other principals (trusted sticky parents require worker-owned entries). Root identities include device, inode and mount ID. This qualification excludes hostile processes sharing the worker's UID or control over its private root; such a deployment must return unsupported. A filesystem or platform lacking these guarantees must not relax the sandbox.

Every materialization reserves a new UUID directory. An exclusive-write binding claims rootId exclusively across revisions; a read-only binding gives each execution its own claim, so concurrent Agents (for example a retained Orchestrator and its requester) can share the root while each attempt still serializes on its execution's claim. The materializer then verifies all entries and atomically activates only inside its fresh private reservation. References are copied, never hardlinked. Failed/uncertain claims survive restart. Only W08/W01 ownership reconciliation can release the exact receipt's claim; disconnect alone cannot. Age alone cannot release an active claim. Closed execution copies can be reclaimed under byte pressure after Run and native closure are confirmed. A failed attempt with no receipt requires explicit ownership reconciliation by the composing service; retrying blindly cannot recover authority.

Source limits: 4,096 regular files, 16 MiB per file, 128 MiB expanded/package bytes, depth 32, 30 seconds preparation and two active materializations per service. Materialization space estimates include three byte copies plus entry overhead; retained directories still consume actual free space. `PostgresSourceReservations` serializes the aggregate host/filesystem budget across main processes (1 GiB charged physical copies, four preparing operations, two active/uncertain materializations); staging and retained copies remain charged. The host transfer composition consumes the original preparation reservation. No archive extractor or document upload-limit change is included.

Approved canonical snapshots are released automatically before a capture reports
capacity exhaustion and during the existing periodic reconciliation sweep.
Active Jobs, queued tickets, source preparations, materializations, Runs and
qualifications retain their snapshots. Current runtime profiles also retain
their source, including qualified verification profiles, so qualification can
still be requested. Historical profile revisions alone do not pin bytes.

Retention starts at the latest recorded approval, binding, preparation, closure,
Job or Run use. It uses the longest referencing Job policy's `retentionSeconds`,
or one hour when no Job policy applies. Snapshot and storage locks fence
admission while cleanup checks these references. Unavailability is committed
before descriptor-anchored deletion; the capture reservation is reclaimed only
after deletion succeeds. Interrupted cleanup retries on the next sweep. Saved
source facts stay immutable: `source_list` reports `unavailable`, `source_get`
returns `SOURCE_UNAVAILABLE`, and retrying the original `source_approve` command
cannot restore the bytes. HTTP and authenticated Operator MCP share this behavior.

`resolve` verifies the exact persisted receipt, root and complete accepted source again. Native launch must consume it immediately under the same reconciled ownership and enforce the binding's read-only/exclusive-write harness security. File modes alone do not grant or implement a same-UID sandbox. `createPrivateSourceRepository` generates a new private Git object store adjacent to the verified tree, with no copied hooks, config, credentials, shared `.git`, or source history. CI receives explicit workTree/gitDirectory; the generated commit is separate from sourceCommit and cannot masquerade as the original Git identity.

The runnable focused local fixture command is:

```sh
corepack pnpm --filter @foreman-code/api exec vitest run src/modules/sources/sourceMaterialization.test.ts --maxWorkers=1
```

This command exercises local filesystem/failure/Git fixtures only. It does not close the orchestrator-only production HTTP/MCP, real carrier, physical laptop, expiry/retention, bounded overhead or native execution gates. The composing W09-C driver must run those after W07-HUMAN approvals.

The generic `PostgresWorkspaceRootPolicies` authority is independent of source/Workflow/Run/Agent. It consumes human-approved host allowlists, verifies current scoped workspace/main/device/install authority before target I/O, and keeps immutable root policy history separate from current heads. The worker-safe `rootAttestation.ts` helpers use explicit base IDs/relative folders, component-safe descriptors and actual local filesystem identities; startup verifies rather than refreshes approved facts. C mounts its existing location command/CAS and UI/MCP adapters around these ports.

`RegisteredWorkspaceSourceRoots` links source snapshots to this one generic authority. `sourceBindingHash` freezes pre-materialization source/root/actual-attempt pins, while the final W08/job dispatch digest is adopted separately on the real main transaction. `verifyPreparation` provides the actual clone stamp for spec construction; `verifyExecution` requires final dispatch adoption. Source-ready is never native entry. `InstalledSourceExecutionHosts` supplies the original-main implementation with mandatory actual-attempt/current-host authorization; remote composition uses W07/B verified bytes and the same materializer.

Additive migrations are source metadata285001 and generic roots285002. No historical root/source/Run fact is synthesized. Root owns the shared export/grant/catalog/migration-index mounts, C owns generic location adapters, HRT-C owns production DI and W08-A owns Run serialization. Source HTTP/MCP adapters share the domain service; a root-only authenticated database fixture is committed at `apps/api/test/source-admission-mcp.integration.test.ts` and was not run by this worker.
# Failed Job preparation reconciliation

Operator HTTP and MCP share the audited domain service:

- `POST /api/management/workspaces/:workspaceId/source-preparations/get` or
  `source_preparation_get`: supply either `operationId` or the original Job Start
  command as `startCommandId`. Requires `sources:read` and `source_roots:read` in
  the same workspace. Missing or ambiguous original commands fail closed.
- `POST /api/management/workspaces/:workspaceId/source-preparations/reconcile`
  or `source_preparation_reconcile`: supply `operationId` and a new `commandId`.
  Also requires explicit `sources:reconcile`. Retry that exact command after an
  unknown acknowledgment, then use the read operation for persisted results.

The original Start must be inactive and never admitted, with a recorded failure,
expired preparation deadline, or lost principal authority. Main persists a
cleanup fence before contacting the original worker. The worker checks its
protected native journal, active preparation tasks, original filesystem, and
source/native producer processes. Live or uncertain ownership stays reserved.

Closure archives the original claim and preserves private Git, transfer evidence
and receipts. Closed Worker executions also retire their immutable reference
copies after result collection and confirmed native closure, including while a
Loop Run continues. Worker workflows share one read-only checkout per source
binding when they cannot write; its files and harness remain read-only. This
keeps historical chat's accepted directory available without retaining a source
copy for every execution. Separate shared working trees keep their own retention.
Main records the remaining footprint and changes the reservation to `retained`,
freeing active materialization/preparing slots. Remaining bytes continue to count
against the aggregate disk budget. Reconciled preparations cannot regain
execution authority.

## Source storage capacity and capture retention

Main measures its private capture filesystem before admission. Execution copies
use the selected computer's pinned filesystem, CPU affinity and available memory;
paired Workers return the same shared capacity contract over the authenticated
source channel after checking the accepted allocation and approved namespace.
Missing, stale or mismatched measurements fail closed.

Ordinary storage is bounded by one quarter of filesystem capacity, up to 64 GiB.
Admission leaves at least 1 GiB or 10% of available disk space free, whichever is
larger. Every outstanding capture, ordinary execution and verification execution
is charged against that free space under the shared filesystem reservation lock.
Retained files already reduce measured free space and remain charged against the
aggregate budget. Ordinary execution concurrency is the smaller of twice the
available CPU count, available memory after its 1 GiB/25% reserve at 512 MiB per
slot, and 64 slots. At most 32 preparations may be pending. Qualified verification
pool byte and slot ceilings still apply independently.
Capacity denials include the exhausted budgets, charged usage, measured CPU and
memory, and admission limits so slot pressure can be distinguished from disk pressure.

Before an ordinary byte-capacity denial becomes final, admission reclaims the
oldest eligible retained execution copies on that host/filesystem, retrying with
a fresh measurement after each removal. Only closed copies of completed Runs
qualify. Pending Run cleanup, undelivered interactions, unsettled reviews, dirty
worktrees and shared-tree references protect their copies. Main fences the
original reservation and the authenticated Worker rechecks ownership, native
closure and filesystem identity before deletion. Each removal is logged and
audited. Interrupted removal keeps its charge and resumes through reservation
reconciliation. Verification pool budgets remain separate.

Execution copies are disposable source storage. Their removal preserves saved
Run/execution results, Git branch refs, canonical snapshots and published files.
FileRevision expiry and `file_retention` preferences continue to govern file
bytes independently. Active writer pressure remains retryable; a request that
cannot fit after eligible copies are reclaimed reports a capacity failure with
the measured limits and remaining usage.

Completed workflow executions release active source ownership after their original
native lifetime closes, including occurrences within a running Loop. Cleanup removes
their unused Main reference trees and clean Git checkouts while keeping branch refs
and commits. Dirty, untracked, or changed-branch worktrees remain charged at their
measured retained size and are retried on later sweeps. Private closure records and
non-Git shared working trees remain retained. Reconciliation visits bounded pages,
prioritizing unfinished execution releases before older retained worktree cleanup.
The Worker source handler bounds outstanding work at 64 operations, including
capacity probes and cleanup alongside admitted preparations. The authenticated
transport also applies its shared flow-control bounds.

Startup and source admission reconcile interrupted captures under both their
original command lock and a private snapshot directory lock. A finalized capture
can still be replayed by its authorized caller during the retention window and
is charged at its measured retained size. A partial capture without an owner is
marked failed. Unadopted captures become reclaimable after the one-hour retention
window only if no source snapshot references them. The failed approval fence is
committed before deletion, and the reservation is released only after physical
removal succeeds. Approved snapshots use the existing reference-aware retention
policy, preserving active Runs, workflow source bindings and qualified profiles.
Both cleanup paths release storage and row locks before filesystem removal, then
reclaim the reservation and write the audit in a short transaction. Interrupted
removal or accounting leaves bytes charged for maintenance to retry. Capacity
retries join in-flight releases and refresh execution capacity after reclamation.

Job preparation cleanup requires the original installed worker closure journal.
Already-admitted Jobs use their original execution cancellation/reconciliation path.

Workflow preparations can be addressed by `operationId` after Main has fenced
the Run for Stop or cleanup. Any session recorded on Main is pinned into the
cleanup request and must match the worker's original journal.
The same HTTP and Operator MCP operations apply. Main fences new worker
construction before requesting cleanup. The worker joins earlier construction
and checks its protected journal. A known worker session requires positive
closure of its original process registry owner. Unknown native entry remains
held. Main can then use the committed worker closure to finish the interrupted
Run without starting another session or claiming a successful result.

Main-local workflow preparation cleanup requires a completed execution and a
persisted no-submission or native-closure record. It uses the same guarded claim
reconciliation and retains all source bytes.


Git-worktree preparation uses the repository saved in the approved source, so
workspace repository edits do not alter accepted Runs. The source package carries
raw commit and tree objects alongside the approved file bytes. It does not carry
ancestor commits or their files. Workers import those objects into their managed
clone before worktree creation, including unpublished Agent snapshots used for CI
runtime preparation. Changed Agent worktrees can produce snapshot bundles up to
32 MiB; unchanged worktrees reuse the base commit without a bundle. The Worker
channel budgets include base64 overhead and preserve bounded chunks and scope
checks. Larger changed bundles require pushing the branch instead.
Runtime preparation sends the same bounded source package in
chunks over its authenticated Worker channel.

Agent worktrees are created without checkout, then populated from the verified
source reference. This avoids running smudge filters and keeps raw approved blob
bytes even when attributes request CRLF. File modes follow the manifest's
executable policy; stripping execute bits can intentionally leave Git mode changes.
Each occurrence uses a unique branch suffix. Fresh clones install atomically,
so concurrent first-use preparations can share the installed cache.

Main-local Git Agents reference the retained immutable snapshot instead of
writing an additional private reference copy for each execution. Their private
receipt files pin the snapshot store and byte-directory identities. Reads check
those identities, the saved manifest, every file hash and link count. Active
materialization records already prevent snapshot retention from deleting those
bytes. Worker and quota-bound Job copies retain their independent references.
Each writable checkout still receives separate inodes and its own branch.

Tree writers retain original write descriptors until data writeback completes,
including writeback error reporting. Qualified journaled ext4 on Linux 6+ uses
manifest-bounded descriptor batches, queued writeback followed by data waits,
and a directory timestamp update followed
by directory fsync to force a full journal commit after all data waits. DAX,
non-journaled filesystems, restricted descriptor budgets and hosts without the
optional Python helper retain per-file fsync. No filesystem or harness settings
are changed. This relies on Linux's [data-wait implementation](https://github.com/torvalds/linux/blob/master/fs/sync.c)
and [ext4 directory fsync forcing a full commit](https://github.com/torvalds/linux/blob/master/fs/ext4/fsync.c).

Copies and verification use qualified descriptors and bounded buffers, yield
between files, reuse pinned ancestors within each operation and avoid access-time
writes. Concurrent imports of one snapshot share Git object import work. Hashes,
modes, link counts, source/attempt pins, fresh authorization, synced receipts and
atomic activation remain required. Failed preparation retains an uncertain claim.

On the v0.0.82 repository tree (4,663 entries, 37.1 MB), five concurrent local
materializations measured 92.7–93.0 seconds before these changes and 13.5–16.2
seconds after them. The remaining data writeback took about 8 seconds in that
trial; the requested sub-10-second preparation target is not yet achieved.
These measurements exercise real snapshots and Git worktrees with a fixture
authorization callback, rather than a complete harness launch. Production DB
state was not changed. Runtime phase logs separate copy and synchronization.

## Git cache storage

Git clone and fetch use a separate budget on the filesystem containing the
cache. The host adapter serializes transfers with a directory lock, measures
all retained bytes, and records the reservation and measured filesystem in
`storage.json`. The budget is one quarter of filesystem size, capped at
64 GiB. A transfer reserves 1 GiB plus a free-space margin before Git starts.
The child inherits the cache lock and a 256 MiB kernel file-size limit.
Fetch stores one pack and index with automatic maintenance disabled; clone
and origin fetch use depth one so accepted commits do not pull full history.
Each transfer remeasures retained objects, including result branches and
active worktree metadata. Failed transfers remove only their own incomplete
packs or newly allocated clone staging. Published objects and existing
worktrees are retained and charged; capacity pressure never deletes them.

HTTP and Operator MCP use the same host adapter. `SOURCE_GIT_CACHE_CAPACITY`
reports a retryable storage failure through both transports and preserves the
original repository import command for retry after space becomes available.
