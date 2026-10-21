# SCH-06 — exact historical Run agent chat

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Repository: `nima20002000/graphql`  
Branch: `feat/nim-2701-schedules`  
Base: `b99c4aa7a829e0dc5d7bb83a09f05375eabed5cd`

This is a source ZIP handoff, not a deployed or repository-gate-verified change.
The implementation and repository tests are supplied. Supplementary offline
checks passed; authenticated PostgreSQL/MCP, full typechecking and real native
qualification remain unexecuted. See `SCH-06-VERIFICATION.txt` and the ZIP's
`MANIFEST.txt` for the exact distinction.

## Identity and continuation

The selected entrypoint takes workspace, workflow, Run and snapshot node IDs.
It validates the physical Run scope and stored immutable `run_board_snapshots`
record, including its workflow version, before deriving the Agent/configuration
pin. It never resolves that Agent through the current saved workflow or current
Agent configuration. An Agent removed or archived in the current workflow does
not invalidate the old snapshot identity.

Execution reads reuse `PostgresRunRepository.executionPages`. One execution can
be selected automatically only when it is the sole execution for that snapshot
node. Multiple executions return `execution_selection_required`; the caller must
supply `executionId`. The response includes at most 100 execution/attempt hints
and `hasMoreExecutions`; existing Run execution paging can enumerate the rest.
An explicit execution outside that hint window still resolves. Missing native
state never causes a different attempt or Run to be selected.

Conversation lookup matches all physical columns:

- `workspace_id`, `workflow_id`, `workflow_node_id`, `agent_id`;
- `origin_run_id`, `origin_execution_id`, `kind='agent'`, and no deletion marker.

The JSON origin must agree with those columns and the selected execution's
configuration/source session. Multiple retained conversations for the same
execution fail closed rather than choosing one. New conversations use an
execution-specific `agent_key`. A matching existing legacy key is reused without
rewriting it or creating a second conversation.

The frozen `SelectedRunChatKey` is returned only when a conversation exists:
workspaceId, workflowId, runId, workflowNodeId, agentId, executionId and
conversationId are all required. A read never allocates a conversation or probes,
attaches, forks or resumes a native session. Before the first message, `key` is
null, not a manufactured or incomplete chat key.

A first allowed message uses the existing `AgentChatService` admission and native
fork path. A continued chat attaches only its stored child session. A returned
parent session or different attached session is not adopted or sent a chat turn.
Provider metadata is read from the exact `execution_native_sessions` reference
joined to the selected Run execution, not an Agent's latest session/lane.

Send, steering, interrupt, queue cancellation, transcript pagination and receipt
settlement remain on the existing services. `readConversation` and a non-null
`expectedConversationId` pin the stored origin execution instead of reselecting a
later attempt. A supplied foreign conversation ID is rejected before prior-turn
receipt lookup. A retry of the original first message with the same null
precondition retains the existing idempotent lost-response behavior.

No code writes Run results/status, Run snapshots, workflow execution records,
workflow native references or worker credentials. The existing native chat launch
uses synthetic `agent-chat:<conversationId>` execution/Run bindings without a
workflow environment. Existing chat-only App MCP suppression and accepted Agent
settings are reused; no harness configuration or workflow launch path is changed.

## HTTP and Operator MCP

New HTTP root:

```text
/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId
```

GET that root, with optional `?executionId=...`, calls `readSelectedRun`. URL scope
is authoritative. Unknown/repeated scope or Agent query fields are rejected.
The successful response has one of three shapes:

```ts
{ kind: 'selected', selection, key: completeKeyOrNull, state }
{ kind: 'execution_selection_required', target, executions, hasMoreExecutions }
{ kind: 'unavailable', target, reason: 'legacy_run' | 'execution_missing' }
```

For `selected`, `state` is the existing AgentChatState. Availability/capabilities,
not merely the presence of a key or conversation, determine whether sending is
allowed. Optional MCP history/receipts use the same conversation-scoped page
services as the existing HTTP history/turn routes.

POST `<root>/messages` takes `executionId` plus the existing message fields,
without `context`:

```json
{
  "executionId": "execution-id-from-readback",
  "requestId": "new-command-id",
  "content": "Continue this discussion",
  "intent": "next_turn",
  "expectedConversationId": null
}
```

Use the readback conversation ID after creation. `steer` and
`interrupt_and_send` retain the existing intent and native-turn preconditions.
POST `<root>/interrupt` takes `executionId`, `agentId`, `conversationId`,
`requestId` and optional `expectedNativeTurnId`; the complete selected identity
is checked before the existing interrupt command can reserve a receipt.

The existing Operator tool names are retained. They advertise additive forms in
`tools/list`, without adding tool-name enums or broadening action grants:

```json
{
  "name": "agent_chat_read",
  "arguments": {
    "workspaceId": "workspace-id",
    "selection": {
      "workflowId": "workflow-id",
      "runId": "run-id",
      "workflowNodeId": "snapshot-node-id",
      "executionId": "execution-id"
    },
    "history": { "limit": 50 },
    "receipts": { "limit": 50 }
  }
}
```

`agent_chat_send` accepts either the original `request` or `selection` plus
`message`; `message` is the ordinary message shape without `context`.
`agent_chat_interrupt` accepts its existing workspace/conversation/request fields
plus optional `selection` containing workflow/Run/node/Agent/execution IDs from
the resolved key. The selected forms call the same service methods as HTTP.
Supplying both old and new selector forms is invalid. Old `query`/`request`
callers retain their original response contracts. The read output schema remains
object-shaped for MCP discovery while validating the exact old/new result union.

Existing HTTP `/agent-chat/conversations/:conversationId/history`, `/turns` and
`/events`, and Operator queue/approval controls, are reused. No UI is added.

## Authorization and native unavailability

Reads require `agent_chat:read`. Sends require `agent_chat:read` and
`agent_chat:write`; interrupts require `agent_chat:read` and `agent_chat:cancel`,
all scoped to the selected workspace/workflow/Run. No additional workflow-write,
Run-start or current-Agent permission is used as a substitute for chat authority.
The existing authenticated HTTP/MCP boundaries and denied-command auditing remain.

Selected operations additionally re-read the live management principal and its
delegation chain, using the existing reader and authorization policy. Reads
recheck before returning; writes recheck at admission, steering again inside its
serialized control boundary. Short authorization transactions release their pool
lease before invoking nested chat/Run services, avoiding pool starvation from
an outer transaction waiting on an inner connection. This does not add a new
transaction spanning native I/O or revoke already admitted turns retroactively.

Missing source sessions, lost stored child IDs/provider versions, ephemeral
Codex sessions after runtime loss, known non-resumable sessions and configurations
that can no longer be loaded are read-only capability states. Stored conversation
messages and receipts remain readable under their existing authorization. A
missing child identity with evidence of previous startup is never treated as
permission to fork a replacement. A source session incorrectly stored as the
chat child is blocked from send/control.

Read-side liveness is deliberately conservative: reads do not contact the native
provider. An on-disk session deleted while its stored identifiers remain may only
be discovered by the existing adapter on continuation. That failure is persisted
as unavailable; no alternate source or replacement session is selected. This
handoff does not claim real-provider liveness or MCP isolation was requalified.

## Frozen-contract and integration notes

1. The pinned FEAT-15 request has no explicit execution selector; its legacy Run
   path chooses the latest business occurrence/attempt. This conflicts with the
   task's assumption that explicit execution selection already exists. The new
   `@graphql/contracts/selected-run-chat` envelope supplies it without modifying
   `agentChat.ts`, `runSnapshots.ts` or FEAT-05 frozen shared contracts. Legacy
   unpinned `query` reads retain that policy; snapshot-selected consumers must use
   `selection`, not the legacy form. Existing conversation controls are pinned.
2. The frozen key requires a conversation ID, but conversations are created
   lazily on first send. Therefore the separate `selection` is not a resolved
   chat/cache identity and `key` is null until creation.
3. The SCH-05 handoff requires registering/applying migration 270205 before use.
   This ZIP adds no migration and does not edit `migrations.ts`. Confirm the
   existing registry contains the following import and array entry, in version
   order, before serving the selected API:

   ```ts
   import { runSnapshotMigration } from './runSnapshotMigration.js'
   // existing migration array:
   runSnapshotMigration,
   ```

   Missing captures return `legacy_run`; no current graph is substituted or
   backfilled. A missing table is a deployment prerequisite failure, not evidence
   that every Run is legacy. The integration test applies the pending SQL only
   in its isolated fixture, following SCH-05's existing test pattern.

No dependency versions, lockfile, migration registry, native harness files,
workflow dispatchers, access-policy grants or UI files were changed.

## Files and checks

Four existing files are modified: the chat service, its HTTP route registrar,
its Operator tool registrar, and contracts package exports. New files contain
the shared envelope, selection helper, routes, three repository test suites, a
supplementary offline checker and this handoff/verification record.

Repository tests supplied, not executed here:

- `packages/contracts/test/selected-run-chat.test.ts`: strict scopes, complete
  key/page identity, null-key states, execution choices and MCP schema forms.
- `apps/api/test/sch06-agent-chat.test.ts`: real shared schemas/service with
  in-memory ports; removed Agent, separate Runs, explicit executions, wrong-target
  replay/control, bounded hints, live grant changes and missing-session states.
- `apps/api/test/sch06-agent-chat-manual.integration.test.ts`, `apps/api/test/sch06-agent-chat-schedule.integration.test.ts`, `apps/api/test/sch06-agent-chat-historical.integration.test.ts`, `apps/api/test/sch06-agent-chat-query.integration.test.ts`: actual isolated PostgreSQL,
  authenticated HTTP/MCP and existing deterministic native-port fixtures; persisted
  readback, removal through saved-workflow services, separate Run forks, foreign
  native receipt, controls, denial/revocation and unchanged historical SQL rows.

The supplemental checker executes the changed selection/service code using
identity-parser contract doubles and in-memory SQL/authority/native doubles. It
is not a replacement for any repository gate:

```sh
SCH06_TYPESCRIPT=/absolute/path/to/typescript \
  node --test scripts/sch06-offline-check.cjs
```

From a full checkout at the stated base, apply the source files, confirm SCH-05
migration registration, then use the pinned runtime and the repository's normal
release-age policy and disposable loopback test database:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm db:up
corepack pnpm test:integration
corepack pnpm test:acceptance
corepack pnpm db:down
```

Those gates and real Codex/OpenCode continuation/isolation qualification are still
required before treating this change as merge-ready.
