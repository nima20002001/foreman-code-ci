Canonical CI artifact adapter
=============================

`createCanonicalJobArtifactPort` constructs the actual CI-B `JobArtifactPort`
(`list` and exact revision `read`) using `PostgresFileRepository`, the existing
allocation/publication tables, and the same private canonical storage root. It
also exposes `publishAccepted` and `verifyRequiredOutputs` for the main receipt
projector. No conversation, Agent or Run is fabricated for a standalone job.

Root composition supplies CI-B's `JobPublicationAuthority` with the actual W08
job-owner fence and approved source/root validation, plus a `TrustedJobOutputReader`.
For remote bytes, `VerifiedJobOutputReader` uses W09-B's verified receipt/open port
and a server-derived `AcceptedJobTransferResolver`. The resolver must locate the
admitted transfer/output intent and current W07 connection, never accept a
worker-supplied transfer ID as authority. Main-local output streams must come from
CI-A's immutable post-closure output collector; do not open the declared relative
output path against the main filesystem. The declaration is metadata.

`publishAccepted(input, source)` is called after the process result is durably
settled, outside the caller's SQL transaction. It opens short authority
transactions, registers canonical allocation ownership, commits the existing
publication link before finalization, stages network bytes without a SQL
transaction, then reauthorizes inside each allocation metadata commit. A lost
finalization acknowledgment recovers the same file/revision receipt without
reopening worker bytes. Changed command bytes/spec/scope conflict. A unique
publication index binds one declared output path to one execution attempt.

The accepted policy snapshots retention and the aggregate output-byte budget.
Allocation guards serialize budget reservations with the canonical job-row lock.
TTL never slides on replay. Canonical expired/removed metadata stays discoverable;
reads fail explicitly instead of substituting latest bytes. Existing tombstone
cleanup now includes job execution scopes. Human document retention preferences
and their apply-to-existing behavior remain limited to their original chat scope.

`verifyRequiredOutputs(sql, execution)` plugs into
`JobWorkerAuthority.verifyPublication`. It checks exact attempt, owner, accepted
spec/output digest, required declarations and live lifecycle, and opens each
canonical object to verify its immutable size/hash before allowing completion.
`JOB_REQUIRED_OUTPUT_MISSING` means a required exact live output is absent/expired.
`JOB_REQUIRED_OUTPUT_CORRUPT` means expected metadata/bytes are missing or fail
integrity. Other infrastructure/auth failures propagate for journal replay.

`CiOutputByteStorage` is a separate explicit capability for the allowlisted
`ci-output` revision class. Its 25 MiB class validates UTF-8 text, JSON syntax,
existing safe ZIP structure, gzip CRC/bounded expansion, and declared generic
binary outputs. The document `FileRevisionSchema`, upload MIME/extensions and
archive policy are unchanged. The default document byte capability refuses CI
revisions; conversation tools/reference resolution deny job execution scope.
HTTP downloads are attachment-only through CI-B; its MCP reader has the existing
1 MiB response limit and advertises exact HTTP readback for larger artifacts.

Integrate `jobArtifactStorageMigration` (285202) after jobs/file storage/file tools
migrations, CI-B's scope/grant contract patch and the `jobs`/`job-artifacts` exports.
Root's approved native document guards are supplied separately in
`/tmp/graphql-workstream-20261001/patches/w09-c-job-document-native-guards.patch`.
They must not be omitted when the shared metadata union expands.

Focused checks:

```sh
corepack pnpm --filter @foreman-code/api exec vitest run \
  test/job-artifacts.test.ts test/job-document-isolation.test.ts \
  test/file-storage.test.ts test/codex-file-delivery.test.ts test/file-tools.test.ts \
  --maxWorkers=1
```

`test/job-artifacts-postgres.integration.test.ts` is the root-only runnable DB
fixture: actual storage/allocation/publication persistence, live hashed credential
authentication, the CI HTTP routes and SDK MCP tools, denied callers, pinned
readback, receipt counts and owner revocation/expiry. Its explicit owner/root SQL
fixture proves the adapter contract, not a qualified two-host/container install.
This lane does not launch integration or physical acceptance.

Main-issued remote output admission
----------------------------------

`createAdmittedJobOutputs` now supplies the actual main admission, B receiver,
`AcceptedJobTransferResolver`, verified byte reader, canonical artifact port and
W07 `byte-transfer-v1` server extension. There is no injected permissive transfer
resolver or alternate byte reader. `WorkerJobOutputApplication` and
`WorkerJobOutputReceiver` implement W08-B's metadata/sender ports on the existing
authenticated W07 application channel.

Admission accepts only `JobOutputPublicationInputSchema`; worker arguments cannot
choose transfer IDs, root IDs, storage paths, principal or connection context.
The main checks the real selected installation, live paired registration,
accepted job/owner/current PostgreSQL owner session, original native/closure
receipt and main process projection, exact materialization/root policy/location,
unrevoked accepted root policy and retained approved source. A newer source catalog
selection does not revoke the original immutable binding. It reserves the
canonical file allocation before issuing bytes, then stores a server-minted
`TransferIntent` in the existing `management_command_receipts` ledger under
`job.output.admit`. Original receipts and one execution/attempt/output slot are
immutable; retries preserve IDs and expiry. After transfer expiry, an identical
publication retry requires a finalized canonical allocation with a ready file and
live original retention; expired staging cannot resume. Metadata links still use the existing
publication ledger. Network byte I/O never spans the admission SQL transaction.

Every B operation resolves its original command receipt and rechecks live
ownership/device/source/root authority and canonical allocation lifecycle. The
current W07 channel is obtained from its authenticated ready-session getter;
stored boot/connection fields alone are not authority. B's existing numeric
`connectionEpoch` represents W07's actual `connectionGeneration`. The opaque
main socket epoch is separately fenced using trusted `AsyncLocalStorage` frame
scope, including after awaits, so an old socket with the same numeric generation
cannot continue after replacement. Reconnect resolves current context while
retaining the originally issued immutable intent.

The approved readonly W07 getter patch is
`/tmp/graphql-workstream-20261001/patches/w09-c-current-device-binding.patch`.
Root/W07 owns sequencing it after the security fixes. It must fence ready state,
current session epoch, channel/session abort and negotiated incoming namespace.
No current binding may be constructed from payload fields.

`registerJobOutputMetadataEndpoints` gives authenticated HTTP/MCP metadata parity
on a separately mounted **device-only** surface. It accepts the actual paired
worker credential and current channel, refuses browser cookies/origin and
Operator credential exchange, and exposes admission/publication only. Bulk
bytes use the bounded binary carrier. Human Operator UI/MCP continue the complete
supported job workflow through job Start and canonical artifact readback; they
do not impersonate an output-producing worker.

Integrate `jobOutputAdmissionMigration` (285203) after the existing command/file/
job/source/device migrations and export `job-output-transfer`. The migration
adds only receipt indexes/immutability, not a second transfer/event table. The
command/file audit source supports `device` without adding a grant or write tool.

Additional focused units: `test/job-output-admission.test.ts` exercises modeled
SQL authority boundaries plus the real B sender/receiver/private storage. The
root-only `test/job-output-admission-postgres.integration.test.ts` exercises real
pairing/current W07 session, actual PostgreSQL `JobOwnership`, HTTP/MCP denial,
original receipt replay, real binary transfer and canonical byte readback/counts.
Its source/native observation rows are explicit fixture facts; this is not
physical laptop/container acceptance. Run that DB fixture only as orchestrator
with an explicitly owned loopback `TEST_DATABASE_URL`.
