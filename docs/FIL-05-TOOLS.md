# FIL-05 — authenticated, file-only agent tools

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`92a8ee5c6756917710a9de99dfde6ee9d1fdd6a9`.

## Delivery status

The ZIP contains the implementation, PostgreSQL migration/repository, MCP
registration, runner artifact seam, unit/endpoint tests, PostgreSQL repository
tests, and independently runnable byte-transfer tests. Frozen contracts are
unchanged. There are no new package dependencies or lockfile changes.

**Outstanding integration:** `infrastructure/migrations.ts` is not changed in
this delivery. Register the migration below before using the endpoint. This is
a partial integration delivery, not a claim that production startup, the pinned
Vitest/MCP suite, full typecheck, or PostgreSQL integration passed.

## Migration registration (required)

Add to `apps/api/src/infrastructure/migrations.ts`:

```ts
import { fileToolsMigration } from '../modules/files/tools/migration.js'

// In the exported migrations array, after fileStorageMigration:
fileToolsMigration,
```

Version **273605**, after FIL-03 version **273601**. The migration adds:

- `file_tool_sessions`: only token digests, immutable bound context, expiry/revocation.
- `file_tool_artifacts`: opaque handles, ownership binding and compare-and-set writer state.
- `file_tool_copy_receipts`: durable create-working-copy command receipts.
- `file_tool_publications`: append-only file/revision-to-native-turn links, with optional message identity.
- `file_tool_read_provenance`: append-only successful Run read pins.

These are backend integration records, not revisions to the frozen shared DTOs.
Publication/copy receipts and provenance cannot be updated or deleted. Artifact
content is stored in FIL-03's managed byte directory, never in JSON/PostgreSQL.

## Existing-file edits

`modules/files/service.ts` adds `allocateAgentResult`, a trusted, non-HTTP method
sharing the existing allocation/retention/receipt implementation. It derives the
agent origin and publication identity from the tool service. Existing human
upload receipt hashes remain unchanged. The public upload input still cannot
supply origin, context, storage keys or publication identity.

`modules/files/production.ts` registers the separate file-only endpoint and
accepts an optional fourth `FileReferenceResolver` argument for FIL-37. Existing
three-argument callers and the returned `TemporaryFileService` are preserved.

Everything else is new under `modules/files/tools/`, `test/`, or this document.
No changes to the workflow GraphQL MCP registry, management credentials, native
adapters, chat send schemas, UI, cleanup, or existing migrations are included.

## Authenticated surface

`POST /mcp/files` uses the same installed MCP server/node SDK transport pattern
as the repository's existing stateless endpoint. It registers only:

| Tool | Frozen input/result |
| --- | --- |
| `files.list` | `AgentFileListInputSchema` / `AgentFileListResultSchema` |
| `files.read` | `AgentFileReadInputSchema` / `AgentFileReadResultSchema` |
| `files.create_working_copy` | `AgentFileCreateWorkingCopyInputSchema` / corresponding result |
| `files.publish_result` | `AgentFilePublishInputSchema` / corresponding result |

Only dedicated `gql_file_…` credentials are accepted. Operator/worker tokens,
browser cookies, workflow App MCP credentials and browser navigation are never
used as fallback authentication. No credential-exchange/issuance HTTP tool is
exposed. Host/Origin checks reuse `requireLocalRequest`. The endpoint sits outside
`/api/` deliberately and has its own mandatory authentication on every method.
GET and DELETE authenticate and then return 405.

The authenticated session fixes the owner, complete discriminated conversation
scope (including Agent and paired Run/execution identities where present),
native session, turn, optional message, accepted file-tool allowlist, and accepted
harness mutation restriction. Current owner grants and persisted conversation
lineage are rechecked on every operation and after potentially slow byte I/O.
Revoked/expired owner/session credentials fail closed. Sessions last at most one
hour and never outlive their owner principal.

Frozen list/copy/publish inputs include scope/destination fields. These are
**assertions only**, checked against authenticated context; they cannot select
another conversation, Run, execution or owner. Extra context/owner/path fields
are rejected by the frozen strict schemas. Discovery omits disallowed writes,
including when current owner grants have been revoked. A direct denied call has
no file allocation or native side effect.

## Native integration seam (adapters intentionally not registered)

`productionFileTools(app)` returns the service from trusted server composition.
The later native adapter must call `sessions.issueForAcceptedSession` only from
its authenticated, persisted native session/turn admission. In particular,
`allowMutation` and `allowedTools` must come from that Agent's accepted harness
security configuration, not a tool request or the owner's broader privileges.
The owner ID is used internally to re-read authority; no owner credential is
passed to the native harness. The adapter receives only the scoped file token.
Revoke that file session when the native binding is withdrawn.

Runner-generated output uses `artifacts.create(token, filename, mediaType)`,
then `artifacts.completeWrite(token, artifactId, writeId, byteStream)`. The
`source` parameter is for the trusted copy service, not agent-controlled output
registration. An edit uses `beginWrite`, followed by `completeWrite`; the new
writer immediately makes the handle unpublishable until completion. An
interrupted writer is failed; a stale writer cannot overwrite a new one.
`abortWrite` is the trusted cancellation/recovery seam for an abandoned writer.

There is no `open(path)`, path conversion, external URL fetch, shell execution,
or arbitrary host-file publish API. Artifact IDs are opaque UUID lookup keys.
The registry copies bytes synchronously on stream delivery and requires EOF,
then uses FIL-03's existing size/hash/type validation and immutable storage.
Only a completed snapshot can be published. Subsequent writes create new
objects, never mutate the snapshot an in-flight publish selected.

Handles are deliberately bound to the exact authenticated native session/turn
as well as owner/conversation/Run/execution. A new token for that same accepted
binding can retry after a process restart; another turn cannot adopt its handle.
The broader frozen conversation-scoped artifact contract permits this narrower
backend policy. Reuse across turns should use the published immutable file pins.

## Publish, retry and turn links

The frozen tool contract names the retry key `commandId`; FIL-03 names it
`requestId`. The service deterministically maps commandId into a namespaced
FIL-03 requestId. The allocation fingerprint additionally binds the originating
context, artifact identity, source pins, current completed content hash/length,
filename/media type and server-computed origin. Different content, filename,
artifact or context under the same key conflicts, including after a restart.
Unchanged source bytes use `agent_copy`; generated/edited bytes use `agent_output`.

Publication reuses FIL-03 allocate, raw-byte upload, verification and finalize.
It always allocates new temporary file/revision IDs and snapshots the owner's
retention preference through FIL-03. Original source bytes are never overwritten.

The immutable turn link commits **before** finalize. A crash after ready metadata
is committed therefore cannot leave a ready tool result without its originating
turn link. A failure before finalize leaves only a pending allocation/link;
`publishedForTurn(token)` excludes non-finalized allocations. A retry repairs
that same allocation instead of minting another result. Successful readback
returns exact attachment pins; expiry/removal never substitutes a newer head.
The relation stores optional message identity and required native session/turn
identity, not an invented browser message selection. Existing chat projection
schemas are not modified; later adapters can adopt these refs through this seam.

## References and reads

Reads pin fileId+revisionId and enforce the frozen 64 KiB range limit. Metadata
is checked again after reading to catch removal or a changed retention deadline.
Run reads append exact Run/execution/file/revision/read-time provenance. List is
bounded metadata-only paging through FIL-03; no automatic content injection.

Permanent write destinations, targets, replacement and removal are not exposed.
The frozen strict copy/publish schemas reject permanent destinations and extra
`target` fields. A future FIL-37 resolver can authorize workspace/workflow
inheritance and supply permanent reads. Its interface has only list/open, not
mutators. Copying an authorized reference later makes detached temporary working
bytes; it cannot edit the reference. Without the resolver, reference reads/lists
return an explicit `FILE_REFERENCE_RESOLVER_REQUIRED` error, not a false success.

## Cleanup boundary

This lane does not sweep artifacts, obsolete completed snapshots, abandoned
writes, or allocation crash residue. All published results retain FIL-03's
ordinary temporary lifecycle. A future artifact sweeper must account for object
keys in `file_tool_artifacts`, not just `file_revisions`. Concurrent working-copy
creation can leave an unreturned losing artifact/snapshot; the unique receipt
still exposes only one handle. No cleanup or permanent-reference behavior is
silently broadened here.

## Verification

Actually executed in the delivery container:

- Nine Node byte-transfer/range tests passed after fixing a mutable-buffer
  prefetch regression caught by the new test.
- All delivered TypeScript files syntax-transpiled with installed TypeScript
  5.8.3. This is not the repository's pinned TypeScript 5.9.3 full typecheck.
- A strict typecheck passed for the two dependency-free transfer source/test
  files using TypeScript 5.8.3 and installed Node types 25.1.0. This does not
  typecheck the service, MCP transport, PostgreSQL adapter, or shared-contract integration.
- The two existing-file baselines were independently checked against their
  Git blob hashes before generating the surgical modifications.

The pinned pnpm 11.27.0 bootstrap failed with DNS `EAI_AGAIN` for the package
registry. No dependencies were substituted or installed with npm. Therefore
16 Vitest domain/real-MCP-endpoint tests and four real-PostgreSQL repository tests
are included but were **not run**. The unit byte boundary is explicitly in-memory;
existing FIL-03 disk/type/structure tests remain required. There is no claim of
full typecheck, lint, build, native acceptance, or production startup success.
See MANIFEST.txt for exact delivery checks and remaining integration work.

Run in the pinned checkout after migration registration:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api test test/file-tools.test.ts
corepack pnpm --filter @graphql/api exec node --import tsx --test test/file-tool-transfers.node-test.ts
# Explicit loopback TEST_DATABASE_URL, with "test" in the database name:
corepack pnpm --filter @graphql/api exec node ../../scripts/heavy-job.mjs -- vitest run test/file-tools-postgres.integration.test.ts --no-file-parallelism
```

The PostgreSQL suite uses a random isolated schema and minimal FIL-03 foreign-key
fixtures. It complements, but does not replace, `files.integration.test.ts` or a
full migration/startup test. Also run the repository-wide checks from AGENTS.md.
