# Native subagent delivery status

This document describes the PR 57 continuation. Native observations, transport fixture tests, and live qualification are different evidence. No fixture result qualifies a provider or enables a production capability.

## Implemented local behavior

- The selected saved Run Board mounts its child overlay inside its own React Flow provider. Child selection is URL-owned. Changing Runs clears only the child fragment selection; browser history can restore the original Run and child. Unrelated URL state is retained.
- Roster permission loss removes both cached circles and the open child panel. The shared dialog supplies Escape, backdrop and focus behavior. Saved-graph keyboard guards do not block editing the child input textarea.
- Production resolves child controls through the original resident execution allocation. Run, workspace, execution attempt, agent, configured instance and accepted placement identity are checked. A replacement Run owner invalidates previously captured leases even if it retains the same manager.
- Durable command retries never dispatch again. Uncertain receipts may be reconciled only by exact correlation readback under the original generation. SQL ownership locks are not held over native readback. Reconciliation is audited; missing evidence remains uncertain. Positive pre-acceptance refusal is stored as rejected.
- Background recovery failures produce bounded identity/code diagnostics without logging native prompt content. Failed tasks are drained without unhandled rejections, and later reads may retry recovery.

## Provider gates

| Provider and mode | Repository evidence | Production limit |
| --- | --- | --- |
| Codex multi-agent v2 | Qualified installation schemas expose thread-addressed start, steer, interrupt and resume | Active input and interruption require a captured child turn. Idle continuation preserves the child settings. All controls require the resident admitted owner. |
| Codex legacy collab | Uses the same thread and turn control methods | The same child ancestry, operation qualification and permission checks apply. |
| Claude Agent | SDK pinned at 0.3.284; existing owned-profile child-history reader | Direct child input is unsupported. No session-wide interrupt is substituted for exact task interruption. Live CLI identity and child operations still require qualification. |

The SDK package version is not proof of the running server's version. Persisted capability observations remain `qualification: unverified`. Reads expose qualified Codex controls only from the live admitted manager and its measured protocol schemas. Saved flags cannot confer a controller or bypass ownership checks. Transport fixtures exercise those schemas but do not qualify an installed provider.

## Codex child controls

The pinned 0.154.0 protocol exposes `TurnSteerParams` with `threadId` and
`expectedTurnId`, and `TurnInterruptParams` with `threadId` and `turnId`.
`TurnStartParams` accepts a target `threadId` and `clientUserMessageId`;
`ThreadResumeParams` accepts a target `threadId`. These definitions are tracked
in the unchanged upstream schema bundle used by transport regression tests.

The controller addresses the child's native thread on the admitted parent's
resident transport. Before sending, it reads the child's source and each
ancestor until the admitted root, checks the immediate parent, and checks the
latest child turn. Resume and continuation omit configuration overrides so the
child retains its sandbox, model and instructions. No parent turn is sent or
interrupted. Native callbacks remain subject to the existing permission policy.

HTTP and Operator MCP use the same command service, scoped grants, revision
checks, persisted receipts and audit records. Retries read the existing receipt.
Input recovery matches `userMessage.clientId`, independently of the native item
ID; interruption recovery requires the addressed turn's interrupted status.
Uncertain native outcomes do not cause another submission. Main recovery keeps
that receipt while a resident manager supplies native readback. The UI exposes
Send and Interrupt only when the corresponding operation is qualified and
currently available to the caller.

## Remaining acceptance gates

1. Coordinate with the concurrent multi-computer/CI owner before editing remote-worker contracts, proxy, host or installed transport. The existing remote proxy does not yet carry child history or child control operations.
2. Prove cold restart/reconnection against the exact original parent and owning computer. The current production readback requires a resident admitted manager. Never create a replacement parent, resume a child prompt, or route remote work to Main as a recovery shortcut.
3. Run exact-provider live qualification. Authenticated HTTP/MCP tests using synthetic native leases prove application authorization and receipt behavior, not live provider support.
4. Complete real browser acceptance on the user's computer once connected, including nested children, paging, denied callers, supported control delivery and restart recovery.
5. Retain baseline failures separately from regressions. Do not weaken native process, filesystem, authorization or qualification checks to make this environment green.

The PR remains a draft and must not be merged as fully qualified while these gates remain open. Current execution logs and the restart handoff are maintained in the project's GraphQL Delivery Handoff Space.
