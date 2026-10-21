# W09 bounded staging port

`ResumableByteTransferService` is a receiver, not a listener, scheduler, publication
service or Run completion signal. W07 must negotiate `resumable-binary-transfer-v1`
and supply a binary chunk separately from its bounded metadata. Never JSON/base64
encode bulk bytes. Sender waits for each append result; do not queue chunks.
W07 owns control priority, backpressure, TLS and the single connection supervisor.

Production must provide a private Linux staging root outside source/working trees,
and `TransferAuthorization.authorize`. The hook must recheck current device
revocation/key/authorization revision, boot/epoch against W07's authenticated
connection, W08's exact accepted operation/execution/attempt and placement, A's
current root binding, and capability expiry on every operation. The origin
boot/epoch in the immutable intent are provenance; reconnect uses a new **current**
context authenticated by W07. The hook cannot be a permissive no-op. Main must
persist its authorized immutable intent before handing it to this receiver.

Caps are shared in `BYTE_TRANSFER_POLICY`: <=1MiB negotiated chunks, <=128MiB source
objects, existing 25MiB artifacts, 2 active/device, 4 globally, <=512MiB global / 256MiB per-device staging,
4096 records, <=1h lifetime, 5min unfinished idle deadline, 8 interrupted-carrier retries.
The sender uses A/C's bounded immutable-snapshot reader and W07's authenticated
connection provider; it resumes from status after lost ACKs and never retries
authorization/integrity/quota failures. Verified bytes still
reserve staging until main publication/adoption acknowledgment is reconciled.
Do not cancel the only producer copy before canonical commit. Source manifests
and archive expansion use A's independent entry/expansion budgets; staging is not
a document validation bypass. C must stream `openVerified` through the existing
full-upload validator/allocation/finalize/publication service for artifacts.

Data fsync precedes atomic checksummed progress journal replacement and directory
fsync, which precede ACK. Duplicate committed ranges are read back and compared.
Each resume checks the durable prefix and truncates only uncommitted tails. If the
first journal was never committed, the freshly authorized original intent can
restart its private part at offset zero under both transfer and allocation locks;
crash-left locks are reconciled only when their original process has stopped.
Missing/corrupt committed bytes fail closed; C must cancel/restart the byte attempt
under the same accepted logical operation. Final SHA256 and byte count are checked
independently, including on repeated finish after lost ACK. `resolveVerifiedReceipt`
uses local authoritative records; submitted receipts cannot create verified state.
`openVerified` verifies the complete object and reauthorizes each bounded read.

Private directory FD paths on Linux anchor runtime operations against ancestor
rename/swap. Ancestors must be owned by root or the service uid and not writable
by others except sticky directories. The root and files must be private/service
owned; files must be regular, singly linked and opened with O_NOFOLLOW. Peers must
not run under the service uid or possess its private directory descriptor. This
is not a security boundary against a compromised service uid.

Per-transfer and allocation locks persist their original Linux boot, PID/start
ticks, root identity and lock inode. Complete private owner files are published
with a non-replacing hard link before work starts. Unique guard records serialize
lock acquisition and recovery across receiver processes. Startup removes only
artifacts whose original process has stopped or whose host boot has changed,
after checking their root and inode. Reader pins use the same owner records and
remain charged while the original process is live. Journals and uncommitted part
files survive restart. Installed Worker loading and Main initialization run this
recovery before admitting work; every service also recovers on first use.
Supervisor retirement persists `deletionRequested` before unlink. Recovery and
quota retries finish only those requested deletions; a
cancelled progress state alone does not authorize retirement or release its charge.
Complete unpublished `.canonical-owner-*.tmp` records are reclaimed with the same
stopped-process, root and inode checks. An interrupted temporary record with
incomplete metadata remains retained for manual reconciliation; it cannot serve
as a lock or reader pin.

Unowned directory locks or reader pins from an older installation, corrupt owner
records and replaced artifacts fail closed. They require manual reconciliation:
stop every process using that canonical store, verify the private root and each
original artifact inode against retained ownership evidence, and remove only
those positively identified locks or pins. Sync the canonical directory after
removal. If the original identity cannot be established, retain the artifact and
its accounting; elapsed time or an empty runtime map does not establish closure.
`cleanupExpired(1..64)` bounds tombstone/deletion batches. C invokes trusted
`retire(id)` for confirmed revocations and invokes cleanup from its existing
cleanup supervisor. Tombstones precede unlink; retries do not extend file lifetime.
Canceled records retain conflict identity until a separately authorized retention
policy removes them. No worker database or native recovery journal is involved.

Focused commands (from root; verbose output should go outside Git):

```
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/contracts exec vitest run src/byteTransfer.test.ts
corepack pnpm --filter @foreman-code/api exec vitest run src/modules/byte-transfer/service.test.ts
corepack pnpm --filter @foreman-code/api typecheck
```

Fault hook supports `data-sync`, `journal-sync`, `directory-sync`; rejecting a hook
simulates EIO/ENOSPC/fsync failure before the corresponding durability boundary.
No new runtime dependency was selected. Existing pinned Node filesystem/crypto and
Zod are used. No claim is made about optional rsync advisories or two-host
qualification: they are not used here.

Outstanding orchestrator acceptance: actual W07 binary carrier negotiation and
control/Stop/heartbeat fairness; authenticated endpoint denied/readback coverage;
main persisted intent and C publication/retention wiring; source immutable sender
adapter; two-process crash/restart runtime verification; peak memory and aggregate
quota calibration; actual ENOSPC/EIO; real PC/laptop source/edge execution after
W07-HUMAN approval. These unit ports alone do not close those live gates.

The concrete `carrier.ts` adapters use W07's negotiated `byte-transfer-v1` namespace
and actual `captureRequest` closures. `transferContextForBinding` retains its
opaque UUID epoch and UUID boot; connectionGeneration is never substituted.
Incoming metadata names only a transfer ID/operation/offset/hash; an authoritative
accepted-intent resolver supplies the immutable main-issued identity. Device JSON
cannot supply connection context, roots or an intent. Private operation grants are
rechecked between two comparisons against the actual current W07 binding.
Reconnect supplies a new current UUID context while the journal/receipt keeps its
original UUID provenance. No numeric-epoch migration or fallback is provided.
Main/worker factories return the actual receiver, verified reader and receipt
lookup, namespace handler and bounded source-package sender. Compose the handler
with C's output handler in the one registered byte-transfer namespace; never
register two competing handlers or another transport.
