# Remote operation ownership checkpoint

This journal is a worker-side durability boundary, not a scheduler and not a database client. Production wiring must use the W07 authenticated application carrier, accepted placement/operation scopes, existing main Run owner, W01 native managers, and W11 recovery/closure evidence. `RemoteExecutionHost` invokes the existing execution-scoped real native manager port on the worker. `RemoteNativeSessionManager` implements that same port on main over the W07 `execution-v1` extension. The shared RPC schema requires exact accepted intent/placement on every frame; session prepare, one-use turn start, read-only history/pending/capability/response reconciliation, and idempotent exact controls are separate methods. Main supplies immutable configuration/input, not provider credentials. Host-local preflight and current scoped authorization run before native effects. `observeReceipt` on the proxy must call the authoritative verified bridge before engine capture acceptance.

Main migration `284401` and `remote/persistence.ts` persist accepted receipt sequences through the existing Run owner transaction, recheck live authority before commit, retain only 32 hashed rejected reports per operation, and expose original-host readback. Owner reconciliation is separate append-only evidence, preserving W08-A's immutable initial dispatch. These files do not establish that a native two-host Run has executed.

Worker startup creates the native output store during first installation or upgrade while holding the worker service lock. Subsequent starts verify its installation marker, private filesystem and budget journal, preserving outstanding reservations. Missing or corrupted established output state requires recovery. Native output tools still require Main authorization and native sandbox qualification.

| Phase | Durable fact | Permitted next action |
| --- | --- | --- |
| received | exact original intent accepted | one serialized entry reservation, or Stop fence |
| native_entry_attempted | reservation persisted before native invocation | query original provider; never repeat Start |
| start_acknowledged | original session/turn/process identity retained | observe same execution |
| running | original execution acknowledged running | scoped exact Stop/respond |
| stop_requested | negative fence and command persisted | cancel original owner; wait for physical closure |
| confirmed_terminal | exact closure evidence and optional result digest | main-owned canonical result/edge transaction |
| uncertain | acknowledgment/process/journal knowledge insufficient | original-host reconciliation only |

`accept`, `reserveEntry`, `control`, and owner reconciliation return only after file fsync, atomic rename and directory fsync. Any write uncertainty poisons the current journal instance. Duplicate dispatch can query the same receipt but cannot reserve another entry. A dispatch lease is deliberately absent: it cannot confer native authority. Control reservation, native delivery entry, and acknowledgement are persisted separately. Only a reservation that has not entered native delivery can retry after renewed authorization; entered or acknowledged effects are never replayed. A response reserves one exact recorded native question; lost response acknowledgment remains a query of that original native question, not a resubmission. W01's NativeResponseJournal remains responsible for native delivery evidence.

New installation initialization is explicit. Missing/corrupt storage on an established installation fails closed. The journal holds a Linux kernel lock for its service lifetime and records the service boot ID, PID and process start ticks. After a crash, only a proven dead service identity or a changed boot permits replacement of the owner record; the old record is retained. Live and unidentifiable legacy owners fail closed. This releases journal access without reconciling or closing any native descendant: original receipts, entry fences and physical recovery requirements still apply. `close()` is a clean local owner handoff, not evidence the provider execution died.

Live retention is bounded by 1000 operations (configurable explicit capacity), 128 controls per operation, 128 owner renewals total, and 4 MiB serialized journal. A confirmed terminal physical reply acknowledged by Main, or positively confirmed preparation cleanup, retires workflow payloads and installed manager/history references. The live journal keeps compact operation/execution/attempt identifiers and a receipt digest; immutable cold receipts preserve exact status, control deduplication and ownership readback. Unresolved work and deduplication records never expire. Admission and non-control payloads leave 4 KiB per active owner for cancellation. Schema/byte exhaustion rejects the attempted change before persistence and leaves the journal usable; disk-write uncertainty still faults the instance. Rejected main reports go to a bounded recovery audit port and cannot modify canonical execution or publish an edge.

The main `VerifiedRemoteEvidence.commit` boundary must run within the existing execution/canonical transaction. `authority()` must lock/read the current Run execution, placement, registered-worker identity, original connection/incarnation, grant scopes/revocation, current reconciled owner and sequence, original native identity and committed terminal evidence. `accept()` atomically persists the receipt/sequence and canonical result + eligible edge via existing writers. It must independently verify closure/artifact attestations using W11/W09 services; a transport-supplied digest is a correlation reference, not trusted native evidence. Do not cast this evidence to a trusted in-process capture. Renewal is the same original physical execution, requires exact native recovery evidence and increments owner epoch; it never reserves another Start.

Recovery calls, through the authenticated scoped application carrier (not SSH or SQL):

1. `journal.status(operationId)` on the original registered worker.
2. If entry was attempted, query W01/W11 for the recorded operation, installation, boot, process identity, session and turn. An absent journal returns `unknown`, not `not_started`.
3. `journal.acknowledgeStart(operationId, provenNativeIdentity)` only after original-host proof; otherwise `journal.uncertain(operationId, redactedReason)`.
4. Main owner restart: `journal.reconcileOwner({ commandId, operationId, previousOwner, nextOwner, native, evidenceDigest })`, with live grant validation and audited main transition in the authoritative adapter.
5. `journal.terminal(operationId, verifiedClosureEvidence)`; main then uses `VerifiedRemoteEvidence.commit` and reads persisted canonical/edge records back. Neither a cancellation request nor PID absence is closure evidence.

Redacted example: `{operationId:"op-…", attemptId:"attempt-…", bindingHash:"<sha256>", phase:"uncertain", entryAttempted:true, native:{sessionId:"session-…",turnId:"turn-…",processIdentityDigest:"<sha256>"}, uncertainty:"provider acknowledgment unavailable; original owner retained"}`. No provider login, application credential, DATABASE_URL or admin token belongs in a receipt.

Remaining release gates: root's main persistence/transaction and HTTP/MCP permission/denial/readback integration; production registration of W07's signed execution-v1 duplex carrier; HRT-B/W01 native manager ownership bridge; W11 validated process-tree/provider closure; W09 real edge/artifact publication; orchestrator-only actual PC→laptop and fault suites. No remote command-line executable or real-device recovery is claimed by this checkpoint.

Focused verification commands (no integration or device mutation):

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/api typecheck
corepack pnpm --filter @foreman-code/api exec eslint src/modules/runs/remote/*.ts src/infrastructure/remoteExecutionMigration.ts --max-warnings 0
corepack pnpm --filter @foreman-code/api exec vitest run src/modules/runs/remote/operationJournal.test.ts src/modules/runs/remote/resultBridge.test.ts src/modules/runs/remote/executionHost.test.ts src/modules/runs/remote/persistence.test.ts --maxWorkers=1
```

## Genuine job subjects and output sequencing

`remoteJobExecution.ts` distinguishes workflow-node subjects with actual Run/node/node-execution IDs from manual-job subjects with actual workspace/job-execution/definition IDs. It does not manufacture an Agent, harness, native session or turn. The same journal file, fsync/rename boundary, exclusive owner lock, capacity and uncertain-entry fence now hold typed OCI job receipts, bounded log spools and immutable output command identities.

`RemoteJobExecutionHost` invokes CI-A's real `executeJob` and `PodmanJobSupervisor`. Exact accepted configuration/input hashes, genuine CI-B job grant/attempt/operation, selected physical target and OCI container/supervisor identity are retained. Worker callbacks use narrow `WorkerJobApplicationSink` RPC; `JobApplicationBridge` checks the trusted W07 binding against the actual accepted job row and CI-B's live PostgreSQL job fence. The main uses `PostgresJobDispatch` and its original owner transaction, not a worker database or another scheduler.

Process closure is journaled and acknowledged by main before collecting or publishing output bytes. Physical exit, log gaps, transport uncertainty and artifact publication remain separate. Main/worker restart and missing OCI inspection never repeat the job. A lost closure/publication acknowledgment retains the original receipt and pending/uncertain publication; it is not authorization for another execution.

`createAdmittedJobCanonicalOutputs` composes W09's persisted output admission, actual resumable receiver, verified transfer resolver, canonical artifact port and signed byte-transfer-v1 extension with CI-B's locked receipt projector. `createWorkerJobOutputCollector` instantiates W09's concrete metadata/binary clients on the existing worker channel; its sender connection must obtain current authenticated W07 context. The remote collector reads only sealed declared output bytes, requires the main-admitted immutable transfer intent, sends through W09-B's actual resumable sender, and verifies pinned canonical artifact readback. Main-local jobs use bounded detached real bytes through the same canonical port, without fabricated device or transfer IDs. Output command IDs are persisted in the operation journal before output admission and reused across retry/restart; changed hashes, sizes or declarations fail closed. W09-C owns the persisted main output-admission/resolver service and RPC schema.

Workflow runtime validation now treats `managedRuntimeRoot` as the registered accepted base. Each actual runtime leaf must be a strict native canonical descendant and carry an exact local attestation for the execution, attempt, operation, placement hash, directory identity and accepted source materialization. Base equality, traversal, project overlap and another execution's attestation are rejected before native submission.

Additional focused fixtures: `jobExecutionHost.test.ts` and `jobCanonicalOutputs.test.ts`. Their OCI command and transfer doubles are model-free contract checks; they are not installed-runtime, live-device or native-acceptance evidence.

`prepareWorkerApplicationAccess` verifies the exact ephemeral main-issued lease through C's `worker-mcp.authorize` schema over the existing W07 supervisor before returning the native child environment. Its request closure forwards every tool call through the same `worker-mcp-v2` namespace to C's actual selected-main MCP relay, which repeats the normal lease and tool authorization. The worker App launcher must mount that closure on its existing private loopback route; HRT-C owns that production composition. No token is minted or persisted by this adapter. Restart still requires original physical residency and renewal of the surviving lease before allocation; this helper cannot recover or replace an uncertain original process.

Job cleanup uses CI-B's committed stop-only Run cleanup receipt and existing Job owner fence: control calls `requireControl`, read/report calls `requireEvidence`, and Start/publication keep ordinary `require` plus the live accepted starter. Neither logs nor artifacts gain a new grant from cleanup. The host requires `inputs: JobExecutorPorts['inputs']` from W09's canonical local/worker input factory; the real executor verifies the accepted operation/attempt/source/input receipt before claiming native entry. Publication denial records `failed` separately from the immutable process terminal; lost collection acknowledgments remain transport uncertainty. The reviewed expired retained-output recovery in `jobCanonicalOutputs` is preserved.

## Original resident reattachment and admitted controls

`execution-v1` now has an observation-only `reattach` frame containing the exact accepted intent, placement, native request and session. It returns only an existing resident after current read authorization, original journal/native process proof and a second owner check. It never calls provider create/attach/start. The installed handler consequently records a genuine session-created response source for the physical readout, rather than relabeling a status boundary. A lost prepare acknowledgment may inspect this same resident; it cannot replay native entry. Unknown, uncertain, terminal, changed-request and absent-resident cases fail closed.

`RemoteExecutionHost.recover` retains the original source materialization binding, runtime directory, request input digest, manager and controller. It clears observation uncertainty only after the recovery port and current native readout establish that same resident lifetime. Authenticated reconnects rebind the connection generation after rechecking installation, boot, configuration and original native ownership. Installed-host restart recovery reads retained entry, session and process records; it does not authorize replacement native entry. Cold `needs_start` allocation remains refused when attachment would launch a replacement app-server process.

`prepareRemoteOwnerControl(sql, owner, binding, command)` is SQL-only and requires an active `GraphTransactionSql`, the original Run fence, committed exact native receipt, and committed cleanup request or selected native interaction. HRT owns persisting the returned command with the admitted delivery fence, committing that transaction, and dispatching outside G1. Reuse that persisted command on reconciliation; regenerating it from a later interaction revision is not an external-effect retry authorization. `productionRemoteWorkflow` continues to reject control delivery inside the Main interaction transaction until that admitted effect is mounted. Worker response acknowledgment loss stays uncertain and an exact duplicate does not resubmit.

Production composes persisted response delivery, connection transitions, scoped MCP authorization and canonical artifact receipts. Unit and database fixtures cover their ownership and retry boundaries. Physical acceptance still requires installed Main and Worker services on two distinct computers: remote review on the original session, disconnect/reconnect and credential renewal, revocation with original-owner Stop, Main and Worker crash recovery, and native artifact publication/consumption after lost acknowledgments. Retain the original operation, attempt, session, turn and process identities and authenticated persisted readback for each case. Loopback fixtures and local native acceptance do not establish this two-computer gate.

## Canonical native artifact output adoption

`NativeArtifactOutputs` composes W09's `CanonicalNativeArtifactResults`, the accepted publication authority, an immutable output repository, and `ArtifactEdgeService`. `acceptOutput(accepted, outputKey, commandId)` binds the original producer attempt/output key to its publication command, native session/turn/message, publication identity, exact file/revision/hash/size and original transfer receipt. Missing/pending publication is an error. `readOutput` always rereads that original command and validates every persisted identity; a later publication or current revision cannot replace it. `pinEdge` fills publication/pins/scope exclusively from this record and leaves sender/receiver authorization with the existing edge service.

`NativeArtifactOutputRepository.bind` atomically preserves its first complete record and rejects a conflicting retry. Its `authorize(FileQuery)` callback runs with accepted grant/native/attempt locks in the persistence transaction. Main and installed-worker output factories supply the accepted native identity and persisted command; the PostgreSQL repository rechecks canonical file, revision, publication and retention facts. Execution, attempt and output namespaces are verified against accepted rows. Output adoption does not infer native completion or discover outputs from text. Database and transfer tests cover persisted adoption; physical acceptance remains subject to the two-computer gate above.

## Designated Orchestrator review turns

A remotely placed designated Orchestrator keeps its original native owner after
its successful workflow turn. That workflow result, session, process digest and
turn identity remain fixed. Later review turns have separate journal entries
bound to Main's claimed review job, interaction, writer lane and Run grant.
Main rechecks the assignment before provider entry; entered or uncertain turns
are observed rather than submitted again.

Retention uses a renewable 60-second Main authorization lease and a bounded
128-turn journal. The original sandbox and scoped application credential stay
in place. Main restart recovery observes the surviving session and restores
that same credential through the authenticated private worker channel; tokens
are never added to the operation journal. Review events and terminal history
require the original physical readout alongside Main's job and lane proofs.

Run disposition closes the original owner with positive registry closure.
Failure to renew retention expires that owner locally. A missing original
process or unavailable original history remains a recovery failure; it cannot
start another provider turn or manufacture physical closure.
