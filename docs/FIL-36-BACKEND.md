# FIL-36 — permanent reference file management

Base: `nima20002000/graphql`, `feat/nim-2733-files`, commit
`219dfda4c7095ad76ef09cba4dca3ef3ca513daf`.

This change adds workspace/workflow reference management on FIL-03's existing
allocation, raw upload, immutable byte storage, validation, and pinned download
pipeline. It does not change shared contracts, the two frozen feature/storage
documents, `migrations.ts`, the UI, or Agent access resolution (FIL-37).
No dependency or lockfile changes are required.

## Installation and migration

Apply the full files in this handoff at their repository paths. The existing
`registerProductionFileStorage` startup call registers both conversation and
reference routes. It decorates Fastify with the reference service; the existing
MCP transport binds that exact instance in `onReady`. No second byte store or
startup registration is required.

Register `fileReferenceMigration` (version **273636**) after FIL-03's
`fileStorageMigration` (273601) in `apps/api/src/infrastructure/migrations.ts`:

```ts
import { fileReferenceMigration } from './fileReferenceMigration.js'

// In the existing ordered migrations array, after fileStorageMigration:
fileReferenceMigration,
```

The registration is intentionally not included in the changed files. Apply
FIL-03's migration first if it has not been registered in the integration tree.

FIL-03 already has permanent scope columns, an exact scope CHECK, no expiry for
permanent files, reference indexes, and immutable revision metadata. Migration
273636 adds a row trigger preventing reference identity/scope/head changes,
removed-file resurrection, ready-to-pending rollback, and physical deletion of
reference metadata. The existing SQL expiry guard in allocation publication is
fixed to accept permanent scopes without weakening temporary deadlines.

## HTTP surface

The two exact scope roots are:

```text
/api/workspaces/:workspaceId/reference-files
/api/workspaces/:workspaceId/workflows/:workflowId/reference-files
```

Every route uses the existing authenticated management HTTP boundary. A body
cannot supply a principal, scope, host path, storage key, or overwrite target.
The scope comes from the matched path and is checked against persisted workspace
and workflow lineage. Worker/Agent credentials are not management credentials.

| Method / suffix under either root | Request | Result |
| --- | --- | --- |
| `POST /uploads` | `{requestId,filename,mediaType,byteSize,sha256}` | `{value: FileWithRevision,replayed}`; 201 new, 200 replay |
| `PUT /uploads/:requestId` | Raw `application/octet-stream` bytes | Same envelope; verified/staged, not yet ready |
| `POST /uploads/:requestId/finalize` | `{}` | Same envelope; ready after publication |
| `DELETE /uploads/:requestId` | Empty or `{}` | Cancel pending staging; cannot cancel a finalized allocation |
| `GET` | `?limit=…&cursor=…` | Exact-scope `FilePage`, including pending and removed rows |
| `GET /:fileId/revisions/:revisionId/content` | No body | Byte-identical pinned attachment download |
| `DELETE /:fileId/revisions/:revisionId` | `{commandId}` | `{value: FileWithRevision,replayed}` containing a tombstone |

There is no overwrite, replacement, scope-move, or current-head download route.
`requestId` idempotency is per authenticated principal across scopes. Reusing it
with different metadata or scope conflicts. A retry after removal never creates
a replacement; a new upload requires a new request ID. Names are metadata, not
storage keys or uniqueness keys. Equal names in two scopes remain separate files.

Uploads reuse FIL-03's 25 MiB bound, deadline, byte-count/SHA-256/type verification,
raw streaming parser, private app-managed storage, and atomic no-overwrite object
publication. Downloads retain attachment disposition, UTF-8 filename handling,
`nosniff`, `private, no-store`, sandbox CSP, and pinned revision lookup. Pending
content is not downloadable; removed content returns 410. A read admitted before
a concurrent removal can finish; removal does not forcibly interrupt existing
streams.

## Authority and lifecycle

Workspace references require `workspaces:read`; writes additionally require
`workspaces:update` on that workspace. Workflow references require
`workflows:read`; writes additionally require `workflows:update` on that exact
workspace/workflow hierarchy. Read and update grants must overlap. Run-scoped
credentials do not become workflow or workspace reference grants. Archived
resources remain readable but cannot be mutated, matching management lifecycle
rules. No permissions are inferred from filenames, upload ownership, or an Agent
configuration.

Reference files are shared through resource grants, not uploader-private. A
second authorized editor can remove an upload made by another principal. Only
the allocating principal can continue/replay its upload request. Temporary chat
ownership semantics are unchanged.

Live principal/delegation, resource rights, and archival state are rechecked
before publication and under the metadata transaction. Revoking a grant while
bytes arrive cannot publish a new ready file. No database connection is held
while receiving the network body. Remove uses the existing command coordinator
and command ID receipt/audit transaction. Allocation and successful publication
also write source-specific management audit records without logging file bytes.

Removal retains the logical file and immutable revision metadata, marks the file
`removed`, and fences pending allocations. A previously finalized allocation
keeps that fact and cannot subsequently use staging cancellation to delete its
accepted object. Conditional SQL state changes plus the new trigger prevent a
late finalize from resurrecting a tombstone. No file head or revision is edited.

Permanent rows never contain `expiresAt` or a retention snapshot and are never
changed by `markExpired` or `applyFileRetention`. The FIL-03 cleanup seam already
filters `scope_kind='temporary'`; it is preserved. This task does not introduce a
cleanup job. Any later physical temporary cleanup must likewise select temporary
rows; object age alone is not an authority to delete bytes.

Removed permanent objects are retained by this lane; pending staging can still
be canceled through the pending-only route. Physical permanent-object reclamation
is not implemented. In particular, filesystem publication interrupted before a
metadata acknowledgment can leave an unreachable object behind a tombstone;
retaining it is safer than a deletion/publication race and is not temporary expiry.

## Operator MCP parity

The real `/mcp` endpoint registers four caller-filtered tools against the same
service used by HTTP. The backend role gate explicitly permits only the Operator
role for these names. Worker servers do not register the handlers. Naming an
unlisted tool directly returns an audited denial rather than bypassing discovery.

| Tool | Input / behavior |
| --- | --- |
| `reference_files_list` | `{scope,limit?,cursor?}`; exact-scope `FilePage` |
| `reference_file_read` | `{scope,fileId,revisionId,offset?,length?}`; `{value: AgentFileReadResult}` with at most 64 KiB canonical base64 |
| `reference_file_add` | `{scope,upload:{requestId,filename,mediaType,byteSize,sha256},contentBase64}`; runs allocate/PUT-equivalent/finalize internally |
| `reference_file_remove` | `{scope,fileId,revisionId,commandId}`; same audited pinned tombstone command as HTTP |

`scope` is the frozen permanent discriminated union. The read result reuses the
frozen range/pin/byte-count validator; it does not imply Agent authorization.
Reads return an unavailable state for pending/removed files. Not-found metadata,
foreign scope, invalid ranges, and corrupt bytes remain errors, not successful
empty reads.

MCP add is complete without an HTTP side channel, arbitrary path, URL fetch, or
shell execution. Canonical padded base64, exact byteSize, SHA-256, format, and the
same file bound are enforced. The bounded MCP request limit is
`4 * ceil(MAX_FILE_BYTES / 3) + 64 KiB` to admit a full-size file with its envelope.
Authentication/local-request checks run before JSON buffering and are repeated
before dispatch. MCP JSON/base64 is bounded but not streamed; use HTTP for raw
streaming upload. All other file byte validation is the shared FIL-03 path.

## Frozen contract gaps reported, not patched

1. The shared file contracts do not define reference upload/remove transport
   envelopes or canonical HTTP route paths. Backend envelopes compose their
   existing metadata, permanent-scope, pinned-reference, command-ID, list and
   read validators. No shared schema is widened.
2. The frozen Operator capability name enums predate these four tools. `tools/list`
   supplies their schemas and grant-filtered discovery. `operator_get_capabilities`
   includes an explicit `permanent_reference_files` runtime-limit note directing
   clients to that discovery rather than emitting values invalid under its frozen
   enum. The legacy `tools`/`requirements` arrays cannot enumerate the extension
   names until an authorized contract update.
3. Exact-scope file pages are not the grouped Board/workspace presentation adapters.
   This backend does not copy workspace files into workflow lists, merge/deduplicate
   scopes, resolve Agent inheritance, or compose Agent manifests. Those behaviors
   are outside FIL-36; the frozen grouped-list schemas are unchanged.

## Tests and verification

Added tests:

- `test/file-reference-bytes.test.ts`: canonical base64, full 25 MiB round-trip,
  exact range clipping/EOF, descriptor closure, truncated and failing streams.
- `test/file-reference-policy.test.ts`: read-only/disjoint/scoped grants, workers,
  explicit MCP roles, absent service, malformed destinations and overwrite inputs.
- `test/file-references.integration.test.ts`: real PostgreSQL/HTTP/MCP lifecycle,
  cross-workspace denial, exact lineage/pins, distinct same-name content, bounded
  pagination, immutable bytes/metadata, temporary-expiry exclusion, command replay
  and conflict, another authorized editor, canceled uploads, revoke-during-upload,
  remove/finalize race, MCP discovery/denial/audit/readback and full-size add.

Actually run in the delivery environment: 22 dependency-free byte tests passed
using Node 22.16.0 after TypeScript transpilation, replacing only the test runner
import from `vitest` to `node:test`. The byte helper also passed an isolated strict
TypeScript check with the installed local Node types. All changed/added TypeScript
sources passed syntax/transpilation checks. The available TypeScript was 5.8.3,
not the repository-pinned 5.9.3; these checks are not a workspace typecheck.

Not run: pinned pnpm installation, repository typecheck/lint/build, the Vitest
policy suite, either PostgreSQL integration suite, or authenticated MCP execution.
The container lacked the workspace dependencies and PostgreSQL; fetching the
required pnpm 11.27.0 through Corepack failed with DNS `EAI_AGAIN`. No paid/native
model sessions were started. Do not treat the authored integration tests as passed.

Run on a full pinned checkout with the repository toolchain and a disposable
loopback `TEST_DATABASE_URL` accepted by the existing helper:

```sh
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api exec vitest run test/file-reference-bytes.test.ts test/file-reference-policy.test.ts
corepack pnpm --filter @graphql/api exec vitest run test/files.integration.test.ts test/file-references.integration.test.ts --no-file-parallelism
```

The integration fixture applies 273601 and 273636 explicitly in its isolated
schema, so it does not require editing `migrations.ts` just to exercise the lane.
