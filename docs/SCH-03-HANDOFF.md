# SCH-03 — schedule persistence handoff

Base: `nima20002000/graphql`, `feat/nim-2701-schedules`,
`772d3b2c18e7c5ac7f6c4df943e29f8e0531cf0b`.

## Delivery and verification status

This package implements persistence, the shared authorized service, HTTP/MCP
composition, and tests. It does not implement a dispatcher. Runtime verification
is incomplete: the authored Vitest/PostgreSQL/HTTP/MCP tests have **not** run in
the delivery environment. Do not interpret the presence of tests as passing
results. `MANIFEST.txt` records the available checks and blockers.

No shared contract, `migrations.ts`, legacy trigger implementation, Run snapshot,
UI, package manifest, dependency lockfile, or remote branch was changed. No new
dependency is required. The existing `@graphql/contracts/schedules` export is used.

## Registration required before boot

In `apps/api/src/infrastructure/migrations.ts`, add the import:

```ts
import { workflowScheduleMigration } from './workflowScheduleMigration.js'
```

Append this entry to the existing `migrations` array, after its current entries:

```ts
  workflowScheduleMigration,
```

The version is **270203**. The registry iterates in array order; appending keeps
all required base tables in place before this migration. No other production
wiring is required by this patch: `WorkflowManagementService` constructs its
`schedules` service using the existing pool/command coordinator; `buildApp`
registers HTTP routes and the Operator MCP registrar registers its tools.

The integration test uses the existing disposable-schema helper and explicitly
applies this migration only when version 270203 is absent. That test convenience
is not a substitute for production registration.

## Storage and command identity

`workflow_schedules` has one primary-keyed slot per workflow, a composite foreign
key proving workspace/workflow lineage, a persisted immutable-by-command result
projection, an indexed next UTC occurrence, and an internal clear tombstone.
`workflow_schedule_occurrences` enforces `(workflow_id, due_at)` uniqueness,
scoped schedule lineage, valid status/reason combinations, and immutable rows.
Accepted rows carry Run/version foreign keys. `recordOccurrence` additionally
checks that the exact Run belongs to the supplied workspace/workflow/version.
There is no public endpoint for inventing occurrence outcomes.

Commands reuse `management_command_receipts` and `management_audit` through the
existing `PostgresCommandCoordinator`; a second schedule-only receipt store is
not introduced. Operations are `workflow.schedule.save`, `.enable`, `.disable`,
and `.clear`. Command identity is the existing principal/operation/commandId
identity, not the transport. Target, full normalized payload, and expectedRevision
are hashed. A matching HTTP/MCP retry returns the original saved result; a changed
payload conflicts. Weekly weekday order and equivalent UTC offsets normalize.
Receipts survive clear and subsequent edits; replay never rolls the current row
back to the replayed historical value.

Mutation order is command lock, live authority, receipt lookup, active workspace
lock, workflow row lock, schedule row lock, live authority recheck, revision/time
validation, row/receipt/audit writes, commit. The workflow row serializes first
creates even when the schedule slot is absent. No request reads an injected caller
clock. New Once validation runs after replay lookup and workflow-lock acquisition;
a past Once retry can replay, but a new past Once save cannot succeed, even when
saving disabled. Disabled schedules have a null next occurrence. Distinct
successful mutations increment revision, including a repeated disable using a
new command ID. A matching command replay does not increment it.

Saved/disabled/cleared preferences do not start or cancel Runs. Changing a schedule
does not rewrite its recorded occurrences or existing Runs.

## HTTP and Operator MCP

All HTTP endpoints are below the existing authenticated **management** namespace:

`/api/management/workspaces/:workspaceId/workflows/:workflowId/schedule`

| HTTP | Operator MCP | Action |
| --- | --- | --- |
| GET root | `workflow_schedule_get` | `workflows:read` |
| PUT root | `workflow_schedule_save` | `workflows:update` |
| POST root`/enable` | `workflow_schedule_enable` | `workflows:update` |
| POST root`/disable` | `workflow_schedule_disable` | `workflows:update` |
| POST root`/clear` | `workflow_schedule_clear` | `workflows:update` |
| GET root`/occurrences` | `workflow_schedule_occurrences_list` | `workflows:read` |

HTTP scope comes only from route parameters; request bodies omit workspaceId and
workflowId and reject unknown keys. Save bodies are `{commandId,expectedRevision,
schedule}`; enable/disable/clear bodies are `{commandId,expectedRevision}`. MCP
inputs include the complete workspace/workflow scope. HTTP occurrence queries use
`limit` and `cursor`; JSON/MCP limits are numbers, not coerced strings.

Both transports call the same service, including concrete workflow-lineage and
live delegated-authority checks before protected reads or receipt replay. Reads
return `{schedule:null}` when the scoped workflow exists but has no schedule.
They do not require write or Run-start grants. Schedule writes do not require
`graph:save` or `runs:start`; using the management namespace avoids the old generic
workflow-route gate mapping writes to graph saves. Neither action is a future
scheduled Run admission grant.

MCP discovery and `operator_get_capabilities` show the available schedule tools.
Direct calls to grant-hidden tools return audited `ACCESS_DENIED`, not a generic
unknown-tool result. Workers cannot discover or invoke these Operator-only tools.
Capability facts explicitly distinguish implemented persistence from absent timed
delivery. Public schedule-input errors become `INVALID_REQUEST`; stored-data
parse failures are not disclosed as request validation details.

Occurrences are newest **due-time** first, default 50/max 100. Since due time is
unique within a workflow, it is a stable paging key without a second tie-breaker.
Cursors are strict, bounded, opaque base64url values bound to their scope and query
kind. They carry no authority, cannot widen grants, and reject foreign workflows.
History remains readable after clear. Paging is a live keyset view, not a frozen
snapshot or promise to include rows inserted after a page was read.

## Frozen-contract gaps and provisional choices

The following omissions are reported rather than edited in SCH-02 files:

1. **Enable, clear, and occurrence paging are not shared transport contracts.**
   The API-local `transportSchemas.ts` composes the existing command envelope and
   occurrence schema. Enable returns the existing save result constrained to
   enabled; clear returns `{value:null,replayed}`; paging returns
   `{items,pageInfo:{nextCursor}}`. HTTP route names, MCP names, and permission
   mapping are also new SCH-03 choices requiring cross-lane agreement.
2. **Clear has no frozen revision/authority semantics.** This implementation
   retains an internal tombstone and consumes a revision. Get returns null;
   re-create uses expectedRevision 0, but the returned saved revision continues
   above the tombstone. Example: create 1, clear internal 2, re-create 3. Thus an
   old saved revision never matches a newly recreated record. The existing
   absence=0 envelope cannot distinguish two separate absent generations: an
   unexecuted expectedRevision-0 create can still succeed after another complete
   create/clear cycle. A shared slot-generation/absence revision would be needed
   to prohibit that ABA case. This package does not silently invent such a field.
3. **The shared Operator capability tool enum is closed and lacks schedule names.**
   An exact additive API-local composition is used for MCP capability responses.
   Existing consumers parsing those responses with the old closed shared schema
   will reject the new names until the shared contract is extended. This is an
   integration gap, not a claim that the frozen capability schema already covers
   SCH-03. None of its existing names, grants or requirements are removed.
4. **Legacy cutover and durable dispatch authority are separate obligations.**
   No legacy trigger row, implementation, or admission path is changed here, as
   requested. Merely storing a new slot does not make a still-enabled legacy
   dispatcher consult it. Before enabling scheduled admission, SCH-04/integration
   must atomically suppress legacy schedule admission whenever a new slot exists,
   including disabled and cleared tombstones. Never delete that tombstone to
   restore a legacy schedule. `updated_by_principal_id` is audit provenance only:
   it is not a durable authorization snapshot or permission to impersonate a
   temporary Operator chat credential. Resolve/accept appropriate durable owner
   authority at the dispatcher boundary, following the existing Run admission
   rules, rather than treating workflow-edit permission as Run-start permission.

Shared follow-up is needed before presenting the provisional clear/paging/
capability extensions as a newly frozen cross-client contract.

## SCH-04 repository seam

`PostgresWorkflowScheduleRepository` is available as `service.repository` or can
be constructed directly with the pool. It is internal, privileged persistence;
public reads must use the authorized service.

- `listDueSchedules({throughUtc,limit?,cursor?}, client?)` returns at most 100
  candidates and a cursor bound to the fixed UTC scan boundary. It excludes
  disabled/cleared schedules and archived parents. It is **not** a claim, lease,
  authorization decision, latest-due/backfill decision, or admission. Re-scan on
  later ticks; concurrent saves/cursor advances can change a live paged view.
- `lock(client, scope)` locks active workspace, workflow and schedule in the same
  order as the writer. `getSlot` exposes the current record, tombstone revision,
  and audit actor. Caller owns the transaction and must recheck eligibility,
  enabled state, expected revision, overlap, timing/grace and live Run authority.
- `recordOccurrence(client, occurrence, serverNowUtc)` parses the frozen record,
  rejects future facts, verifies accepted Run lineage, and records once. Exact
  retries return the original fact. A different immutable outcome for the same
  workflow/dueAt returns `SCHEDULE_OCCURRENCE_CONFLICT`; it never overwrites.
  Rejected reasons must be safe application-owned codes/messages, not raw native
  exceptions, prompts, credentials or arbitrary secret-bearing text. No caller
  should expose this internal seam as an unauthenticated record-insertion API.
- `advanceCursor(client, scope, expectedRevision, previousDueAt, nextDueAt)` is
  an optional forward-only compare-and-swap. It updates both the indexed UTC
  column and record projection without incrementing the editable revision.
  It does not compute missed/backfill decisions and must not advance on its own
  before admission/outcome recording commits.

For admission, SCH-04 must open one transaction, acquire the shared locks,
re-evaluate the frozen timing/overlap/revision rules, resolve the latest saved
workflow, accept durable authority, create the exact Run and immutable snapshot,
record the occurrence, advance the cursor, and commit together. Reuse this
transaction's client for all repository methods; they never BEGIN or COMMIT.
If a record conflict is found after speculative Run work, roll the entire
transaction back. Do not commit another Run on an occurrence replay. Native Run
execution and external effects must remain after committed admission.

## Tests and commands for integration

`apps/api/test/workflow-schedules.test.ts` contains boundary/cursor/discovery
unit tests. `apps/api/test/workflow-schedules.integration.test.ts` covers all
three modes, clock/DST/past-Once validation, stale revisions, concurrent creates
and commands, cross-transport replays, persisted readback, revoked/live grants,
forged workspace lineage, clear/re-create, immutable occurrence uniqueness,
accepted Run lineage, transaction rollback, paging, due scans/cursor CAS, archived
parents, unchanged legacy rows, and a real authenticated MCP endpoint with denial
and HTTP readback. The latter uses the existing loopback, explicitly test-named
`TEST_DATABASE_URL` helper and a random isolated schema. No production database
fallback, real provider session, or paid model call is used.

From a complete checkout with the pinned toolchain and dependencies:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api exec vitest run test/workflow-schedules.test.ts --maxWorkers=1
# Supply an explicit disposable, loopback, test-named PostgreSQL database:
TEST_DATABASE_URL="$TEST_DATABASE_URL" corepack pnpm --filter @graphql/api exec vitest run test/workflow-schedules.integration.test.ts --no-file-parallelism
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
```

The integration suite is intentionally skipped when TEST_DATABASE_URL is absent;
a skipped suite is not database evidence. Follow `AGENTS.md` for the complete
repository verification sequence before merging. No full-suite pass is claimed.
