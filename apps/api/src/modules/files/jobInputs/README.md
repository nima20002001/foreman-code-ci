# Immutable accepted job inputs

`createCanonicalJobInputPorts` constructs the SQL authority, original admission
receipt and canonical byte reader from the existing pool, FileByteStorage,
PostgresJobDispatch, accepted-source preparation and current W07 endpoint. Its
`validateDeclaredJobInputs(sql, principal, workspaceId, inputs)` performs real
SQL-only definition/Start validation, including empty inputs. It must run before
source preparation. `local.prepare` implements the required executor input port.

For devices, register `extension` on the actual W07 server and construct
`createWorkerJobInputPort` from `workerFactory.ts` with the existing signed application channel plus its
actual current authenticated binding accessor. Main-owned intents and exact
canonical ranges use namespace `job-inputs-v1`; the worker uses the existing
ResumableByteTransferService for verified staging. No worker SQL or management
principal is delivered. Current recipient dispatch/source/root, sender scope,
source result binding, device credential and file expiry are checked again.

The persisted original binding uses management_command_receipts, operation
`job.inputs.bind`. Register the root-owned immutable receipt migration patch.
The manifest exposes only exact file pins and accepted workflow JSON. The
security receipt must be kept in a private main/worker host directory outside
all build mounts. `.graphql-job-inputs` cannot replace an existing source path.
Its returned receipt requires CI-B's actual readonly OCI bind before native
entry; file modes are an additional check, not the readonly authority.

Partial copies fail closed and cannot be overwritten. Verified staging remains
charged until B's bounded expiry cleanup; private retained input copies remain
charged under the original source volume claim until proven process closure and
root-owned cleanup. No TTL deletion of a potentially running source is added.

Focused invocation:
`corepack pnpm --filter @foreman-code/api exec vitest run test/job-input-delivery.test.ts test/job-input-channel.test.ts --maxWorkers=1`

Root still owns PostgreSQL/authenticated HTTP-MCP persisted-readback execution,
production composition, CI-B readonly-mount/native proof and physical acceptance.

Worker bundle boundary: `workerFactory.ts` imports the authenticated input channel and
read-only delivery only. `factory.ts` keeps the original compatibility re-export for Main
consumers. Input/output namespace and context helpers remain identical through SQL-free
`protocol.ts` and `../jobs/workerProtocol.ts`; no SQL authority is loaded on a worker.

Worker output collection is exported from `../../runs/remote/workerJobOutputs.ts`.
`jobCanonicalOutputs.ts` keeps its original worker API re-exports while retaining Main
canonical allocation/publication/projection composition. HRT must import these worker
leaves directly; packaging owns the captured-source allowlist update and full rebuild.

Focused leaf compatibility/graph verification: `test/job-worker-leaves.test.ts` uses the
production `assertWorkerDependency` guard and esbuild's actual transitive input graph.
It does not weaken the captured-source allowlist or replace canonical ports.
