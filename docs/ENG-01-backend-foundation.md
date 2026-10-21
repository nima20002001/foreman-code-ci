# ENG-01 backend foundation

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

> Historical foundation record. The real workflow slice described in
> [`ENG-02-real-workflow-engine.md`](./ENG-02-real-workflow-engine.md) now
> implements several items originally listed below as future work.

## Implemented and real

- A Fastify API process starts only after its dependencies are ready.
- A dedicated `pg` pool provides application PostgreSQL access.
- `PostgresSaver` initializes the `langgraph` schema and its official
  checkpoint migrations. This is durable LangGraph storage, not an in-memory
  checkpointer.
- Liveness and readiness endpoints are contract-shaped. Readiness queries both
  PostgreSQL connections and returns 503 if either is unavailable.
- Shared Zod contracts now cover immutable workflow and agent-configuration
  versions, explicit outcome/result routing, join policies, bounded repeats,
  parallelism limits/groups, pinned run identities, harness attempts/results,
  native-session initialization, and ordered activity.
- Docker Compose provides one local PostgreSQL service. The integration test
  proves a checkpoint can be read by a newly opened saver.

## Still mocked or unimplemented

- The frontend's `/api/workspaces/*` product routes remain served by MSW in
  development. The backend deliberately does not return fixture data.
- No workflow, run, agent, conversation, result, or activity rows are persisted
  by application repositories yet.
- No workflow is compiled to LangGraph and no run is started, resumed, retried,
  routed, joined, or repeated.
- No Codex/OpenCode process or native session is started.
- No live activity transport is exposed to the frontend.
- Memory, MCP, Kanban, Browser Use, uploads, Skill Hub UI, scheduling,
  agent-to-agent communication, authentication, and authorization remain later
  work.

## Extension points

| Workstream | Interface | Contract surface |
| --- | --- | --- |
| ENG-02 persistence/API | `WorkflowRepository` | `WorkflowVersion`, `AgentConfigurationVersion`, existing frontend request/response schemas |
| ENG-03 harness execution | `HarnessAdapter` | `HarnessExecutionRequest`, `HarnessExecution`, `ExecutionResult` |
| ENG-04 LangGraph mapping | `WorkflowOrchestrator`, `CheckpointStore.saver` | routing/join/execution policies and immutable run pins |
| ENG-05 live activity | `ActivityRepository`, `ActivitySubscription` | `RunActivity`, list-activity request/response schemas |

Runs must be created from an immutable `WorkflowVersion` and retain its
`workflowVersionId` plus the complete agent-to-configuration-version mapping.
Harness adapters receive the pinned configuration—including system prompt and
assigned skill versions—only through `HarnessExecutionRequest`. Native output
must be normalized into ordered `RunActivity` records before a live transport
exposes it.

## Commands

```sh
corepack pnpm install
corepack pnpm db:up
cp apps/api/.env.example apps/api/.env
corepack pnpm dev:api
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
corepack pnpm test:integration
corepack pnpm db:down
```

The normal `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, and `corepack pnpm build` root
commands include `@foreman-code/api`. The integration test stays separate so the
ordinary unit suite does not silently require local infrastructure.
