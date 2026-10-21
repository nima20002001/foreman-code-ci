# SCH-09 — selected Run board

Repository: `nima20002000/graphql`  
Branch label: `feat/nim-2701-schedules`  
Exact base: `804ec9835d296b47ef314d0faa0e89cd5ab5fc79`

This is an **unmounted feature bundle**. Only files in this directory are added.
No `WorkflowBoard.tsx`, graph file, contract, route, dependency or lockfile is
changed. The host/route edits below are instructions, not applied changes.

## Public surface

```tsx
import { RunBoard, RunBoardSlot } from '../run-board'
import { RunsSelector, useSelectedRun } from '../runs-selector'

const selectedRun = useSelectedRun({ workspaceId, workflowId })

<RunsSelector selection={selectedRun} />
<RunBoardSlot selection={selectedRun}>
  {/* The complete, existing current-board owner, with Start/Save and its draft. */}
  {currentBoard}
</RunBoardSlot>
```

`RunBoard` alone renders the history region. `RunBoardSlot` additionally hides
and makes inert its **always-mounted** current-board child during history.
Use the same `SelectedRunState` object for the selector and viewer; it includes
`identity: { workspaceId, workflowId, runId: string | null }` and the per-visit
selection generation. Do not recreate this state from just `runId`: the first
A and the later A in A -> B -> A must have different generations.

The viewer uses the existing `useSelectedRunSnapshot` query and its authenticated
`runsSelectorApi.snapshot` client. It does not introduce a cache, URL parameter,
fetch implementation or writable copy of server state. All three identity fields
are checked by that client; the query checks the generation after the read and
removes data after failed reads. The component checks the generation again and
keys only its history canvas by generation. No previous-Run placeholder graph is
used. The legacy response displays exactly `Snapshot unavailable`; a valid empty
snapshot displays `No nodes`. Neither is repaired using today's workflow.

## Exact host mount at the pinned base

The existing host is `apps/web/src/routes/WorkspaceRouteEntry.tsx`. Do **not** edit
`WorkflowBoard.tsx`. Once the SCH-08 route prerequisites below are applied, add
these imports and this local wrapper to the route file:

```tsx
import type { ComponentProps } from 'react'
import { RunBoardSlot } from '../features/run-board'
import { RunsSelector, useSelectedRun } from '../features/runs-selector'
// Keep the existing WorkflowBoard import.

type HistoryBoardHostProps = Omit<ComponentProps<typeof WorkflowBoard>, 'run'>

function HistoryBoardHost(props: HistoryBoardHostProps) {
  const selectedRun = useSelectedRun({
    workspaceId: props.workspaceId,
    workflowId: props.workflowId,
  })
  return <>
    <RunsSelector selection={selectedRun} />
    <RunBoardSlot selection={selectedRun}>
      <WorkflowBoard {...props} />
    </RunBoardSlot>
  </>
}
```

In the existing `slots.graph` JSX, replace **only the opening/closing
`WorkflowBoard` tag names** with `HistoryBoardHost`, and remove `run={run}`.
Keep the existing `key={JSON.stringify([workspaceId, workflowId])}`, every other
prop, the status message and the entire `PersistedWorkflowBoundary` child.
That produces this shape (the other existing props are deliberately retained):

```tsx
<HistoryBoardHost
  key={JSON.stringify([workspaceId, workflowId])}
  workspaceId={workspaceId}
  workflowId={workflowId}
  selectRun={selectRun}
  summaries={details.runs}
  selectInspection={selectInspection}
  selectedAgentId={search.agentId}
  selectDraftAgent={selectDraftAgent}
  inspection={{ runNodeId: search.runNodeId,
    runRelationshipId: search.runRelationshipId, runExchangeKey: search.runExchangeKey }}
>
  {workspace.isError ? <p role="status">Workspace updates are unavailable. The local draft is retained.</p> : null}
  <PersistedWorkflowBoundary workspaceId={workspaceId} workflowId={workflowId} workflow={workflow} />
</HistoryBoardHost>
```

The wrapper is instantiated only after a workflow ID is resolved, so its hook is
not conditional and is never called with a fabricated empty ID. Do not key the
host, current `WorkflowBoard`, draft owner, or persisted boundary by Run. Do not
swap the current owner for a history component with a ternary. Do not pass Run
snapshot nodes into the authoring `graph` prop or install them in the draft store.
Removing `run={run}` here prevents the old version/inspector-driven canvas from
also rendering or driving the hidden authoring owner. The new viewer does not
invent a complete `RepeatGraphScopeV3` from the narrower snapshot contract.

### Required host work outside this bundle

The SCH-08 selector is itself unmounted on this base. Its
`../runs-selector/README.md` explains the full route integration. In particular:

* In `apps/web/src/app/router.tsx`, use `RunsSelectorSearchSchema` for the workspace
  route. In `WorkspaceRouteEntry.tsx`, import
  `resolveRunsSelectorBoardLocation as resolveWorkflowBoardLocation` from
  `../features/runs-selector`, not the frozen resolver directly.
* Preserve `selectedRunId` in default-workflow guards and unrelated search
  updates. Pass `withoutRunsSelectorSearch(...)` into strict older search helpers
  and departure predicates. An explicit current/legacy Run selection must clear
  conflicting pins. Keep the existing navigation blockers and unsaved/pending
  operation guards; selecting history is not an authorization to flush or save.
* **Portalled authoring overlays need their existing host guards.** `hidden` and
  `inert` cover the child DOM subtree, not a dialog/popover portalled into
  `document.body`. Before accepting a history navigation, the host must settle
  or close its authoring overlays through existing pending/unsaved guards; while
  history is selected it must not open an authoring portal. This slot does not
  intercept, forcibly dismiss, or rewrite the state of unrelated dialogs.

Without this host work, do not treat the example as a fully integrated Board.
In particular, toolbar-only mounting on the untouched route is insufficient.
Full route integration, existing body-portalled overlays, navigation blockers,
and the real editor's full draft lifecycle were not exercised here.

## Read-only canvas: no shared prop change required

The new canvas composes the repository's `AgentNodeView` and `SignalEdgeShape`
with React Flow. It does **not** call the old `SelectedRunCanvas` (which has its
own version/configuration/Run-inspection queries), and does not fetch current
Agent facts. Nodes use snapshot names, configuration references, positions and
sizes. Every snapshot edge is retained, including parallel approval/execution
relationships; labels, directions and explicit handles are preserved. Unspecified
handles use renderer-only right/left anchors; the stored edge is unchanged.

The shared `AgentHandles` has only a left target. This directory supplies a
small locked adapter with all four source/target handles instead of editing that
shared file. Edge curves feed measured handle coordinates into `SignalEdgeShape`
so they do not assume the current graph's fixed 212px card radius.

React Flow has its own nested provider/store. Dragging nodes, selecting elements,
connecting, reconnecting, deletion and keyboard editing are disabled on both the
canvas and its projected objects. There are no mutation callbacks, agent panels,
Start or Save controls. The Controls widget has no interaction-unlock toggle;
panning, zooming and Fit remain available. The design-system node's normally
clickable visual core is inert/aria-hidden; its outer focusable image wrapper has
the saved accessible name. There is no fabricated runtime status or harness.

The current editor can keep its existing background queries because its owner
stays mounted; that is not a source for historical rendering. No draft or graph
presentation store is imported or modified by production code in this folder.
The slot cannot prevent unrelated existing background effects from running.

## Verification and limits

No new dependency is required. The base web package pins React 19.3.0,
`@xyflow/react` 12.11.6, TanStack Query 5.102.8, Router 1.170.35, Vitest 5.0.0 and
MSW 2.15.0; the root pins `pnpm@11.27.0`.

**Executed:** eight dependency-free Node smoke checks of the actual projection,
curve and source boundaries; syntax/transpilation of all ten TS/TSX files with
available TypeScript 5.8.3; CSS parsing with PostCSS 8.5.6; archive/hash checks.
These are not a semantic typecheck, React render test or authorization proof.

**Included, not executed:** 19 Vitest cases across `model.test.ts` and
`RunBoard.test.tsx`. The latter uses actual Router, Query, authenticated client,
MSW and React Flow/shared renderers. Its layout shim supplies only jsdom's missing
geometry APIs. Race tests deliberately drop transport cancellation in a client
spy while still using real HTTP/MSW, so generation fencing is tested independently.
The draft test verifies the lifetime of a mounted editor probe containing unsaved
text and a local geometry buffer, not a booted production WorkflowBoard.

Direct Git access failed DNS resolution. The authenticated connector supplied
source at the exact base, but no full checkout/dependencies were available.
`corepack pnpm --version` attempted the required pnpm 11.27.0 download and failed
with `getaddrinfo EAI_AGAIN registry.npmjs.org`. No npm install, dependency
substitution, lockfile rewrite or policy bypass was used. Consequently the pinned
install, semantic typecheck, lint, Vitest/MSW, build, full integration/acceptance,
live 320px browser and screen-reader verification could not run.

After merging the bundle and completing host wiring, run from the repository root:

```sh
corepack pnpm install
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/web exec vitest run src/features/run-board --maxWorkers=2
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
# Also run the repository's integration/acceptance gates where services exist.
```

At 320px the CSS constrains the viewport, offers pan/zoom/Fit, and avoids a minimum
board width. The test simulates a 320px container; it does **not** prove actual
browser layout. Native browser verification is still required.

## Contracts, authorization and MCP

No frozen contract is changed. The snapshot endpoint is read through the existing
selector client and its response schema/identity validation. This UI adds no new
server capability, write authority, worker credential or MCP tool. SCH-05's
server-side authorization and equivalent Operator MCP snapshot reads remain the
backend dependency. Authenticated live HTTP/MCP denied-caller and persisted
readback tests were not run or reimplemented in this UI-only bundle. MSW denial
coverage must not be represented as backend/MCP authorization evidence.
