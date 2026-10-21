# FIL-04 — temporary file cleanup

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`543c38dff7b5487dae676219477a1bb9c69d6a8e`.

## Integration

Apply the full files at their repository paths. The **only existing source file
modified** is `apps/api/src/modules/files/production.ts`: three imports and
startup/shutdown wiring for the sweeper. The existing `server.ts` call to
`registerProductionFileStorage` installs it. `onReady` initializes the existing
managed byte store before starting cleanup; `preClose` stops and drains cleanup
before `server.ts` closes the shared database pool in `onClose`.

No migration, dependency, lockfile, config, shared contract, UI, retention API,
file access policy, or upload/download service change is required. Existing
FIL-03 (273601), FIL-36 (273636), and FIL-40 (273640) schema integration remains
a prerequisite. No new migration registration line is needed.

This is internal physical maintenance, not a new management action. There is no
cleanup HTTP/MCP endpoint and no new agent authority. HTTP and Operator MCP keep
using their existing services, metadata and bytes; their expiry checks are not
replaced by a timer. Retention settings and their MCP parity remain FIL-40's.

## Discovery, pacing and restart behavior

The process starts a batch immediately, then uses one sequential, abortable,
unref'ed server timer. Defaults are 32 entries per discovery channel, one second
between catch-up batches, and 60 seconds after a completed discovery pass.
Concurrent calls to `sweep()` coalesce rather than overlap.

There are two bounded discovery channels:

1. PostgreSQL finds overdue **temporary pending/ready** heads, paged by file ID.
   It samples the database statement instant; physical deletion checks the
   database clock again. Files with no remaining bytes still get an expired
   tombstone. Errors do not pin the cursor to the first failed file.
2. An incremental directory walk scans `objects` and `staging`, at most 32
   entries total per batch, including invalid names. Recognized internal keys
   are mapped back to eligible temporary revisions through PostgreSQL. This
   finds already-expired files (including FIL-40 immediate shortening), canceled
   temporary residue, non-head revisions, crash `.part` files, and empty
   allocation directories. Unknown keys are not deletion authority.

A batch handles at most 64 distinct revisions. Deletion handles at most 64
allocation entries per revision plus its object and empty directory. It never
recursively removes a directory. Additional entries remain discoverable for
later bounded batches.

Committed tombstones and remaining disk entries are the durable work queue;
there is no in-memory-only deletion receipt. Restart resets discovery cursors
and catches up immediately. Historical tombstones with no bytes are not scanned
again in every SQL batch. A directory walk can miss entries during concurrent
filesystem mutation; subsequent passes reopen directory handles and recover
those entries. A late upload admitted before expiry can recreate a `.part`
directory after a sweep; its expired file cannot finalize, and disk discovery
revisits the residue even though the tombstone was already persisted.

Per-revision errors are logged and the batch continues. Database/discovery and
filesystem failures trigger capped exponential pacing: 60, 120, 240, then 300
seconds, resetting after recovery. Busy publication/retention owners are skipped
without blocking or tight retry loops. Shutdown aborts timer sleep and waits for
the currently guarded deletion before closing directory handles.

## Retention and publication races

Discovery carries exact file/revision/storage/owner/allocation identity, an
unrounded microsecond UTC expiry token and the owner's current preference
revision. FIL-40 does not store a separate per-file preference revision, so this
owner revision is a **discovery guard**, not a new DTO or allocation field.
Future-only saves can invalidate a candidate; a later pass reads a fresh guard
without applying that preference's duration to the old file.

For each candidate, the repository:

1. Tries FIL-03's exact owner/request publication advisory lock (when an
   allocation exists), then FIL-40's exact owner-retention advisory lock. The
   latter is session-scoped here so it survives the tombstone commit; it
   conflicts with FIL-40's transaction-scoped lock on the same identifier.
   This matches allocation's lock order and uses one pool client.
2. Under a file-row lock, re-reads the pinned revision, temporary scope, owner,
   allocation request, exact expiry, preference revision and database-time
   eligibility. A stale/extended candidate does not reach the filesystem.
3. Commits `expired` for due pending/ready metadata **before** any physical
   deletion. Existing expired/removed tombstones remain tombstones. A lost
   commit acknowledgment does not authorize unlinking in this process.
4. Starts a second transaction and repeats the identity/expiry/revision check
   under a row lock immediately before deletion. The owner and publication
   locks remain held through the bounded unlink operation. An error cannot
   roll the already-committed tombstone back to ready.

Both checks explicitly require temporary scope; expired rows also must remain
past their expiry. Removed temporary rows can be reclaimed without waiting for
their old deadline, consistent with pending cancellation. No expired/removed
file is made live and no allocation or revision metadata is deleted or rewritten.
Session locks are explicitly released in reverse order. Uncertain lock/commit
acknowledgments, failed rollback, lost connection or unconfirmed unlock destroy
the pool client instead of returning a possibly locked session to the pool.

A retention extension that began while the file was live but commits after its
old deadline is covered: discovery can see the old overdue MVCC version, but
cleanup cannot acquire the owner's lock until that save completes. Reusing that
old snapshot then fails the exact expiry/preference-revision check.

## Byte safety and downloads

Deletion only accepts FIL-03 UUID storage keys, beneath its existing initialized,
private app-managed root. It validates directory ownership/permissions, rejects
staging-directory symlinks, and opens directory descriptors with no-follow.
Only `verified` and UUID `.part` allocation entries are unlinked. Unknown
children/subdirectories fail closed rather than triggering recursive removal.
Leaf symlinks are unlinked themselves, never followed. Changed directories are
fsynced; retries tolerate already-missing paths.

The pinned FIL-03 schema makes revision storage keys unique and immutable. A
permanent revision cannot also own the temporary revision's object pathname.
Deleting a temporary object's link never truncates its inode or removes other
object keys that hard-link to it. Both permanent scopes, including removed
references and their staging directories, are excluded from this job. Unmapped
objects and permanent-removal reclamation are intentionally not treated as
expired temporary storage.

A download already admitted on its open descriptor may finish after unlinking.
A download whose byte verification overlaps expiry still goes through FIL-40's
existing post-verification metadata read and rejects the read, closing its descriptor.
New requests remain subject to the existing 410 expiry behavior, with or without
a running sweeper. The job does not forcibly close active downloads.

## Tests and verification

Added unit suites:

- `file-cleanup.test.ts`: bounded/deduplicated batches, cursor fairness, restart
  discovery, guarded byte authority, coalescing, shutdown drain, deterministic
  catch-up timers and capped error backoff.
- `file-cleanup-bytes.test.ts`: real filesystem deletion/retry, crash parts,
  bounded allocation cleanup, repeated directory discovery, symlink/path
  rejection, preserved permanent hard links and open read/write descriptors.
- `file-cleanup-postgres.test.ts`: transaction/transport fault double covering
  stale expiry/revision/identity checks, both deletion guards, lock order,
  busy owners, committed tombstones after disk errors, uncertain acknowledgments
  and pool destruction. This double is not proof of PostgreSQL SQL/lock behavior.

`file-cleanup.integration.test.ts` uses the existing isolated loopback
`TEST_DATABASE_URL` helper, real PostgreSQL sessions, existing authenticated-owner
retention/allocation/download services and real managed storage. It covers
seven-day and changed snapshots, immediate apply-to-existing expiry, no
resurrection, restart/cancellation/late upload residue, non-head revisions,
permanent/unknown/shared-inode exclusion, two sweepers and publication locks,
a real retention command paused after its live extension but before COMMIT,
and admitted versus still-verifying downloads at expiry. It does not launch a
model or reset a shared database. Without TEST_DATABASE_URL it skips.

Actually run here: **24/24 unit tests passed** on Node 22.16.0 after TypeScript
5.8.3 transpilation and changing only the three test-runner imports from Vitest
to `node:test` in a separate verification copy. No implementation or assertion
was replaced for that execution. All nine delivered TypeScript files have zero
syntax/transpilation diagnostics. The dependency-free cleanup core passed an
isolated strict TypeScript check with local Node 24.0.4 types. A broader unit
check also passed using explicit, verification-only pg/Vitest declarations;
those declarations are not included and are not the repository's real types.

**Not run:** pinned pnpm/Vitest, real PostgreSQL integration, authenticated HTTP
or MCP execution, full repository semantic typecheck, ESLint, build, or
production startup/shutdown. The container could not clone the repository
(GitHub DNS resolution failed), and Corepack could not fetch pnpm 11.27.0
(`EAI_AGAIN` for the package registry). Only a reconstructed source subset is
available; Fastify, pg, Zod, Vitest, Docker and PostgreSQL are absent. No security
or dependency-policy bypass was used. The integration tests are authored,
not passed evidence.

Run in the full pinned checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api exec node ../../scripts/heavy-job.mjs -- vitest run test/file-cleanup.test.ts test/file-cleanup-bytes.test.ts test/file-cleanup-postgres.test.ts test/file-storage.test.ts test/file-retention.test.ts
# Explicit disposable loopback TEST_DATABASE_URL; database name must contain 'test'.
corepack pnpm --filter @graphql/api exec node ../../scripts/heavy-job.mjs -- vitest run test/file-cleanup.integration.test.ts test/files.integration.test.ts test/file-retention.integration.test.ts test/file-references.integration.test.ts --no-file-parallelism
```

Then run the repository-wide verification commands in AGENTS.md. No revision,
file tombstone, command receipt, or run provenance backfill is included.
