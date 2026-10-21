# FIL-08a — native Codex file-turn integration (partial)

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Base: `5d80063a83d5b0b091eaa29da1136db63e76e74e` on `feat/nim-2733-files`.
Apply these full files over that exact checkout. This handoff supplements, rather
than replaces, `FIL-08-CODEX.md` and the existing `codexFiles/turn.ts` bridge.

## Status and remaining integration

The real `CodexAppServerSessionManager` now calls the existing bridge from
`startTurn`, dispatches native `item/tool/call` requests, and owns file authority
through completion/cancellation/disposal. `buildProductionApp` wires the Agent
chat manager to the new trusted composition port when its sixth argument is
provided. **Default server startup does not provide that argument yet. This is
not a complete, enabled end-to-end attachment feature.**

At this base, the Agent chat send/admission path still needs the FIL-10 persisted
attachment/owner admission. This ZIP does not invent an owner from an attachment,
workflow execution, or open Board. A concrete resolver and persisted-message
adopter are outstanding. The host/source ports also need the separately owned
execution-host implementation. Existing storage/tools must be registered on the
same Fastify instance before the adapter calls `productionFileTools(app)`.

Operator chat's existing management-credential manager is not file-enabled by
this wiring. File-enabled managers reject credential-enabled App MCP mode. A
separate credential-free Operator file-chat admission path remains outstanding.

## Native turn path

1. A chat-owned manager receives `CodexChatFiles`. On native thread creation it
   declares the four FIL-08 schemas (or only list/read for a read-only harness).
   Declarations are not executable authority. There is no invented native
   register-tools RPC and no additional MCP transport.
2. `startTurn` reserves its existing start slot, asks the trusted resolver for
   that exact session/correlation, then calls `prepareCodexFileTurn`. The original
   bridge performs pinned scope/lifecycle/hash checks and host materialization.
   `bridge.nativeInput(prompt)` supplies the actual `turn/start.input`, including
   any native image input already produced by FIL-08. Text-only admissions stay
   text-only. File turns require an `onSubmitted` callback before native input.
3. Native requests/events arriving before acknowledgement remain staged. The
   acknowledged native ID is passed to and awaited through `onSubmitted` before
   `bridge.activate(nativeTurnId)` can issue a FIL-05 file session. Only after
   activation does the local executable registration accept tool calls.
4. Native file calls validate thread, native turn, namespace, and call identity.
   They bypass the approval-interaction translator, never the FIL-05 service's
   authorization. Dispatch does not block the stdio frame reader on file I/O.
   Foreign calls are denied before consulting receipts. Repeated equivalent call
   IDs share a promise/result; changed arguments under the same call ID fail.
   A native request ID has only one in-flight response writer. Caches are bounded.
5. The production adapter delegates list/read/copy/publish to the existing
   `AgentFileToolService`. A successful trusted publish result is passed to
   `adoptPublished` for the originating persisted message before replying to
   Codex. No token or host path from tool arguments can select another message.
6. Terminal observation, cancel, abort, disconnect, close, and restart fence the
   handler and close the bridge. FIL-08 revokes before draining calls and closing
   the host lease. Cleanup failures remain retryable; native process shutdown is
   still attempted when file cleanup fails. Each new turn gets independent state.

No changes were made to the original bridge, file-tool contracts, FIL-05 service,
execution-host materializer, permanent mounts, OpenCode adapter, or UI.

## Trusted composition contract

Pass a `ProductionCodexChatFiles` as the optional sixth argument:

```ts
buildProductionApp(config, database, checkpoints, logger, undefined, codexChatFiles)
```

Its `resolve({ conversationId, session, clientCorrelationId, signal })` must load
an authorized durable admission. Returning `undefined` means that an identified
admission is positively known to have no file context; missing, ambiguous,
unauthorized, or mixed identity must throw, not silently become text-only.

Return `CodexChatFileAdmission` with:

- `clientCorrelationId`: the exact persisted native correlation. This is checked
  separately from `accepted.admissionId`, which remains the send-receipt identity.
- `accepted`: FIL-08 owner, temporary conversation scope, native session,
  originating message, accepted permissions, expiry, host identity, and pinned
  attachments. Derive Agent workspace/workflow/run/execution from the admitted
  conversation. Pre-Run admissions must not acquire a fabricated run ID.
- `dependencies`: authenticated attachment reader/rechecker and the separately
  implemented execution-host lease, plus any FIL-07 image options.
- `adoptPublished(nativeTurnId, refs)`: atomically/idempotently union the exact
  ready publication pins into that admission's message. Recheck its durable
  conversation/session/turn/message lineage, including canceled-publish repair.
  Never look up the currently selected browser message or current active Run.

The concrete persisted-message adopter is **not included**. Its success/failure
is part of tool completion, but durable repair after an adoption failure, lost
publish result, or API crash also needs the originating conversation repository's
FIL-05 publication readback. The adapter does not claim this repair is implemented.

## Resume, restart, and policy limits

Resuming/forking/restarting does not inject developer startup instructions again.
History reconciliation does not call attachment preparation or resend
`turn/start`. A recovered acknowledgement can establish native identity without
reopening a bridge already closed during disconnect/cancellation.

A new turn on a resumed, file-enabled native thread can prepare a new file bridge.
An already in-flight file turn is **not** transparently rehydrated after process
replacement: its old file authority remains fenced. Restoring registered mutable
host copies and repairing publications across that boundary needs the durable
admission/host work described above. Old native threads created without dynamic
file declarations are not upgraded or replaced by this patch; support for those
threads has not been qualified.

Read-only mode retains the existing FIL-08/FIL-05 limitation: list/read only.
This patch adds no edit tool, writable project directory, or mount workaround.
Reference write restrictions remain in the existing service/bridge.

## Protocol evidence

The production qualification gate remains limited to its existing pinned Codex
versions. The existing FIL-08 emitter's `type: 'function'` shape is also present
in the upstream generated `DynamicToolSpec.ts` at both `rust-v0.154.0` and
`rust-v0.156.1` (Git blob `8f60e4eece6d864c5de1a83955c402171f4fce78`). The 0.154.0
`DynamicToolFunctionSpec.ts` blob is `50bcd4271b752242a3719a0b147c17f38796d351`;
`DynamicToolCallResponse.ts` is `788e6242dc67aaf13688a26db1169dc4ff14358e`.
These are in `openai/codex`, under
`codex-rs/app-server-protocol/schema/typescript/v2/`.

`codexProtocol.ts` now includes `item/tool/call -> DynamicToolCallResponse` in the
existing generated-schema response validator. No schema hash, admitted version,
or qualification check was relaxed. Installed-binary qualification was not run.

## Tests and verification

`codex-file-runtime.test.ts` adds ten real-manager/stdio tests using the existing
`codex-test-helpers.ts` and `codex-app-server.cjs` executable fixture. The new
helper extends that executable in each temporary test directory at three asserted
insertion points: pre-ACK file calls, keeping attachment turns active, and reflecting
the process-local App MCP disable flag. Existing fixture defaults are unchanged.
The tests use FIL-05/auth/storage and host doubles, not a real database or host.

Coverage: prepared attachment input and ACK/persistence order; copy/publish and
originating-message adoption; equivalent/conflicting call identities and foreign
turn rejection; resume without redelivery/startup text; consecutive turns on one
process; cancel during token issuance and during preparation; foreign admission;
mandatory receipt callback; credential isolation; unknown tools/namespaces.

`codex-file-registration.test.ts` adds six dependency-isolated lifecycle tests.
These six cases were executed locally after TypeScript transpilation with only
the test-runner import changed from Vitest to Node's built-in test runner: 6 passed.
Five additional local probes executed the transpiled production manager with
transport/contract/bridge doubles: ACK gating, successive-turn cleanup, pre-input
cancel, missing receipt, and transport close after cleanup failure; 5 passed.
Those probes are supplemental checks, not the real app-server fixture suite.
All nine delivered TypeScript files passed syntax/transpilation checks. This is
not a semantic typecheck. Modified base files were reconstructed and verified
against their Git blob hashes; the payload has no trailing whitespace.

**Not run:** pinned Vitest suite, complete existing Codex/Agent chat regression
suite, semantic typecheck, lint, build, database/HTTP/MCP integration, actual native
Codex/schema generation, and execution-host/image-file access. This runtime has
no complete checkout or repository dependencies. Bootstrapping the pinned
`pnpm@11.27.0` failed with `EAI_AGAIN` for `registry.npmjs.org`; no replacement
package manager or dependencies were installed.

In a complete checkout with the pinned toolchain and dependencies, run:

```sh
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api exec vitest run \
  test/codex-file-registration.test.ts test/codex-file-runtime.test.ts \
  test/codex-app-server.test.ts
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

End-to-end acceptance also requires providing the real admission/adoption/host
ports and testing actual message readback, API restarts, and the installed Codex
binary. This ZIP should not be represented as that acceptance result.
