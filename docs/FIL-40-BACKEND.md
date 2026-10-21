# FIL-40 — temporary chat file retention

Base: `219dfda4c7095ad76ef09cba4dca3ef3ca513daf`, branch `feat/nim-2733-files`.
The shared file contracts and the two frozen file-contract/backend documents are unchanged.
No dependencies, UI, cleanup sweeper, or native harness changes are included.

## Integration

Add this import to `apps/api/src/infrastructure/migrations.ts`:

```ts
import { fileRetentionMigration } from './fileRetentionMigration.js'
```

Add this entry to the exported `migrations` array, immediately after the existing
`fileStorageMigration` entry:

```ts
  fileRetentionMigration,
```

The new migration is version **273640**. FIL-03 version **273601** is already
registered at the pinned base. This package deliberately does **not** edit
`migrations.ts`. Apply the new migration before starting the updated API.
It creates one preference row per owner and a partial live-temporary-owner index.
Command receipts and audit records reuse the existing management tables.

`buildProductionApp` creates one `FileRetentionService` and supplies the same
instance to the HTTP routes and Operator MCP services. The existing
`registerProductionFileStorage` installs the transactional retention snapshot
adapter for FIL-03 allocations. No extra registration in `server.ts` is needed.

## Identity and permissions

There is no target-owner parameter. The verified principal's ID selects the
preference, file owner predicate, command namespace, and readback identity.
All methods require an active, non-revoked, non-delegated `operator` principal
and unscoped `settings:read`; save additionally requires unscoped
`settings:update`. The live persisted principal is checked inside the database
transaction, including before command-receipt replay. Its authority row stays
share-locked through that transaction.

This follows the existing root-human authority convention in
`modules/access/runAuthority.ts`: a non-delegated Operator principal represents
its own root authority. The implicit local human and explicitly granted
non-delegated Operator credentials can act. Worker/User audiences and delegated native
Operator/Run credentials cannot manage retention, even with broad settings
grants. Delegates are never silently translated to their parent owner.
Loopback and Origin protections remain at the HTTP boundary; `/mcp` still requires
explicit bearer authentication. Authorization denials from this service are audited for
both transports; direct MCP calls to grant-hidden retention tools are also
audited and return an explicit denial.

Operator conversation ownership and Agent conversation resource authorization
remain FIL-03's existing rules. In particular, an Agent chat is still shared by
its resource grants. Retention uses `files.owner_principal_id`, the existing
allocating owner, without inventing a conversation owner or changing who can
read that chat. No ownership backfill or delegated-owner remapping is included.

## API and MCP

All payloads/readbacks use the unchanged `@foreman-code/contracts/files` schemas.
Transport paths and MCP registration names are backend additions:

| HTTP | Operator MCP | Input / result |
| --- | --- | --- |
| `GET /api/management/file-retention` | `file_retention_get` | Empty input; `{ preference }` |
| `POST /api/management/file-retention/preview` | `file_retention_preview` | `{ durationSeconds }`; owner, preference revision, duration, `asOfUtc`, `expireNowCount` |
| `POST /api/management/file-retention` | `file_retention_save` | `commandId`, `durationSeconds`, optional `expectedRevision` and `applyToExisting`; `{ value: { preference, updatedFileCount, expiredNowCount }, replayed }` |

Get rejects query owner selectors. All input schemas are strict. An unset
preference reads as **604800 seconds / 7 days, revision 0** without inserting a
row. Durations are integer seconds, inclusive **3600 through 31536000**
(1 hour through 365 days). A first successful save stores revision 1; each
subsequent accepted new command advances the revision, including a same-value
save. There is no sliding expiry or local-calendar arithmetic.

Omitted `expectedRevision` applies the last write to current state. A supplied stale revision returns `REVISION_CONFLICT` / HTTP 409. Reusing a command ID
with different normalized input returns `COMMAND_ID_CONFLICT` / 409. Omitted
`applyToExisting` and explicit `false` normalize to the same command; HTTP and
MCP share command identity. Identical replay returns the historical accepted
receipt without incrementing revision or reapplying retention to later files.
Get provides the current preference after newer commands. A preview is an
as-of read, not a reservation or a promise that a later save has the same count.
The owner advisory lock has a five-second lock timeout; an owner-lock timeout
returns `FILE_RETENTION_BUSY` / 409 and the same request can be retried.

### Frozen-contract discovery gap

The pinned management `OperatorToolNameSchema` and
`CurrentOperatorToolNameSchema` do not contain the three retention names.
Therefore the existing `operator_get_capabilities.tools`/`requirements` enum
cannot enumerate them without a shared-contract change. This package leaves
those contracts and that enum-based capability result unchanged. The tools
are discoverable through actual MCP `tools/list`, with frozen file schemas,
permission/owner restrictions, bounds, side effects, retry semantics and
readback documented in their descriptions. Backend unified-role classification
explicitly makes the three names Operator-only; worker tool registration is
unchanged. A contract-owner follow-up is required to add these names to the
enum-based capability inventory. No fabricated shared enum values are emitted.

## Allocation and apply-to-existing semantics

New allocation creation and preference saves take the same transaction-scoped
owner advisory lock. FIL-03's request allocation lock remains in place. The
preference read, creation timestamp, file/revision insertion and allocation
insertion occur inside **one transaction on one client**; there is no second
pool checkout under an allocation lock. Creation samples the clock after the
preference snapshot is available. Preference changes never happen between that
snapshot and allocation commit. Neither lock is held while receiving network
upload bytes. Allocation retries do not resample today's preference.

The additive `AllocationSession.createWithRetention` seam preserves existing
FIL-03 test/custom adapters: adapters without it still use the existing injected
reader, defaulting to seven days. Production explicitly installs
`readFileRetentionSnapshot` on `PostgresFileRepository`. Custom production
compositions must install that adapter too. The trusted generic repository
`create` seam remains an explicit-metadata insertion seam, not a new authorized
upload endpoint; callers of that seam are responsible for their supplied
retention snapshot. Existing reference creation is unaffected.

With `applyToExisting` omitted/false, no existing file row changes. With true,
one explicit database UTC instant is sampled after the owner lock, and SQL
selects only this owner's `temporary` rows whose stored state is pending/ready
and whose **old** expiry is later than that instant. Preview uses the same live
predicate and counts only rows whose proposed expiry is due at that instant.

Each selected row receives `created_at + duration_seconds * interval '1 second'`
using its original creation time. Newly due rows become expired immediately.
Counts are returned from the actual update. File changes, preference revision,
command receipt and success audit commit or roll back together. The immutable
revision, bytes, filename, creation timestamp, storage key and scope do not
change. A later allocation replay can reflect an explicit apply-to-existing
change or lifecycle transition; it never independently applies a newer owner
preference.

Stored expired/removed rows and already-overdue pending/ready rows are excluded,
including during extensions. Overdue rows do not have to wait for FIL-04 to be
considered expired. Pre-existing overdue metadata can remain physically
pending/ready until cleanup persists the expiry; existing public file reads
already calculate effective expiry. Both permanent reference scopes are
excluded by an explicit scope predicate, not by missing/nullable expiry fields.

Downloads now re-read the exact pinned file metadata after byte verification,
so a retention shortening during verification cannot return a stream authorized
with an obsolete expiry snapshot. This does not retract bytes from an already
open download. Retention changes never delete physical bytes: FIL-04 owns the
sweeper, staging cleanup and eventual byte deletion. Expired files retain their
audit metadata and immutable revisions.

## Tests and verification

Added `apps/api/test/file-retention.test.ts` covers the allocation adapter,
default/injected/transactional durations, replay, Agent-chat allocating-owner
identity, timestamp ordering, invalid snapshots, post-verification download
expiry, settings grants and Operator-only MCP role mapping.

Added `apps/api/test/file-retention.integration.test.ts` uses the existing
isolated loopback `TEST_DATABASE_URL` fixture, actual PostgreSQL, authenticated
Fastify HTTP and `/mcp`. It covers default/non-default persistence, future-only
saves, preview, shortening/extension, unchanged original creation/revision,
overdue/expired/removed exclusion, both permanent scopes, owner isolation,
strict owner-selector rejection, command replay/conflict, stale revisions,
delegated/read-only/scoped/worker denial, denial audit, readback, replay after
grant revocation, simultaneous writers, allocation/save locking observed via
PostgreSQL blocking PIDs, and rollback when receipt insertion fails. Each test
owner is distinct. No paid model, native session, shared database reset or
`DATABASE_URL` fallback is used. Without `TEST_DATABASE_URL` these integration
tests skip; skipped tests are not evidence of passing behavior.

Suggested commands in a full checkout with the repository's pinned toolchain:

```sh
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/api exec node ../../scripts/heavy-job.mjs -- vitest run test/file-retention.test.ts
corepack pnpm --filter @foreman-code/api exec node ../../scripts/heavy-job.mjs -- vitest run test/file-retention.integration.test.ts --no-file-parallelism
corepack pnpm --filter @foreman-code/api typecheck
corepack pnpm --filter @foreman-code/api lint
```

Supply a disposable loopback `TEST_DATABASE_URL` whose database name contains
`test` for the integration command. Also run the existing FIL-03 unit/integration
suites before integration; no existing tests are rewritten by this package.

Delivery-environment results: TypeScript **5.8.3** `transpileModule` reported zero
syntax/transpile diagnostics for the 16 supplied TypeScript files. This is not
the repository's TypeScript 5.9.3 semantic typecheck. Original bytes for all nine
modified files were checked against their GitHub Git-blob hashes at the pinned
base; ZIP contents and SHA-256 checksums are checked during packaging.

**Not run:** Vitest unit/integration suites, PostgreSQL migration/transaction
execution, authenticated HTTP/MCP execution, semantic typecheck, ESLint, full
build, or production startup. The working container has only the reconstructed
changed-file subset, not a full repository checkout; Fastify, Zod, pg and Vitest
are absent, as is PostgreSQL. Bootstrapping pinned pnpm 11.27.0 with Corepack
failed with DNS `EAI_AGAIN` for the package registry. No substitutes or disabled
security checks were used to manufacture a green runtime result. The package
includes implementation and tests, but runtime integration remains unverified.
