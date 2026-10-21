# FIL-37 — effective Agent reference-file access

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`7485f07a74424617e58529b3836afb5e6e0387ab` (tree
`211fde3a1dd15e3ef54227f22281ab45db6c889e`).

## Delivery status: partial integration

The resolver, compact manifest, bounded read service, durable provenance adapter,
migration, production service composition, and tests are included. **This is not
an end-to-end Agent tool delivery.** The pinned base has no
`apps/api/src/modules/files/tools/` FIL-05 implementation. No existing Agent tool
calls the new service yet, and the new migration is not registered in
`migrations.ts`. These two integration steps remain open.

No shared contracts, frozen handoff documents, dependency manifests, lockfiles,
UI, native adapters, credential issuance, harness security settings, MCP tool
allowlists, or existing Operator management handlers are changed. There are no
new HTTP routes or MCP tool registrations. The sole existing-file edit is
`modules/files/production.ts`: compose and decorate the new service using the
existing FIL-03 repository and byte store.

## Backend entry point and authority

`registerProductionFileStorage` decorates Fastify with `agentReferenceService`.
Trusted authenticated backend adapters can obtain it as follows:

```ts
import type { AgentReferenceService } from './modules/files/references/agentService.js'

const service = app.getDecorator<AgentReferenceService>('agentReferenceService')
// Use the principal produced by the existing authenticated execution boundary.
const files = service.forExecution(principal)
const manifest = await files.list({ limit: 50 })
// A model explicitly requests a bounded range from a manifest pin.
const result = await files.read({ fileId, revisionId, offset: 0, length: 4096 })
```

An authenticated conversation adapter instead binds
`service.forConversation(principal, persistedConversationId)`. Pass only the
frozen `list`/`read` object to a tool adapter, never the management service or a
credential. The conversation ID must come from that adapter's bound conversation,
not model arguments or the currently selected Board. Binding does not cache a
grant: each list/read reloads and authorizes persisted identity. Successful reads
recheck it inside the provenance transaction as well.

For execution callers, the existing live worker credential binding must match
its exact execution, Run, Agent, workspace, and workflow. The resolver also calls
`assertWave25WorkerBinding`, preserving the current engine's purpose, Run state,
execution state, native-session/generation, and revocation checks. No scope is
inferred from an Agent ID or from a union of unrelated grants. A closed historical
worker credential is not reactivated by this feature.

For conversation callers, a stored Agent conversation supplies workspace/workflow
and Agent identity. If it has a Run origin, both origin IDs must match the exact
persisted execution and Run, including their workspace/workflow/Agent lineage.
A worker may use only its own execution's conversation, not another conversation
with the same Agent or even another execution in the same Run. Management callers
use the existing live/delegated principal and `agent_chat:read` authorization.
Historical Agent conversations do not depend on a node still existing in today's
graph. An owned global Operator conversation, or a global Operator execution view,
has no inherited references: list is empty and read returns `not_found` without
probing file metadata or bytes. Foreign/deleted/unauthorized conversations fail.

## Effective manifest and pinned reads

The backend list accepts only `{limit?, cursor?}`. It obtains exactly two scopes:
the resolved workflow's `workflow_reference` and its workspace's
`workspace_reference`. Temporary files, sibling workflows, and other workspaces
are excluded. Both scope dimensions remain attached to each row; filenames are
not identity and duplicate names remain distinct.

Rows contain only `filename`, `mediaType`, `byteSize`, `fileId`, `revisionId`,
`scope`, and `state` (`pending`, `ready`, or `removed`). There are no object keys,
host paths, inline bytes, or prompt-generation hooks. The page contains at most
100 rows total, not 100 from each scope. Pagination consumes workflow rows before
inherited workspace rows, performing at most two existing exact-scope repository
list calls per page. The outer cursor is bound to principal and resolved
conversation/Run/execution identity; the inner cursor retains FIL-03's scope
binding. A full final workflow page can be followed by an empty workspace page.
There is no unbounded scan to fill such a page.

Read arguments use the frozen strict `AgentFileReadInputSchema`: both IDs are
required and each response is at most 64 KiB. No scope, path, destination,
workspace/workflow, Agent, conversation, Run, or execution input is accepted.
The response passes `parseAgentFileReadResult` for exact pins/range/byte count.
FIL-03's verified immutable descriptor is read on demand, with only the requested
range buffered and the descriptor closed even on failure. Offset beyond EOF is
an error; offset at EOF returns an empty ready range. Missing pins/foreign scope
look unavailable. Pending/removed state and missing bytes return unavailable;
corrupt/truncated storage remains an error, never a fabricated successful read.

**Frozen-contract gap:** `FileManifestEntrySchema` is a full `FileWithRevision`
row and the shared list input requires a caller-supplied scope. This lane does not
silently change those contracts. Its compact manifest is a backend-only projection
of shared revision/scope types; its strict pagination schema picks the existing
pagination fields. A future public transport must explicitly adopt this envelope
or receive authorization to add a shared schema.

## Read-only access

The Agent-bound service has only `list` and `read`; it does not inherit the
management upload/add/finalize/cancel/remove methods. Existing FIL-36 management
operations retain their Operator-only audience and resource-grant checks.
Working-copy/publish schemas continue to require temporary destinations. There
is no permanent replacement/overwrite route, and FIL-36's immutable-head and
lifecycle trigger remains unchanged. New Agent tools must not expose FIL-36's
management principal/service to work around the missing runtime integration.

## Durable Run pins and removal

Migration 273637 creates two tables. `run_reference_file_pins` fixes the first
successfully read revision for `(runId, fileId)` across all executions in a Run.
`run_reference_file_reads` retains the first successful read fact for each
`(runId, executionId, fileId)`, including `revisionId` and `readAt`. Repeated ranges
are not separate audit events; they preserve the first fact's timestamp. Different
executions record distinct facts but share the Run-wide pin. Non-Run conversation
reads create neither an invented Run nor a provenance row.

Only after the bounded bytes have been read successfully does a transaction
reauthorize the exact context, share-lock and recheck the permanent file, validate
the execution lineage, and commit the pin and fact. A unique key serializes
independent-process first reads; a contender for another revision fails with
`FILE_REFERENCE_PIN_CONFLICT`, never updates the winner. No connection is held
while reading file bytes. No bytes are returned if authorization or provenance
commit fails. Metadata listing, unavailable results, and failed reads create no
pins. Reads at EOF still count as successful reads of the exact revision.

Both tables reject updates/deletes. Foreign keys and insert triggers enforce
exact revision, Run/execution lineage, inherited permanent scope, and read time.
They intentionally prevent parent deletion from discarding these historical
facts; no cascade deletes are added.

Run manifests consult existing pins before returning metadata. Explicit reads
never substitute `currentRevisionId`. FIL-36 already forbids changing a permanent
head; tests additionally simulate a newer head to exercise fail-closed historical
behavior. Missing pinned metadata is an error rather than a fallback. Tombstones
remain discoverable, but new reads after removal return unavailable and existing
facts remain intact. If removal wins before the read transaction checks the file,
no bytes or new fact are returned. A read admitted under the transaction's file
lock may finish delivering its already-read range after a later removal, matching
FIL-36's admitted-read policy. Storage objects are neither copied nor removed by
this lane.

## Migration integration (still required)

Register after `fileStorageMigration` (273601) and `fileReferenceMigration`
(273636). This handoff deliberately supplies the migration file, not a replacement
for the shared migration registry:

```ts
import { fileReferenceAccessMigration } from './fileReferenceAccessMigration.js'

// In the existing ordered migrations array:
fileReferenceAccessMigration,
```

Do not invoke the new service against a database without these migrations. No
request-time schema creation or compatibility fallback hides missing tables.

## Verification and remaining work

Executed here: **30 access/lineage tests passed**, using Node 22.16.0 after
TypeScript transpilation, with only the test-runner import changed from `vitest`
to `node:test` in a disposable execution copy. These tests execute the actual
`agentAccess.ts`, `agentLineage.ts`, and unchanged FIL-36 byte-range helper, with
injected authorization/storage/provenance test doubles. They do not execute Zod,
PostgreSQL, live credential authorization, or an authenticated MCP endpoint.
All 11 delivered TypeScript files passed syntax/transpilation diagnostics with
local TypeScript 5.8.3; this is not the repository-pinned 5.9.3 typecheck.

Authored but not run: `file-agent-reference-policy.test.ts` (13 cases) checks
strict inputs, authorization delegation, conversation ownership, and denial of
all existing permanent management mutations to workers. Its worker-authority
mock tests the call to existing engine authority, not the engine's native-session
implementation. `file-agent-reference-provenance.integration.test.ts` (7 cases)
uses real PostgreSQL transactions and the three real file migrations in an
isolated schema with minimal parent tables. It covers concurrent pins, retries,
exact lineage, scope inheritance, removal, and immutable history; it is not a
full application or native worker bootstrap fixture. It refuses any database URL
other than an explicit loopback `TEST_DATABASE_URL` whose database name contains
`test`, with no `DATABASE_URL` fallback.

Not run: pinned pnpm install, workspace typecheck/lint/build, the actual Vitest
suites, either PostgreSQL/application integration suite, authenticated MCP
execution, and production startup. The container has no workspace dependencies
or PostgreSQL; fetching pinned pnpm 11.27.0 through Corepack failed with DNS
`EAI_AGAIN`. No paid model or native session was started. MANIFEST.txt records the
actual checks and hashes of every payload file.

On a full pinned checkout, register the migration and run:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api exec vitest run test/file-agent-reference-access.test.ts test/file-agent-reference-policy.test.ts
# With an explicit disposable loopback TEST_DATABASE_URL:
corepack pnpm --filter @graphql/api exec vitest run test/file-agent-reference-provenance.integration.test.ts test/file-references.integration.test.ts --no-file-parallelism
```

Finally, bind FIL-05's authenticated Agent list/read handlers to this service and
add real authenticated endpoint discovery/denial/readback tests under the
existing tool-enablement policy. That hookup and endpoint proof are unfinished,
not implied by the production decorator or by the tests above. Native mounts,
prompt composition, UI, and new credential issuance remain outside this lane.
