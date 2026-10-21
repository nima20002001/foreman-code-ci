# PR #15 lifecycle corrections

Based on PR #15 at `39b291a8a22d157c2d3f34e86d12a573f612dfae`.
This follow-up retains the accepted Agent, execution, native session and request
identities. It does not replay native prompts to recover missing acknowledgements.

| Finding | Correction and regression coverage |
| --- | --- |
| 1 | Separate `user` credential audience and `/api/user/interactions` list/get/respond routes. The management Run-start path preserves the saved approval policy. Production HTTP and MCP tests exclude Operator and Worker takeover. |
| 2 | Explicit `reviewer` credential purpose is available only to the finalized designated Orchestrator session while its Run remains active. Normal completed executions still cannot receive workflow credentials. Run completion closes idle retained reviewers; active reviews close on settlement. |
| 3 | Workflow results require an exact correlation/provider turn. Reviewer discovery waits for durable workflow finalization, published after result persistence, budget finalization and native cleanup. |
| 4 | Production preflight, attachment and response delivery revalidate the accepted directory identity and accepting principal before native side effects. |
| 5 | Delivery lane queries and release use the transaction's existing connection. Stop command ownership uses a dedicated, scoped connection so runtime cleanup can use the bounded application pool. PostgreSQL tests cover one-slot and saturated three-slot pools, including production Stop during delivery. |
| 6 | Native connection identity and local sequence are distinct from durable ingestion sequence. Existing stored events stay unchanged; conflicting source identities still fail. |
| 7 | An acknowledged native response survives a later history-read failure under valid lane ownership. OpenCode retains qualified response receipts. |
| 8 | Graph acknowledgement recovery checks the checkpoint before activating execution accounting. A completed A can settle its lost outbox acknowledgement while B waits. |
| 9 | OpenCode normalizes persisted message and part history, derives the exact submitted message ID from correlation, and returns only its matching terminal result. |
| 10 | OpenCode observation belongs to the session and continues after the prompt consumer yields approval. Read-only history ingestion fills reconnect gaps without another prompt. |
| 11 | Explicit provider sibling-cancellation evidence cancels durable pending asks. Successful terminal execution also retires remaining pending asks without inventing approvals. |
| 12 | Approval timeout scope is **per execution active time**. Each ensure/observe lifetime owns its deadline; waiting pauses accounting and completed branches cannot time out successors. The legacy non-approval Run timer is unchanged. |
| 13 | Signal handlers precede startup I/O and recovery. Shutdown is idempotent and prevents initialization from continuing after closure. |
| 14 | Reviewer discovery reads durable native-session metadata. It never allocates or qualifies a provider process, including when enqueueing fails. |

Migration 509 adds User authentication, reviewer credential purpose, durable
workflow-session finalization and native ingestion identity. Historical protocol
versions are limited to the two adapters qualified by PR #15; native attachment
still verifies the provider and original session.

Human approval credentials can be issued with the existing CLI:

```sh
# Human approvals use the implicit local human in the loopback app; no User token is issued.
```

Send that credential as a Bearer token to `/api/user/interactions`. Operator
cookies and App credentials cannot authenticate on this surface. Response and
list bodies use the existing shared interaction contracts.

The production lifecycle integration suite uses `buildProductionApp`, real
PostgreSQL credentials/leases/delivery/budgets and LangGraph checkpoints, and
HTTP/MCP. Only native transport is doubled. Its composed scenario completes an
Orchestrator, handles two approvals on one Worker, loses an acknowledgement,
recreates the runtime while another Worker waits, recovers the outbox and
finishes using the original reviewer session. It also exercises User routing,
location/authority revocation and Stop with a one-slot application pool.

Live-provider acceptance remains the existing Codex → OpenCode → Codex workflow;
it is separate from deterministic approval/recovery coverage.

Verification: pinned install, typecheck, lint and production build passed; 633
unit tests passed (one existing skip), 73 PostgreSQL integration tests passed,
and the compiled production-start smoke test passed. Live-provider acceptance
passed on retry; the first native Run failed before the assertion exposed its
durable error, so that assertion now includes the failure result. Database
verification used a separate Compose project and port.

The single independent review (`pr15_fix_review`) identified three additional
corrections, all applied: validate before persisting a decision, clean up idle
retained reviewers at successful Run completion, and persist active-time expiry
as `EXECUTION_ACTIVE_TIMEOUT` failure rather than cancellation. Focused regression
checks cover each correction; no second review pass was run.
