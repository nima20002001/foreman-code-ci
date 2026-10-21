# FIL-08 — Codex file bridge (partial delivery)

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Base repository: `nima20002000/graphql`  
Branch: `feat/nim-2733-files`  
Exact base: `dfaaf97b8691923f75813f051251788c875e94b8`

## Status: not integrated into the production Codex adapter

This ZIP adds a tested per-turn bridge, its shared-contract composition wrapper,
a fake app-server fixture, and a standalone native Markdown smoke script. It does
**not** complete FIL-08. No existing repository file is changed. Applying the ZIP
alone does not deliver attachments or enable file tools in real chats.

Missing work includes production chat admission/adapter wiring, a concrete
execution-host materializer, proof of source-and-parent filesystem protection,
Read-mode editing, and production qualification for Codex 0.157.x. The tests do
not exercise `CodexAppServerSessionManager`, the authenticated file-tool
endpoint, PostgreSQL, or a real OS sandbox. These limitations are material, not
optional follow-up polish.

## Added files

| Path | Purpose |
| --- | --- |
| `apps/api/src/modules/harnesses/codexFiles/port.ts` | Accepted-turn, authenticated attachment-source, and execution-host lease boundaries. |
| `apps/api/src/modules/harnesses/codexFiles/bytes.ts` | Bounded byte ownership and execution-host receipt/path validation. |
| `apps/api/src/modules/harnesses/codexFiles/turn.ts` | Input preparation, per-native-turn file session, four-tool dispatch and registered-copy publication. |
| `apps/api/src/modules/harnesses/codexFiles/index.ts` | Frozen schemas/constants, FIL-07 image helper composition, native dynamic-tool definitions. |
| `apps/api/test/codex-file-delivery.node-test.ts` | Dependency-free bridge tests with explicit in-memory service and host fakes. |
| `apps/api/test/fixtures/codex-files-app-server.mjs` | Deterministic subprocess emitting early and foreign-turn tool calls. |
| `scripts/smoke-codex-files.mjs` | Standalone real-native Markdown fixture smoke, not backend integration. |
| `docs/FIL-08-CODEX.md` | This handoff. |

No shared contract, package dependency, lockfile, migration, UI, OpenCode code,
GraphQL App MCP registry, credential grant, or native configuration is modified.
`MANIFEST.txt` is ZIP metadata, not a repository source modification.

## Implemented bridge behavior

`prepareCodexFileTurn(accepted, dependencies)` takes a trusted persisted chat
admission. Owner, complete temporary conversation scope, accepted file-tool
permissions, selected execution host and native session are not native tool or
browser arguments. FIL-05 checks current authorization again when issuing and
using the dedicated session.

The authenticated attachment source returns bytes and exactly pinned metadata,
never API storage paths. The bridge bounds and hashes bytes, rechecks lifecycle
metadata after transfer and immediately before native submission, and rejects
foreign scopes, revision changes, pending, removed, overdue, or malformed input.
Initial deliveries are detached read-only copies. A host receipt must agree on
host identity, absolute canonical execution path, size, hash and write policy.
This receipt validation is **not proof of filesystem isolation**; the host lease
must enforce the guarantees documented in `port.ts`.

`nativeInput(prompt)` returns the user text plus concise JSON filename/path/pin
rows and native `{type: 'localImage', path}` entries. Binary payloads are not
added to the prompt. The wrapper composes FIL-07 `prepareNativeImage` only when
explicit accepted image capabilities are supplied, with a first-frame notice
when appropriate. Image conversion itself was not tested in this delivery;
bridge tests inject a small image preparer. Startup prompts and skill bundles
are not accepted by this bridge and must not be supplied on resume by the caller.

`activate(nativeTurnId)` calls `sessions.issueForAcceptedSession` once after
provider identity acknowledgement and durable acceptance. It binds the actual
provider turn, owner, exact scope, native session, optional message and accepted
allowlist. The `gql_file_` token remains in a private field. It is never returned
in a prompt, native tool definition, child environment or native tool result.
No Operator or worker credential is issued or exchanged.

The native functions are aliases of the existing FIL-05 service methods:

| Native function | FIL-05 method |
| --- | --- |
| `files_list` | `files.list` / `service.list` |
| `files_read` | `files.read` / `service.read` |
| `files_create_working_copy` | `files.create_working_copy` / `service.createWorkingCopy` |
| `files_publish_result` | `files.publish_result` / `service.publish` |

The wrapper generates input schemas from the frozen shared Zod schemas. Native
function names use underscores; the FIL-05 names/contracts are unchanged. Runtime
strict parsing and destination-scope checks occur **before** runner mutation or
snapshot sealing, not just before the eventual backend publish call. Callback
thread and turn IDs must exactly match the active accepted binding. Unexpected
namespaces and non-file tools are denied, with sanitized native error text.

In accepted Write mode, working-copy creation returns an opaque artifact handle
and its separate execution-host path. `beginWrite` marks that artifact incomplete
before the writable path is exposed. After native direct editing, publish looks
up only that registered handle, seals a completed host snapshot, calls FIL-05
`completeWrite`, then calls FIL-05 `publish`. Live, interrupted, unknown or foreign
writers do not reach publication. Backend idempotency and origin computation
remain FIL-05 responsibilities. A completed publish retry reuses the selected
snapshot instead of reading a mutable path again. This delivery does not reopen
a sealed working copy for another edit or register arbitrary newly generated host
files. Start another explicit copy for another edit.

`publications()` exposes the existing FIL-05 turn-pin readback seam. Adoption into
real message DTOs is not wired. `close()` revokes the token before draining calls
and releasing the host lease. Failed cleanup leaves this bridge closed and can
be retried explicitly; it never authorizes replay of a native turn.

## Required adapter wiring — not done

1. Obtain attachments and authenticated lineage from the real accepted chat
   send/admission, after FIL-10 receipt validation. Supply an authenticated source
   reader and a host lease selected from the actual native execution location.
   Do not infer an owner, run, workspace or host from the open Board. Pre-Run chat
   has no run/execution identity; Operator scope has none of those dimensions.
2. Compose the bridge with `productionFileTools(app)` from the existing service.
   Derive permissions from the accepted harness policy. Register the four allowed
   native dynamic function definitions through the existing app-server process,
   retaining chat `appMcpAccess: 'none'`. Do not create a parallel transport or
   set `GRAPHQL_MCP_TOKEN` to an Operator/worker credential.
3. Feed `nativeInput()` to the existing `turn/start` input array. Preserve receipt
   correlation and uncertain-delivery rules. This partial bridge does not add
   attachment support to `NativeTurnInput` or chat send contracts.
4. Add schema-qualified `item/tool/call` / `DynamicToolCallResponse` handling to
   the existing protocol and adapter. Stage pre-ack callbacks, persist the native
   turn identity, await `activate()`, then dispatch staged callbacks. The current
   adapter's `acceptStartedTurn` / `onSubmitted` ordering must be reviewed rather
   than simply inserting activation after already-drained staged requests.
5. Resume must preserve accepted native instructions without resending startup
   prompts/skills, including Operator sessions. Register/update the current tool
   binding safely at an idle boundary without reviving a prior token or turn.
   Handle accepted resume/fork, disconnect, cancellation, uncertain start, restart
   and disposal paths. Keep publication pins associated with the exact origin.
6. Review steering separately: this bridge handles a newly admitted turn, not
   attachments added to an already-active `turn/steer` request. It cannot silently
   substitute that active turn's scope or accepted token.

## Security and frozen-contract gaps

**Execution host and permanent references.** There is no concrete production host
lease in this ZIP. A valid implementation must transfer bytes to the selected
host and use a server-owned registration lookup. It must not reinterpret an API
path as an execution-host path. It must prove that Codex cannot write source
storage **or its parents**, including through renaming or changing permissions.
A `0444` file under a Codex-owned writable directory is not sufficient. Read-only
mounts, ownership/isolation arrangements, and native policy must be established
by the existing execution environment, not bypassed by extra writable roots.
No SSH, router, VPS, or sandbox policy is changed here. Permanent source paths
are never passed by this bridge; permanent reads/copies remain authorized by the
FIL-05/FIL-37 resolver. This does not prove that a co-located Codex process cannot
discover API storage by other means. Production integration must fail closed if
source/parent protection cannot be established.

**Completed bytes.** `sealCompleted` requires positive writer completion and
fencing, not just a size/mtime check, `chmod`, or reading a live file. Existing
open writers must not be able to change the selected snapshot. The in-memory
fake implements that contract for tests; an OS/remote implementation is missing.

**Read-mode editing.** The base frozen FIL-05 surface has list, bounded read,
create-working-copy and publish, but no agent-callable byte-edit operation.
`allowMutation: false` rejects both copy and publish. This delivery therefore
supports read/list and read-only native inputs in Read mode, not the requested
Read-mode edit/publish flow. An attempted Read-mode mutation grant is rejected
with `CODEX_READ_MODE_FILE_EDIT_UNSUPPORTED`. It does not infer a write grant from
the owner's broader authority or create a writable project/scratch bypass.
Completing the requirement needs an explicitly designed file-artifact editing
contract and accepted capability policy, without changing project access.

**Codex 0.157 qualification.** At the supplied base, `codexProtocol.ts` qualifies
0.154.0 and 0.156.1 only. Its gate is unchanged. The native function definitions
were checked against upstream `openai/codex`, tag `rust-v0.157.0`, files
`codex-rs/app-server-protocol/schema/typescript/v2/DynamicToolSpec.ts`,
`DynamicToolFunctionSpec.ts`, `DynamicToolCallParams.ts`, and
`DynamicToolCallResponse.ts`. This is not a
measured installation/schema qualification. Production 0.157 support still
requires upstream pinning, generated-schema validation and adapter acceptance.
Do not pass a false older version or weaken the gate to run this lane.

## Native smoke

```sh
node scripts/smoke-codex-files.mjs --codex /absolute/path/to/codex --model YOUR_MODEL
```

The script requires an existing ChatGPT login and `codex-cli 0.157.x`, and probes
that installation's help for a supported stdio option. It creates
a disposable Markdown input, registers native fixture copy/publish callbacks,
asks Codex to read the input, directly edit the registered copy, and request
publication. After the native process exits it checks the requested marker,
unchanged input, exact turn, regular non-linked output and byte limit, then
writes a new `.md` output without overwriting an existing file. The JSON result
identifies its **native-only fixture** scope and returned output path/hash.
It disables the known GraphQL App MCP entries process-locally and does not pass
application credentials. It does not edit native config or login records.

Its fixture publish acknowledgement is not a ready-file receipt. The script
does not call FIL-05, validate PostgreSQL links, establish OS isolation, prove
all possible descendant writers have stopped, or qualify the production adapter.
It is a diagnostic for native read/edit/tool-callback behavior, not the complete
end-to-end smoke requested in FIL-08. That end-to-end test remains outstanding.

## Verification actually performed

- Node **22.16.0** ran the dependency-free tests after syntax transpilation with
  installed TypeScript **5.8.3**: **44 passed, 0 failed** (36 top-level tests and
  8 nested negative cases). This includes the fake app-server subprocess.
- All five added TypeScript files syntax-transpiled without syntax diagnostics.
  This is **not** a strict TypeScript check or the repository's pinned toolchain.
- Both added `.mjs` files passed `node --check`.
- Pinned `pnpm@11.27.0` bootstrap was attempted through Corepack and failed with
  DNS `EAI_AGAIN` for `registry.npmjs.org`. No substitute npm install was used.
- The native smoke was invoked but could not start: `spawn codex ENOENT`.
- No full typecheck, lint, build, pinned test run, shared-schema wrapper runtime
  test, real FIL-05 endpoint/database test, real image conversion, real Codex
  turn, remote-host transfer, permanent-source OS protection test, or full
  repository acceptance suite was run.

The test fake uses a deliberately small parser to exercise validation ordering.
It does not stand in for executing `index.ts` against the real shared schemas.
The subprocess fixture specifies the intended acknowledgement/staging order;
it does not verify that the unchanged production adapter follows it.

In a complete checkout with the pinned dependencies, the added bridge tests can
be run explicitly without adding a package script:

```sh
corepack pnpm --filter @graphql/api exec node --import tsx --test test/codex-file-delivery.node-test.ts
```

Run the repository checks in `AGENTS.md` and the existing FIL-05 tests as part of
actual integration, then exercise the existing Codex adapter and execution-host
policy with real attachment and permanent-reference cases.
