# SCH-02 — frozen contract decisions

## Schedule and clock

One schedule slot belongs to `(workspaceId, workflowId)`; no caller-allocated
schedule id. Get returns `{ schedule: null }` when absent. Save/disable use the
management `commandId`/`expectedRevision` and `{ value, replayed }` conventions:
revision 0 means absence, saved revisions start at 1, distinct successful
mutations increment once, and matching replays return the original value.
Changed-payload command reuse or stale revisions conflict. Disable requires an
existing record. Revision and nullable `nextOccurrenceAt` are server-owned;
disabled records have null, as may an exhausted once record.

Settings use a flat `mode` discriminator. Weekly weekdays are unique ISO numbers
(Monday 1–Sunday 7). Timezones use supported IANA Area/Location names, including
slash-form links, or UTC/GMT; ambiguous abbreviations/numeric offsets are rejected.
`nextOccurrences(schedule, fromUtc, n)` returns distinct ascending instants
**strictly after** its explicit boundary, ignores the stored cursor, and returns
none for disabled/exhausted schedules. `n` is 0–1000; UTC instants normalize to
milliseconds (sub-ms input is rejected), with years 0001–9999 supported.

Intervals mean elapsed UTC time: `anchorAt + k * duration`, integer `k >= 0`.
They may display repeated local times. Weekly/once wall times shift **by the gap
duration** (02:30 → 03:30 for a one-hour gap), and use **only the first fold
instance**. A skipped date can shift into the next date; equal instants deduplicate.
No implicit clock, process timezone or new dependency is used. Host `Intl`/IANA
data determines previews; services are authoritative and accepted UTC facts
never change after timezone-data updates.

## Admission defaults

**No backfill:** recovery considers at most the **latest due** occurrence.
Earlier backlog is `missed/superseded`, even inside grace; anything older than
**5 minutes** is `missed/outside_grace`. Exactly five minutes is eligible; future
occurrences are not recorded early. An overlapping, still-in-flight scheduled
Run of the same workflow is `skipped/overlap`. Disabling affects **future
admissions only**, never accepted Runs/snapshots; a due disable race is
`skipped/disabled`. This policy does not cancel manual Runs.

Policy is always `latest_saved`. At acceptance, atomically recheck revision,
enabled state, eligibility and overlap, resolve the latest saved workflow
version, create the Run/snapshot, and record acceptance. The pure helper's
`eligible` result is not admission or authorization. Accepted occurrences require
`workflowVersionId`, `runId`, and null reason; other statuses require a safe,
non-secret reason and forbid those ids. The opaque deterministic id is
`"schedule:v1:" + JSON.stringify([workflowId, canonicalUtcDueAt])`;
settings/revision/version cannot change it. Storage must enforce uniqueness.

**New once saves** must call `parseScheduleSaveInput(input, serverNowUtc)` after
replay lookup. Invalid dates or resolved instants at/before now are rejected,
even when saving disabled. Static schemas stay clock-free for history/replays;
a second fold instance cannot rescue an already-past first instance.

## Runs and legacy

`RunDropdownSummarySchema` is separate from the existing root `RunSummarySchema`.
Pages are scoped, newest admission first with a stable Run-id cursor tie-breaker
(default 50, maximum 100). `shortId` is display-only; `startedAt` is null until
actual start. Status projects execution state, or terminal outcome when completed;
interrupted stays interrupted. Never relabel another legacy trigger as manual.

Capture board/Agent-version/layout/edge facts once at admission. Parsed snapshots
are deeply cloned/frozen and strict whitelists exclude credentials/configuration
bodies; persistence must also preserve immutability. Legacy Runs without a capture
are explicitly `unavailable/legacy_run`, never rebuilt from today's board. Chat
keys require all seven scope/node/Agent/execution/conversation ids; missing ids
mean no resolved key, not current-chat fallback or an authorization grant.

The legacy `WorkflowTriggerSchema` schedule variant remains untouched. Once a
new schedule record exists, it is the **sole schedule authority even when
disabled**. Backend cutover must atomically suppress the old schedule trigger;
disable never revives it. No automatic conversion of its pinned version/location,
interval or missed policy is implied. Other legacy trigger kinds are unchanged.

## Needed exports (not edited)

`packages/contracts/src/index.ts`:

```ts
export * from "./schedules.js";
export * from "./runSnapshots.js";
```

`packages/contracts/package.json` export-map entries:

```json
{
  "./schedules": { "types": "./dist/schedules.d.ts", "import": "./dist/schedules.js" },
  "./run-snapshots": { "types": "./dist/runSnapshots.d.ts", "import": "./dist/runSnapshots.js" }
}
```

Existing Vitest discovery includes both new `src/*.test.ts` files. HTTP/MCP must
share these contracts and authorized services; transport, transactional admission,
persistence and UI implementations/tests belong to their respective lanes.
