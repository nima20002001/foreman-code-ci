# W11-B owner handoff (NIM-2855)

## 2026-10-01 resumed W11-B authority checkpoint

Lane-owned Main authority consumes `metrics:report` from the actual live W07 device
registration. `connect`/`heartbeat` alone, a negotiated capability alone, a stale key,
expired credential, removed reporting scope or authorization revision mismatch cannot
report or read retained remote samples. Whole-computer readback separately requires
`devices:metrics:read`; `devices:read` and scoped Run/chat/job grants do not imply it.
Shared permission schemas/catalog discovery belong to the integration owner. Neither
this change nor those schema additions grant existing registrations or credentials
live permission. There is no new telemetry endpoint or worker database access.

Accepted workflow attribution joins the original captured writer/session with the
exact accepted SQL harness execution, accepted Run v3 configuration pin, persisted
original native session, immutable placement/dispatch and current owner epoch. The
lane must correlate to `execution:<executionId>` and its captured connection generation.
Immutable execution input, directory, configuration and occurrence-related identities
must match; changed session/provider reference, expired lease or retired captured
lifetime is unavailable. Mutable completion changes only lifecycle, never saved facts.

HRT composition supplies `PassiveTelemetryServicesInput.getRemoteNativeOwners?()` in
`apps/api/src/modules/resource-telemetry/productionAuthority.ts`. Each original capture
is a `CapturedRemoteTelemetryNativeOwner`: `execution`, `session`, `writer` with
`id/token/connectionGeneration`, actual `nativeOwner`, exact authenticated `binding`,
original `native: RemoteNativeIdentity`, and `assertCurrent()`. This is a trusted
in-process getter from the original lifetime owner, never a deserialized metric row.
Main validates its remote receipt/native digest and native turn, accepted placement
registration revisions and actual W07 host/install/boot/connection. SQL is read only
on Main. The Main-local `nativeScopes()` filters remote hosts; it never attributes a
laptop sample or its processes to the Main collector. A's `scopeProjection.ts` owns
worker-side trusted projections and must receive original accepted/session facts
through HRT's read-only producers, without worker SQL.

Reported shared values whose genuine co-owners cannot be enumerated return opaque
`shared-restricted` without lastKnown. Remote workflow projection marks co-owner
completeness false pending that producer, even if other workflow captures are known.
Conversation/CI roles stay unavailable where original role lease/OCI producers are
absent; no workflow grant, selected Run, agent ID or name synthesizes another role.

**Activation gate:** integration must land `metrics:report` and `devices:metrics:read`
shared contracts and HTTP/MCP discovery, wire HRT original remote capture getters and
A's worker projection, then exercise live revocation races/persisted readback through
the authenticated production MCP endpoint. A human-approved explicit W07 reporting
authorization and separate reader grant are still required before real remote metrics
can qualify. This lane does not alter live registration scopes or credentials. DB,
browser, OS counter comparison, reboot and PC/laptop acceptance remain unrun here.

Focused non-DB proof for this continuation: pinned API `tsc --noEmit`, owned ESLint
and `git diff --check`; carrier/service/authenticated HTTP-MCP adapter suite 52 cases
passed after correcting a fixture that accidentally reused the terminal owner's
cgroup for a separately live owner. Repository heavy-job scheduling requires host
PID visibility: the ordinary reviewed harness escalation was used with its unchanged
scheduler; no queue bypass, peer termination or scheduler modifications occurred.
The authorized integration-owned permission producer is
`ab8c0ee1491d43ee80f2682233632015e29bf017` (local cherry-pick `793839c6`), consumed
without modifying its files. The schema-enabled API suite passed 95 cases in six
files: production authority, ingestion, carrier, authenticated HTTP/MCP adapters,
selectors and separate metrics permission contracts. Shared leaf/schema checks passed
7 cases across resourceTelemetry.test.ts and deviceMetricsScopes.test.ts. The original dispatch connection
and an unrevoked owner grant are read under SQL share locks; reconnect cannot revive
an owner whose existing grant was revoked. All checks remain non-DB tests with
controlled SQL/session/clock producers, not production or physical acceptance.

## 2026-10-01 authenticated carrier continuation

`carrier.ts` exports `mainResourceTelemetryExtension` (Main client),
`startRemoteTelemetrySession({service,binding,signal,request})` and
`createWorkerResourceTelemetryExtension({signal,currentBinding,createCollector})` (worker server).
The request function must be W07's captured `resource-telemetry` request for the exact supplied binding.
The Main loop issues a challenge, accepts the bounded response through the existing service, and skips
missed ticks. Worker initialization consumes A's `createPassiveLinuxResourceCollector` with the actual
registry and native-scope projection. Its collector uses connection/application lifetime rather than
individual request lifetime; a changed authenticated collector identity closes and joins the old sampler.
Both returned owners expose `close()`; Main also exposes `completion`, which the composition owner observes.
Ordinary transport loss stops requests while preserving authorized offline last-known state; live revocation
checks and a new authenticated handshake fence prior callbacks and generations.

The negotiated extension needs `mainCanRequest`; worker push is absent. The production authority direction
check now matches this request/response carrier. Five focused carrier cases include real W07 channel chunk
assembly/negotiation/revalidation, spoofed installation, stale callback, revoked authority and collector lifetime.
The combined carrier/authority/ingestion/HTTP-MCP adapter run passed 66 cases across four files.
Pinned heavy-job API `tsc --noEmit`, owned-file ESLint and `git diff --check` passed for this continuation.

Unfinished gates remain explicit: current device scope contract only contains `connect` and `heartbeat`,
so no explicit telemetry reporting grant is available and no registration was broadened. Root must settle
that contract before physical metrics qualification. Current production owned authority resolves genuine
local workflow captures only; remote workflow, role-specific conversations and CI require their original
accepted/native/lease/OCI projections. C/root exclusively own mounts and physical acceptance. No additional
role implementation, database, native, installation or security work was performed in this continuation.

Local/unpublished lane baseline: `0b23598c48a58e27151d891b4d4a9dcf183cbaff`.
CP1: `a195d043a298d186dcd5953bc816cdc2e9f7c371`; first lint/coverage correction: `f1db825a`.
The final lane commit includes subsequent wire bounds/source-role validation and ingestion/read adapters.

Read-only Linear source pins on 2026-10-01: parent NIM-2853 (`8a03abca-56b4-404e-aa5d-a0142c44df21`),
B NIM-2855 (`8d8aca28-9406-42b7-ba66-a949d4b7fd93`), A NIM-2854 (`58566787-5aa8-4fd0-85c2-476913d9f463`),
research document `3b98123f-5edc-40c7-b8a9-8c0885ccc6f1` / slug `8abde3d5de35`.
Read HRT NIM-2835/2836, W07 NIM-2821/2823, W08 NIM-2843/2844, CI NIM-2837/2838,
W05 NIM-2814, W12 NIM-2848 through Linear MCP; cross-checked `/tmp/graphql-workstream-20261001/w11-plan`.
Existing integrated leaf identities were inspected: deviceConnection/deviceIdentity, nodePlacement,
remoteExecution/remoteJobExecution, jobRuntime and harnessRegistry. Worktree checkpoints inspected:
W07 `3fa8ad2d`/`33d70824`, W08 `42109a51`/`e5a942c8`, CI `198bdfa4`/`a8b92d48`,
HRT `476206ab`/`1f242005`. These are source observations, not runtime qualification.

## Composition seams (owned by other lanes)

- HRT-03 constructs one `ResourceTelemetryService` per actual main runtime, injects the three
  authority ports and monotonic clock, registers HTTP/MCP, and joins `close()` before releasing
  the runtime owner. It exclusively owns production/server/factory/replay composition.
- W07 supplies `TrustedTelemetryContext` from its authenticated session, negotiated
  `resource-telemetry/v1`, and `resourceTelemetryExtension` on its existing chunked carrier.
  Remote installation maps to `binding.workerInstallationId`; local uses the real HRT main
  device/installation/boot/runtime epoch. No invented worker connection exists locally.
- Authenticated initialization/reset invokes `handshake(context, collectorGeneration)`;
  call `challenge()` at a two-second cadence, skip a null offer, and offer it to A's collector.
  Supply serialized **raw JSON** to `ingest(context, json, signal)`. Never accept context from
  that JSON or queue cached/offline captures. W07 retains control/Stop/heartbeat priority;
  B limits ingress to two pending frames and two outstanding challenges.
- Active authorization is distinct from online presence. The session authority must keep
  legitimate offline last-known reads possible while denying revoked registration/key/main/
  authorization/runtime generations. Revocation must call `revoke(context)` synchronously
  to fence callbacks and clear cache, in addition to live authority checks.
- HRT/W08/CI supply passive `TelemetryOwnershipReader.resolve` over existing exact lease,
  accepted execution/attempt/operation/binding hash/grant epoch and observed-host facts.
  Conversation leases have their own role authority. CI uses its genuine subject variant.
  Resolve must reject retired/revoked attempts even after reconnect. Private sharedOwners are
  authorization inputs only, never wire fields. Ownership transitions must be reflected live.
- `TelemetryReadAuthority` must resolve live principal/delegation and exact resource grants.
  Whole-computer telemetry requires an explicit device policy grant; a workspace/Run/Agent
  grant is insufficient. Owned workflow, conversation and CI grants remain separate. Check
  every co-owner before returning shared values; errors fail closed. This lane does not invent
  a new grant ledger or broaden the existing grants. Root must settle the actual device-policy
  producer before production registration; a permissive fake authority is never production wiring.
- Register `registerResourceTelemetryRoutes` below existing HTTP authentication and
  `registerResourceTelemetryTools` only for an authenticated Operator context, using the SAME
  service and denial audit. The POST read route's schema is read-only; normal browser origin
  protections still apply. Generic route reauthorization currently imposes capabilities:read
  on unknown paths, so telemetry reads rely on authenticated requirePrincipal plus the live
  scoped read authority rather than borrowing that unrelated permission.
- Shared package exports/barrels and Operator capability/catalog/permission discovery are
  root-owned. Required exports: `./resource-telemetry`, `./resource-telemetry-fixtures`.
  W12's selector projection must expose trusted current boot/runtime/collector generation before a first read; older DevicePresence alone does not contain collectorGeneration. Never synthesize it. Tool `resource_telemetry_read` remains a passive snapshot. Promise/AsyncIterable authorized
  `changes` is provided to presentation/HTTP stream composition; no collector starts on read.

## Deterministic evidence and remaining gates

Focused leaf/API tests use fake session/ownership/clock/authorization producers. Adapter parity
uses Fastify injection, bearer authentication and the real NodeStreamableHTTPServerTransport
at an isolated `/mcp` route; it reads retained samples through both adapters and denies callers
with no private last-known values. It does NOT exercise the fully composed production `/mcp`
with PostgreSQL policies. Root/HRT-03 own that integration gate and catalog/discovery wiring.

Commands from this worktree (pinned runtime):

```
corepack pnpm --filter @foreman-code/contracts exec tsc -p tsconfig.build.json
corepack pnpm --filter @foreman-code/contracts exec vitest run src/resourceTelemetry.test.ts --maxWorkers=1
corepack pnpm --filter @foreman-code/contracts exec eslint src/resourceTelemetry.ts src/resourceTelemetry.test.ts src/resourceTelemetryFixtures.ts --max-warnings 0
corepack pnpm --filter @foreman-code/api exec vitest run src/modules/resource-telemetry/ingestion/service.test.ts src/modules/resource-telemetry/readback/adapters.test.ts --maxWorkers=1
corepack pnpm --filter @foreman-code/api exec tsc --noEmit
corepack pnpm --filter @foreman-code/api exec eslint src/modules/resource-telemetry src/routes/resourceTelemetry.ts src/mcp/operator/resourceTelemetry.ts --max-warnings 0
```

Initial tests used temporary aliases to built contract dist while the root-owned exports were
pending. Subsequent checks use the canonical package exports; the current focused suite has 27 API cases and four contract cases. One expanded run stopped before
admission on shared heavy-job CI temp cleanup EACCES; a subsequent normal admission passed.
No permissions, security settings, scheduler, dependency, database, native helper, transport,
production factory, UI or physical service/pairing settings were changed by B.

The bounded in-memory latest/last-known cache is not durable history. B recomputes reported
counter/window arithmetic but cannot independently attest a remote kernel. DB authorization
races, production carrier/catalog/readback wiring, browser A/B/A acceptance, actual PC/laptop
and CI measurements, service/pairing/provider approvals, overhead qualification and physical
reboot remain orchestrator gates. No staged schema/unit result closes those gates.
