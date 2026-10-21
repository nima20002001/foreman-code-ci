# NIM-2851 explicit rsync staging backend (Oct 2)

Owned files are `rsync.ts`, `rsyncStore.ts`, `rsyncAdapter.ts`, their two test files,
and this handoff. Baseline: clean integrated `bb268407ed2d235fd489a33323a1c9bf39f2c873`.
No shared schema, scheduler, factory, migration, setup module or canonical adapter changes.
Existing binary-carrier fallback remains unchanged. Backend selection and production mounts
belong to integration/HRT; this module does not silently select itself.

## Composition

`RsyncStagingTransport(endpoint, TransferAuthorization, RsyncStagingPorts, executor?)`
exposes `stage(intent, currentContextGetter, signal?) -> RsyncStagedBytes`.
The result has the original normalized `TransferIntent`, SHA256/length, bounded
`read(offset,length,signal)` and `close()`. It deliberately has no publication receipt.

Endpoint configuration is trusted setup output, never transfer request data. It
contains fixed user/host, private local/remote roots, absolute binary paths and
both exact binary SHA256 pins. Direction selects push/pull; UUID names select one
sealed `.snapshot` and one `.part`. No arbitrary file name, remote command,
user argument, recursive tree, delete or canonical in-place write is accepted.
Single immutable source packages use the existing bounded archive/source manifest.
`--protect-args`, single-file size cap, private partial directory, checksum and
strict existing SSH known-host checks are fixed. The executor drops provider,
DB, `RSYNC_*`, agent and other inherited environment variables.

Required control ports:

- `source(intent,derivedSnapshotPath,signal)` returns `verify(signal),close()`.
  Freeze and reserve the exact accepted source before copying. Closing its handle
  must preserve the only sealed copy until canonical acknowledgment/expiry.
- `receiver(intent,derivedPartPath,signal)` returns `verify(signal),interrupt()`.
  Verify hashes/length, fsync and return staged bytes; interrupt releases writer
  ownership and retains a bounded partial under the same immutable identity.

Remote implementations must use the already authenticated application control
RPC with current accepted Run/attempt/placement/source authority. SSH ownership
alone must never authorize an app transfer. Ports must honor their AbortSignal
and bound their cleanup. Authorization rechecks the current context before byte
movement, after byte movement, at readback and each second during the subprocess;
read-only current/authorization waits are abortable. Revocation can interrupt byte
movement within that polling window; final verification/read/publication still
requires current authorization. Boot/epoch comes from the current binding while
immutable intent provenance stays unchanged.

`RsyncPrivateStore(root, quota)` implements local freeze from an authorized FD,
receive and trusted retire, usable on either host. Ancestors, files and partial
directory are checked for ownership/privacy/symlinks. Handles anchor local FS
operations through the root FD. RSYNC itself uses the private pathname; other
agents must not share this service uid or access its root. Same-uid compromise
is not a security boundary. Writer locks fail closed after crashes and are never
stolen by age. Existing supervisor reconciles confirmed stopped owners.

`quota.reserve(intent)` must reuse the existing persistent allocation authority:
aggregate/per-device byte caps, active-operation limits, original expiry, retry
budget and finite partial/source retention. Reservation survives interrupted
leases and source handle close. `quota.retire(intent)` is its idempotent release.
No new quota ledger or cleanup loop is provided. Call `store.retire(intent)` only
from that supervisor after confirmed stopped writer plus expiry or canonical
acknowledgment. It removes only UUID private files/partial, keeps intent identity
until expiry, and never removes a live lock. Receiver successful staged `close()`
removes its byte copy and releases reservation; do this after canonical acknowledgment.

On the destination, `importRsyncStagedBytes(staged, existingByteTransferPort,
currentContextGetter, signal?)` adopts bytes locally through the unchanged
receiver validator/journal and returns its genuine `VerifiedTransferReceipt`.
C must then use its existing full-upload validator, finalize/publication service,
accepted receipt authority and edge pins. Preserve staging on adoption/publication
failure. An rsync exit, staged hash or receipt is not canonical publication or Run
completion. No new exactly-once or cold process recovery semantics are claimed.

Cancellation sends TERM only to the owned local process group, with KILL after
one second. Remote rsync I/O timeout is 30 seconds; a disconnected remote child
may take that long to exit. The whole byte attempt deadline is at most five
minutes or original expiry, whichever is sooner. The caller retries explicitly
under the same immutable intent; no second reconnect supervisor exists.

## Binary qualification

Checked official sources on 2026-10-02:

- https://rsync.samba.org/security.html: 3.5.0 fixes August 2026 audit issues.
- https://ubuntu.com/security/CVE-2026-53790: Ubuntu 26.04/24.04 Needs evaluation.
- https://ubuntu.com/security/notices/USN-8349-2: June regression versions only.

PC system `/usr/bin/rsync` is `3.4.1+ds1-7ubuntu0.3`, SHA256
`92faeb9388dc94801b6af10160f09f553dbdfe72952a90d11b686c2814b54831`.
Builder system `/usr/bin/rsync` is `3.2.7-1ubuntu1.5`, SHA256
`6b4fb867cb49d0332b72b234656311c807ab68b0537905fda7a3e7481a139f16`.
Neither is qualified by this backend. Version suffix is not complete patch proof.

Packaging owner supplied official signed-source native 3.5.1/protocol33 builds,
without replacing system packages. Backend independently rechecks both version
outputs and binary hash pins before each transfer:

- PC `/home/user/.local/share/graphql-tools/rsync/3.5.1/bin/rsync`, SHA256
  `ef0e0133741553921153dc42763793dd4e4e6f50477b169bca45498c96a5551c`.
- Builder `/home/builder/.local/share/graphql-tools/rsync/3.5.1/bin/rsync`, SHA256
  `66ea7be9ce8a03d9131794783faaa124d6cce3ea388225ecd8dffc240a2ed868`.

Packaging owner retains signature/source/build provenance. This worker independently
proved actual execution of those exact pinned binaries, not their build provenance.

## Checks and acceptance handoff

Use the unchanged host-visible `scripts/heavy-job.mjs` and pinned pnpm/Node.
Sandbox PID namespaces can cause scheduler tickets to disappear; never bypass
queue, clear peer slots or kill peer processes. Only requeue a confirmed lost own job.

Focused:

```sh
node scripts/heavy-job.mjs -- corepack pnpm --filter @foreman-code/api exec vitest run src/modules/byte-transfer/rsync.test.ts
node scripts/heavy-job.mjs -- corepack pnpm --filter @foreman-code/api exec tsc --noEmit
node scripts/heavy-job.mjs -- corepack pnpm --filter @foreman-code/api exec eslint src/modules/byte-transfer/rsync*.ts --max-warnings 0
```

Physical test is skipped unless `RUN_RSYNC_PHYSICAL=1`. Supply
`RSYNC_PHYSICAL_LOCAL_BINARY`, `RSYNC_PHYSICAL_LOCAL_SHA256`,
`RSYNC_PHYSICAL_REMOTE_BINARY`, `RSYNC_PHYSICAL_REMOTE_SHA256`, and optional
`RSYNC_PHYSICAL_REPORT` path, then run the same scheduler command with
`vitest run src/modules/byte-transfer/rsync.physical.acceptance.test.ts`.

The physical harness uses already authorized strict SSH, unique private roots,
0/1MiB/8MiB random bytes, source mutation after freeze, real push/pull hash/length
checks, owned throttled-process cancellation, observed partial and explicit resume.
It also deliberately corrupts only its remote private staging object, verifies
rejection, restores via rsync, then pulls correct bytes. Cleanup removes its unique
remote/local test root. Fixture control ports/quotas authorize isolated test data;
this does not prove production app authorization or canonical publication.

Integration-owned remaining gates: mount real source/receiver control RPC and
quota/cleanup supervisor; explicit setup-bound backend selection; current revoked
or denied app authority during actual transport; exact immutable source and
artifact adoption/publication readback; downstream edge Run pins; duplicate/lost
publication acknowledgments; worker/Main crash and stopped-owner lock recovery;
ENOSPC/EIO; shared service restart/faults; full PC/Builder Board/Job/app acceptance.
No shared restart, network change, new key/grant, package replacement, merge,
deploy or additional review was performed by this worker.

## Final owned verification evidence

28 focused tests, API tsc and owned lint passed; final physical harness passed
in 44.95 seconds on final source. Report `/tmp/graphql-rsync-physical-report.json`,
logs `/tmp/graphql-rsync-final-check.log` and `/tmp/graphql-rsync-physical-check.log`.
Actual isolated run: `41710fcf-21c9-4c8a-a3b4-0c17fcab06ec`. Remote/local roots cleaned.

| Bytes | Frozen/remote/returned SHA256 | Fault |
| ---: | --- | --- |
| 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | none |
| 1048576 | `9b0274ffbcf58211b923122f121151b0db1ad9ebb871090df4e87db3e126bb49` | corruption rejected; restored |
| 8388608 | `7d36abecf8cba87efa730b9dbd6407f1b590f2a3a6545b683cbc4f7386db818b` | canceled; 229376B partial; resumed |

All hashes and lengths matched after restoration/resume despite original source mutation.
This is isolated backend byte proof with fixture control authority, not full application
publication, downstream execution or live app revocation proof.
