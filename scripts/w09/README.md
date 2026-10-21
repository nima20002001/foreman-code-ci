W09 orchestrator evidence collector
===================================

Run only after W07-HUMAN approvals and actual W07/W08 production readiness. This
collector sends bounded fixture operations to the selected application main and
checks response pins/counts; it never installs services or accesses the laptop via
SSH. Fixture authors and workers must not launch integrated physical acceptance.

Actual invocation from repository root:

```sh
node scripts/w09/collect-evidence.mjs \
  --pc-device-id "$PC_DEVICE_ID" --laptop-device-id "$LAPTOP_DEVICE_ID" \
  --pc-root-binding "$PC_APPROVED_ROOT_BINDING" \
  --laptop-root-binding "$LAPTOP_APPROVED_ROOT_BINDING" \
  --main-endpoint "$MAIN_ENDPOINT" --fixture-manifest /tmp/w09-live-fixture.json \
  --credential-handle W09_TEST_CREDENTIAL --fault lost-finalization-ack \
  --evidence-out /tmp/w09-live-evidence.json
```

`W09_TEST_CREDENTIAL` names an environment variable containing a specifically
authorized test credential; never put the token in the fixture or argv. The
endpoint must be the selected main, with no embedded credentials. The output is
exclusive-create, mode 0600; select scalar evidence only. Reports exclude raw
bodies and network error text. Keep reports and fixture files outside Git.

The version 1 manifest contains `operations` (maximum 256). Each operation has
`id`, `phase`, `method` (`GET` or `POST`), main-relative `path`, optional `body`,
`expectedStatus`, nonempty `assertions` (`pointer`, `equals`), and optional
`evidence` (safe label to JSON pointer of a scalar response field). Optional
`fault` selects operations for the `--fault` scenario. Use actual production
HTTP/MCP endpoints and existing orchestrator-owned fault controls; this collector
does not invent fault endpoints or change production security. Assertions must
pin the accepted device/root identities, installed application/dependency hashes,
source manifest and bytes, exact Run/node/execution/attempt/placement/edge,
transfer offsets, publication revisions/hashes/sizes, adoption/dispatch counts,
retention denials and bounded resource observations. MCP assertions use response
`/result/structuredContent/...` pointers.

Required phases: `identity`, `source-materialization`, `producer-publication`,
`edge-consumption`, `consumer-publication`, `restart-readback`, `fault-recovery`,
`expiry-denial`, `read-only-denial`, `scope-denial`, `write-conflict`, `disk-full`,
`traversal-denial`, `bounded-overhead`. Missing phases yield `incomplete`, exit 1.
A complete report is evidence that the supplied assertions passed, not proof that
unasserted fixture behavior or physical installation qualification passed.
The orchestrator must independently inspect the scenario and evidence. Exercise
partial/corrupt/chunk-conflict upload, missing/corrupt finalized bytes, lost
finish/allocation/finalization/adoption/dispatch acknowledgments, main/worker
restart, old-attempt completion, queued/lock-wait expiry, revocation/scope denial,
source edits, stale CAS, ENOSPC/fsync, unsafe archives, root conflict and interrupted
cleanup using their named scenario fault values. A fixture for one scenario must
not claim the whole matrix passed.

Composition gates still required
-------------------------------

The shared export/migration/production entrypoint changes are orchestrator-owned.
Mount `registerDistributedArtifacts` only with W07 credential authentication and
W08 persisted accepted-attempt resolution. `PostgresArtifactEdgeAuthorization`
requires a SQL `AcceptedArtifactAttemptFence` that verifies exact durable dispatch
intent, owner grant revision, root/configuration and device registration inside
its transaction. `DistributedArtifactPublicationService` requires equivalent
accepted mutation authority and original-source lifecycle locking. Do not supply
no-op production fences. No public endpoint creates edge delegations.

The publication path extends the existing `file_tool_publications.record` with
original transfer receipt and input hash. It allocates canonical storage before
I/O, links before finalization, and recovers finalized retries from that ledger
without needing worker staging. Existing conversation/native adoption consumes
finalized ledger pins. W08 must call `pinAccepted` before edge dispatch and perform
idempotent adoption/dispatch through its existing receipts. Transfers may be
canceled/reclaimed only after canonical commit reconciliation. Physical deletion
can use `DistributedArtifactDeletionOwnership` via the cleanup repository's
optional ownership guard: held/unknown defers deletion after the tombstone,
without permitting expired byte access. A/B own their staging/materialization
cleanup ports. Offline eviction remains best effort.

Focused units are `corepack pnpm --filter @graphql/api exec vitest run
 test/distributed-artifacts.test.ts --maxWorkers=1`. The committed DB fault fixture
is `test/artifact-edges-postgres.integration.test.ts`; only the orchestrator runs
it with an explicitly owned loopback `TEST_DATABASE_URL`. No two-device acceptance
or integration suite was run by this lane.
