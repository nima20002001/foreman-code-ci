# Agent chat G4: readback, legacy overflow and unknown activity

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Backend patch base: `277113c4452f9be8712a0469104cb9d5e0346368`.
Scope: A2-PF-09, pre-existing receipt overflow, T-09, and a partial A-R01 classification improvement.

## MCP message and receipt readback

`agent_chat_read` keeps its name, `agent_chat:read` grant, and ordinary flat state response.
It accepts two optional fields in addition to `workspaceId` and the existing Agent selection `query`:

```json
{
  "workspaceId": "workspace-id",
  "query": { "workflowId": "workflow-id", "workflowNodeId": "node-id", "agentId": "agent-id" },
  "history": { "limit": 50 },
  "receipts": { "limit": 50 }
}
```

The returned state includes `history` and/or `receipts` only when requested and a conversation exists.
Both pages carry `conversationId` and `nextCursor`. `history.messages` contains complete persisted
messages; `receipts.turns` contains retained delivery receipts, including terminal receipts.
The initial page is the newest page; entries within each page are oldest-first. To load earlier
entries, put that page's `nextCursor` into its own request field's `before` property. Prepend those
entries and continue until the cursor is null. Do not mix message and receipt cursors.
Cursors are decimal PostgreSQL bigint strings; never convert them to JavaScript numbers.
Limits are integers from 1 through 100, defaulting to 50.

Message readback uses the existing HTTP history service and byte budget, including its one-complete-
oversized-message exception for cursor progress. It does not put oversized content back into SSE.
Large MCP values remain complete in `structuredContent`; the existing shared tool formatter bounds
only its duplicate text mirror. No automatic resend or new native call is involved.

HTTP uses the same authorized services:

- `GET /api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/history?before&limit`
- `GET /api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/turns?before&limit`

Readback authorizes the stored conversation's workspace/workflow/Run scope. Worker/App callers,
revoked/expired callers and mismatched grants gain no new access.

## Recovery of pre-existing excess receipts

The 100-open-receipt admission cap and the default repository overflow exception are unchanged.
The shared chat service explicitly opts into a bounded recovery view instead of making the UI
or MCP state read fail. During overflow, state has `hasMoreTurns: true`, `canSend: false`, and an
explanation in `availability.message`. `turns` is explicitly incomplete; page `receipts` to inspect
all retained identities. The recovery window contains at least one queued cleanup target when
one exists, even if the oldest 100 entries are all unconfirmed.

The existing UI warning and queued-cancel controls can consume this state after rebuilding the
shared contracts. Existing authorized HTTP/MCP cancel-one and Stop controls remain unchanged.
Cancel-one readback succeeds even when the remaining count is still above 100. Stop cancels all
queued messages when available. Neither action treats an unknown delivery as canceled or proves
native settlement. Unknown-only overflow still requires native evidence; there is no destructive
"clear unknown" shortcut, hidden deletion or automatic resend.

Contract additions are limited to the optional `hasMoreTurns` state flag and shared readback/page
schemas. No action, tool name, intent, delivery state, capacity bound or grant is added or relaxed.
Merge this additive contract change into the integrated backend/UI build; the separately pinned
UI contract has a different blob because it lacks the backend's earlier SSE documentation note.
No `apps/web` source is changed by G4.

## Unknown activity and App MCP limits

Abandonment now changes only pending/running activity for an unknown receipt to `unknown` in the
same transaction as the receipt update. It preserves native ownership, cancellation and pending
approval fields. Already-terminal activity stays terminal; repeated abandonment is idempotent for
activity revisions. Recovery also clears stale pending/running activity on already-unavailable
conversations using an exact unknown-receipt join, before native reconciliation is skipped. Later
exact terminal evidence can still complete the retained native owner.

Additional explicit Codex MCP configuration/environment and OpenCode credential-binding errors
are classified as `harness_unavailable`, not missing-session evidence. Generic transport or MCP inspection failures
and an absent optional Codex MCP entry are not included in that permanent classification.

**A-R01 remains functionally unresolved:** enabled App MCP entries are still refused by the
pinned adapters. G4 does not issue App/workflow credentials, silently alter native configuration,
or implement/qualify a per-chat no-App launch override. This classification improvement is not
closure of the original enabled-App startup/attach/fork scenario.

## Tests and integration boundaries

`test/agent-chat-g4.test.ts` adds unit/schema regressions. `test/agent-chat-g4.integration.test.ts`
adds opt-in isolated PostgreSQL and authenticated HTTP/MCP cases, including large message parity,
denials, cancellation while still overflowing, full receipt pagination, and activity rollback via
a failing test-only trigger. Native ports in that suite are deterministic substitutes.

The handoff's isolated source-probe results do not establish Zod/SDK validation, a complete typecheck,
PostgreSQL behavior, mounted UI behavior, native qualification or live-provider acceptance.
Other lanes still own unknown-turn cancellation/reconciliation, permanent queue fences, transaction
lock ordering and disposal/shutdown. Preserve G4's activity update when integrating G2's lock-order
fix in `unknown()`, and preserve the explicit recovery option when integrating repository changes.
