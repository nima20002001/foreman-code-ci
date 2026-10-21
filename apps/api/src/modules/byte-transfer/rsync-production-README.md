# Rsync production leaf continuation

Baseline: clean integration `f22d416dafb00fc0ea1f590617e0d196a4d82270`.
Shared-contract prerequisite: Root commit `23cb6731`, consumed unchanged.
Ownership: only new `rsyncProduction.ts`, `rsyncProduction.test.ts`, this document.
No common factories, canonical adapters, shared schemas, protected Codex callback
stores, external Claude boundaries, live services or network settings changed.

`createRsyncProductionBackend(input)` provides:

- `send(intent, source?, signal?)`: Main alone starts SSH. `source` is permitted
  only for Main-to-worker source packages. Worker outputs must resolve from their
  existing accepted immutable reader on the worker. Returns the actual existing
  receiver's `VerifiedTransferReceipt`, not publication completion.
- `sender(source).send(intent,signal?)`: structural sender leaf for existing
  source package admission. Common owner must change its concrete sender return
  type to a structural `Pick<ResumableByteTransferSender,'send'>` before selecting
  this leaf; no source-package encoding or allocation semantics are replaced.
- `handle(payload,actualFrame)`: ID-only metadata control, exact current W07
  binding plus accepted authority before/after operations. No caller paths,
  intent, command strings or byte payload are permitted.
- `acknowledge(intent,signal?)`: requires genuine existing canonical/adoption
  acknowledgement independently on both sides, then removes private files and
  releases the extra allocation. Failed publication keeps the only staging copy.
- `retireExpired(intent,signal?)`: existing supervisor only, original expiry plus
  genuine stopped-byte-writer proof. No new cleanup loop or age-only lock stealing.
  Its mandatory trusted `quiescent` hook validates exact persisted immutable intent
  and original expiry as well as stopped writers; it must reject caller-altered pins.

Required production inputs are the actual `AcceptedTransferAuthority`, current
W07 binding getter, actual canonical `ByteTransferPort`, privately installed root,
shared external quota, and REQUIRED `ownership: RsyncWriterOwnership` and
`writers: RsyncTransferWriters`. HRT supplies one ownership registry per installed
root, shared with its writer and lifecycle supervisor. The factory checks that
registry against the staging root and obtains ONE `ownership.store()` adapter
for BOTH source and receiver stores. There is no absent-owner default.
Source producer supplies `ImmutableTransferSource`;
it must be bound to exact accepted snapshots/sealed outputs. The leaf writes at
most one existing negotiated chunk at a time, fsyncs, and calls the tested private
store to seal/verify SHA256/length. Reservation, producer reads, writes, unlink
and fsync run inside a `source-materializer` access lease. Its directory and
`.input` handles are attached before bytes; stop/drain waits for physical IO and
descriptor closure. A bounded stop cannot discard pending IO or release quota.
It does not guess paths inside native processes.

Main's selection callback returns
`{backend:'rsync',check,endpoint,nodeBinary,entryPoint}`. The two wrapper paths are
REQUIRED protected installed facts, verified/pinned by the selection provider;
they replace any path fields returned by the writer port. They are rechecked
through transfer authorization and never accepted through control RPC. `check` is
fresh (at most 60s) `TrustedConnectionCheck` from existing setup; both persisted
consent and live registration must match exact intent IDs/revisions, ready probe
host fingerprint and OS user must match consent, and protected endpoint/binary
roots/pins must remain unchanged through transfer authorization. Selection is
explicit; missing or revoked setup is an error, never a fallback attempt. This
leaf currently supports the tested SSH port 22/hostname/user forms; unsupported
endpoint forms fail closed. Main uses the previous backend's actual binary pin
and >=3.5.0 security checks. Owner consent never replaces per-agent transfer grants.

`writers.local(intent,command,signal)` captures the actual protected local owner
and command pin. `writers.remote(intent,signal)` prepares the original server
reference; `writers.activate(intent,reference,signal)` admits its actual waiting
wrapper through W07. After preparation, executor and activation run concurrently.
`writers.quiescent(intent,signal)` must positively join BOTH original hosts before
receiver verification/unlock. `writers.stop(intent,signal)` must attempt BOTH
original process scopes. An uncertain stop or closure retains source and receiver
handles, locks and allocations; a successful local exit is insufficient.

## Shared quota interface for HRT

`RsyncExternalStagingQuota`:

```ts
reserve(intent, currentContext, {
  kind: 'rsync-source' | 'rsync-receiver',
  byteSize: number,
}): Promise<void>
release(intent, kind): Promise<void>
```

HRT owns the durable implementation in the original byte allocation supervisor.
It must share global/device totals, active/retry/record budgets, original expiry
and idle deadline with existing canonical receiver journals, and atomically
reject changed intent/kind/bytes. Release is idempotent trusted local composition,
not a remotely submitted receipt. Conflict identity survives until original expiry.
Logical active slots deduplicate by transferId across external reservations and
canonical journals; byte totals still add all copies. A receiver reservation plus
canonical start must not count one logical transfer twice against the active limit.

Source reserves **2N before materialization**, covering transient input + sealed
snapshot. The conservative reservation persists until genuine acknowledgment.
Receiver reserves **3N extra before private part**: previous destination N,
rsync temporary/partial N, and a potential unlinked verified inode N held by a
staged FD across retry/rename. The unchanged canonical receiver additionally
reserves N, giving a conservative **4N destination peak**. Source remains 2N.
The [official rsync manual](https://download.samba.org/pub/rsync/rsync.1) states
that modern partial-dir resume updates the partial without another independent
temporary copy. Our required >=3.5.0 binaries support that behavior.
Existing budgets must reject overlap that does not fit; do not increase limits
or silently select fallback. Both reservations share the same allocation totals.
Cancellation and source-handle close retain allocations. Missing quota is rejected
before source bytes are read. Interrupted/private/canonical bytes may not be
forgotten merely because an adapter call failed or its handle closed.

## Wire/discovery handoff to Root

Root's shared strict request (`RsyncControlRequestSchema`):

```ts
{ kind: 'rsync-stage-v1', transferId: uuid,
  method: 'source-prepare' | 'source-verify' | 'source-close' |
    'receiver-prepare' | 'receiver-verify' | 'receiver-interrupt' | 'acknowledge' |
    'writer-prepare' | 'writer-activate' | 'writer-status' | 'writer-stop' }
```

Response repeats exact kind/method/transferId. `receiver-verify` requires existing
`VerifiedTransferReceiptSchema`; all other methods forbid receipt. Every frame
and response forbids binary payload. The leaf imports Root's shared request,
response and request type from `@foreman-code/contracts/byte-transfer`; it defines no
local wire parser or compatibility default. Root owns shared schema exports and
their consumer/discovery tests.

The CONTRACTS installed W07 handler intercepts all four writer methods before
forwarding staging controls to this leaf. `writer-prepare` returns the exact
original `{transferId,ownerId,ownerDigest}` in the strict response envelope.
Activation/status/stop respond only after their actual ownership operation.
The staging-only handler rejects writer methods; they cannot fall through to
acknowledgement. Activation revalidates original accepted authority after actual
WAITING and before grant, without a SQL transaction spanning that wait.

The existing byte-transfer-v1/version1 descriptor has no submethod capabilities;
its presence alone cannot certify these controls. Approved discovery is a
`rsync-stage-v1`/version1 metadata-only extension on the **same W07 socket**:
Main client, worker server, 16KiB JSON, zero binary, described by the shared
`RSYNC_STAGE_EXTENSION`. No new socket, reconnect supervisor or scheduler.
The byte-transfer-v1 fallback remains unchanged. HRT owns final routing.
Do not advertise the extension before real accepted source, shared quota,
canonical receiver and acknowledgement ports are all mounted.

## Producer and publication dependencies

Actual inspected seams:

- `sources/operationSender.ts` already yields exact `ImmutableTransferSource`
  after existing persisted package allocation/revalidation. Use `sender(source)`
  here; Root/HRT must make its return type structural, select this backend, and
  mount worker accepted source/receiver controls. This leaf does not re-encode
  manifests or allocate another transfer identity.
- `workflowArtifactReceiver.ts` yields genuine Main `transfers`, canonical reader
  and worker publication authority. Main-to-worker source authority is a separate
  existing source operation; an artifact denial must never fall through to it.
- Job output/input channels have actual original admission and sealed byte readers.
  Their common owners must provide those readers/accepted authorities explicitly;
  do not infer output locations from a current job or native session.
- Canonical workflow artifact publication/Job output allocation consumes genuine
  verified receiver receipts. Existing file publication finalizes immutable
  revisions and edge pins; this leaf cannot fabricate them. Main must trigger a
  selected pull for admitted worker output only after its actual sealed reader is
  available. The worker does not SSH Main and does not copy owner/DB credentials.

Focused tests use actual local canonical receiver storage/receipts, fake byte
executor and fixture control/authorization ports, including a failed canonical
append followed by same-intent retry while the verified producer copy is retained.
They are not DB/SSH/native
production acceptance. No new physical fault was run in this continuation.
Remaining Root gates: actual discovery composition, HRT common mounts and real quota,
actual persisted source/output/acknowledgement/cleanup ports, explicit selection,
HTTP/MCP authority/readback, production publication/edge flow and coordinated
actual two-host acceptance. Missing ports remain unavailable, not test success.

The previous production leaf checkpoint recorded 16 focused tests, API types and
owned lint against the shared schemas. Current writer-port verification also
covers captured producer IO/FDs, concurrent activation, both-host closure and
retained holds, protected wrapper selection and rejected writer-handler bypass.
Exact fresh check counts and commits are in the WRITER orchestration checkpoint;
no full-suite, authenticated-MCP, SSH/native or physical acceptance is implied.
