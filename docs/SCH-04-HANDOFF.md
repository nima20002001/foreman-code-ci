# SCH-04 — API schedule dispatcher

Base: `nima20002000/graphql`, branch `feat/nim-2701-schedules`, commit
`6df8c964f5c913f1505c15256bdd57d90c6c1dcb`.

Read at this exact revision: `AGENTS.md`, `packages/contracts/src/schedules.ts`,
`docs/FEAT-05-SCHEDULE-CONTRACT.md`, and `docs/SCH-03-HANDOFF.md`.
Those files are unchanged. No UI, Run-history snapshot implementation, native
adapter changes, dependencies, lockfile changes, remote commits or deployment.

## Composition and transaction boundary

`WorkflowScheduleDispatcher` is a bounded API-process timer. Fastify `onReady`
starts it through `RunManagementService`; `preClose` drains its current work and
cancels further polling. It only scans while the actual current production
binding reports runtime admission available. There is no browser timer, remote
"dispatch now" endpoint, or alternate worker credential.

The SCH-03 `PostgresWorkflowScheduleRepository.listDueSchedules` seam supplies
candidates, not claims. A scan processes at most five pages of 100 candidates.
Its fixed-boundary cursor continues across ticks, then wraps, so a failing prefix
does not indefinitely starve later workflows. One process coalesces concurrent
ticks; process-local state is not used to establish occurrence ownership.

`PostgresScheduleDispatcher` re-reads each slot under SCH-03's workspace,
workflow and schedule row locks. Missed/skipped/rejected facts and each cursor
advance commit together on one PostgreSQL client. Preparation performs no
filesystem or provider I/O while holding these locks. Historical missed entries
are materialized in bounded batches of at most 100 per workflow/pass. Very long
backlogs therefore take multiple passes to drain; the dispatcher never starts
an earlier backlog entry while a later due entry exists.

Eligible work calls **`admitRepeatRun`**, exactly the durable function used by
manual HTTP/MCP Start. The public `RunStartV3InputSchema` is unchanged. An internal
`ScheduleStartGuard` is accepted only with the internal `schedule` source; it
cannot be supplied through the public Start request. The same command receipts,
location preflight, live authorization, runner capacity/recovery gates,
latest-saved snapshot checks, tokenless Run authority, canonical G1 publisher
and immutable Run writer remain in force.

Inside that common transaction, before acceptance, the guard locks/re-reads the
slot and checks the exact revision/cursor, enabled state, live owner authority,
latest-due eligibility, previous occurrence and scheduled overlap. After the
common Run insert/publication, it records the accepted occurrence with the exact
Run/version IDs and advances the cursor. A pre-COMMIT callback rechecks time and
authority, including a newer due instant arising during publication. Throwing
rolls back the speculative Run, authority, command receipt, occurrence and cursor.

The existing unique `(workflow_id, due_at)` constraint and deterministic frozen
occurrence ID provide logical identity independently of schedule revision or
workflow version. The internal Start command ID is a SHA-256-derived identifier
of that occurrence. A second dispatcher serializes on the same database locks
and re-reads the committed state. No expiring process lease is required: locks
are transaction-scoped and are released on rollback or connection loss.

Native execution is requested only after a known successful common Start COMMIT,
using the same engine entry as manual Start. There is no second launch on receipt
replay. Lost COMMIT replies remain uncertain to that caller, not an instruction
to create another Run; a fresh scan reads durable state. Existing engine recovery
includes queued Runs in `reconciliationCandidates` and starts those exact IDs.
The production native runtime's existing ownership/readiness restrictions remain
unchanged; this change does not bypass them to enable a second native owner.

## Frozen policy

The implementation calls the frozen `nextOccurrences` and
`scheduleAdmissionDecision` helpers rather than reimplementing calendar/DST rules.
Only the latest due instant can be admitted. Exactly five minutes is eligible;
one millisecond beyond is `missed/outside_grace`. Earlier entries inside grace
are `missed/superseded`. Due entries overlapping an accepted scheduled queued,
running, waiting, interrupted or cleanup-pending Run are `skipped/overlap`.
Manual Runs alone are not classified as scheduled overlap; common Start's normal
capacity and recovery restrictions still apply.

Disabled or cleared slots never admit. An already-observed due candidate can be
recorded as `skipped/disabled`; missed policy takes precedence where required by
the frozen helper. Disable/clear never cancels accepted Runs. Cursor advancement
updates both the indexed timestamp and JSON projection without consuming a
user-management revision. Once ends with a null cursor. Ordinary version races
are retried with a fresh latest-saved Start request; saved-version and location
pins are still checked by common Start under its transaction.

## Owner binding and migration

New migration: `apps/api/src/modules/schedules/dispatchMigration.ts`, **270204**.
The registry import and registration are included, immediately after SCH-03:

```ts
import { workflowScheduleDispatchMigration } from '../modules/schedules/dispatchMigration.js'
// In migrations, after workflowScheduleMigration:
workflowScheduleDispatchMigration,
```

A successful enabled save or enable captures an explicit durable root human
owner, actor ID, schedule revision and grant ceiling. Resolution follows manual
Start's parent-authority rules: a temporary caller may act through a root or an
active Run-bound authority, not another temporary chat credential. The ceiling
is the intersection of the writer's live grants and the allowed parent authority.
A later enabled save/enable replaces the binding; command replays never do.
No bearer token, chat credential or synthetic schedule principal is stored.

At dispatch, the root owner's current grants, revocation and expiry are re-read
with share locks. Effective authority is bounded by the captured ceiling. It must
include scoped `runs:start` and `workspace_locations:read`. A later grant increase
does not silently expand an older ceiling. Authority errors publish only
`schedule_authorization_denied`, not raw SQL, native output, token or path details.
Common Start independently constructs and checks its normal per-Run authority.

**Upgrade action:** the SCH-03 `updated_by_principal_id` is audit provenance, not
a durable grant. Existing schedules are deliberately not backfilled from it.
Before their next due time, save or enable them again under the intended human
owner. An unbound due schedule records `rejected/schedule_authority_missing` and
advances normally. An already rejected/elapsed Once occurrence cannot be revived;
choose a new future Once time. Replaying an old save command does not bind it.

The same migration suppresses only legacy `kind='schedule'` rows whenever a new
slot exists, including disabled/clear tombstones. A trigger serializes legacy
re-enables against the workflow row and forces them off. Other legacy trigger
kinds and historical Run/job rows are not rewritten. Current common Start already
rejects legacy `triggerJobId` admissions; that rejection remains. This is not a
migration or translation of legacy pinned-trigger jobs into the new dispatcher.

## Existing-file wiring (six files)

| Existing path | Necessary change |
| --- | --- |
| `apps/api/src/app.ts` | API ready/pre-close hooks and safe dispatcher error logging. |
| `apps/api/src/infrastructure/migrations.ts` | Import and register migration 270204; all historical SQL unchanged. |
| `apps/api/src/modules/runs/management.ts` | Compose/start/drain dispatcher using the existing pool, locations, production binding and engine. |
| `apps/api/src/modules/runs/repeatStartAdmission.ts` | Internal source/guard validation, occurrence-bound command hash, before/after acceptance hooks; clarify legacy-job refusal. Manual request/receipt behavior otherwise unchanged. |
| `apps/api/src/modules/schedules/service.ts` | Capture authority within fresh enabled save/enable transactions, never replay or disable/clear. |
| `apps/api/src/mcp/operator/tools/workflowSchedules.ts` | Replace stale "timed delivery not implemented" descriptions with dispatch and owner/grant requirements. |

The dispatcher, policy adapter, authority helpers, guard, runtime composition and
migration are new files in the owned schedules directory. Existing authenticated
HTTP and Operator MCP save/enable/disable/clear/history surfaces remain the control
and readback boundary. No agent/worker dispatch or schedule-write tool is added.

## Frozen-contract gaps and explicit choices

1. There is no durable owner/binding field or ownership-transfer rule in the
   frozen schedule DTO. This patch uses an API-local binding: the latest successful
   enabled writer's root owner plus a non-expanding grant ceiling. Public owner-ID
   readback/transfer semantics require a shared-contract follow-up; no DTO is widened.
2. The frozen schedule has no Run input template. Scheduled Start supplies `{}`
   to the existing strict Start schema. It never borrows a legacy trigger payload
   or an unsaved Board draft. Configurable scheduled inputs require a contract change.
3. SCH-03's provisional clear/enable/paging compositions and closed shared Operator
   discovery enum remain unchanged. Existing API-local capability composition is
   reused; cross-client schema consolidation is still required.
4. Run board-history snapshots are SCH-05, excluded here. The common Start's existing
   canonical publication/pin checks remain, but this change does not supply the
   separate history snapshot DTO/storage feature.
5. Bounded historical materialization is deliberately not an unbounded startup
   transaction. A very large backlog can delay reaching its latest due entry over
   multiple passes; earlier entries are never admitted as backfill. No claim of
   constant-time historical catch-up is made.

## Tests authored

`apps/api/test/workflow-schedule-dispatcher.test.ts` covers all three recurrence
modes, grace edges, latest-only catch-up, batch lookahead, disabled/overlap policy,
safe rejection codes, coalescing/drain, readiness, failure isolation, bounded/fair
paging, duplicate cursor handling and server-timer cancellation.

`apps/api/test/workflow-schedule-dispatcher.integration.test.ts` uses the existing
isolated loopback-only PostgreSQL fixture, real location evidence, real
`admitRepeatRun` and real canonical publisher. It covers weekly/interval/Once
acceptance and pin readback; restart catch-up; grace edges; two independent pool
races; lost acknowledgement; pre-COMMIT rollback; scheduled overlap; disable and
clear races; permission loss; latest saved version races; time moving during
publication; manual Run non-overlap; transient errors; missing owner binding;
non-expanding grant ceilings; legacy suppression; and authenticated HTTP/MCP
readback plus denied writes. No provider is launched by these tests.

## Validation actually performed

- All six edited source originals were reconstructed from pinned GitHub reads
  and verified against their exact Git blob SHA before editing.
- Global TypeScript **5.8.3** transpile/syntax diagnostics: **15 TypeScript files,
  zero syntax errors**. This is not a repository semantic typecheck or build.
- **Six standalone Node loop smoke checks passed** against the authored
  `dispatcher.ts`: coalescing/injected boundary/drain, readiness, bounded fair
  sweep, error isolation, repeated-cursor/candidate handling, deterministic fake
  server-timer scheduling/cancellation. No database or contract substitute was
  used to claim admission correctness.
- Diff whitespace checks and ZIP path/checksum verification are recorded in the
  accompanying manifest.

**Not run:** repository Vitest tests, PostgreSQL integration tests, semantic
monorepo typecheck, lint, build, acceptance or native/runtime end-to-end tests.
Node 22.16.0/Corepack 0.32.0 were available; pnpm, Vitest, PostgreSQL and Docker were
not installed on PATH; `TEST_DATABASE_URL` was unset. Bootstrapping the pinned
`pnpm@11.27.0` failed with `EAI_AGAIN registry.npmjs.org`. Git clone also could not
resolve GitHub. This is a changed-file bundle, not a complete local repository
checkout. No test suite is reported as passing on the strength of syntax checks.

In a complete checkout, build the contracts and run the two named test files with
the repository's pinned pnpm/Vitest tooling. Use the repository integration runner
and an explicitly disposable loopback test database for the integration file.
Then run the AGENTS.md typecheck, lint, build, integration and acceptance gates.
The PostgreSQL concurrency/atomicity and native-restart claims above describe the
implemented protocol; they are **not yet verified by executed integration tests**.
