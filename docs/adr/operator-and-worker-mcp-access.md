# ADR: Operator and Worker MCP access

- Status: Accepted; Operator MCP v1 and App MCP v1 implemented
- Date: 2026-09-15
- Scope: NIM-2579 through NIM-2587

> **Amended 2026-09-27:** the two endpoints were unified into one `graphql` MCP
> server at `/mcp` with role-scoped tools and one credential variable,
> `FOREMAN_CODE_MCP_TOKEN`. Audiences, grants and bindings are unchanged; the role is
> resolved from the credential. See [`../graphql-mcp.md`](../graphql-mcp.md). The
> sections below record the original decision.

> **Amended 2026-10-08:** only Codex and Claude are supported. OpenCode setup
> below records the original decision and is retired; it is not a supported
> configuration path. Saved historical facts remain readable.

## Decision

The API process owns two logically separate MCP domains:

- `/mcp/operator` is the authenticated product-management interface delivered by this wave.
- `/mcp/tools` is the authenticated App MCP for board Agents. Its V1 catalog is
  `context_get`, `interaction_list`, `interaction_get`, and conditionally
  `interaction_respond` for the exact designated Orchestrator.

Both domains may reuse transport helpers, deterministic authorization, audit infrastructure, and application services. They have separate registries and credential audiences. Splitting endpoints is defense in depth; it is not operating-system isolation and does not replace authorization.

Browser HTTP routes and Operator MCP tools call the same application services. Services own authorization, product rules, and transaction coordination; repositories own PostgreSQL persistence; MCP and HTTP handlers only validate, establish caller context, invoke a service, and validate/map the result.

## Authority and grants

Caller identity comes only from a validated credential. A supplied agent ID, role, node, prompt, skill, label, or model-generated confirmation cannot establish identity or grant authority.

Operator, Researcher, Developer, and Reviewer are permission templates or display labels, not runtime authority. Ordinary board agents have no Operator MCP access by default. An owner may explicitly grant a compatible principal access to either or both MCP domains with action and resource scope. A worker-only credential cannot authorize Operator calls.

Authorization is deny-by-default and evaluated for tool discovery, every invocation, every target resource, and each operation in an atomic graph batch. Scope follows authorized workspace, workflow, run, and resource relationships. A principal cannot issue credentials, grant itself privileges, or silently delegate its grants.

Accepted policy references may be pinned for reproducibility, but live expiration, revocation, and narrowed permissions override snapshots. Broader access requires a fresh owner-authorized grant.

## Native harness boundary

Application permissions do not replace Codex/OpenCode sandbox, filesystem, network, or native tool controls. Native harness tools remain available only under those independent controls.

Board-agent MCP delivery uses one static, manually installed provider entry and
a different `FOREMAN_CODE_APP_MCP_TOKEN` value in each owned Agent process. Foreman Code
derives the immutable Agent/workspace/workflow/run subject from the durable
execution, stores only a SHA-256 token digest, expires the credential after 15
minutes, and revokes it when the owning process ends. A resumed/new process gets
a new credential for the same durable subject and does not rewrite config.

Before providing the environment value, Foreman Code inspects the effective config
in the same runner and working directory. The entry must use Streamable HTTP,
the exact expected `/mcp/tools` URL, and the expected environment reference.
Missing, mismatched, failed, or unresolvable config receives no token. Detection
is read-only and never installs, repairs, or rewrites user configuration.

Credentials are never written to CLI arguments, prompts, graph JSON, native
events, generic configuration reads, logs, global process environment, or an
unrelated child process.

## Manual provider setup

The user owns this static configuration. Replace the local port only when the
Foreman Code API is intentionally served elsewhere; the path must remain
`/mcp/tools`.

Codex `config.toml`:

```toml
[mcp_servers.graphql-app]
url = "http://127.0.0.1:3000/mcp/tools"
bearer_token_env_var = "FOREMAN_CODE_APP_MCP_TOKEN"
```

OpenCode configuration:

```json
{
  "mcp": {
    "graphql-app": {
      "type": "remote",
      "url": "http://127.0.0.1:3000/mcp/tools",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:FOREMAN_CODE_APP_MCP_TOKEN}"
      }
    }
  }
}
```

Do not put a literal token in either file. Foreman Code does not automatically add,
repair, or migrate these entries.

## Implemented now versus deferred

Operator MCP v1 implements scoped local Operator credentials, authenticated management tools, shared application services, durable drafts, command receipts, and management audit.

Deferred work includes automatic MCP installation/repair, public OAuth
interoperability, memory, Files, Kanban, browser services, scheduling, remote
runners, and a full Operator chat UI.

## Consequences

Local credentials are intentionally preconfigured and revocable; they are not described as universal OAuth support. Public or remote deployment will require a standards-compliant OAuth resource-server and identity-provider integration.

Management mutations use stable command identities and transactionally stored receipts. Replays reconcile safely, but a receipt is not a claim of exactly-once external side effects. Run Start persists acceptance before asynchronous execution, while Stop reports acceptance separately from confirmed process termination.
