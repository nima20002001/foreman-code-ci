# Distributed Board production gate

The main remains the only scheduler/database authority. This checkpoint's base W07 advertises
`dispatch:false` and `transfer:false`; the host-aware composition rejects remote
work until an approved dispatch/native bridge is integrated. A worker connection,
queue receipt or acceptance collector passing synthetic fixtures is not live proof.

## Orchestrator integration

Compose `HostAwarePlacementDispatch` with the original local transport and the
W07 approved connection / W08-B journal bridge. Call it only after the existing
Run/occurrence transaction commits its immutable placement and dispatch intent.
Delivery/reconciliation/Stop/respond must retain the same operation, attempt,
owner grant and accepted binding; the B bridge performs exact control fencing.
Do not turn `null` reconciliation into permission to launch. Manual HTTP/MCP,
schedules and repeats must use the same existing admission/engine path.

Instantiate `RunPlacementReadService` on the main pool with a mandatory reader for B’s authoritative persisted observations and mount its HTTP adapter
beneath management authentication; register its MCP adapter in the authenticated
Operator server. Tool `run_node_placement_get` requires live scoped `runs:read` plus `workspace_locations:read` for canonical root/CWD details.
The service locks/rechecks live grants and validates workspace/workflow/Run/node
membership. Accepted facts do not imply observed process residency.

Root must integrate A's migrations/admission wiring, B's durable observations and
control bridge, W07 dispatch authority and W09 source/artifact revision binding.
HRT-C owns `production.ts` and execution manager composition; root owns common
engine/route/MCP entrypoints. These modules alone do not complete runtime wiring.

## Human and live gates

The owner powers on/unlocks the laptop, confirms main and worker identities and
roots, approves W07's actual installation/pair/service commands, logs into each
provider locally, and approves the fixture and provider budget. W07 supplies
commands; no remote CLI or installation commands are invented here. Reuse existing
SSH/Tailscale. Never copy `.env`, provider login files or database credentials.

Through the production Board, save A on PC and B on laptop and Start one Run.
A generates a fresh nonce and artifact. B consumes the exact persisted edge and
returns a deterministic digest. Capture main-owned read-only diagnostic evidence
using the following implemented command:

```sh
node scripts/distributed-board-acceptance.mjs \
  --manifest /absolute/path/to/approved-two-host-manifest.json \
  --case happy-path \
  --evidence-dir /absolute/path/to/evidence/w08
```

This command collects and validates evidence; it does not start a standalone
worker or perform disruptive operations. The diagnostic path is an approved main
route in the manifest. Missing production diagnostics fail; arbitrary mock/local
host claims, missing native attribution/edge readback and unsafe replay fail.

Manifest version 1 requires `topology: production-two-host`, `mainId`, `runId`,
`mainEndpoint`, `diagnosticPath`, `credentialReference` (environment variable name),
and ordered `hosts` A/B with machineId, hostname, non-loopback endpoint, allowedRoot.
`approvals[case]` pins mainId/runId, both hostIds, original operationIds, approvedBy,
from/until UTC window. No secrets enter the manifest. Fault cases additionally
require faultPerformedAt after the separately authorized human operation.

Named cases: lost-start-ack, worker-restart, worker-sleep, main-restart,
lease-expiry-live-process, late-result, revocation, placement-change. There is no
`all` case. Each requires a separately approved host/window/operation. The collector
never executes arbitrary shell commands, sleep, restart, grant revocation or replay.
Report safe reconciliation of the original operation or recovery_required. Do not
claim exactly-once external effects.

Diagnostic response requirements are executable in `validateEvidence`: immutable
snapshot/binding hashes, versions, distinct actual boot/host identities, native
PID/PPID/start/CWD/session/turn, original operation/attempt/owner and ACK sequence,
fresh A output, canonical edge/artifact revision, exact B input, unique Run/edge
consumption, final authoritative readback, verified deterministic derived result.
Diagnostic output must redact credentials/private artifact contents. W11 process
attribution and orchestrator real-device acceptance remain release gates.
