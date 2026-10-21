# FIL-10b: attachment-only chat admission

Base: `08bfa311f0b680012821f8fd015f09c56469d7b4` on `feat/nim-2733-files`.

## Send contract

`content` remains a required string. Both send schemas retain their existing
trimming. After trimming, a message must have either nonempty content or at least
one attachment. An empty string or whitespace-only string is accepted with valid
attachment pins; the persisted content stays `""`, not a generated placeholder.
Missing/non-string content remains invalid. Omitted attachments still parse as
`[]`; empty content with omitted or empty attachments remains invalid.

The Agent's existing 32,000-character limit, attachment count/uniqueness rules,
strict fields, scope/availability checks, and intent/target preconditions are
unchanged. File validation is still performed by the FIL-10 repository admission
path. This does not allow attachments to create a new Agent conversation or move
between conversations.

This supersedes the statement in `FIL-10-BACKEND.md` that send-content validation
is unchanged and attachment-only messages need a subsequent change.

## Wiring

The Operator send schema is in `packages/contracts/src/index.ts`;
`operatorChat.ts` contains history/readback schemas and needs no change.
`OperatorChatService.accept` and `AgentChatService.sendMessage` already parse
these shared schemas before admission, so the new rule applies to direct service
calls as well as HTTP. No duplicate service validator is added.

The selected-Run envelope derives its context-free message fields before applying
the same content rule. It does not call `.omit()` on the newly refined Agent
request. Its HTTP body and both MCP selector forms retain validation; context
remains server-derived. The existing `agent_chat_send` tool nests the shared
request schema and its description now documents attachment-only input.

## Receipt compatibility

No hash, payload builder, repository replay branch, migration, or readback schema
is changed. Nonempty text is trimmed exactly as before. No-files payloads omit
attachment identity exactly as before. Attachment-only messages use the existing
FIL-10 ordered `fileId`/`revisionId` identity with empty content. Existing receipt
replays do not append messages, relaunch native work, or rewrite stored receipts.

## Tests

`apps/api/test/fil10b-attachment-only.test.ts` covers both shared schemas,
whitespace, empty/no-files rejection, invalid pins, preserved limits and defaults,
pre-attachment JSON/hash bytes, ordered attachment identity, and selected-Run
schema composition including the MCP input envelopes.

`apps/api/test/fil10b-attachment-only.integration.test.ts` uses the existing
isolated PostgreSQL fixture and real file uploads, chat services, HTTP routes,
and authenticated Operator MCP. It covers attachment-only service/HTTP sends,
empty input without admission side effects, readback, replay and changed-file
conflicts, byte-for-byte stored-row comparisons for text receipts (including the
Operator `legacy` sentinel), and denied-writer isolation. Only native I/O is
synthetic; no paid harness or external model is used.

Native attachment materialization/delivery, chat UI changes, and historical Run
execution are not implemented by this task. The selected-Run addition here is
only a compatibility fix for the derived send schema.

## Verification status

Source baseline Git blob identities and TypeScript syntax/transpilation were
checked locally. The supplied Vitest tests, PostgreSQL/MCP integration tests,
full typecheck, lint, and builds were not run: the pinned pnpm bootstrap failed
with registry DNS error `EAI_AGAIN`, dependencies were unavailable, and
`TEST_DATABASE_URL` was unset. No dependency versions or lockfiles were changed.
See the accompanying `MANIFEST.txt` for exact checks, hashes, and rerun commands.
