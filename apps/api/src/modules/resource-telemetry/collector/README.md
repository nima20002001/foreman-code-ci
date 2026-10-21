# W11-A passive ownership projections

`scopeProjection.ts` produces `TrustedNativeScope | null` from existing owners.
It is a local composition API, never an HTTP/MCP/frame input or an authorization
service. No token, arguments, environment, provider version or process name is
emitted. CPU measures the observed host's OS work, not cloud inference.

HRT-03/W11-B must supply an atomic, authorized snapshot from original owners:

- `projectAcceptedWorkflowScope`: immutable accepted SQL HarnessExecution and
  original captured execution, persisted workspace/workflow association, original
  accepted placement and reconciled dispatch intent, active original lane/writer
  and observed native session. Remote owners also supply their original receipt;
  its complete intent, session and current connection must agree. Immutable
  execution comparison includes input, creation time, directories, group,
  configuration, attempt and IDs; progress/result fields may change. The caller
  verifies accepted SQL column/record equality, Run/WorkflowVersion pins, current
  grant, original capture identity and active lease under the same read fence.
- `projectConversationScope`: original persisted Agent/Operator conversation
  owner row, original native owner capture and active lane/writer/session. The
  caller verifies the conversation-row-to-capture association. Native session
  correlation alone does not establish ownership. Shared native processes require
  explicit memberships and `shared: true`.
- `projectCIJobScope`: accepted persisted JobExecution, original journal receipt,
  original host-side OCI certificate and active original job lease. The caller
  verifies current grant and lease authority, native supervisor association and
  certificate revision. Qualification certificates are excluded. Container and
  helper certificates are disjoint inputs; the existing accounting adapter drops
  nested boundaries to prevent double counting. Helpers without accounting
  boundaries are disclosed as partial (`escaped-boundary`); their usage is not
  invented or added to an incompatible cgroup counter.

Use the existing `passiveRegistryOwnershipReader(registry, scopes)` and
`createPassiveLinuxResourceCollector` seams. `TrustedNativeScope.captured` adds
actual CI container launch IDs, birth-qualified roots and cgroup certificates to
the passive native-registry join. `nativeOwner` is always captured, never formed
from a telemetry selector. Sequential native launches remain included. CPU resets
when captured root birth, launch, lease, selector/owner, boot or collector identity
changes. Missing/denied sources never establish closure or become measured zero.

The scope producer owns revision and ordered changes; use revision/re-read for
atomic joins and publish gaps when resnapshot is required. Callers must resample
original authority on lease expiry/restart/reconnect. These pure projections
neither acquire ownership nor create an ownership ledger. A rejected projection
must surface ownership unavailable through B's readback; do not use stale facts
as a current owner. Do not invent a NativeSessionLane for remote work: if the
original owner has no lane, its authority must publish its actual lease/session
projection before this adapter can be mounted.

Production/common and worker mounts, SQL authority, manifest/export changes,
MCP authenticated denied/readback checks, DB/integration and PC/laptop comparisons
remain with their assigned owners. Focused tests use injected sources and clocks;
no physical metrics collection, provider launch or laptop change is performed.
