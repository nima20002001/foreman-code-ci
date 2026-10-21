# H2 — Agent chat without Foreman Code App MCP authority

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

This A-R01 follow-up supersedes the F3 requirement to manually remove or disable
the native Foreman Code App MCP entry before using Agent chat. The accepted Agent
configuration and native configuration files are not rewritten.

## Native session boundary

Codex chat uses its own app-server process. A configured Foreman Code App MCP entry
gets a process-local `-c mcp_servers.graphql.enabled=false` override before
startup, plus the same override on thread start/resume/fork. The launched
process's `config/read` must confirm the entry is disabled before any thread
operation. An installation without the entry is checked without inventing a
transport-less MCP server. Reopening a retained session repeats the launch check.
The accepted MCP policies are still checked against native configuration; the
chat exception does not discard the Agent's other policies.

OpenCode chat uses its own ManagedOpenCodeServer. Its inline runtime config
sets only `mcp.graphql.enabled=false`, retaining other inline settings and
letting OpenCode merge the other native configuration layers normally. Before
publishing a ready generation, `/config` and `/mcp` must show the entry disabled
or absent. The manager rechecks this for the addressed directory before session
setup and MCP control application, including recovery after restart. Its saved
Foreman Code enabled switch is retained in the accepted snapshot but is never used
to reconnect Foreman Code in chat. Other accepted MCP switches are still applied and
verified. No post-launch Foreman Code connect/disconnect or config write substitutes
for the launch-time exclusion.

Both paths reject injected App/worker environment credentials. OpenCode also
rejects borrowing a managed server without the chat launch policy or renewing a
chat process with scoped credentials. Ordinary workflow/Operator factories keep
their original scoped launch behavior; only the Agent-chat production factory
opts into the new OpenCode process policy.

## User-visible facts and failure handling

Unblocked chat state retains `canSend: true` and states that Foreman Code workflow
tools are not available in chat. Existing blocked-state reasons take precedence.
No frozen contract schema was changed. A failed isolation check remains an
honest harness-unavailable refusal, rather than permission to expose workflow
tools. No harness is categorically refused merely because the accepted Foreman Code
entry is enabled.

This change does not clear previously persisted unavailable/uncertain-session
fences or change session-creation delivery classification. H1 owns the definite
first-session-rejection work; unknown creation must retain its existing fence.

## Regression coverage and verification limits

`agent-chat-h2-native.test.ts` exercises actual adapters/transports with in-memory
process and HTTP fixtures: fresh creation, cold attachment, Run-source fork,
ignored overrides, restart, unrelated MCP controls, source preservation, and
unchanged ordinary workflow credential behavior. `agent-chat-h2-state.test.ts`
checks the existing availability contract and blocked-state precedence. The F3
Codex refusal cases now target injected credentials; zero native transport and
unchanged-input assertions remain in place. Positive enabled-entry behavior is
covered separately in H2, not by weakening those security assertions.

The H2 handoff records an offline substituted-dependency run of these new tests,
not a repository Vitest, Zod/native-schema, full typecheck, lint, PostgreSQL,
application, or real-native qualification run. Run the repository suites and
pinned-native acceptance in the terminal environment before declaring native
qualification complete.
