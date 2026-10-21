# SCH-08 — Runs selector

Base: `nima20002000/graphql`, `feat/nim-2701-schedules`,
`772d3b2c18e7c5ac7f6c4df943e29f8e0531cf0b`.

This is an **unmounted feature bundle**. Every added source/test file is in this
folder. No existing file, frozen contract, dependency, or `WorkflowBoard.tsx` was
changed. Apply the route integration below before mounting it in the real Board.

## Mount

From a component in `features/workflow-board/`, inside the existing Router and
QueryClient providers, create one selection hook and pass the same result to the
selector and selected-Run consumers:

```tsx
import { RunsSelector, useSelectedRun, useSelectedRunSnapshot } from '../runs-selector'

const selectedRun = useSelectedRun({ workspaceId, workflowId })
const selectedSnapshot = useSelectedRunSnapshot(selectedRun) // optional downstream consumer

// In the existing toolbar, beside its small controls:
<RunsSelector selection={selectedRun} />
```

`selectedRun.identity` is `{ workspaceId, workflowId, runId: string | null }`.
`null` means Current workflow. A URL is a request for an identity, not permission
to access it. Do not key/remount the whole Board by Run; only a selected-Run
subtree should reset on `selectedRun.generation.id` when appropriate. The
selector itself makes the authorized snapshot lookup, so a downstream consumer
of the same selection/query key shares that request.

`useSelectedRunSnapshot` returns no snapshot while switching, after an error, or
for another selection generation. A legacy `unavailable/legacy_run` snapshot
confirms a Run exists; it does not permit rebuilding it from the current graph.
Use that result for an honest unavailable state in the snapshot-rendering lane.
This bundle does **not** wire the existing canvas, Run inspector, or chat.

## Required route integration (not applied in this bundle)

The frozen `WorkspaceBoardSearchSchema` is strict and already reserves `runId`
for a complete `(Run, workflowVersionId, executionSemanticsVersion)` pin. The new
summary contract has neither version nor semantics pins, and even the snapshot
contract does not contain execution semantics. Do not invent those fields or
write an incomplete existing `runId` selection.

This feature therefore uses `selectedRunId`, with `workflowId` pinned alongside
it. Existing fully pinned Board links are read aliases. Selecting another Run
canonicalizes to `/workspaces/:workspaceId?workflowId=...&selectedRunId=...` and
removes old Run/inspector pins. Selecting Current workflow removes the history
parameter and pins; unrelated search values and the hash survive.

1. In `apps/web/src/app/router.tsx`, import the owned adapter and change the
   workspace route's search validator (remove the old import if now unused):

   ```tsx
   import { RunsSelectorSearchSchema } from '../features/runs-selector'
   // workspaceRoute:
   validateSearch: RunsSelectorSearchSchema,
   ```

2. In `apps/web/src/routes/WorkspaceRouteEntry.tsx`, replace the resolver import
   from the shared package with this owned adapter. The call and return type
   remain compatible with the existing Board route:

   ```tsx
   import {
     resolveRunsSelectorBoardLocation as resolveWorkflowBoardLocation,
   } from '../features/runs-selector'
   ```

   This validates the extended search first, then projects the old fields into
   the unchanged frozen resolver. Existing version/semantics validation is not
   weakened. Without **both** steps above the real route will reject the link.

3. Preserve a requested `selectedRunId` in the route's default-workflow fallback
   logic. Its current `if (run) return` guard must also check for the new history
   selection; the functional search updater's `previous.runId` guard must check
   `previous.selectedRunId` too. Read that value from `useLocation().search`,
   include it in the effect dependencies, and never resolve a missing requested
   workflow/Run to the current workflow. The adapter intentionally returns the
   old Board shape, not a second writable copy of the new selection.

4. Existing unrelated search updates (for example selecting an authoring Agent)
   must preserve `selectedRunId`. The frozen `boardSearchForRun` and other strict
   helpers must receive `withoutRunsSelectorSearch(previousSearch)`, then merge
   the existing `selectedRunId` into their result for an unrelated operation.
   An explicit legacy Run selection or Current workflow action must instead
   clear the new parameter, so the URL cannot name two different Runs.

5. The existing departure checks using `staysOnWorkflowBoard` also parse the
   strict frozen search shape. Their route-level caller must validate with
   `RunsSelectorSearchSchema`, project both searches with
   `withoutRunsSelectorSearch`, and then call the unchanged predicate. Only a
   valid, same-workflow history selection is a selection-only navigation; retain
   all current authoring, pending-operation, and unsaved-change guards. The hook
   uses `router.navigate` and does not bypass those blockers.

These are integration dependencies, not applied edits. Mounting only the toolbar
lines on the untouched base is insufficient. Full integration and live Board
verification remain outstanding.

## Generation guard

Capture a generation **when starting** work, and validate it before using the
result. Generation tickets are per hook subscription and per visit: the first A
is not the later A after A -> B -> A. Back/forward and unmount also fence tickets.
The history subscription observes intermediate changes even if React batches
several navigations into one render. Cancellation is an additional defense, not
the guard's only defense.

```ts
const ticket = selectedRun.capture()
const result = await loadForIdentity(ticket.identity)
if (!selectedRun.isCurrent(ticket)) return // ignore the late result
// Feed only this identity/generation to its query/cache consumer.
```

For server data use TanStack Query rather than a component-state copy.
`useSelectedRunSnapshot` already incorporates the guard, a generation-scoped
query key, AbortSignal, and exact returned workspace/workflow/Run identity checks.
Do not use `shortId` as an identity, cache key, or authorization fact.

## HTTP seam — confirmation needed from SCH-05

The frozen files specify payload schemas, but not transport paths. This bundle
isolates the following **provisional** spellings in `client.ts`; confirm or adjust
those two path builders to the SCH-05 registration before mounting:

```text
GET /api/management/workspaces/:workspaceId/workflows/:workflowId/runs?limit=25&cursor=...
  -> RunDropdownPage ({ items, pageInfo: { nextCursor } })
GET /api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot
  -> RunBoardSnapshotGetResult ({ snapshot })
```

All requests go through the existing authenticated `apiClient.request`; no raw
fetch, second auth path, mock runtime, or locally redefined HTTP shape is used.
All response parsing uses `@foreman-code/contracts/run-snapshots`, which is already
exported at the pinned base. A selected Run is checked through the single-Run
snapshot endpoint, **not** by searching every history page: absence from a loaded
page is not proof of a missing Run. 401, 403, and 404 remain distinct short states;
the URL is never silently cleared on denial or failure.

This UI neither adds a server capability nor grants authority. SCH-05's shared
authorized services, HTTP registration, Operator MCP read tools, denied-caller
coverage, and persisted readback are required dependencies. They were not
implemented or exercised in this UI-only bundle. Do not treat these MSW tests as
MCP parity or production authorization evidence.

## Presentation and bounds

The list retains server **admission** order; it never re-sorts `startedAt`.
Null start times display `Not started`. Labels use the browser's local timezone,
include the year, and add shortId only when another **loaded** Run shares that
local calendar date, including across page boundaries. The contract has no
server-provided same-date count, so an unseen page cannot influence a label
until loaded. Null start dates have no date to disambiguate. Display shortId
collisions remain possible by contract; full runId still identifies each row.

Each request asks for 25 Runs. Paging stops at 10 pages / 250 distinct rows,
without evicting the newest page. Repeated cursors stop further requests. More is
explicit, serial, and does not close the menu. While open, a 15-second refresh can
surface newly admitted Runs without touching the URL or selection generation.
Unauthorized background reads suppress cached rows. Snapshot reads are keyed by
workspace, workflow, full runId, and selection generation, with no previous-data
placeholder across identities.

Zustand stores only which menu is open. Keyboard support includes Enter/Space,
Up/Down, Home/End, typeahead, Escape with focus return, Tab out, and outside-click
dismissal. The existing shared top-layer floating helper clamps the surface to
the viewport; the menu has one bounded scroll area and a 296px maximum width at
a 320px viewport. Real-browser layout was not verified in this environment.

## Tests and verification

Files supplied:
- `model.test.ts`: date labels, null dates, order/deduplication, bounds/cursor
  cycles, scoped URL parsing and legacy aliases, A -> B -> A, unmount and guards.
- `RunsSelector.test.tsx`: real router + Query + existing MSW server; loading,
  empty/error/retry, same-day Runs, selection/new arrival, refresh/back/forward,
  deferred out-of-order replies, workspace switch, missing/forbidden Runs,
  legacy/unloaded selection, permission loss, paging/cap, keyboard and 320px
  positioning assertions.
- `client.test.ts`: real authenticated client + MSW; encoded paths/cursors,
  requested bounds, malformed responses, wrong returned scope, status retention.

Use the repository's pinned runtime from the full checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/web exec vitest run src/features/runs-selector --maxWorkers=4
corepack pnpm --filter @foreman-code/web typecheck
corepack pnpm --filter @foreman-code/web lint
corepack pnpm --filter @foreman-code/web build
```

These Vitest, project typecheck, lint and build commands were **not run** here.
Pinned `pnpm@11.27.0` bootstrap failed resolving `registry.npmjs.org`
(`getaddrinfo EAI_AGAIN`); Git transport also could not resolve `github.com`.
Source inspection used the authenticated GitHub connector at the exact commit,
not a substitute branch. No npm install, alternate package-manager version,
policy bypass, or dependency downgrade was used.

What did run: syntax-only transpilation of all 14 TS/TSX files with the already
installed TypeScript 5.8.3 compiler (0 diagnostics; not the repo's pinned compiler
and **not typechecking**), and seven Node tests against the emitted pure
presentation/generation modules (7 passed, 0 failed). The Node checks cover local
dates, nullable timestamps, order/deduplication, paging bounds, A -> B -> A without
AbortSignal, subscription replay, scope departure and invalid-selection fencing.
They are not a substitute for the supplied, unexecuted Vitest/MSW suites.

No full repository checkout, database, integration/acceptance, authenticated MCP,
or real-browser visual/interaction run was available. See root `MANIFEST.txt`
for the file inventory, checksums, and verification limitations.
