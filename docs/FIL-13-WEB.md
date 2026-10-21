# FIL-13 — real chat attachment mounts (partial)

Base: `08bfa311f0b680012821f8fd015f09c56469d7b4`, branch
`feat/nim-2733-files`, repository `nima20002000/graphql`.

## Included

`RootShell` mounts the existing FIL-11 attachment provider above conversation-keyed
panels. Its client is stable and its lifetime follows the authenticated session.
The small `ChatAttachmentBoundary` also permits standalone chat embedding without
nesting another store when the shell already supplies one. No `WorkflowBoard.tsx`,
router, backend, shared contract or package/dependency file is changed.

Operator scope comes from the selected persisted conversation and the authenticated
shell's existing browser-access Query. It has only owner/operator/conversation
identity, never the currently open workspace, workflow or Run. Agent scope comes
from the persisted AgentConversation, including the actual origin Run/execution
when present. File selection, upload completion and acknowledgement continue to
use the existing provider's scope-bound draft keys and opaque snapshots.

The real OperatorComposer and ConversationComposer expose FIL-11's paperclip and
chips. Existing Stop, approval, offline, permission, native capability, setup,
reservation and unknown-delivery controls remain in place. The Agent panel reaches
these changes through the existing `AgentChatPanel -> AgentConversation` mount.

Operator reservations persist ordered immutable pins with the existing command,
not File/Blob objects or acknowledgement closures. A pending reservation with the
same text but different files cannot silently reuse the pending command. Recovery
uses the original requestId/pins and the existing receipt-only recovery path.
Attached Operator successes are checked against the originating user message and
its exact pins before clearing the outbox/draft. An unconfirmed or uncertain
response keeps the draft. Cross-harness handoff cannot transfer attached files
into a new conversation; the UI blocks that combination and keeps the selection.

Agent next-turn, steer and interrupt-and-send capture the ready pins once. Existing
command receipts own acknowledgement. The callback retains the original provider
snapshot, so completion/readback cannot clear another conversation's selections
or files added after the click. Failed/unknown receipts do not acknowledge. Explicit
“send again as new message” carries the original message/command pins, not the
current composer's file selection, and does not clear that draft. A currentness
guard rejects stale attachment-only handlers after receipt reconciliation removes
their selection; ordinary text-only behavior and request keys are retained.

Both transcript paths render FIL-12 cards from persisted message readback only.
Pins use `revision.fileId`/`revision.revisionId`, never `currentRevisionId`.
Attachment-only persisted rows are not dropped. Actual DTO expiry and Expired or
Removed states are rendered by FIL-12, without inventing download metadata or
turning an upload into a sent message. Download paths retain the message's original
conversation (and, for Agent chat, its authenticated workspace).

Scoped CSS gives file chips a separate wrapping row and lets action rows wrap,
without removing Send/Stop. Physical 320px geometry was not browser-verified.

## Unfinished / integration constraints

**FIL13-BLOCKER-01: attachment-only send admission.** The pinned shared schemas
still require nonempty trimmed `content`:

- `packages/contracts/src/index.ts`: `SendOperatorMessageRequestSchema` uses
  `z.string().trim().min(1)`.
- `packages/contracts/src/agentChat.ts`: `SendAgentChatMessageRequestSchema` uses
  `z.string().trim().max(1_048_576)`.
- `docs/FIL-10-BACKEND.md` explicitly excludes attachment-only sending in FIL-10.

The composers allow an empty text submit when ready files are selected, but those
shared validators still reject the resulting real command. This is NOT working
end-to-end at this base. The source keeps the shared validation boundary intact:
no placeholder text, whitespace workaround, fake message, or local relaxed copy of
the contract was introduced. Two explicit `it.fails` regressions document the
required shared-contract behavior. The backend/contract owner must implement and
verify empty-text-plus-nonempty-attachments admission for both chat services before
these cases can become ordinary passing tests. Empty text with no attachments must
remain invalid, and existing text-only receipt identities must remain unchanged.

**Existing conversation required.** FIL-11/FIL-10 upload scope requires an app
conversation ID. A fresh Board Agent with no conversation therefore shows a
disabled paperclip until a conversation exists; no fake ID, empty hidden chat turn,
or pre-conversation allocation route was added. This is another boundary to resolve
if first-ever Agent messages must support files before conversation creation.

## Tests authored

`apps/web/src/features/conversations/chatAttachments.test.tsx` exercises the real
Operator chat and Board Agent panel with MSW at the upload/send/readback boundaries.
Only unrelated Operator settings popovers and live transport are replaced. Cases
cover Operator send, Agent send, upload completion after chat/Run switching, lost
Operator acknowledgement and receipt recovery, Agent unknown receipt, user and
assistant Expired/Removed cards (including an overdue ready DTO), composer-only
attachment-only affordances, and the two expected-failing contract regressions.
The provider stays above keyed panels in these integration fixtures, as in the
production shell.

`chatAttachmentAttempt.test.ts` covers ordered pin identity, historical revisions,
blocked upload capture, exact original snapshot acknowledgement after switching,
stale attachment-only handlers, and first text-only conversation creation.

The new suites were NOT executed in Vitest. Do not interpret their presence or
expected-failure annotations as passing test evidence.

## Verification performed

- Every modified pre-existing file was fetched at the exact base ref and its local
  pre-edit bytes were checked against the Git blob SHA returned by GitHub.
- Global TypeScript 5.8.3 transpilation: 17 TS/TSX files, no syntax diagnostics.
  This is not the repository's semantic typecheck.
- PostCSS parsed the one added stylesheet successfully; no layout assertion follows
  from a successful parse.
- Nine isolated runtime checks executed the actual transpiled pure attachment
  capture/pin helpers on Node 22.16.0, with no runtime dependency stubs. These are
  not React, Vitest, MSW, browser, server or native-harness tests.
- ZIP paths, payload hashes, unchanged-file exclusion, archive CRCs, and the absence
  of `WorkflowBoard.tsx` were checked when packaging.

The container could not bootstrap the repository-pinned `pnpm@11.27.0`:
`corepack pnpm --version` failed fetching its registry tarball with
`getaddrinfo EAI_AGAIN registry.npmjs.org`. Local Git access also lacked DNS access;
source retrieval used the connected GitHub reader instead. A full checkout and its
workspace dependencies were not available locally.

Not run: dependency installation, contracts build, repository semantic typecheck,
lint, Vitest/MSW suites (new or existing), production build, database/integration/
acceptance checks, a live app, or any browser/320px visual check. No native execution
or end-to-end success is claimed. Run the repository-prescribed root checks with
its pinned toolchain on a full checkout before merging this partial overlay.
