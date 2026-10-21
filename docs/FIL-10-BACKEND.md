# FIL-10 — attachments on real chat messages

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`dfaaf97b8691923f75813f051251788c875e94b8`.

## Delivery and boundary

Both existing chat send contracts compose the frozen `MessageAttachmentFields`.
Both existing admission transactions validate and save exact file/revision pins.
Both state and paged-history readers project current attachment metadata. There
is no new endpoint, database migration, dependency, lockfile edit, UI change, or
native file delivery. The existing FIL-03 storage migration (273601) must already
be registered before attachment-bearing commands are used. Text-only paths do
not query the file tables.

The source changes and tests are included; full integration verification is
outstanding. See Verification below and the delivery's `MANIFEST.txt`.

## Shared request and readback shapes

Operator: `POST /api/operator/conversations/:conversationId/messages`:

```json
{
  "requestId": "message-command-1",
  "content": "Review this document",
  "attachments": [{ "fileId": "file-1", "revisionId": "revision-1" }]
}
```

Agent: `POST /api/workspaces/:workspaceId/agent-chat/messages` retains its existing
`context`, `intent`, `expectedConversationId`, and optional native-turn precondition,
with the same additional `attachments` field. The context is validated and resolved
by the existing chat service; attachment input cannot supply a scope, owner,
filename, path, bytes, or expiry. Omission and `[]` both mean no attachments. The
frozen limit is ten distinct logical files per message. Attachment order matters.
Existing content validation is unchanged; this does not add attachment-only sends.

Public `Message.attachments` is optional and contains existing `FileWithRevision`
DTOs, not a second metadata format. For each entry, `revision.fileId` and
`revision.revisionId` are the accepted pins; `revision.filename`, `mediaType`, and
`byteSize` are immutable metadata. `file.state` and `file.expiresAt` are current
read-time values. The file's discovery `currentRevisionId` is not a download pin.
No attachment field is added to text-only readback, preserving its old shape.
State, history, and their existing transport schemas share this projection.

The Agent chat HTTP routes and Operator MCP `agent_chat_send` / `agent_chat_read`
already consume these exact shared schemas and services. They gain the same
attachment behavior without a parallel handler or authorization bypass. Operator
chat's existing human HTTP surface is unchanged; no recursive Operator self-send
MCP capability is introduced.

## Persistence, authorization, and lifecycle

Messages store an internal `record.attachmentRefs` array of `{fileId, revisionId}`.
They do not store a copy of expiry or readiness. Public readers remove this internal
field and batch-load exact metadata from `files` and `file_revisions`; historical
messages can pin different revisions of the same logical file. No read follows
the mutable file head, reads bytes, exposes a storage key, or refreshes retention.
Tombstone metadata remains visible when the bytes expire or are removed. Missing
retained metadata fails closed rather than fabricating a filename or a revision.

Admission uses the existing conversation/receipt transaction. After checking for
an existing receipt, it locks all selected file rows in deterministic file-ID order
with `FOR SHARE`. It then joins the exact revision pins and checks effective state
using `clock_timestamp()` after the lock wait, rather than transaction-start
`now()`. These locks serialize against file lifecycle writers through admission
commit. Native calls and byte I/O are outside this transaction. The send path never
changes file expiry, state, retention, or bytes.

Scope is checked against the actual persisted conversation:

- Operator: owner principal, Operator ID, and conversation ID must all match.
  Workspace, workflow, Agent, Run, and execution file columns must be absent.
  A browser route/context hint cannot change the attachment scope.
- Agent: conversation, Agent, workspace, and workflow must all match. Run and
  execution must exactly match the conversation's paired origin columns. NULL
  in a pre-Run conversation is not a wildcard for another Run.

Permanent references are not accepted as temporary message attachments. This
lane does not change their separate read-only reference resolver. All existing
chat authorization and HTTP/MCP credential checks still apply to sends, reads,
and receipt replay. The helper is a transaction-internal repository adapter, not
an authorization entry point. It does not introduce a new grant-revocation lease
or strengthen the existing Agent service's in-flight principal snapshot semantics.

## Idempotency and no inheritance

Nonempty attachment identity is added to, not substituted for, the complete old
text/settings/context/intent/target hash. It uses the frozen ordered
`messageAttachmentIdentity` function. Empty attachments add no hash component,
leaving old text-only hashes byte-identical. Adding, removing, reordering, or
changing pins under a used request ID conflicts. The old Operator `legacy` hash
fallback and Agent steer/urgent compatibility fallbacks cannot accept new files.

Already accepted receipt replay precedes availability validation: later expiry
cannot change an accepted command into a new send. A definitely failed Operator
attempt that is eligible for an actual relaunch rechecks file availability first.
Receipt-only recovery never relaunches. Uncertain deliveries retain the existing
receipt fences.

An Agent's expected conversation and selection key are retained. Switching a
browser selection while a command waits does not retarget the command. A new
Agent conversation with attachments is rejected: FIL-03 allocations require an
existing conversation, and this lane does not create speculative conversations
for uploads. Establish the conversation first, then allocate, upload, finalize,
and attach. New Runs are separate conversations and cannot adopt pre-Run or other
Run pins. The tests cover two Runs of the same workflow and Agent.

A cross-harness Operator continuation that would create a new child also rejects
parent attachments before creating the child. Existing handoff history remains
text-only. An existing text-only fork receipt still replays without adding files.

## Errors

The existing request validation, authorization, stale-conversation, and receipt
conflict errors remain unchanged. Attachment-specific errors are:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MESSAGE_ATTACHMENT_NOT_FOUND` | 404 | File or pinned revision is not in this conversation. |
| `MESSAGE_ATTACHMENT_NOT_READY` | 409 | Upload is still pending. |
| `MESSAGE_ATTACHMENT_UNAVAILABLE` | 410 | Effective state is expired or removed. |
| `MESSAGE_ATTACHMENT_CONVERSATION_REQUIRED` | 409 | A new conversation cannot adopt earlier files. |
| `MESSAGE_ATTACHMENT_METADATA_UNAVAILABLE` | 500 | Retained pin metadata is missing or cannot be safely resolved. |
| `MESSAGE_ATTACHMENT_CONTEXT_MISMATCH` | 500 | Stored message envelope belongs to another conversation. |

## Existing-file edits

`packages/contracts/src/index.ts`: compose Operator send attachment fields and add
optional metadata to `MessageSchema`. The exported request type continues to allow
omitted attachments for existing typed callers, while schema parsing supplies `[]`.

`packages/contracts/src/agentChat.ts`: compose Agent send attachment fields with the
same omitted-input compatibility.

`apps/api/src/modules/conversations/operatorChatRepository.ts`: ordered receipt
identity, transactional validation and pin persistence, replay compatibility,
child-conversation guard, and state/history hydration.

`apps/api/src/modules/conversations/agentChatRepository.ts`: ordered receipt
identity, safe legacy fallbacks, new-conversation guard, transactional validation
and pin persistence, and state/history hydration.

The shared adapter, both test suites, and this handoff are new files. No route,
service, production composition, MCP registry, or migration registration edit is
required because the existing callers use the changed schemas/repositories.
`packages/contracts/src/files.ts` and both frozen/source handoff documents are
unchanged.

## FIL-05 and later native adapters

FIL-05's append-only publication relation and `publishedForTurn` seam are not
rewritten or joined speculatively to a browser-selected message. FIL-08/09 remain
responsible for native attachment delivery and adopting published result pins on
the exact accepted native turn/message. This delivery persists user send pins and
returns their metadata; it does not claim Codex/OpenCode received file bytes, nor
that a standalone tool publication automatically appears as an assistant message.

## Verification

Actually executed in the delivery environment:

1. Verified all four existing-file baselines against the Git blob hashes returned
   for the exact base commit before modifying them.
2. Ran 288 byte-for-byte text-only hash comparisons against those baselines by
   extracting and executing the actual old/new hash functions with Node. This
   exercises only text-only hash paths, not nonempty attachment contracts or SQL.
3. Syntax-transpiled all seven changed/added TypeScript files using installed
   TypeScript 5.8.3. This is not the pinned TypeScript 5.9.3 full typecheck.

Included but **not run**: `fil10-message-attachments.test.ts` and
`fil10-message-attachments.integration.test.ts`. The latter uses the existing
isolated loopback PostgreSQL helper, real migrations, real file uploads and disk
bytes, chat repositories/services, authenticated HTTP, and Operator MCP. Only
native I/O and the finished-Run read projection are synthetic. It includes
same-name isolation, duplicate/conflicting receipts, pre-Run and two-Run scopes,
a blocked-send navigation change, lifecycle contention, tombstone readback,
read-only/revoked credentials, and legacy/fork guards. These are test cases, not
claims that the suite passed.

The pinned pnpm 11.27.0 bootstrap failed with registry DNS `EAI_AGAIN`. No package
versions were substituted and no npm install was used. `TEST_DATABASE_URL` was
not provided. Full typecheck, lint, Vitest, PostgreSQL integration, build, production
startup, and native acceptance were not run.

Apply the ZIP's full files to the exact base, then run the pinned checkout's checks:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api test test/fil10-message-attachments.test.ts
# Supply a disposable loopback TEST_DATABASE_URL with "test" in the database name.
corepack pnpm --filter @graphql/api exec node ../../scripts/heavy-job.mjs -- \
  vitest run test/fil10-message-attachments.integration.test.ts --no-file-parallelism
```

Also run the existing Operator chat, Agent chat, and FIL-03 integration regressions
and the repository-wide checks required by `AGENTS.md` before merging.
