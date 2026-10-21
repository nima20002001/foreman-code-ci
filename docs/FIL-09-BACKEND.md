# FIL-09 — OpenCode files: partial backend handoff

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Base: `4c7bb220d4d545ba076657d75bae99a36511121f` on `feat/nim-2733-files`.

## Status

**Partial; not production-wired. Do not treat this ZIP as a completed FIL-09 implementation.**

This change supplies tested file-delivery, execution-host registry and scoped-MCP components for the existing OpenCode adapter. It does **not** connect them to `OpenCodeNativeSessionManager`, chat admission, its durable turn identity, or production host provisioning. Applying the ZIP does not turn on chat attachments. `opencodeServer.ts`, `opencodeTransport.ts`, chat services, production composition, contracts, migrations, Codex and UI are unchanged.

The only existing source file changed is `apps/api/src/modules/files/tools/mcp.ts`. It accepts a structural service facade and can append a trusted working-copy path annotation to the text portion of `files.create_working_copy` results. The frozen structured result, four tool names, authorization, schemas, default service behavior and endpoint remain unchanged.

## Implemented components

`opencodeFiles/attachments.ts` reads exact file/revision pins through FIL-05 in 64 KiB ranges. It checks range continuity, declared size, SHA-256, end-of-file and a final authorization/expiry read. It never reads an API storage path. The returned prompt fragment contains filenames, execution-host paths and artifact/pin identities, not contents, credentials or startup instructions. PNG/JPEG/WebP/GIF use native `type: file` image parts with encoded execution-host `file://` URLs. Other formats remain files, not injected text or active previews.

`opencodeFiles/turn.ts` issues credentials only through `issueForAcceptedSession` using an accepted server binding. Before issuance it requires a matching execution host, an isolation check and disabled workflow App MCP. It registers a uniquely named remote file-only MCP connection with a `gql_file_` Authorization header, then checks connection readback. No Operator/worker credential or Foreman Code App MCP enable operation is introduced.

An instance owns one accepted native turn. Replayed preparation preserves working copies, does not reissue a credential and conflicts on changed input. Helpers sharing one controller cannot hold overlapping file turns. This is a component guard, not a substitute for a production process-wide admission lease. The host/process must be dedicated to the chat binding; other sessions must not be able to use its resident MCP configuration.

Write-mode attachments become detached, registered temporary artifacts. The artifact is put into `writing` state before native edits. The native MCP facade snapshots only its registered handle when `files.publish_result` is called, completes the FIL-05 artifact and delegates immutable publication, idempotency and message/turn linkage to the existing service. On-demand working copies get the same treatment. The facade validates frozen schemas before any snapshot and has no unknown-token fallback to the general service.

`opencodeFiles/host.ts` provides a Linux execution-host implementation. Descriptor-anchored directory traversal and `O_NOFOLLOW` prevent path replacement from redirecting a snapshot through a symlink. Publication rejects hard links, directories, devices and oversized files; two bounded reads plus file identity/timestamp checks detect changes during capture. Unicode display names that exceed practical filesystem byte limits receive a short physical filename without changing revision metadata. Retried materialization does not overwrite native edits. Cleanup removes registered files and empty directories only; it does not recursively delete unregistered editor-created entries.

`assertProtectedSourcePaths` checks the actual non-root native UID, supplementary groups, IDs, DAC capabilities and mount namespace before checking a complete trusted source-path inventory. A source or ancestor that is writable, native-owned or a symlink is rejected. A directory vault must be inaccessible to that identity; making only its directory non-writable does not make its contents immutable. Same-UID chmod is deliberately not accepted as isolation. The inventory must cover the whole vault and aliases, not only currently selected references.

Production chat uses `OpenCodeVaultIsolation` instead of applying that identity check to the API-owned vault. The local OpenCode factory launches the native process through the system-owned `/usr/bin/bwrap`, with private mount, PID, user and IPC namespaces. The vault is replaced by an empty read-only tmpfs, its ancestors are pinned mountpoints, and a private procfs hides the API's open byte descriptors. Workspace paths remain shared so the API can deliver detached inputs and snapshot native working copies through the existing mediated file services. The vault remains private and API-owned.

A trusted helper checks the namespace, mounts, dropped capabilities and `no_new_privs` inside the sandbox before executing OpenCode. The controller binds its startup acknowledgement to that process generation and rechecks the original vault identity before admitting files. This local composition requires Linux, Bubblewrap with user namespace support, and the pinned Node.js 22.23.2 runtime, which includes `process.execve`. Plain chat keeps scoped tools for inherited references without creating attachment copies. File ownership, accepted sender validation, native permissions and token issuance remain enforced by the same services.

## Lifecycle contract for the missing adapter wiring

1. Resolve the actual persisted native session and accepted chat turn. Derive owner, conversation, agent, workspace/workflow and optional Run/execution provenance there. Do not build `AcceptedOpenCodeFileTurn` from browser fields, MCP arguments or the open Board. Verify that its native session ID matches the adapter's session before any preparation.
2. Provide a verified execution-host file broker. Instantiate `LocalOpenCodeExecutionFiles` only on the host where OpenCode runs, not as a fallback in a remote API process. Supply contract constants `MAX_FILE_BYTES` and `MAX_MESSAGE_ATTACHMENTS`. A real source-isolation attestation is mandatory; test callbacks are not deployment configuration.
3. Bind a dedicated `/mcp/files` listener using `createOpenCodeFileMcpFacade`. It must be reachable from that execution host and must reject every other turn's token. Preserve FIL-05 local-request restrictions using the existing trusted connection/forwarding boundary; do not expose management MCP or weaken that boundary. The example smoke uses a separate loopback listener.
4. Call `prepare` before native dispatch, use its metadata fragment only in the new turn's user text, and put `imageParts` in that turn's native `parts` array. Include its identity in durable request/turn conflict checks. Never prepare and resubmit an already accepted or uncertain native prompt merely because its observer disconnected.
5. Call `submissionAttempted()` immediately **before** dispatch, then `submissionAcknowledged()` only after a positive acknowledgement. Exact terminal evidence or a definite native rejection permits `finish`. Observer cancellation, a timeout or a missing acknowledgement does not. `publications()` provides the existing FIL-05 turn-linked result pins before credential revocation.
6. Revoke before disconnecting MCP or removing files. A revoke/cleanup failure retains the process ownership fence and needs `retryCleanup`; it must not silently permit a different binding to acquire the process.

## Remaining work and contract gaps

### Existing native adapter and resume behavior

No changes were applied to the existing `watchTurn`, `OwnedTurn`, native payload or native history paths. The base `sessionInstructions` unconditionally calls `agentInstructionBundle`; the adapter's existing system/digest/readback logic needs a coordinated change for startup-once/resume behavior. This helper itself never emits a startup or skill bundle, but that is **not** proof that the existing adapter will stop repeating one.

OpenCode 1.18.31 can add synthetic text while ingesting native file parts and replace file URLs with image data in native history. Native replay checks therefore need image-aware canonical identity handling, not a concatenation of every returned text part. Do not strip or fabricate history through a transport wrapper to make the old check pass. Add adapter-level tests for image delivery, resume, native acceptance with a lost acknowledgement, and the absence of repeated startup/skill content.

Production accepted-turn resolution, publication adoption/readback and source-host provisioning are also not wired. The helper does not implement a durable admission repository. The existing receipt authority must remain authoritative when a fresh helper instance is constructed.

### Read-mode editing

The frozen FIL-05 surface has list, read, create-working-copy and publish, but no model-callable edit operation. `FileToolContext.allowMutation` must come from accepted harness security, and the existing service denies copy/publish for a read-only binding. This handoff preserves that denial, including in tests. It **does not fulfill** the requested read-mode edit/publish behavior.

Do not fix this by making the project writable, minting an elevated credential or adding an undocumented escape tool. Completing the requirement needs an explicit accepted artifact-write capability and a bounded artifact-edit contract agreed with the owning contract/file-tools lane. Neither was added here.

### Host recovery and publication barriers

The supplied registry and controller-owner guard are in memory. Durable mapping recovery, cleanup of orphaned execution-host allocations and rebinding after an API/native process restart remain integration work. A native generation change is rejected rather than silently using old process paths or replaying input. The concrete registry supports Linux; it is not a remote-host transport or a Windows/macOS implementation.

The snapshot checks detect concurrent changes during capture. They cannot prove that an arbitrary background writer which is currently paused will never resume. Production integration must use the runner's completed-write barrier/lease or a native policy that prevents uncontrolled background writers. The real smoke denies shell/subagent execution and permits native reads/edits only in its disposable project. Do not advertise the generic local implementation as an OS sandbox or as a proof that all native writes have finished.

## Verification

Executed in the artifact environment:

- 33 focused cases passed using the same case factory registered by the Vitest wrapper. The focused runner uses real Node HTTP against a fake OpenCode server, an in-memory file-service double, and real filesystem operations for registry tests. It transpiles TypeScript; it does not typecheck the repository.
- Three direct non-root source-audit checks passed: a root-owned immutable source with non-writable ancestors was accepted; a chmod-0444 source under a writable parent was rejected; a native-owned chmod-0400 source was rejected.
- All 10 included TypeScript files passed syntax/transpile validation. Both `.mjs` scripts passed `node --check`. The real smoke's `--help` entrypoint ran.
- Environment: Node 22.16.0, available TypeScript 5.8.3. The repository pins TypeScript 5.9.3; its pinned toolchain was not run.

Not executed: `opencode-files-mcp.test.ts` against the actual FIL-05/MCP dependencies; Vitest under the repository runtime; full typecheck, lint, build, database/integration/acceptance suites; real OpenCode smoke. The complete checkout/dependency graph was not locally available, shell network access was unavailable, and no OpenCode executable/provider setup was present. No replacement dependency install or lockfile update was performed.

`FIL-09-VERIFICATION.txt` contains the focused run output and additional check results.

## Commands in a complete checkout

```sh
corepack pnpm install
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/api exec vitest run test/opencode-files.test.ts test/opencode-files-mcp.test.ts
node scripts/test-opencode-files.mjs
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
```

Real native component smoke, using the repository-qualified OpenCode **1.18.31** (within the requested 1.18.x family):

```sh
node scripts/smoke-opencode-files.mjs --help
node scripts/smoke-opencode-files.mjs \
  --binary /absolute/path/to/opencode \
  --model provider/model \
  --output fil09-returned.md
```

Run as a non-root Linux user with configured native provider credentials. The smoke uses the real FIL-05 domain services with the repository's in-memory test persistence/byte store, not the app database. It starts a real local OpenCode server, asks its native Read/Edit tools to change an attached Markdown working copy, requires publication through the scoped MCP facade, verifies the original stayed unchanged, and exclusively creates the returned `.md` at the selected output path. It refuses to overwrite an existing output. Native user configuration and provider credentials are not rewritten. This is a component smoke script, not an end-to-end production chat test.

## Source compatibility notes

The public protocol shapes were checked against the OpenCode `v1.18.31` source for `packages/opencode/src/session/prompt.ts` and the generated JavaScript SDK, plus the repository's `QUALIFIED_OPENCODE_VERSION`. No new runtime dependency is introduced. Frozen file contracts, FIL-03/FIL-05/FIL-37 services and authorization remain the authority for file identity, scope, expiry, provenance and immutable storage.
