# FIL-39 — Project files

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`7485f07a74424617e58529b3836afb5e6e0387ab`.

## Mount

In `apps/web/src/routes/WorkspaceSectionRoutes.tsx`, add this import:

```tsx
import { ProjectFilesSection } from '../features/project-files'
```

In `SettingsRouteEntry`, immediately after the existing `settings-card-list`
`</ul>` and before `WorkflowDirectory`, mount:

```tsx
<ProjectFilesSection workspaceId={workspaceId} />
```

Pass the route's `workspaceId`, not an active-workspace store or a default ID.
The existing application QueryClientProvider is sufficient. No additional
provider or settings form integration is needed. The existing settings page and
all other base files are intentionally unchanged.

## Behavior and ownership

The section has an Upload button, bounded file pages, filenames, binary sizes,
icon download/remove actions, and a short shared Dialog confirmation. Removed
rows are omitted; pending rows cannot be downloaded. There is no expiry display,
editor, overwrite action, image preview, or rendering of untrusted file content.
Full filenames and icon labels remain available through accessible names and
native title tooltips. The list can shrink at a 390px viewport; filenames truncate
without shrinking the action buttons. The confirmation wraps long filenames.

TanStack Query owns server pages, request status, and upload variables. List and
mutation keys include workspace identity and the authenticated-session generation.
The section's keyed child and view-owned Zustand store hold only the local picker
issue and the exact immutable row selected for confirmation. They cannot migrate
into another workspace. The native file input is also remounted; a selection from
an old detached picker is never retargeted to the new workspace.

Uploads continue through SPA navigation using their original workspace, File,
request ID, and session boundary. Returning to that workspace while the request
is pending shows its existing upload state and disables a duplicate submission.
Hook-level settlement callbacks invalidate only the originating workspace's list,
even after its view unmounts. Errors and retries remain in that workspace's
mutation cache, not the newly selected workspace. Request state is in memory and
subject to the application's normal mutation-cache lifetime; it is not a durable
upload queue across reloads or browser shutdown.

Upload retries reuse the original request ID and the same File. An allocation
replay already marked ready returns immediately, recovering a lost finalize
acknowledgement without a second upload. Removal uses the existing CommandAttempt
helper: uncertain outcomes keep the original command ID and confirmation lock for
explicit retry. Downloads are canceled/suppressed on row or workspace unmount and
on authenticated-session changes. A late response cannot open a download from a
previous workspace.

## HTTP and contracts

The boundary is `projectFilesClient.ts`. JSON requests use the existing apiClient;
raw upload/download requests use same-origin fetch inside that boundary, preserving
session cancellation, late-response guards, normalized errors, and 401 notification.
MSW intercepts these real request paths; no mock client is used in production.

All operations use `/api/workspaces/:workspaceId/reference-files`:

- GET with `limit=50` and an optional opaque cursor.
- POST `/uploads`, then PUT `/uploads/:requestId` as raw
  `application/octet-stream`, then POST `/uploads/:requestId/finalize` with `{}`.
- GET `/:fileId/revisions/:revisionId/content` for pinned bytes.
- DELETE `/:fileId/revisions/:revisionId` with `{commandId}`.

The picker/filename/type/size inspection is reused from FIL-11's attachment helper.
Upload hashing uses the actual selected bytes. Every stage is checked against the
original workspace, file/revision pins, immutable metadata, size, and SHA-256;
finalize must report ready. Downloads are bounded to the revision's validated size
and verified against its MIME type and SHA-256 before creating a download-only
object URL. Object URLs are revoked after the browser's click task. API operations
have a 120-second client deadline and never accept host paths or remote byte URLs.
Server-side authorization and actual format validation remain FIL-36/FIL-03's job.

### Frozen contract gap

FIL-36 returns a bare FilePage, not the grouped WorkspaceProjectFilesList envelope.
The client parses FilePage and then validates it inside the existing shared
WorkspaceProjectFilesListSchema to enforce exact workspace-reference scope.
FIL-36's documented `{value: FileWithRevision, replayed}` command envelope is
composed locally from the frozen shared metadata schema. No API/domain metadata
shape is redefined and no shared contracts, route registrations, or migrations
are changed. The upload/remove transport-envelope gap reported by FIL-03/FIL-36
remains unchanged.

### Operator parity

This section is another consumer of FIL-36, not a new backend capability. The
existing `reference_files_list`, `reference_file_read`, `reference_file_add`, and
`reference_file_remove` Operator tools use the same underlying service. This change
does not register Agent writes, change grants, or claim newly executed MCP tests.
FIL-36's backend installation/migration prerequisites still apply.

## Tests

`projectFiles.test.tsx` uses the existing Vitest setup/server and real client with
MSW. It covers list/empty/pending/tombstone behavior, raw upload/finalize/download,
confirmation/dismissal/locking, removal readback, paging, long accessible names,
no expiry/edit labels, invalid picks, errors and explicit retries, same-name files
in different workspaces, A→B and A→B→A upload races, late list/download/removal
responses, native picker isolation, mismatched scopes/pins/hashes, zero-byte
Markdown, and authenticated-session changes.

`projectFilesBytes.test.ts` covers exact/chunked/empty bytes, SHA-256, truncation,
overflow cancellation, stream failures, size validation, and aborting blocked reads.

Run in a full checkout with the repository's pinned runtime:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/web exec vitest run src/features/project-files/
corepack pnpm --filter @foreman-code/web typecheck
corepack pnpm --filter @foreman-code/web lint
corepack pnpm --filter @foreman-code/web build
```

## Verification actually performed

- All 14 byte-helper tests passed with Node 22.16.0 after TypeScript transpilation.
  The local adapter changed only the test-runner import from Vitest to node:test
  and the emitted helper import extension. It used the shipped helper's unchanged
  implementation. This exercised Node's Blob path, not JSDOM's FileReader fallback.
- The byte helper passed an isolated strict TypeScript check with DOM types.
- All seven added TS/TSX files passed syntax/transpilation checks.
- The installed compiler was TypeScript 5.8.3, not the repository's pinned 5.9.3.
  These limited checks are not a workspace typecheck or a passing Vitest suite.

Not run: pinned dependency installation, Vitest/MSW tests, repository
typecheck/lint/build, backend HTTP/MCP/integration/acceptance suites, or real-browser
390px layout/focus/native-picker/download verification. The container had no full
checkout or web dependencies. Git cloning failed on GitHub DNS; the requested
source was inspected using the GitHub connector at the exact base commit.
Corepack could not fetch pnpm 11.27.0 because registry.npmjs.org returned
`getaddrinfo EAI_AGAIN`. No alternate npm install, dependency changes, database
services, or isolated browser environment were used.
