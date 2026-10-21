# Agent chat: F3 native safety and lifecycle

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Applies to the F3 patch against backend `a8c4ebef23733d7d509e5e5ebb13e46f3a731b6a`.
Scope: A-R01, A-R13, A-R16, A-R18 and A-R19 only. This does not resolve the
other receipt, steering, authorization or UI findings being fixed in parallel.

## App MCP: explicit fail-closed behavior (A-R01)

Production Agent-chat managers use `appMcpAccess: 'none'` (the equivalent fifth
constructor argument for Codex). An enabled named App MCP entry is rejected
before opening a chat thread/session or attaching/forking its source. A chat
native environment containing supplied credentials is also rejected. The
Agent's accepted sandbox, permissions and configuration are not rewritten.
The normal workflow and Operator managers retain their existing scoped
credential checks; their default mode is unchanged.

This patch **does not disable or rewrite the owner's native MCP configuration**.
A native configuration with the App entry absent or disabled is needed for a
fresh chat context. With an enabled entry, a new unsubmitted turn fails with
an explicit `harness_unavailable` state instead of an unknown-delivery receipt.
During restart reconciliation, the earlier delivery can still be unknown:
being unable to attach does not prove that the earlier prompt was rejected.

Chat neither issues a Worker credential nor borrows the source execution's
credential or manager. The `agent-chat:<conversationId>` adapter descriptor is
not an actual Run. Existing unavailable conversation records remain blocked;
this lane adds no reset, implicit retry, replacement-session or configuration
mutation API. A separate conversation must remain an explicit user action.

## Missing sessions and ephemeral persistence (A-R13, A-R16)

Availability normalization reads both `error.result.error.code` (Codex) and
`error.code` (OpenCode). A missing stored session or missing Run-fork source
sets `native_session_missing`, disables continuation, and creates no replacement.
OpenCode fork HTTP 404 now retains session-not-found evidence. HTTP 5xx and
uncertain transport outcomes are not turned into permanent session loss.

The existing JSONB conversation record gains optional
`sessionUnavailableReason: 'native_session_missing' | 'harness_unavailable'`.
Older records default to `native_session_missing`. There is no SQL migration
and no public contract/schema change.

Per the terminal decision, `capabilities.resume` describes whether this
conversation can continue **now**, not a promise about a future process restart.
A live exact ephemeral Codex session allows follow-ups. A stored ephemeral
session without its resident owner is unavailable after restart, even when it
has no active receipt. The service does not try to attach or create a replacement
for that cold ephemeral session. The peer UI can consume the existing capability
and availability fields without a new wire shape.

## Native ownership and shutdown (A-R18)

Disposal marks a runtime as retiring, fences further work, and coalesces
concurrent disposal attempts. Both the service and factory retain the manager
until its disposal succeeds. A rejected disposal remains retryable and visible
as unavailable rather than releasing its ownership entry. An unbound manager
without a `dispose` operation cannot claim successful cleanup.

Shutdown closes admission synchronously, aborts the service lifetime, and drains
in-flight commands, pumps, recovery and serialized controls before disposing
managers. Recovery cannot allocate a manager after the barrier closes. Failed
manager disposals cause an `AggregateError`; the existing production shutdown
barrier therefore cannot treat that shutdown as successful or release its
runtime ownership. A subsequent shutdown attempt retries retained owners.

## Run-origin policy (A-R19)

A first Run-origin conversation selects the **most recent executed business
occurrence containing this node**, then the **last technical attempt within
that occurrence**. For a node outside a repeat block, only the technical attempt
orders its executions. Execution-ID traversal order is not a business ordering.

For repeated nodes, the selector validates the immutable occurrence identity
in the execution input against the saved block and the selected workspace,
workflow, Run and WorkflowVersion. It uses the occurrence index before attempt.
The selected attempt must be completed and have a native session and working
directory; it must not fall back to older history when the selected attempt has
no usable native session. This is a last-executed-context policy, **not a claim
that the attempt produced the canonical accepted workflow result**. A completed
failed or canceled attempt can still provide its native conversation context.

The existing origin fields pin `executionId` and `sourceNativeSessionId` when the
conversation is admitted. Readback retains that origin and does not rerank an
existing conversation. Forking uses that exact native source. Runs, executions,
accepted results and their native ownership lanes are read-only to this service.

## Regression coverage and limits

`apps/api/test/agent-chat-f3.test.ts` covers safe pre-submission failure and
readback, permanent/transient missing-session outcomes, live/cold ephemeral
capabilities, disposal retention/retry, recovery/control/admission shutdown
barriers, and repeated-Run selection/fork origin/readback.

`apps/api/test/agent-chat-f3-native.test.ts` covers both adapters' fail-closed
App MCP boundaries, unchanged scoped validation, disabled-entry behavior,
and OpenCode attach/fork 404 versus 503 classification. Its command output,
qualification and native HTTP are fixtures, not real-provider evidence.

The F3 handoff contains the executed offline probe runner and logs. It executes
these tests with parse-through contract schemas and substituted external
boundaries because repository dependencies were unavailable. It is not a
replacement for the pinned Vitest, full typecheck/lint, authenticated
PostgreSQL HTTP/MCP tests or real-native acceptance. No app, database or real
native provider was run by this lane.
