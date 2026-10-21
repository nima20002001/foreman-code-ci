# Claude file MCP producer

`createClaudeFileMcpServer` creates an actual SDK-hosted MCP server using the
installed official Claude Agent SDK 0.3.284 `createSdkMcpServer` and `tool` APIs.
Pass its `server` as the `graphql-files` entry in the admitted query's
`mcpServers`; dispose `close()` with that native owner. Allocation is synchronous
and issues no credential. Call it only after profile/lifetime admission.

The common factory supplies the actual `AgentFileToolService`, a
`ClaudeFileAdmission` backed by the owner's existing accepted submission,
`createClaudeFileCallResolver({ manager, signal })`, and the accepted harness
`allowMutation` flag. `manager` returns the current admitted Claude manager and
`signal` belongs to its admitted lifetime. The
resolver must obtain the exact observed native message ACK, session, principal,
client correlation, attempt, generation, and tool-use identity from trusted
provider evidence. Tool arguments cannot provide identity. Children are denied.
The existing Claude bridge and file domain service authorize every effect using
the current owner/grants and conversation lineage; no administrator write port,
new credential store, or app MCP grant is involved.

## Pinned provider evidence boundary

The installed SDK `sdk.d.ts` declares the tool handler as `(args, extra: unknown)`.
`SDKControlMcpMessageRequest` declares only `subtype`, `server_name`, and the
JSON-RPC `message`. The installed `sdk.mjs` `mcp_message` branch forwards that
message to the registered SDK transport. The installed CLI 2.1.284 MCP wrapper
stamps `_meta['claudecode/toolUseId']` after spreading caller metadata in
`/home/user/.local/share/claude/versions/2.1.284` (binary
byte offsets 231461709 and 231782413), then forwards that metadata to `callTool`.
SDK `sdk.mjs` `_onrequest` (character offset 609552) copies `params._meta` into
handler extra. The standard MCP `RequestHandlerExtra` declares `_meta` and
`signal`; the resolver runtime-checks both because the Claude SDK declaration
uses `unknown`.

The provider-written tool ID resolves only through the manager's unique live,
ACK-observed root owner map and captured callback authority. After the wait,
the resolver rechecks the exact session/message/correlation/generation mapping
and lifetime. Child, unknown, ambiguous, terminal, stale, closed or canceled
contexts cannot issue a credential. MCP request IDs and transport session IDs
are never treated as native IDs; a last callback or locally planned UUID cannot
replace evidence. Missing metadata fails closed. This module does not claim a
live production qualification; the pinned source route is tested with local
SDK transport and domain fixtures.

Focused verification uses the actual SDK server and MCP transport with the
existing in-memory file-domain service fixture. It covers bounded pinned reads,
Run provenance recording, live principal revocation/write denial, conversation
isolation, read-only discovery, missing ACK and child rejection.
