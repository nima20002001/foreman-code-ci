# CHAT-READY — FEAT-15 selected-Agent chat (NIM-2682 gate)

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Frozen seam for NIM-2683 (backend, lane A) and NIM-2684 (node-chat UI, lane B).
Base: the commit that adds this file on branch `feat/chat-foundation`.

## Source facts (verified 2026-09-27)

- Mounted node chat: `apps/web/src/features/graph/AgentPanels.tsx` `AgentChatPanel`, rendered by
  `NextDraftEditor.tsx` `panels(nodeId).chat` inside `DraftCanvas` Agent popovers. Today it only shows
  `runNodeView(...).activity` and says messaging is unavailable. `apps/web/src/features/conversations/*`
  (composer, history, draft store) exist but are not mounted — reuse them, do not add a second chat UI.
- Existing native chat: Operator chat (`apps/api/src/modules/conversations/operatorChat*.ts`,
  `routes/operatorChat.ts`, web `features/operator-chat`). It already owns native session creation,
  durable request receipts (`operator_conversation_turns`), messages, public activity, SSE events,
  cancel, approval responses and restart reconciliation. Agent chat reuses these services/tables.
- Native port: `apps/api/src/modules/harnesses/port.ts` `NativeHarnessSessionManager`
  (createSession/attachSession/startTurn/cancel/history/reconcile/respond/close). No steer/fork yet.
- Workflow executions: `harness_executions` (+ `nativeSessionId`), `native_session_lanes`. Chat must not
  write these rows, Run records, run graph, checkpoints or accepted stage results.
- Installed natives: the API runs the repository-pinned `@openai/codex` **0.154.0** (`apps/api/package.json`,
  resolved by `harnessBinaries`); a global `codex-cli 0.157.1` also exists but is not what the app launches.
  OpenCode is the global `opencode 1.18.31`. Both Codex versions expose the same `turn/steer`/`thread/fork` shapes.
  - Codex app-server schema (`codex app-server generate-json-schema`): `thread/start`, `thread/resume`,
    `thread/fork`, `thread/read`, `thread/turns/list`, `turn/start`, `turn/steer`
    (`{threadId, input, expectedTurnId, clientUserMessageId?}` → `{turnId}`; fails when the active turn
    differs), `turn/interrupt`, notifications `turn/started`, `turn/completed`, `item/*`.
  - OpenCode server OpenAPI (`/doc`): `POST /session`, `GET /session/{id}`, `POST /session/{id}/message`,
    `POST /session/{id}/prompt_async`, `POST /session/{id}/abort`, `POST /session/{id}/fork`,
    `GET /session/status`, `POST /session/{id}/permissions/{permissionID}`. No expected-turn steer
    precondition. Busy-session `prompt_async` ordering/consumption is NOT yet qualified.
- In-flight overlap: Skills PR #49 (`feat/skills-v1`, worktree `graphql-worktrees/skills`) edits
  `codexAppServer.ts`, `opencodeServer.ts`, `migrations.ts` (migration 267201) and contracts index for
  pinned instruction delivery. Keep edits in those files small and additive; the terminal reconciles.
- Baseline on 9cc0252: `tsc --noEmit` already fails in 4 contracts test errors
  (`approvalTopology.test.ts`) and 260 API test-file errors (wr4/wave25/nim2644 integration tests).
  Do not count these as regressions; do not add new ones.

## Contract (terminal-owned, frozen)

`packages/contracts/src/agentChat.ts` (`@graphql/contracts/agent-chat`), fixtures in
`agentChatFixtures.ts`, new actions `agent_chat:read|write|cancel|respond` in `management/index.ts`.
Lane changes to these files must be listed as overlap with preimage/result hashes and a reason.

HTTP (all under `/api/workspaces/:workspaceId/agent-chat`, existing browser/MCP auth):

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `` | `AgentChatQuerySchema` | `AgentChatStateSchema` |
| POST | `/messages` | `SendAgentChatMessageRequestSchema` | `SendAgentChatMessageResponseSchema` |
| POST | `/conversations/:id/interrupt` | `InterruptAgentChatRequestSchema` | `AgentChatStateResponseSchema` |
| POST | `/conversations/:id/turns/:turnRequestId/cancel` | `CancelQueuedAgentChatTurnRequestSchema` | `AgentChatStateResponseSchema` |
| POST | `/conversations/:id/responses` | `RespondAgentChatInteractionRequestSchema` | `AgentChatStateResponseSchema` |
| GET | `/conversations/:id/history` | `before`, `limit` | `AgentChatHistoryPageSchema` |
| GET | `/conversations/:id/events` | SSE | `AgentChatStreamEventSchema` (first `snapshot`) |

Errors use the existing `DomainError` JSON shape. `409` codes: `AGENT_CHAT_CONTEXT_STALE`
(expectedConversationId mismatch), `AGENT_CHAT_TURN_NOT_ACTIVE` (steer/interrupt target ended),
`AGENT_CHAT_REQUEST_CONFLICT` (same requestId, different input). `403` for denied callers.

## Semantics

1. **Identity.** One open conversation per (workspace, workflow, node, agent, runId|none). Selecting a
   different Agent or Run reads a different conversation; nothing leaks between keys. Conversation id,
   native session id, request/turn id, native turn id, execution id and Run id are never reused for
   each other.
2. **First message** (`expectedConversationId: null`). Persist conversation + receipt + user message
   first, then create exactly one native session and start the turn. Retrying the same requestId never
   creates a second session.
   - No `runId`: fresh session from the Agent's current accepted configuration and the workspace execution
     location used for Runs.
   - `runId` of a terminal Run whose execution for this node has a native session: native fork
     (Codex `thread/fork`, OpenCode `POST /session/{id}/fork`); origin `run_execution`. The Run, its
     execution rows and the source native history are never modified.
   - Selected Run not terminal: blocked `run_active` (chat read-only; Run activity still shows).
   - Fork impossible/storage missing: blocked `native_session_missing` with an honest message. No fresh
     session is silently substituted.
3. **Follow-up after completion**: `next_turn` on an idle conversation starts a new turn in the SAME native
   session (Codex `turn/start` on the thread, resuming it first after process restart; OpenCode prompt on
   the same session id).
4. **Next-turn queue**: `next_turn` while active → receipt `queued` (FIFO by `sequence`), submitted
   automatically once the active turn is terminal. A queued turn can be canceled until it starts.
5. **Steer**: only while a turn is active and `capabilities.steer !== "unavailable"`. Codex uses
   `turn/steer` with `expectedTurnId = expectedNativeTurnId`; mismatch/ended → 409
   `AGENT_CHAT_TURN_NOT_ACTIVE`, no side effect, UI offers "send as next turn". OpenCode is
   `cooperative_next_step` only if qualified on 1.18.31; otherwise `unavailable` with a reason.
6. **Interrupt-and-send**: persist intent, interrupt the active turn, wait for native terminal
   settlement, then submit the new input exactly once as a new turn (ahead of queued turns). If the turn
   already ended, submit normally. Plain **interrupt** cancels the active turn and every queued turn.
7. **Delivery**: `queued → submitting → accepted → completed | failed | canceled`; `unknown` when
   acceptance cannot be proven (lost ack, crash). `unknown` is reconciled from native history using the
   client correlation id; never auto-resent. Acknowledgement ≠ consumption.
8. **Restart/reconnect**: native processes are owned by the API service, not UI connections. After API
   restart a conversation resumes the exact stored native session; in-flight submissions become
   `unknown` until reconciled. UI reconnect = GET state + SSE `snapshot`.
9. **Startup instructions/skills**: resolved from the conversation's pinned accepted configuration and
   applied once at session creation (or inherited by fork). Resume/follow-up never re-sends them in the
   transcript. Reuse the existing/Skills-PR instruction path; do not create a new one.
10. **Approvals**: pending native interaction → `waiting_approval`, reply via `/responses` using the
    existing native reply routing and scope checks.
11. **Authority**: chat turns run with the Agent's accepted permission/sandbox configuration. They never
    reopen, restart, advance or overwrite a Run, stage result or graph.
12. **MCP parity** (AGENTS.md): Operator MCP tools `agent_chat_read`, `agent_chat_send`,
    `agent_chat_interrupt`, `agent_chat_cancel_queued`, `agent_chat_respond` on the same services and
    `agent_chat:*` actions, with capability discovery, a denied-caller test and persisted readback.
13. **Attachments**: current chat has none; FEAT-15 is text only.

## Ownership

- Terminal: this doc, `packages/contracts/src/agentChat*.ts`, `packages/contracts/package.json`,
  `packages/contracts/src/management/index.ts`, integration, PRs, final tests.
- Lane A (NIM-2683): `apps/api/**` (harness adapters, conversations module, routes, MCP tools, access
  mapping, one additive migration — version `268201`, appended at the end of the list), API tests,
  `docs/` notes for backend limits.
- Lane B (NIM-2684): `apps/web/**` (mount chat in `AgentChatPanel`, reuse `features/conversations`,
  client in `shared/api/agentChat.ts`, MSW handlers from the shared fixtures, hooks, CSS, web tests).
- Neither lane edits the other's tree except a necessary, declared overlap.

## Baseline commands

```sh
corepack pnpm install
corepack pnpm --filter @graphql/contracts build
corepack pnpm lint && corepack pnpm test && corepack pnpm build
corepack pnpm db:up && corepack pnpm test:integration && corepack pnpm test:acceptance && corepack pnpm db:down
```
