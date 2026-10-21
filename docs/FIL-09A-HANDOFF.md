# FIL-09a — partial native-manager integration

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Base: `nima20002000/graphql`, `feat/nim-2733-files`,
`0fe0b630dcdd15c7c219d04f4cd17a9d7fc1d3cf`.

## Status: PARTIAL — do not mark FIL-09a complete

The actual `OpenCodeNativeSessionManager` now owns the file bridge lifecycle when
its new `chatFiles` dependency is supplied. **`production.ts` does not yet supply
that dependency.** This is not an enabled end-to-end production feature. No
Codex, UI, shared contract, FIL-05 authorization, or production composition file
was changed.

This builds on `docs/FIL-09-BACKEND.md` rather than replacing the bridge. The old
standalone `prepare()` entry remains for the existing FIL-09 callers/tests. It
still has the old pre-submission setup behavior and must not be used by chat.
The manager calls only `prepareInputs()` followed by `acknowledge()`.

## Implemented in this patch

- `prepareInputs()` uses a trusted admission-bound range-reader capability to
  read and validate exact revisions without minting a native credential. It
  retains the existing bounded ranges, final reauthorization, checksum checks,
  execution-host identity checks, source-isolation attestation, and native image
  URL construction. Initial inputs are read-only even in write mode; working
  copies are created through the existing tool after acknowledgement.
- The manager appends filenames/paths to the new turn's user input and adds native
  image parts to `prompt_async`. It reserves the uncertain-delivery fence before
  that request. An error in a callback or tool registration after native ack
  cannot convert an accepted prompt into a definite rejection.
- After native ack and the existing `onSubmitted` callback, the bridge issues the
  `gql_file_` session and registers its remote MCP entry. The existing
  `createOpenCodeFileMcpFacade` dispatches the file tools into FIL-05. Credentials
  are also registered with the manager's existing redactor.
- The trusted binding is checked against the manager's exact native session ID,
  native turn/message ID, owner agent/operator ID, directory, and originating
  application message. A file-enabled manager requires `appMcpAccess: 'none'` and
  retains the existing no-credential/no-workflow-App-MCP checks. It fences another
  active chat in the same process.
- The in-memory correlation digest incorporates the prepared attachment identity
  while preserving the original text-only digest. Files belong to `OwnedTurn`,
  not an SSE observer. Detach/observe does not reprepare or resubmit them.
- Exact persisted user-message evidence can activate an unacknowledged file turn
  without another prompt. Failed/revoked activation is not retried implicitly.
- Publication adoption is an idempotent **repository callback** bound to the
  original accepted context. It is invoked after publish and during terminal or
  process-closure cleanup, including a lost publish acknowledgement. It does not
  accept a destination from model output. The concrete database adopter remains
  to be supplied; this patch does not write production chat message rows itself.
- Terminal/cancel/process-close paths close facade admission, revoke credentials,
  remove registered inputs, and unmount the listener. Adoption failure does not
  retain native authority. Failed revocation/cleanup remains retryable. Native
  shutdown attempts revocation independently of whether process stopping succeeds.
  Confirmed process closure avoids an HTTP disconnect that could restart the
  native server. Resource closure is not fabricated terminal-result evidence.
- The existing application system-instruction behavior for genuinely new turns
  remains unchanged. File metadata is never added to startup/system instructions
  and is not reinjected by observation/resume.

## Required production integration — NOT implemented

At the OpenCode branch of `resolveAgentChatManager` in `apps/api/src/production.ts`,
provide a real `OpenCodeChatFiles` as `chatFiles` to the existing manager. Do not
instantiate a test backend or silently return `undefined` for unavailable files.
The following obligations are deliberately explicit in `opencodeFiles/chat.ts`:

1. **Durable accepted admission.** Resolve by the conversation's accepted command
   and the manager-supplied correlation/native IDs. Obtain immutable attachment
   pins and the originating application message ID from that accepted record.
   Validate the full accepted security configuration, not just the native agent
   name. Preserve attachment-sensitive durable request receipts. This patch only
   augments the manager's in-memory digest; it does not implement FIL-10 receipts.
2. **Pre-ack authorized range reader.** Supply a server-side, admission-bound
   reader which reauthorizes the current owner, exact scope and revision for each
   bounded read. Do not implement it by issuing a native file-tool token before
   ack. This internal reader is not an HTTP or MCP capability.
3. **Execution-host materializer.** Supply the existing trusted
   `OpenCodeExecutionFiles` capability on the native execution host, including
   authoritative source-vault/ancestor isolation and per-turn cleanup tracking.
   Do not fall back to an API-host path or attest same-UID directories as protected.
4. **File-only listener/registry.** `mount()` receives the existing scoped facade.
   Mount a dedicated listener or an exact-token registry entry at the supplied
   trusted `/mcp/files` endpoint. Reject unknown/recovered tokens until explicitly
   rebound; never forward them to a permissive shared service. No Operator or
   worker credentials may be attached to this chat process.
5. **Database publication adopter.** Atomically read FIL-05's durable publication
   ledger for the exact binding and idempotently adopt file/revision references
   into `context.messageId`. Check owner, conversation scope, native session,
   turn and message together. It must remain usable after token expiry/revocation
   so terminal recovery does not need to retain agent authority.

The global Operator chat currently uses its separate management-authority path.
This patch does not change that path or silently repurpose those credentials for
file chat. The file-enabled manager explicitly rejects such a configuration.

## Read mode — still blocked

At this base FIL-05 exposes list/read/create-working-copy/publish, but no scoped
working-copy edit operation. Both create-working-copy and publish are denied for
`allowMutation: false`. This patch **does not flip that flag** or make the project
writable to bypass the existing denial. Read-mode inputs and reads work; the
requested read-mode edit/publish workflow is not implemented. A named TODO in
the native-manager test states the missing capability rather than presenting a
denial test as successful read-mode editing.

Complete this with an explicit server-authorized artifact-only edit capability
and its service/transport contract, retaining permanent-reference and project
write denials. Do not make read mode implicitly equal write mode.

## Restart/recovery limitations

Same-manager observation, lost native acknowledgement, and confirmed producer
replacement are wired without prompt replay. Graceful process closure revokes
known credentials and removes known input handles. A replacement producer is
not automatically given new credentials or another prompt.

**Cold API-process recovery remains incomplete.** Prepared delivery state, host
handles, listener ownership and adopted/cleanup state are not persisted by this
patch. Supply a durable turn journal/registry, recovered-token revocation and
FIL-04 cleanup registration before enabling production recovery. The current
manager cannot reconstruct a lost file bridge or reclaim unknown issued tokens
from memory alone. Uncertain credential-issuance acknowledgements also need
binding-indexed recovery. Never infer permission to replay from a missing native
message, a missing file, or a process exit.

Actual OpenCode 1.18.31 discovery of a newly registered MCP server during an
already-acknowledged turn has **not** been qualified here. Validate that ordering
with the real server before rollout; do not add a second prompt as a workaround.

## Validation

Executed with Node 22.16.0 and the available global TypeScript 5.8.3:

```sh
FIL09A_TYPESCRIPT_MODULE=/path/to/installed/typescript node scripts/test-fil09a.mjs
```

The final standalone run passed **16/16** bridge cases using a real loopback HTTP
config/MCP fixture and the FIL-05-shaped in-memory backend. These cover tokenless
input preparation, native image metadata, post-ack setup, idempotence, publication
adoption/lost ack, read-mode denials, foreign scope/token/artifact denial,
uncertain delivery, cancellation, native generation changes, setup failures,
cleanup retries, owner revocation, expiry and legacy helper compatibility.

Added, but **not run**, `apps/api/test/opencode-chat-files.test.ts`: **15** cases
using the repository's existing `FixtureServer` plus **one explicit TODO** for the
missing read-mode edit capability. They cover the manager path, not just a new
mock transport. The existing fake fixture file is not modified.

All nine added/changed TypeScript source/test files passed syntax/transpilation
checks. This is not semantic typechecking. Existing-file whitespace checks passed.

Not run: the repository TypeScript typecheck, lint, pnpm/Vitest suite (including
the existing FIL-09 tests), PostgreSQL integration tests, or a real OpenCode model
turn. The full repository/dependency tree was not available in the runtime;
Corepack could not fetch pnpm because registry DNS/network access failed, and
`TEST_DATABASE_URL` was not configured. Only the selected base files were retrieved
through the authenticated GitHub connector; their Git blob hashes were verified
before edits. No GitHub branch or commit was changed.
