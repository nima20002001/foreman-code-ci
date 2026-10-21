# Trusted installed rsync selection provider

Assignment1 only, based on verified clean980dbcab in isolated resume_rsync_selection.
Owned: byte-transfer/installedRsyncSelection.ts+test; narrow
 devices/trustedConnectionSetup.ts+test; this handoff. No common factory, identity,
shared DTO/migration, manifest, grants, installation/configuration or live probes.

`readProtectedInstalledRsyncSelection(serverOwnedAbsolutePath,signal)` reads a
bounded private no-follow owner file with safe ancestors; returns strict
InstalledRsyncSelection or undefined when no file. Never create/seed a selection.
Record: formatVersion1, backend literalrsync, full existing registration,
consentRevision, endpoint{user,host,localRoot,remoteRoot}, localBinary/remoteBinary
{path,sha256,version:'3.5.1'}, sourceProvenance{sourceSha256,releaseSignerFingerprint}.
Package provenance is historical installer evidence, not fresh authorization or
binary qualification. No known PC/Builder paths/digests appear as product defaults.

`createInstalledRsyncSelectionProvider({installed,setup,accepted,capture,executor?})`
returns `{selection(intent,signal):Promise<RsyncBackendSelection>}`.
installed(deviceId,signal) must read protected explicit config afresh (use reader);
setup is Pick<PostgresTrustedConnectionSetup,'checkAcceptedTransfer'>;
accepted is original AcceptedTransferAuthority;
capture(deviceId) MUST return the actual outgoing
DeviceEndpoint.captureRequest(deviceId,'rsync-stage-v1')?.binding. Do not use the
incoming-only currentBinding(namespace) query for this Main-client namespace.
executor defaults to existing NodeRsyncExecutor; tests inject it, no physical run.

`setup.checkAcceptedTransfer(intent,{accepted,binding,current},signal)` is an
internal accepted-domain capability. It validates the persisted original intent,
actual W07 binding, original current domain authorization/expiry, then reads fresh
protected registration/consent and strict SSH diagnostics, fencing again after
awaits. No Operator principal is passed, lent or granted settings:read. This is
not a new public management endpoint. Existing public check behavior unchanged.

Provider requires exact installation registration/consent revision and consent
endpoint/host fingerprint, explicit backend, app-private3.5.1 binary locations and
protected expected digests. Local digest is checked before invoking any binary;
remote pinned path digest is checked over existing strict SSH before its version.
Existing verifyRsyncBinaries rechecks both digests/version; exact3.5.1 enforced.
Protected selection, actual current capture, original accepted authority and
trusted consent are freshly reread after verification. Failures remain unavailable;
no default/fallback, hardcoded patches, synthetic consent/readiness, source/data
allocation, stopped-writer proof, scheduler or independent quota counter.

HRT owns actual composition; W07 owns protected installed path loading; Root owns
any shared publication/installation approval and all actual acceptance. A missing
explicit record never becomes selected from consent or old PATH rsync. Main alone
SSHes, roots and pins come from protected configuration only. This leaf does not
write a live selection/consent or verify real hosts in implementation tests.

Verification (2026-10-02): approved host-visible heavy-job ticket
000000000031-2de80102-509b-409f-b0ac-92255321a3d5 completed exit0.
Contracts build, 52 focused tests across installed selection / trusted setup /
existing rsyncProduction, API tsc --noEmit, and lint of the four owned TS files
passed. Log: _orchestration/resume-20261001/rsync-selection-focused.log;
scheduler-evidence.json records inherited scheduler common directory and actual
host PID namespace (token recorded only as hash). Tests use isolated temporary
fixture bytes and injected SSH/probe/executor; no physical host was contacted.

Remaining integration: HRT must wire this leaf into the common production factory;
W07 must supply the actual outgoing capture and load a genuine protected explicit
installer selection. No live record is seeded here, and historical package
provenance or PATH tool readiness alone remains insufficient for selection.
Root/integration owner owns action-time installation consent and physical acceptance.
