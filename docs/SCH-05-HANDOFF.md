# SCH-05 — immutable Run Board snapshots and history reads

Base: `nima20002000/graphql`, branch `feat/nim-2701-schedules`, commit
`772d3b2c18e7c5ac7f6c4df943e29f8e0531cf0b`.

No shared contract, scheduler, legacy trigger, chat transport or UI file is changed.
This is an unmerged ZIP handoff, not a deployed or PostgreSQL-verified change.

## Required migration registration (intentionally not applied)

In `apps/api/src/infrastructure/migrations.ts`, add the import:

```ts
import { runSnapshotMigration } from './runSnapshotMigration.js'
```

Add this entry to the existing migration array in version order (270205):

```ts
runSnapshotMigration,
```

The registry file is deliberately absent from this ZIP. Register/apply the new
migration before serving the changed API or admitting Runs. Do not synthesize a
backfill: pre-existing Runs remain snapshot-unavailable. The SCH-05 integration
test adds the real pending SQL to its isolated fixture setup without editing the
application registry; existing repository integration tests need the registration.

## Capture and persistence

`insertRepeatRun` is the existing common Start insertion, inside its branded G1
transaction. It now writes `run_board_snapshots` immediately after `runs` and
before canonical publication. Snapshot failure, publication failure or a later
transaction failure therefore rolls both records back. Receipt replay returns
before insertion: it never rebuilds, repairs or replaces a snapshot. Dispatch
and receipt/authority behavior are otherwise unchanged.

The capture takes presentation/topology from
`accepted.snapshot.workflow.definition`: the **locked saved Board**, whose
executable meaning the frozen `AcceptedRepeatStartV1Schema` has already checked
against the accepted immutable version. This is important because layout/name
saves can legitimately keep the executable version ID. Agent configuration pins
come from the accepted Run and are checked against the accepted version. No
future history read consults a mutable Board, Agent, draft or configuration head.

The DTO contains only the frozen whitelist: Run/workspace/workflow/version IDs,
admission timestamp, node IDs/names/Agent IDs/configuration-version IDs, positions,
sizes, and all allowed edge fields. No prompts, configuration bodies, native
session paths or location credentials are copied into it.

The migration adds a Run-keyed table, physical composite scope/version FK, JSON
identity checks, admission-trigger metadata and immutable row guards. Updates or
deletes of captures fail. Deleting a captured Run is restricted. Admission
identity and database creation time cannot be updated; lifecycle fields remain
mutable. Nodes/edges/Agents are stored as values, not cascading FKs. The existing
immutable-version/Agent FK and archive behavior is retained; no historical Run,
execution or native-session deletion code is added.

## Shared reads and transport wiring

`RunManagementService.history` owns a single `RunHistoryService` instance used by
both HTTP and Operator MCP. Inputs and successful outputs are parsed with the
unchanged `@graphql/contracts/run-snapshots` schemas.

| HTTP GET path | Operator MCP tool |
| --- | --- |
| `/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries` | `run_summaries_list` |
| `/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot` | `run_board_snapshot_get` |

The list accepts `limit` (default 50, maximum 100) and an opaque `cursor`.
Snapshot scope is supplied in the URL; scope keys repeated in query parameters
are rejected. HTTP results use `Cache-Control: private, no-store` and vary by
Authorization/Cookie. Registration reuses the existing authenticated management
and Operator inspection entrypoints; no separate authentication surface is added.

Reads require compatible `runs:read` authority, check the live delegated grant
chain under share locks, and recheck expiry before committing the read. Run-only
grants are filtered before pagination and intersected with the live grants.
Snapshot lookup requires the exact persisted workspace/workflow/Run tuple. A
foreign Run ID wrapped in an allowed hierarchy cannot return data: it produces
not-found (404), or access-denied (403) when the supplied scope itself is denied.
No write, `workflows:read` or live `agents:read` grant is needed for these Board DTOs.

Pagination orders by immutable PostgreSQL `runs.created_at DESC` then `id COLLATE
"C" DESC`, not the mutable actual-start timestamp or an offset. Cursors preserve
all six fractional timestamp digits and bind workspace/workflow. They are
positions, not credentials. Status and `startedAt` may change between pages,
without moving a Run across the cursor. Later newer admissions do not reappear
below an already-issued boundary. There is no cross-page MVCC snapshot promise.

An existing Run without a capture returns exactly:

```ts
{ snapshot: { kind: 'unavailable', workspaceId, workflowId, runId, reason: 'legacy_run' } }
```

A stored but malformed/mismatched capture is an error, never a current-graph
fallback or a manufactured available snapshot.

## Frozen-contract and integration gaps

### Scheduled admission is not present at this base

The common insertion accepts an internal fourth argument:

```ts
await insertRepeatRun(sql, accepted, publication, 'schedule')
```

Manual callers keep the default `'manual'`. Future scheduled admission must use
this same insertion and supply `'schedule'`; HTTP/MCP callers cannot supply this
internal argument. The existing `admitRepeatRun` still rejects `triggerJobId` with
`REPEAT_TRIGGER_UNSUPPORTED`. This task deliberately does not remove that fence
or create a scheduler. Thus the shared capture seam is ready for scheduled
admission, but end-to-end scheduled Start is **not implemented or demonstrated**.
The integration test exercises the internal scheduled insertion only.

### Capability-name enumeration

The frozen `CurrentOperatorCapabilitiesSchema` does not admit these new tool
names in its `tools`/`requirements` enums. The actual authenticated `tools/list`
registers them, with the frozen input/output schemas and read-only annotations.
`operator_get_capabilities.runtimeLimits` explicitly describes the feature,
required action, tool names and enum limitation. Its typed name arrays are not
modified or populated with invalid values. Updating those arrays requires the
contract-owning lane to extend the frozen enum.

### Legacy trigger provenance / incomplete older dropdown coverage

A workflow's saved `executionCondition` is eligibility, not evidence of how a Run
was actually started. New captures persist the actual internal admission trigger.
At this pinned base the pre-capture V3 admission path is manual-only, so its legacy
V3 Runs are classified as manual even when a workflow was schedule-eligible.

Older non-V3 Runs do not have proven actual trigger provenance in this lane. The
frozen summary has only `manual | schedule`, with no `unknown` or event/message
variant. Such older rows are **omitted from dropdown summaries**, not relabeled
or deleted. Their exact Run IDs can still return the legacy-unavailable snapshot.
This is a coverage limitation, not a claim that no older history exists. The
contract-owning lane must decide an explicit representation/provenance policy to
include all older history. No mutable `workflow_triggers` data is consulted.

### Missing saved geometry

The saved node schema permits omitted position/width/height while the snapshot
requires concrete geometry. At capture time only, the implementation uses the
existing Board defaults at this base: width 208, height 112, x `64 + index * 300`,
y 120. Explicit sizes are preserved without clamping. These become stored facts,
not defaults re-evaluated during future reads. Label is used only if name is absent.

## Tests and verification

`apps/api/test/sch05-run-snapshot.test.ts` adds projection, latest saved
presentation, pin rejection, common-admission ordering, rollback, exact replay,
lost-COMMIT retry and bounded/cross-scope/microsecond cursor regressions. The
existing `eng04-start-fixtures.ts` SQL double now models transactional captures,
rather than accepting/ignoring an unfamiliar write.

`apps/api/test/sch05-run-history.integration.test.ts` uses the existing real
application/provider-boundary fixtures. It covers Run A retaining Y/layout/edges
and native-session rows after typed Save removes Y; a geometry-only Save retaining
the version ID; public MCP Start of Run B without Y using that newer layout;
HTTP/MCP persisted readback; tools/list and denied callers; scoped/forged IDs;
live grant revocation; legacy-unavailable; microsecond/tied-ID pagination; Run-only
grants; SQL immutability and rollback; and the internal scheduled insertion.
PostgreSQL tests are gated by the repository's `TEST_DATABASE_URL` convention.
They were **written but not executed in this environment**.

A limited reproducible offline check is included:

```sh
node apps/api/test/sch05-offline-check.mjs
# To use a separately installed TypeScript compiler:
SCH05_TYPESCRIPT_PATH=/absolute/path/to/typescript.js \
  node apps/api/test/sch05-offline-check.mjs
```

It checks syntactic transpilation and runs the real emitted pure projection/cursor
helpers against explicit test inputs. It does NOT execute contract schemas, SQL,
HTTP/MCP, Vitest or native adapters, and it is NOT a semantic typecheck.
See `SCH-05-VERIFICATION.txt` and `MANIFEST.txt` for actual results and limitations.

After integrating the migration entry, run the pinned repository gates:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm db:up
corepack pnpm test:integration
corepack pnpm test:acceptance
corepack pnpm db:down
```

Use the repository's existing integration runner and disposable loopback test
database, not a production database. No dependency or lockfile change is needed.
