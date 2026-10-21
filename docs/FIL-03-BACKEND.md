# FIL-03 — temporary file storage and HTTP API

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`4884027a7fa168a4131fb6957a21237c48ceecaa`.

The frozen `packages/contracts/src/files.ts` and
`docs/FEAT-03-FILES-CONTRACT.md` are unchanged. No dependencies, lockfiles,
chat send contracts, native harnesses, MCP tools, UI, sweeping jobs or permanent
library routes are changed.

## Integration

`server.ts` registers `registerProductionFileStorage(app, database.pool, config)`
after constructing the authenticated production app and before listening. The
same helper can be used by another HTTP composition; `buildProductionApp` alone
does not install this lane's routes. Tests can instantiate the repository,
service and route adapter separately without starting a native harness.

**Required manual migration registration:** add the following import and array
entry to `apps/api/src/infrastructure/migrations.ts`. This ZIP intentionally does
not modify that file.

```ts
import { fileStorageMigration } from './fileStorageMigration.js'

// Inside the existing exported migrations array:
fileStorageMigration,
```

The migration version is **273601**. It creates `files`, `file_revisions`, and
`file_allocations`. It must run before the file routes are used. The integration
test applies it explicitly in an isolated schema when it is not yet registered.

`FILE_STORAGE_ROOT` configures an absolute app-managed directory. Its default is
`~/.local/share/graphql/files`, resolved from the API process's home directory.
A trusted `ApiConfig.fileStorageRoot` override is also supported. Use a persistent,
private directory owned by the API account (mode 0700). The implementation
requires a filesystem supporting hard links, no-follow opens and directory
fsync. Do not mount its staging and objects subdirectories on different devices.

Initialization refuses temporary directories, workspace/harness overlap,
symbolic-link paths, non-private directories and foreign ownership. Objects and
staging live under the same managed root; no filename, conversation ID or client
path is interpolated into a host path. Object/attempt keys are server-generated
UUIDs. Only metadata, hashes and internal object keys go into PostgreSQL.

## HTTP protocol

Operator root:
`/api/operator/conversations/:conversationId/files`

Agent root:
`/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/files`

These routes inherit the existing Operator authentication, browser Origin/CSRF
policy and management grants. Neither a caller-supplied owner nor a caller-
supplied file scope is accepted. Every method resolves an existing, non-deleted
conversation before touching file metadata or bytes.

| Method and relative path | Input and result |
| --- | --- |
| `POST /uploads` | Strict JSON `{requestId, filename, mediaType, byteSize, sha256}`. Returns `{value: FileWithRevision, replayed}`; 201 for the first allocation, 200 for a replay. |
| `PUT /uploads/:requestId` | Raw `application/octet-stream`, without content encoding. Streams into staging; returns the same metadata envelope after validation. Chunked transfer is supported. |
| `POST /uploads/:requestId/finalize` | Empty JSON object or no body. Atomically publishes verified bytes, then marks the file ready. Returns the metadata envelope. |
| `GET /` | Optional `limit` and opaque `cursor`. Returns the frozen `FilePage` shape for the exact conversation scope. |
| `GET /:fileId/revisions/:revisionId/content` | Downloads that exact revision. It never resolves a missing revision to the current head. |
| `DELETE /uploads/:requestId` | Empty body/object. Tombstones and removes pending staging, with retryable cleanup; it does not delete a finalized file. |

The metadata envelope never exposes storage keys, host paths, or inline bytes.
`requestId` is unique per authenticated principal across conversations. Repeating
it with different metadata or a different conversation returns 409. It is not a
cross-principal lookup capability. Upload/finalize/cancel need both chat read and
chat write grants; reads need chat read grants.

Operator scope is derived solely from owner, Operator and conversation identity;
there are no workspace, workflow, Agent, Run or execution fields. Agent scope is
derived from the persisted workspace/workflow/Agent conversation and its optional
paired origin Run/execution. Agent conversations at this base intentionally have
no owner principal: authorization therefore uses their persisted resource grants,
matching existing Agent chat behavior rather than inventing owner-based access.

Downloads use attachment disposition (safe ASCII fallback and UTF-8 extended
filename), the allowlisted media type, verified length, private/no-store,
nosniff, a restrictive sandbox CSP and same-origin resource policy. Range and
conditional-cache behavior is not implemented. Missing bytes or effective
expiry/removal return 410; a pending file returns 409; foreign conversation/file
IDs do not return file data. Explicit authentication failures use existing
401/403 behavior.

## Publication, retry and interruption

1. Allocation commits the logical file, immutable revision and owner/request
   receipt in one transaction, including the original creation instant and
   retention-duration snapshot.
2. Each incoming attempt writes a distinct private `.part` file. Actual byte
   count and SHA-256 are checked during the stream with backpressure. Type and
   structure validation occurs before the candidate is eligible for staging.
3. Verified bytes are fsynced and made read-only. A no-overwrite hard link
   publishes `staging/<key>/verified`, followed by directory fsync.
4. Finalization verifies staging and atomically links it to `objects/<key>`,
   fsyncs the objects directory, then commits ready metadata. It removes the
   redundant staging link. A previously published object must match the same
   immutable size and hash before a retry can acknowledge it.

Owner/request advisory locks coordinate allocation/publication/cancel across API
processes. A busy commit returns a retryable 409 rather than queueing indefinitely.
No pool connection or transaction is held while receiving the network stream.
Authentication and conversation authority are checked again after receiving bytes.
Upload streams have a bounded deadline; truncated, disconnected and rejected
attempts are removed without truncating another retry's staging file.

A lost staging acknowledgement leaves an `allocated` receipt with verified
staging; finalize can recover it. A lost finalization acknowledgement leaves an
existing object with pending/staged metadata; finalize verifies it and repairs the
metadata. A crash during a partial write may leave an unreferenced `.part` file;
a later attempt uses a different attempt ID. FIL-04 owns sweeping such crash
residue. Cancellation commits the tombstone before deleting bytes so a crash or
filesystem failure can be retried, and a stale uploader cannot resurrect it.

Downloads rehash the same open descriptor they subsequently stream. Verification
uses explicit-position bounded reads: destroying a verification stream must not
close the descriptor before final publication or download. The byte tests cover
this lifecycle and both filesystem publication/restart boundaries.

## Validation policy

The upload envelope composes the frozen file metadata validation, including the
25 MiB maximum, safe filename, filename/MIME agreement and lowercase SHA-256.
PNG/JPEG/WebP/GIF, PDF, DOCX, Markdown and ZIP are supported.

Markdown must be UTF-8 without binary control characters. Images/PDF receive
signature/structure checks; PNG chunks additionally receive CRC checks. ZIP and
DOCX directory/local-header metadata, paths, compression sizes and CRCs are
checked without extracting to disk. DOCX requires the core Office package parts.

Backend archive safety bounds are 1,000 members, at most the file limit in total
expanded bytes, a 100:1 expansion ratio, and 1 MiB per inspected DOCX structural
XML part. Encryption, links, traversal, ambiguous paths, ZIP64, duplicate member
names, unsupported compression, and active/embedded Office packages in DOCX are
rejected. These stricter archive policies are backend choices, not additions to
the frozen shared contract. Type/structure validation is not antivirus scanning,
full image decoding, XML validation or PDF sanitization.

## Reuse seams

`PostgresFileRepository` implements `FileRepository`:

- `create` atomically persists a logical file and its first immutable revision;
  it accepts temporary and permanent scopes. The caller owns byte publication.
- `read(fileId, revisionId)` returns precisely pinned metadata and an internal
  object key. It never follows the discovery head as a substitute.
- `list(scope, page, asOfUtc)` uses exact discriminated scope predicates. Absent
  SQL scope columns are matched with `IS NULL`, never treated as wildcards.
  Keyset cursors bind to a hash of the canonical scope. Readback shows effective
  expiry even before a sweeper persists it.
- `markExpired(fileId, asOfUtc)` changes only due, still-pending/ready temporary
  metadata. It neither deletes bytes nor expires permanent references.

The repository is a trusted internal persistence seam, not an authorization
boundary. FIL-05/FIL-36 must authorize their caller and persisted lineage before
using it. FIL-36 can explicitly combine workspace-reference and workflow-reference
lists for inheritance; temporary conversation lists do not silently include either.
The migration retains revision metadata on expiry/removal and rejects revision
updates/deletes. Scope-specific SQL constraints are wrapped in `IS TRUE` so SQL
NULL cannot accidentally satisfy a required-field constraint.

## Frozen-contract gaps and deferred integration

**HTTP envelopes:** FIL-02 defines file metadata and tool/library contracts, but
not upload allocation, raw-upload, finalize or cancellation HTTP inputs/results.
This lane supplies a documented backend transport envelope in
`modules/files/requests.ts`, without editing the frozen source. Promote it to a
shared contract only in an explicitly authorized follow-up.

**Retention preferences:** allocation has an injected authenticated-owner
preference reader. The production default is the frozen seven-day duration.
Preference persistence/routes and apply-to-existing integration are deferred;
FIL-04 owns sweeping. Replays retain the first allocation's original retention snapshot.

**Conversation existence and adoption:** uploads require an existing conversation;
this lane does not create a first conversation or alter either chat send schema.
The frozen contract does not define a durable sent/adopted marker for an upload.
Cancellation is therefore deliberately limited to pending staging. A finalized
file cannot be deleted via cancellation merely because a client calls it unsent.
Message attachment adoption and post-finalize unsent cleanup need an explicit
follow-up contract/transaction.

**Agent ownership:** the existing Agent chat model is shared-resource/grant based,
not owner-principal based. A stronger owner-only policy needs a coordinated chat
ownership contract change; this lane preserves the existing authorization model.

**Tools and libraries:** no MCP tools, attachment delivery to harnesses, capability
claims, UI, or permanent reference routes are installed. The HTTP-only delivery in
this lane is intentional; FIL-05 owns tool parity and FIL-36 owns library behavior.
The `@graphql/contracts/files` package export already exists at the pinned base.

## Tests and verification

`file-storage.test.ts` covers every allowed media type with chunked writes,
byte-identical download, repeated finalize/restart, concurrent completed retry
candidates, partial/disconnected streams, actual overflow, aborted upload cleanup,
SHA/size/type/CRC failures, malformed text, unsafe archives, empty Markdown,
missing/corrupted bytes, path separation and symlink rejection.

`file-authorization.test.ts` covers persisted Operator ownership, Agent resource
and Run scope, read/write policy, invalid credentials, frozen metadata composition
and safe download headers.

`files.integration.test.ts` uses real PostgreSQL, real credential authentication,
Fastify routes and disk storage. It covers each type over HTTP, two-chat isolation,
foreign/missing IDs, request deduplication/conflicts, partial retry/cancel, lost
staging/finalization acknowledgements, scope constraints, revision immutability,
expiration, permanent repository groundwork and cross-scope cursor rejection.
It uses the existing guarded `TEST_DATABASE_URL` helper and a random isolated
schema; it does not use a production database or launch a model.

Expected verification in a full checkout (after migration registration):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api test test/file-storage.test.ts test/file-authorization.test.ts
# With an explicit loopback TEST_DATABASE_URL configured:
corepack pnpm --filter @graphql/api exec node ../../scripts/heavy-job.mjs -- vitest run test/files.integration.test.ts --no-file-parallelism
```

The package-wide integration script can also run a broader selection; an explicit
loopback test database is required. See `MANIFEST.txt` for checks actually run.
In the delivery environment, only the storage tests could be executed using a
Node test-runner adapter and an installed TypeScript transpiler. This is not a
claim that the pinned Vitest suite, full typecheck, lint, PostgreSQL integration or
production startup passed.
