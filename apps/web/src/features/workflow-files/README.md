# FIL-38 — Board reference files

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`7485f07a74424617e58529b3836afb5e6e0387ab`.

## Mount

This folder is self-contained feature code. No existing source files are edited,
including `WorkflowBoard.tsx`, the shared contracts, dependencies, and lockfile.
The host already needs the app's `QueryClientProvider` and Nocturne styles.

From a component under `features/workflow-board`, import:

```tsx
import { WorkflowFilesButton } from '../workflow-files'
```

Mount in the Board toolbar using that Board's workspace/workflow identity:

```tsx
<WorkflowFilesButton workspaceId={workspaceId} workflowId={workflowId} />
```

`readOnly` is an optional presentation flag for a read-only/archived host view.
It hides workflow upload/removal controls. It is not an authorization grant;
FIL-36 always checks current server-side resource grants and lifecycle state.
The inherited workspace group is download-only regardless of this flag.
`className` and a mockable `WorkflowFilesClient` are optional.

These are the workflow's current permanent references, not a selected Run's
historical file provenance. The component does not read or mutate graph state,
the editable workflow draft, chat attachment drafts, or selected Run state.

## Behavior and ownership

- A small, labelled Files icon opens a native top-layer popover using the shared
  floating-surface helper. It clamps to viewport gutters, scrolls vertically,
  truncates long filenames, supports keyboard/outside dismissal, and restores
  focus on explicit close. Removal uses the shared Dialog, including backdrop,
  focus-return, and pending-operation locks, with one short confirmation.
- Two independent exact-scope TanStack infinite queries load workflow references
  and inherited workspace references. Each requests 25 rows, with a separate
  More action. Query keys include the scope kind, workspace, optional workflow,
  and document session generation. There is no previous-scope placeholder data.
- A keyed inner component discards the open popover, validation message, removal
  selection, and mutation observers when workspace/workflow identity changes.
  An old query cannot render under the new identity. In-flight mutations retain
  their original scope and are aborted on unmount. Late downloads cannot start
  a browser save after a Board or Operator-session switch.
- TanStack owns pages and upload/remove/download request status, errors, and retry
  variables. A non-persisted, per-instance Zustand store owns only the popover,
  removal selection/command ID, and local picker validation. No shareable state
  or second server-state cache is added.
- Names are presentation metadata, not keys. IDs distinguish same-name files
  across and within scopes. Overlapping pages are deduplicated by file ID only.
  Pending rows have no Download; removed tombstones are omitted from the visible
  list. There is no expiry text, edit control, overwrite flow, or content preview.

## HTTP boundary

`workflowFilesClient.ts` uses FIL-36's documented routes:

```text
/api/workspaces/:workspaceId/workflows/:workflowId/reference-files
/api/workspaces/:workspaceId/reference-files
```

List, allocation, finalize and remove use `apiClient.request`. That client is
JSON-only, so raw PUT and byte download are contained in this feature client,
using same-origin credentials, the app's session fence, cancellation/deadline,
normalized API errors, and authentication-required notification. MSW intercepts
these real HTTP calls; production never selects a mock transport.

Workflow upload reuses FIL-11's picker inspection/allowlist and the FIL-03/FIL-36
protocol: inspect a bounded file, compute SHA-256, allocate, PUT raw bytes with
`application/octet-stream`, then finalize. Scope, state, metadata, digest and
both pins are checked at every response. UI success requires ready readback,
not just a successful PUT. Retries reuse the original request ID and File;
an allocation replay already marked ready skips retransmission/finalization.
Each new selection allocates new IDs, even for an existing filename.

Removal sends `DELETE /:fileId/revisions/:revisionId` with `{commandId}` and checks
an exact-scope, exact-pin tombstone. A failed confirmation retains its command
ID for retry. This Board client rejects workspace-scope writes at runtime too.
No workspace upload/removal method is exposed by the UI.

Download pins `fileId` and `revisionId`, validates ready state and scope, then
checks MIME, exact size and SHA-256 before initiating an attachment download.
The byte buffer is bounded by the shared 25 MiB metadata limit; no unbounded
`response.blob()` is used. Object URLs are revoked after the save click.
Untrusted contents are never rendered, evaluated, or navigated to.

An interrupted upload may leave FIL-36 pending metadata/staging in its original
workflow. The component does not automatically finalize it after navigation or
pretend it was canceled. Pending workflow rows can be removed through the same
pinned, confirmed removal route. Permanent bytes are never overwritten.

## Frozen-contract gap / MCP parity

FIL-36 does not expose the frozen grouped Board DTO as a combined HTTP endpoint.
The UI composes the two exact-scope FilePage endpoints without changing shared
contracts. Its documented upload/remove result envelope is composed locally
from `FileWithRevisionSchema`; all domain shapes remain shared contracts.

No new backend capability or authorization policy is introduced. Operator parity
is the existing FIL-36 `reference_files_list`, `reference_file_read`,
`reference_file_add`, and `reference_file_remove` tools on that same service.
No tools or grants are added for Agents. Backend/MCP integration tests were not
executed as part of this UI handoff.

## Tests and verification

`workflowFiles.test.tsx` contains 26 Vitest/MSW cases, including parameterized
allocation/PUT/finalize errors. They cover A/B and cross-workspace switching,
late responses, late uploads/downloads, inherited read-only behavior, exact
pins, duplicate names, independent paging, pending/removed states, no expiry or
edit UI, short confirmation/backdrop behavior, failed-remove command replay,
unsupported picks, corrupt/mismatched responses, and session changes.
`workflowFilesModel.test.ts` contains 12 identity/presentation helper tests.

Actually run in the delivery container:

- All eight TypeScript/TSX files passed syntax/transpilation checks using installed
  TypeScript 5.8.3, not the repository-pinned 5.9.3. This is not typechecking.
- All 12 dependency-free helper tests passed under Node 22.16.0 after transpiling
  and changing only their `vitest` runner import to `node:test` and the emitted
  local module extension. No DOM, HTTP, shared-schema, or React tests were run
  through that adapter.

Not run: the 26 Vitest/MSW cases, the helper tests under pinned Vitest, the full
workspace typecheck/lint/build/test/integration/acceptance suites, authenticated
MCP execution, or a real browser/narrow-screen visual check. There was no local
checkout/dependency tree. Direct GitHub access failed DNS resolution, and the
pinned pnpm 11.27.0 bootstrap failed with `EAI_AGAIN registry.npmjs.org`.
No alternate package manager, dependency version, or isolated browser was used.

Run in the full pinned checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/web exec vitest run src/features/workflow-files/workflowFiles.test.tsx src/features/workflow-files/workflowFilesModel.test.ts
corepack pnpm --filter @foreman-code/web typecheck
corepack pnpm --filter @foreman-code/web lint
corepack pnpm --filter @foreman-code/web build
```
