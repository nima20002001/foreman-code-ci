# Claude SDK candidate boundary

This implementation uses official streaming `query()` through an injected runner.
Allocation performs no I/O. Production must use `createOfficialClaudeSdkRunner`
with an explicit hash-qualified `binary` and the **same** write-ahead `NativeProcessRecovery` object admitted by the
common factory. It records every child synchronously through `spawnNativeProcess`
and joins `stopRecoveredChild` on close. Query closure, subscriber closure,
exact cancellation, durable settlement and positive process closure remain
separate operations. An SDK iterator finishing is not process-closure proof.

The initial candidate is exactly SDK **0.3.284**, published at
**2026-09-28T17:15:09.221Z**, with CLI **2.1.284**. Registry integrity is
`sha512-NSoJwEq6nFSf8dtaacYx37QdGgqApI3eHFUlxclMLYi8irb6ZJwEaUnPnLUCyAyg9W/tMkgZC0GXWLRCc01I0w==`.
The installed package version is checked when loading the official adapter.
The lockfile and host qualification independently bind package integrity,
resolved executable bytes, profile and configuration revision. A release-note
parity statement is not native qualification.

The October 1 local diagnostic ran with Node 22.23.2, pnpm 11.27.0, Linux x64.
The ordinary PATH executable resolved to CLI **2.1.286**, so ordinary selection
is blocked for the 0.3.284/2.1.284 candidate. An existing versioned 2.1.284
executable was explicitly observed as 2.1.284 with SHA-256
`5cd90aabd83f8a15136c35aa37bb1d92b348993573316643dc3fe4e04afbf88f`,
without changing PATH or installation. The runner supplies the selected binary
through `pathToClaudeCodeExecutable`; it cannot silently use an SDK-bundled CLI.
Neither filesystem inventory nor the owned `--version` probe reads credentials,
runs a model prompt or establishes authentication. No native model/authentication
qualification is claimed by these fixtures.

Client prompt UUIDs remain client identities when offered to the bounded queue.
Only an actual SDK `user_message_uuid` / `user_message_uuids` echo can establish
native consumption. The submitted native **input message** receipt is stored
separately from the native session, native output frame/API message, application
correlation and native turn. `onMessageSubmitted` persistence finishes before the
matching output is exposed. `onSubmitted(nativeTurnId)` is not called because
this candidate does not expose a proven native turn ID. A result without the
exact input echo cannot terminalize the newer application request; native wake
frames are never assigned by queue order. Result evidence survives a later
iterator exception; EOF alone stays uncertain.

Native history helpers use the SDK process's profile. They fail if asked to use
a different profile rather than changing process-global environment or copying
authentication homes. Resume names the exact saved session/device/profile/cwd;
missing history never creates a replacement. Fork calls the official helper and
returns a distinct session, preserving its source. Native transcripts are not
filesystem snapshots. Cold restart does not recreate process-local approval
callbacks or justify resending possibly admitted prompts.

Exact-turn steering/cancellation, background-preserving restart detach,
child control/streaming, alternate-profile history helpers and unattended
background continuation remain unavailable. `closeForRestart` explicitly
rejects: `query.close()` terminates native work. Permission/question/file bridges
require their separate authority and native qualification gates. Server file/MCP
authorization is distinct from native sandbox enforcement.

Focused deterministic command (no native CLI or credentials):

```sh
corepack pnpm --filter @foreman-code/api exec vitest run src/modules/harnesses/claudeSdk/runner.test.ts src/modules/harnesses/claudeSdk/sessionManager.test.ts src/modules/harnesses/claudeSdk/discovery.test.ts --maxWorkers=1
```

Live SDK/model qualification is performed by the terminal owner through the
production factory and existing admitted services. It is deliberately not an
automatic test or a fabricated successful fixture. It must prove authenticated
first/second turns, exact message receipts, idle/active/approval cleanup,
result-then-throw, queued wakes, exact resume/fork/history, independent owners,
callback races and HTTP/applicable-MCP persisted readback before enabling each
capability. A standalone SDK probe cannot prove GraphQL admission.

Primary source references:

- [Pinned SDK release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.284)
- [Official streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Official session resume and fork](https://code.claude.com/docs/en/agent-sdk/sessions)

## App settings and MCP setup

Claude presets are explicit configuration templates. In Settings → Harnesses →
Claude, choose the host-local profile directory, model, authentication and sandbox.
The optional **Include Foreman Code MCP** action copies this API's HTTP endpoint into
the preset. **MCP connections** can add/remove the app HTTP connection, and
**Tool permissions** can enable exact tool names and approval rules. External
MCP servers are rejected when saving because only the app connection has an
accepted tool manifest. Stored configurations remain readable for correction.
New tools default to app-routed `ask`. Adding a connection grants no tools.
Native login files and ambient CLI MCP configuration are not modified or imported.
Only future configurations copy preset edits; existing Agent/WorkflowVersion/Run
pins retain their exact values.

`claude_setup_options_get` and its authenticated HTTP equivalent read the owning
API endpoint. `harness_defaults_update` and `harness_instance_save` preserve their
existing permissions, idempotency and audit contracts. `expectedRevision` is optional: omission applies the last write; a supplied stale revision rejects the save. Preset saves
validate configuration but cannot themselves produce native qualification.
Installed subscription metadata is discovered through an owned zero-input SDK
control query. Missing model selections initialize from the native recommended
canonical model with advertised medium effort; explicit model, effort and access
choices remain authoritative. Native discovery preference, installation,
authentication, configuration and execution qualification remain separate facts.
Automatically detected Claude presets retain read-only access and remain
unavailable until the user explicitly selects Full access. Startup never converts
a restricted preset or role default to Full access.
An unchanged incomplete Claude preset can be retained when saving another
provider's defaults. Editing or explicitly selecting Claude still requires
supported access and MCP configuration.
Claude's local rollout switch is
`GRAPHQL_ENABLE_EXPERIMENTAL_CLAUDE_SDK`.

The explicit `harness_instance_check` operation now has a real local Claude
producer. A first Operator Claude default selection reuses an exact qualified
local profile or prepares and checks one through the same revisioned, authenticated
HTTP/MCP services. This requires both harness read and update authority and can
consume subscription capacity. Before any diagnostic input, the producer checks
that the configured profile directory matches the API or Worker process's
`CLAUDE_CONFIG_DIR` (or its default `~/.claude`). Native history and fork helpers
cannot select a different process profile; a mismatch returns
`CLAUDE_PROFILE_DIRECTORY_MISMATCH` with no paid turn.
The producer records real SDK initialization,
first/second turn receipts, two queued inputs and their positive UUID echoes,
idle closure, exact resume/history/source-preserving fork, tool hook allow/deny
on owned disposable Write fixtures, and a transparently injected transport fault
after an actual native result. The background-disable check covers the delivered
disable setting and the observed absence of child/background tools; it does not
claim a separate Bash-background-attempt scenario. Production rejects unexpected
background/deferred frames instead of settling their parent result as success.
It stores the evidence file identity and SHA-256
in the exact host/profile proof; it never supplies synthetic native results.

Claude accepts only Full access (`danger-full-access`). Saving a preset, host
profile or agent in another mode, or starting an existing non-full configuration,
returns a clear validation error. Existing values are not silently upgraded.
Native qualification requires Write and proves an allowed owned write plus an
always-applied hook denial; application grants and approval routing still apply.
Changed policy requires a fresh `claude-profile-check-v3` check. Earlier native
profile evidence cannot enable execution. Unsupported sandbox checks remain
historical evidence and do not acquire capabilities from metadata.
The broader four-owner-path, callback race, publication and restart
qualification below remains separate from this bounded default-chat path.
An installed and signed-in PATH CLI does not satisfy native proof or substitute
for the application's exact SDK executable pin. Scoped Foreman Code MCP HTTP credentials are
delivered only by the existing admitted execution owner, never stored in the
preset. [Official MCP configuration](https://code.claude.com/docs/en/agent-sdk/mcp)
describes direct `mcpServers` configuration, HTTP transport and exact tool names.

## Required production proof and remaining gates

The root-owned **zero-input initialization probe** on
source `26c0517` / SDK 0.3.284 / explicit CLI 2.1.284 confirmed: control
initialization answered and settled, but no session field or streamed `system/init`
arrived before input. It offered zero messages, saw zero turn frames, and joined
output with positive owned process closure. This is actual recorded startup
evidence; neither an account object nor these results prove model readiness. The root
probe must record zero offered user messages, unexpected model/turn frames,
strict MCP/settings isolation, bounded startup/idle cleanup and positive owned
process closure. An account object does not prove authenticated/model readiness.

The separate create/start service ordering must therefore change for new Claude
sessions. The provider implements optional `startInitialTurn`; the shared services
must mount that atomic lifecycle:
accepted application owner/request -> same write-ahead process scope -> one SDK
input offer -> persist the **observed** native session -> persist the observed
input-message receipt -> expose events. A callback can await that persistence
barrier; it cannot mint a native ID or file credential to satisfy startup.
Interrupted/unknown initialization remains fenced, never a new create/replay.
The provider fixtures exercise this order. Root/HRT-C shared service mounting
and real four-path admission/readback remain mandatory gates. Waiting longer for
a pre-input native SID would repeat the observed deadlock.

| Gate | Required evidence | Current implementation/fixture boundary |
| --- | --- | --- |
| A01 | Missing/changed CLI, signed-out/expired/wrong profile blocked before model effects | Filesystem/version cases and native init CLI/cwd validation; live auth gate remains root-owned |
| A02 | First/second actual app turns across all four owner paths with persisted native receipts | Observed message callback and isolated reusable session fixtures; no native model pass claimed |
| A03/A07 | Pre-init/input/idle/approval/active close, repeated dispose and positive child containment closure | Owned SDK spawn/abort/join, callback cleanup owner, bounded queues and subscriber-detach fixtures; live SDK cleanup still required |
| A04 | Exact error result then throw, malformed/future result and EOF uncertainty | Authoritative known result retained; malformed/EOF never terminalize |
| A05 | Exact host/profile/session resume, unavailable history, independent owners and source-preserving native fork | SDK helper ports with bounded history pages and explicit profile check; real fork/history recall and source hashes still required |
| A06 | Lost ACK/crash/late previous generation reconciled without duplicate native prompts | Stable **client** UUID plus exact native user-history receipt lookup; native transcript assistant completion never substitutes for an SDK result |
| A08/A10 | Queued native wake/result-only echo and parent result with deferred/background continuation | Exact echo/message/tool provenance, unowned late children, background/deferred fences; no automatic continuation |
| A09 | Exact current SDK callback and session-close race; database row after restart gives no callback | Read-only live-map inspector checks session/request/message/generation and qualification; stale/missing callback unavailable |

For each workflow execution, Operator chat, Agent chat and selected-Run
continuation, the release gate remains:

`authenticated admission -> exact owner/configuration -> real shared production factory -> qualified SDK effects -> persisted receipt/activity/interaction/publication -> authorized HTTP/applicable MCP readback -> cold API restart/readback`.

Record native-effect counts and unchanged selected historical Run facts. Include
denied principals with zero native effects, two independent owners in one cwd,
repeated reconciliation without receipt revision changes, stale callback
responses, missing native history, fork source preservation and publication
adoption before completion. Native history lacking an authoritative result leaves
accepted work uncertain; it does not make a prompt safe to repeat. No fixture or
standalone SDK probe closes the production/readback or owner-approval gates.


One user-authorized external checker ran with actual model
`claude-haiku-4-5-20251001` (canonical `claude-haiku-4-5`) and Read/Glob/Grep only.
Requested low effort is unsupported for Haiku 4.5; no effort flag was applied.
It read recorded evidence/source and performed no native/model/DB probe. Its
assessment identified the absent pre-input session, but its recommendation to
make runner.open wait for that ID would retain the deadlock and was rejected.
Actual recorded result was non-error, estimated cost USD 0.0617513, checker exit
SIGKILL, timeout false, positive owned closure true. The root probe facts, not
checker prose, determine the lifecycle correction.

Pre-input inspection now reads the actual SDK `initializationResult` and
`mcpServerStatus` controls on the same reserved query retained for initial input.
`prepareInspection(start)` requires the exact admitted owner/configuration/cwd;
it never invents a session ID. Configuration and connected-health evidence remain
separate. After scoped management credentials are issued,
`refreshInspectionCredentials` uses actual SDK `setMcpServers`, validates its
acknowledgment, then reads actual status again. Server names, endpoints, commands,
arguments, unrelated servers and noncredential environment cannot change. The
spawned process environment is not mutated. Owners with `appMcpAccess:none` may
not receive a management credential. Failed/pending/auth-required SDK status is
reported honestly; saved configuration is never labeled connected.

Callback authority is captured on each accepted input and looked up only against
its positively observed session/message/correlation/generation. Reusable SDK
callbacks no longer capture first-turn principal/attempt constants. Actual B map
pending notifications wake the exact owned iterator without another SDK frame;
complete pending snapshots, including response-in-flight entries, join history
and reconciliation. This is callback availability/publication, not a native
response-delivery acknowledgment or restartable callback proof.
