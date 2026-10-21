# Foreman Code MCP: one connection, role-scoped tools

The app serves one MCP server, `foreman-code`, at `POST /mcp`. Operator chat and
workflow agents use the same native harness entry and the same credential
variable, `FOREMAN_CODE_MCP_TOKEN`. The bearer credential decides the caller's role:

| Credential | Role | Can call |
| --- | --- | --- |
| Operator (root or chat-delegated) | Operator | Management tools, filtered by its grants, plus `interaction_list`/`interaction_get` |
| Worker, bound Agent's pinned `productRole` is `orchestrator` | Orchestrator | `context_get`, `interaction_list`, `interaction_get`, `interaction_respond` |
| Worker, any other `productRole` | Coder | `context_get`, `interaction_list`, `interaction_get` |

Each role lists only its own tools. A direct call to a tool outside the
caller's role returns `ROLE_NOT_ALLOWED` with the allowed roles and records a
denial audit; it never reaches the owning service. The server's `instructions`
tell the model its role. `context_get` returns `role` and `tools`.

MCP tool inputs ignore unknown fields, including fields inside typed nested
objects. They are stripped before service validation and command identity, so
extra fields do not change saved data or idempotent retries. Declared fields
still require valid values; open record/map payloads retain their keys. Output,
HTTP and persisted schemas retain their existing validation. Unknown fields
cannot change caller identity, grants, scope or read-only access.

### Per-Agent tools

Within its role, each Agent can have fewer tools:

- **Agent default** (`graphqlTools` on the Agent configuration, edited in the
  Agent's Advanced settings or with `agent_create`/`agent_update`): the tools
  it gets in every workflow. Absent means every tool its role allows.
- **Workflow node** (`graphqlTools: { add, remove }` on the node): turns tools
  on or off for that Agent in that workflow only.

Enabled = (Agent default) + node `add` − node `remove`, never beyond the role.
A Run pins both through its configuration and workflow version. Tools not
enabled are not listed; a direct call returns `TOOL_NOT_ENABLED`. Operator-only
tools can never be enabled for an Agent: saves naming a tool outside the role
are rejected.

The role is necessary, never sufficient. The caller's own tools are the existing
implementations: Operator grants and scopes, Worker bindings, run scope and the
exact designated-Orchestrator check still apply on every call. A tool the role
may use but the credential cannot (for example a read-only Operator and
`workflow_create`) stays unlisted, as before. The role table lives in
`apps/api/src/mcp/unified/roles.ts`.

## Installing

In Harness Settings → MCP servers, use **Add Foreman Code MCP** for each native
harness. It installs the managed stdio launcher
(`~/.local/share/graphql/mcp/launcher.mjs`) with automatic instance routing.
Existing installs of the retired `graphql-app` and `graphql-operator` entries
show **Upgrade to Foreman Code MCP**; the upgrade writes `foreman-code` and removes both
retired entries in one native write. **Repair Foreman Code MCP** converts a
standard fixed `/mcp` entry to the launcher and keeps its disabled state and
tool/approval policies. Custom and inherited entries must be changed at their
native source.

The Operator can discover, apply, and read back the `graphql` preset (its stable serialized name) through
`harness_mcp_servers_list` → `harness_mcp_managed_request` →
`harness_mcp_change_get`, then list the persisted connections again. With the normal
`harnesses:read` and `harnesses:update` grants, the request applies the native change
directly, including for delegated Operator credentials. An uncertain result uses
`harness_mcp_change_reconcile`; it must not be resubmitted as a new write. Local
programs must already be installed. Provider API-key provisioning remains local-human-only;
credentials must not be placed in MCP arguments. Operator chat setup
and workflow credential preflight both recognize either the enabled `foreman-code` or supported `graphql` entry.

For paired computers, the Operator can read the connection with
`device_connection_read`, configure it with `device_connection_configure` using
global `settings:update`, and verify readiness with `device_connection_check`.
Pairing authorizes direct connection changes; no separate human approval is required.
This does not install the companion, SSH, rsync or Tailscale, sign in to accounts,
enable SSH/VPN, or grant sudo or Agent execution access. Local installation and
credential entry remain separate setup steps. Read-only callers and callers
without the required grants or scope remain denied.

## Routing

The app registers its endpoint under a SHA-256 digest of each issued
credential: root Operator credentials and active Worker bindings at startup and
reconciliation, Worker credentials after issuance and lease renewal, and
Operator chat credentials for the conversation's lifetime. The launcher reads
`FOREMAN_CODE_MCP_TOKEN` or its supported `GRAPHQL_MCP_TOKEN` alias, looks up that digest and forwards to the owning app's
loopback `/mcp`. It never scans ports or falls back to another instance. Route
files hold an endpoint, runtime PID and expiry, never a token, and are
owner-only. Restarting on another port refreshes routes without changing native
configuration. Owner Operator credentials default to no expiry (reported as
`9999-12-31T23:59:59.999Z`); explicitly finite tokens still expire. Accepted
Runs continue after starter-token expiry and still honor owner revocation and
current scopes. A revoked or expired credential stays denied even if a route file
survives an interrupted shutdown.

Verification: `graphql-mcp-roles.test.ts` covers each role's tool list and
`ROLE_NOT_ALLOWED` for each role; `graphql-mcp-launcher.integration.test.ts`
routes two real instances through the launcher, including a port change.
