# SCH-07 — workflow schedule control

Base: `nima20002000/graphql`, `feat/nim-2701-schedules`,
`772d3b2c18e7c5ac7f6c4df943e29f8e0531cf0b`.

All implementation files are new and contained in this directory. The frozen
contracts, their exports, `WorkflowBoard.tsx`, shared UI, shared HTTP client,
backend routes, and Operator MCP tools are not changed. No dependencies added.

## Mount

From `apps/web/src/features/workflow-board/WorkflowBoard.tsx` (or the existing
workflow authoring toolbar):

```tsx
import { ScheduleClockButton } from '../schedules'

<ScheduleClockButton workspaceId={workspaceId} workflowId={workflowId} isSaved={Boolean(savedWorkflowVersionId)} />
```

`savedWorkflowVersionId` is a caller binding to the **persisted workflow readback**;
it is not an identifier added to `WorkflowBoard.tsx` by this patch. The current
board props do not expose this fact, so the integrator must supply it from the
owning workflow query/authoring toolbar. A client-allocated workflow id is not
evidence of a saved version. A saved workflow with unsaved local edits remains
schedulable: the service runs its latest **saved** version, not those edits and
not the selected historical Run's version.

`isSaved={false}` (or a missing workflow id) produces a disabled clock and the
focusable tooltip “Save workflow first”, with no schedule HTTP request. The host
must provide its existing QueryClientProvider and UnsavedChangesProvider. Use the
existing application theme; do not add another modal provider or HTTP client.

## Transport integration gap — align with SCH-03

The frozen SCH-02 files specify payloads/results and idempotency semantics but
not HTTP paths, methods, error-code vocabulary, or a command-status read route.
This implementation isolates the following **proposed transport mapping** in
`client.ts`; it is not a claim that these handlers exist at the base commit:

| Action | Method/path | Body | Result |
| --- | --- | --- | --- |
| Get | `GET /api/workspaces/:workspaceId/workflows/:workflowId/schedule` | none | `ScheduleGetResult` |
| Save / enable | `PUT /api/workspaces/:workspaceId/workflows/:workflowId/schedule` | complete `ScheduleSaveInput`, including scope ids | `ScheduleSaveResult` |
| Disable | `POST /api/workspaces/:workspaceId/workflows/:workflowId/schedule/disable` | complete `ScheduleDisableInput`, including scope ids | `ScheduleDisableResult` |

Both path ids are URL-encoded. SCH-03 must reconcile this mapping (including body
scope ids), reject path/body scope disagreement, and supply authenticated routes
and equivalent authorized Operator MCP tools. No clear/delete action is invented
by this UI. Structured error envelopes use the existing shared `ApiError` boundary;
409 is treated as a revision conflict only when its outcome is definite. Do not
ship this UI as an integrated capability until transport and MCP parity are
verified with the backend lane.

## State and command safety

TanStack Query owns schedule readback, mutation lifecycle/errors, and the original
command variables. Zustand owns open state, editable form strings, field errors,
and draft comparison/concurrency tokens. A background read cannot overwrite an
initialized draft. Opening performs a fresh read; a failed read is never treated
as an absent schedule. The next-run line always comes from server readback in
the viewing device's timezone, never from a client recurrence preview or an edited form.

A command has no automatic retries/offline resume. Synchronous mutation-cache
checks fence double clicks and a second control for the same workflow. A network,
5xx, 408, 429, malformed-response, or unstructured 4xx failure retains the original
command. The Retry action explicitly replays its identical id, payload, revision,
and interval anchor. A later 4xx cannot erase earlier uncertainty. A matching GET
is not a receipt and does not permit a fresh save. Confirmed writes remain
confirmed even if their follow-up GET fails; replay responses are followed by a
fresh read because a receipt may describe an older revision.

Only the latest attempt per workflow/session is retained in MutationCache, with
infinite garbage-collection time so an unresolved command survives modal/board
unmounts with the same QueryClient. Query keys and writes use the existing
session-generation boundary; changing workflow remounts the local editor. A late
response cannot populate another workflow's cache or close its editor.

**Recovery boundary:** this lane does not add a durable browser outbox or a new
server receipt/status API. A forced document reload, QueryClient.clear(), or a
new QueryClient loses in-memory command identity. The existing unsaved-change
provider is registered with `canResume: false` and blocks ordinary departures /
warns before unload while a command is pending or unconfirmed. It must not promise
reload recovery. Durable recovery requires a separately agreed, owner/installation-
bound outbox or backend command-status contract. Do not infer non-acceptance from
a GET after such a forced reset.

## Editing rules

- New intervals anchor one chosen period after the first Save's browser instant;
  existing intervals preserve their anchor when reopened/edited. An uncertain
  retry never recomputes that anchor.
- An unchanged record toggled off uses Disable, so an exhausted/past Once can be
  disabled without trying to save a new past Once configuration. Other edits,
  including enable, use Save. The browser invokes the frozen validation helper
  for early feedback; the service's clock and validation remain authoritative.
- A conflict keeps the inputs and captured revision. Save is blocked until the
  user explicitly reloads/reopens server state; no silent revision rebase occurs.
- Shared Dialog implements backdrop/Escape/focus behavior. Dirty dismissal goes
  through the shared unsaved-change guard. Pending/unconfirmed operations lock
  editing and dismissal, with an explicit same-command Retry for uncertainty.
- Native date/time fields use the browser device's IANA timezone; no timezone
  selector is needed. New Once settings normalize to UTC and reopen locally.
  Weekly settings retain their saved source calendar until days/time are edited;
  on a different device, the fields show the next occurrence in local time with
  the saved source intent disclosed. A days/time edit intentionally uses the
  editing device's calendar. Viewing, unchanged saves and enabled-only edits
  preserve the original recurrence, including daylight-saving behavior.

## Verification

Tests use Vitest, Testing Library, and the existing MSW server, not mocked client
methods. They cover Weekly, second/minute/hour Interval units, Once, validation, conflict and
error preservation, disable/re-enable, fresh reopen, server-only next-run display,
backdrop versus inside drag, focus return, the unsaved guard, keyboard tabs,
unknown/malformed responses, same-command replay after remount, later 403 after
uncertainty, duplicate callers, failed follow-up GET, and workflow-switch isolation.

The 320px test checks responsive CSS/DOM invariants and a reserved footer outside
the scrolling body. **jsdom does not measure layout.** Real-browser horizontal
fit, native date/select widgets, short viewport scrolling, zoom, and focus traps
still need verification through the repo-approved built-in computer-use path.

Run in a complete checkout with the pinned runtime and release-age policy:

```sh
corepack pnpm install
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/web exec vitest run src/features/schedules --maxWorkers=4
corepack pnpm --filter @foreman-code/web typecheck
corepack pnpm --filter @foreman-code/web lint
corepack pnpm --filter @foreman-code/web build
```

Follow with repository-wide checks and SCH-03 authenticated HTTP/MCP integration.
The delivery manifest records exactly what was and was not executed here.
