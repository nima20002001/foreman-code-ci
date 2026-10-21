# Real workflow engine and harness qualification

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Qualified on 2026-09-14 from the installed binaries, their live model catalogs,
their help output, and harmless authenticated probes.

## Real product path

The frontend's save, Start, and run-detail calls
use the Fastify API. Saving an executable workflow creates an immutable
`WorkflowVersion`. Its `entryNodeId` is always the first item in the saved
`nodes` array—the first Agent added—not the leftmost canvas position. A Run
pins that version and its complete Agent-configuration-version mapping.

LangGraph compiles the saved DAG and uses `PostgresSaver` with `thread_id` set
to the durable Run ID. The Run record separately pins its immutable
WorkflowVersion ID. Native results are first accepted in `harness_executions`;
downstream nodes then read that accepted row back from PostgreSQL to construct
their input. No filesystem or in-memory handoff is used.

The first engine supports success-only DAG edges, parallel fan-out, and `all`
joins. Result predicates, cycles/bounded repeats, and `any`/threshold joins fail
with explicit unsupported errors rather than being changed silently.

## Codex CLI contract

- Qualified binary: `codex-cli 0.154.0`
- Authentication: ChatGPT login, checked with `codex login status`
- Acceptance model/presets: `gpt-5.6-luna` with `low` for Agent A and `medium`
  for Agent C
- Execution: `codex exec --json`, explicit `-C`, model, reasoning effort,
  sandbox, and optional Fast service tier
- Native identity: `thread.started.thread_id`
- Final result: completed `agent_message` text
- Resume: `codex exec resume SESSION_ID`
- Cancellation: owned child process receives SIGTERM, followed by SIGKILL if
  it does not exit
- Supported contract fields: model, reasoning effort, read-only/workspace-write
  sandbox, standard/priority service tier, startup prompt, working directory,
  structured events, resume, and cancellation
- Unsupported: OpenCode native-Agent selection

The adapter validates the selected model and effort against `codex debug
models` before launch. Official behavior for JSONL, final-message output, and
resume is documented in [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

## OpenCode contract

- Qualified binary: `opencode 1.18.31`
- Authentication: OpenCode Go credential, checked by provider name only; the
  credential file is never read
- Acceptance model: `opencode-go/deepseek-v4.1-flash`
- Catalog capabilities: active; variants `low`, `high`, and `max`; text/image
  input; text output; reasoning and tool calls; no audio/video/PDF
- Acceptance preset: variant `max`, native Agent `build`, thinking hidden,
  automatic permission approval disabled
- Execution: `opencode run --format json --dir ... --model ... --variant ...
  --agent ...`
- Native identity: `sessionID`
- Final result: final `text` event
- Resume: `opencode run --session SESSION_ID`
- Cancellation: owned child process receives SIGTERM, followed by SIGKILL if
  it does not exit
- Unsupported by this Product adapter: Codex sandbox/service-tier settings and
  automatic permission approval

The provider-prefixed model and native Agent are validated before launch.
OpenCode's current CLI flags are documented in the [OpenCode CLI reference](https://opencode.ai/docs/cli/).

## Required acceptance workflow

The seeded `Real three-agent handoff` workflow is:

1. Product Agent `agent-researcher` — Codex, Luna/low — produces three facts.
2. Product Agent `agent-developer` — OpenCode, DeepSeek V4.1 Flash/max — receives
   Agent A's accepted stored result and summarizes it.
3. Product Agent `agent-reviewer` — Codex, Luna/medium — receives Agent B's
   accepted stored result and produces the final response.

Each step has a distinct occurrence ID, attempt, working directory, native
session ID, input snapshot, native event stream, and result. Run details remain
available after API restart.

## Commands

```sh
corepack pnpm db:up
cp apps/api/.env.example apps/api/.env
corepack pnpm dev:api
corepack pnpm dev
corepack pnpm test:acceptance
corepack pnpm db:down
```

The acceptance test invokes both authenticated CLIs and may consume model
usage. Ordinary `corepack pnpm test` excludes it.
