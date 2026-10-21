# W07-B transport integration manifest

This checkpoint supplies a device-only transport core, not a mounted listener or qualified remote execution.

Root-owned integration:

- Export `packages/contracts/src/deviceConnection.ts` as `@graphql/contracts/device-connection` (dist JS/d.ts), independently of the identity export.
- Pin `ws` 8.22.0 in API and worker artifacts, validate engines/advisories/48-hour release age and resolve the lockfile with pinned pnpm. The existing lock has no equivalent websocket server dependency. No Fastify websocket plugin is required by this Node upgrade adapter.
- Create an explicitly approved separate HTTPS listener, with normal TLS certificates. Never mount onto the browser/MCP API listener or widen its origins, hosts or auth.
- Construct `ws.WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false })`. Register `deviceUpgradeHandler(endpoint, websocketServer)` as this listener's upgrade handler and `deviceHttpHandler` as its HTTP request handler. Set bounded HTTP/header/TLS handshake timeouts and connection limits in listener composition. Compression extensions are rejected.
- Export A's `device-identity` and `device-identity-node` alongside the connection export. Supply authenticated-session `signMainIdentityProof(request)` to the endpoint and separate enrollment-only `signMainEnrollmentProof(request)` to the device HTTP handler, backed by A's persisted application Ed25519 main identity. `/device/challenge` returns signed identity proof for a fresh worker nonce before pairing. Worker configuration must retain the explicitly approved application-key fingerprint; this is separate from TLS keys.
- Supply the canonical persisted main ID and approved public-key fingerprint to `/device/identity`. Inject A's `PostgresDeviceAccessService.pair`, `authenticateDevice` and `revalidateDevice`; connect A's post-commit revocation callback to `endpoint.revoke(deviceId, authorizationRevision)`.
- Construct `DeviceEndpoint` with synchronous generation-aware presence publication and authoritative reconciliation. Main close calls `endpoint.close()` before closing its separate listener. W08/W09 must replace the empty checkpoint reconciliation ports when actually integrated. No command buffering/replay exists at W07.
- C bundles `workerConnection.ts`, `connectionSupervisor.ts`, `deviceCarrier.ts`, `deviceWire.ts`, and the shared connection contracts with the pinned ws dependency. `createWorkerConnection({pairing,bootId,appVersion})` returns start/stop/status. Worker service lifetime owns this instance; neither a browser nor SSH tunnel owns it. Endpoint URLs must be `wss://.../device/connect`; no certificate bypass or credential in URL.

Before worker synchronization/readiness, the worker verifies the signed welcome against its approved application-key fingerprint and exact nonce, device/installation, key/auth revisions, boot, client/server epochs, generation and protocol/worker version. The main application version is also signed and must match welcome. Main presence becomes ready only after the worker acknowledges verified proof and completed reconciliation on the same epoch. Missing or invalid proof blocks as wrong-main.

Session binding retains main/device/installation/key/auth revisions and process boot separately from the server-issued connection epoch. Replacements, revocation and shutdown cancel old sessions before presence writes. Heartbeat has live auth revalidation; receipt is connectivity only. Protocol is exact v1 independent of app and provider versions. Dispatch and transfer remain false.

Focused transport doubles cannot qualify real WSS, persisted main restart, the worker service surviving SSH/browser closure, or laptop acceptance. Root/human must supply that evidence after approving listener/TLS/artifact/service changes. No listener, service, security or network settings were changed in this lane.

## Actual negotiated application channels

Root/C packaging also includes worker-safe `deviceApplicationChannel.ts` and exports `@graphql/contracts/device-application`. Consume A's `933a7d8` signed `negotiationHash` contract/helper. The proof binds the sorted namespace/version/direction/byte-limit intersection; altered advertisements fail before ready. Registrations are supplied at service construction and changes require a fresh negotiated connection.

```ts
const extensions: DeviceExtensionRegistration[] = [{
  namespace: 'execution-v1', version: 1, role: 'server',
  maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
  handle: async (payload, context) => {
    // Domain port verifies exact operation/manual-job grant and context.binding.
    return { payload: await actualDomainHandler(payload, context) }
  },
}]
```

Supply `extensions` to `DeviceEndpoint` and `createWorkerConnection`. Main uses `endpoint.request(deviceId, namespace, payload, {signal?, bytes?, timeoutMs?})`; worker uses `connection.request(namespace, payload, options)`. Both return `{payload,bytes?}`. Client-only registrations require the compatible peer's actual server handler. Server/duplex registrations require an actual function. No registrations retain heartbeat-only capabilities. `execution-v1`/`job-v1` enable dispatch only for a negotiated main-to-worker handler; `byte-transfer-v1` enables transfer only for a compatible direction. Other namespaces (MCP/discovery) remain explicitly negotiated without implying execution authority.

JSON requires at least256bytes for safe error envelopes; JSON and binary independently cap at1MiB. Wire chunks carry at most8KiB raw data inside16KiB frames and wait for per-chunk credit. Each channel bounds eight in-flight requests and4MiB upload/assembly budgets. Control/heartbeat frames bypass domain handler waits; handler results/cancellation remain correlated to the authenticated epoch. Receipt of a chunk/ACK never means execution accepted or file published. Oversized payloads return an explicit rejection, with no truncation.

Main revalidates device authorization before calls, handler admission, replies and heartbeats. Domain handlers must separately validate W08 execution/manual-job intent/grant/owner/target or W09 transfer root/revision permissions against `context.binding`; connect/heartbeat scopes never become execution grants. Request cancellation aborts the handler context and fences late results. Replaced/revoked/shutdown channels reject pending requests and old callback writes. Main revocation also fences authentication tickets still awaiting DB readback, so a late pre-revoke result cannot index a fresh session.

Worker MCP uses an actual separately registered `worker-mcp-v1` main handler, called through `connection.request`; W08/C owns its narrow token validation and local worker-only launcher bridge. This carrier never exposes the browser/MCP API or invents an MCP endpoint, domain scheduler, storage receipt, execution authority or listener.

Main reconciliation runs after proof verification and starts the authenticated reader before invoking `reconcile(binding,signal)`. That callback may query the worker through `endpoint.request` for authoritative domain reconciliation; main ready presence is withheld until it completes. It must reconcile admitted work rather than dispatch new work. Worker factory reconciliation remains local initialization before its proof acknowledgement.

## Production binding, observed presence and drain

Consume security repairs `0040c346` then `03a6964` before the canonical presence/runtime checkpoints. Public enrollment proofs have their own audience/message/schema and cannot certify a connection. Revocation carries its committed authorization revision; replaying an older revoke cannot disconnect a later authorized revision. Transient database/transport authorization failures remain retryable.

`DeviceSessionBindingSchema` extends the existing canonical connection identity with the opaque UUID connection epoch. `DevicePresenceSchema` carries binding, ready/offline phase, dispatch/transfer flags, actual worker hello appVersion, validated wire protocolVersion and lastSeenAt ISO timestamp from accepted frames. An unobserved peer has no DTO; inventory may represent absence as null. Outgoing auth reads and public getters never advance lastSeenAt. Offline DTOs preserve the last observed tuple and timestamp.

`currentBinding(deviceId)` returns a frozen live authenticated tuple during reconciliation, before ready publication. `currentBinding(deviceId, namespace)` additionally requires ready and the negotiated incoming worker request direction. Closed, aborted, replaced, revision-fenced or mismatched tuples return undefined. This getter grants no domain authority; W09 still checks its accepted actor/job/root/current-device SQL locks.

`captureRequest(deviceId, namespace)` is ready-only, checks the outgoing negotiated direction and returns `{binding,request(payload,options)}` tied to the actual immutable channel instance. It never follows a replacement socket by device ID. The old closure rejects after that channel closes.

Shutdown calls `endpoint.close(); await endpoint.join()` before closing dependencies. Join tracks actual underlying auth/revalidate/sign/reconcile promises, reader/request tasks, and physical domain callbacks retained by every current/replaced channel, including callbacks whose timeout/cancellation wrapper already settled. The32 authentication admission slots remain occupied until their physical queries settle, including cancelled/deadline-expired wrappers. A physical callback must settle before join returns; no conditional/no-op drain is supplied. The separate HTTP pairing/enrollment callbacks remain part of C's listener/global domain tracking and must also drain before DB closure.
