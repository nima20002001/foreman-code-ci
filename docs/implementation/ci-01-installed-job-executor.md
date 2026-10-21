# CI-01 actual installed Job executor

Scope: NIM-2837. `executorInstalled.ts` constructs the actual noninteractive Job executor; qualification remains a separate diagnostic. It does not install, pull images, create a Main scheduler, or manufacture readiness.

## Mount interface

Import `createInstalledJobExecutionHost` from `apps/api/src/modules/jobs/executorInstalled.ts`.

Input is `Omit<RemoteJobExecutionHostPorts, 'supervisor'>` plus:

- `configuration: InstalledRuntimeConfigurationLocation | null`
- `registry: NativeProcessRegistry` (the original native owner registry)
- `currentBinding?(): Readonly<DeviceSessionBinding>` (mandatory for fresh device create/start)

Return is `RemoteJobExecutionHost`: `handle`, `recover`, `drain`, `shutdown`.

HRT owns mounting this host alongside the existing Workflow host through `createRemoteExecutionHandler(workflows, jobs)` on the existing `execution-v1` namespace. Worker startup must call `await jobs.recover()` to rearm retained absolute deadlines before advertising Job availability. Recovery uses local retained ownership and never restarts a build. A different boot requires recovery, not fresh execution.

The caller must supply the ORIGINAL `job-runtime-operations.json` journal already containing the genuine measured qualifier; do not rename, initialize, or replace missing workflow/diagnostic/Job journals. Open it without `initializeNewInstallation`. A missing journal requires recovery. The factory never opens a journal itself.

`RemoteOperationJournal` preserves schemaVersion 1 and existing workflow/qualification facts. Its additive `jobOwners` array defaults empty for existing files and retains original qualifier operation, exact launcher reservations/exits, container intent/ID, process/cgroup certificate, absolute deadline and observed timeout. Main-local certificates use `observedDeviceId: null`; no device ID is fabricated.

## Canonical adapters and integration gates

Supply W09's exact private Git source verifier as `source`. The factory additionally verifies that the materialization is on the qualifier's bounded filesystem; it must be beneath its source parent, with the exact runtime root. No raw archive, external Git common directory, credential helper or user's working copy may be substituted.

Use the existing `createWorkerJobInputPort` for device input delivery, `WorkerJobApplicationSink` for Main's exact authorization/receipt/log callbacks, and `createWorkerJobOutputCollector` for canonical declared artifact transfer. Main-local input/output adapters remain their existing canonical factories. Unavailable adapters must stay unavailable. No fabricated files or independent byte store.

The retained diagnostic must be closed and genuinely qualified for the accepted policy revision/image/toolchain, host/installation/registration/workspace/root selection. Fresh create/start rechecks expiration, protected physical pins and live Main authorization. Cleanup and offline deadlines use local retained scope without network authority, so disconnect cannot authorize a new launch or prevent an admitted stop.

Terminal process evidence is persisted before Main acknowledgment or artifact collection. Lost closure/collecting/publication acknowledgments resume the original W09 command IDs. Deterministic local collection failures mark publication failed while preserving actual exit; transport failures retain collecting/uncertainty. A stopped-container inspection alone is insufficient: closure joins its original helpers and checks the retained cgroup certificate. Queued cancellation has zero spawn; stop commands must match the authorized outer operation/attempt/subject/owner.

## Verification boundary

Focused tests use actual local filesystem/journal IO with explicit native, OCI, authority and measurement doubles. They establish code sequencing and recovery contracts, not installed-runtime qualification, authenticated MCP/DB integration, selected-computer builds, native descendants, or physical artifact transfer.

The integration executor owns authenticated HTTP/MCP denied-caller/readback checks, DB/integration/native suites, packaging, common mounts and two-computer acceptance. Real rootless OCI configuration/cgroup/filesystem/image/toolchain qualification, a real private Git materialization, success/failure/child cancellation, offline timeout, one launch/publication across reconnect and actual artifact readback remain required physical gates.

## Accepted-source bridge follow-up

`JobApplicationBridge.resolveAcceptedSource(intent, binding)` returns `AcceptedJobSourceReadout` from `runs/remote/jobAcceptedSource.ts`: `{ execution, materialization, root, diskQuotaBytes }`. Device readback uses the existing exact authenticated installation and Job evidence fence, with all metadata reads in one transaction. Main-local composition may call `readAcceptedJobSource(sql, execution)` only after its equivalent current Job read fence in the same transaction.

The producer verifies the original materialization operation/attempt/source digest/final dispatch binding, effective state column, root namespace/attestation/registration, exact retained Git manifest and immutable runtime-policy version. Quota comes from that saved policy version, not a worker request or current defaults. It returns neither physical verification nor qualification. HRT must pass the actual record through W09's source verifier/private repository verification before returning `JobSourcePort.verify` facts.

Root owns the shared `job-source` RPC request/readout schema; HRT owns routing it to this public producer on the existing channel. No transport/migration/common factory changes are included in this producer follow-up.
