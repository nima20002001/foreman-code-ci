# `@foreman-code/api`

This package owns the real local API, product persistence, LangGraph workflow
mapping, and native Codex/OpenCode process adapters.

## Runtime boundaries

- `src/app.ts` builds the Fastify HTTP application without opening sockets or
  infrastructure connections, which keeps route tests deterministic.
- `src/server.ts` is the composition root. It loads configuration, connects
  PostgreSQL, initializes LangGraph's PostgreSQL checkpointer, then listens.
- `src/infrastructure/database.ts` owns the application `pg` pool.
- `src/infrastructure/checkpoints.ts` owns `PostgresSaver`; its `saver`
  property is the checkpointer ENG-04 passes to compiled LangGraph workflows.
- `src/modules/workflows/postgres.ts` persists definitions and immutable
  versions, including the explicit first-added entry node.
- `src/modules/harnesses` qualifies and runs the installed Codex/OpenCode CLIs
  behind a shared process-lifecycle interface.
- `src/modules/runs/engine.ts` compiles saved DAGs into LangGraph and supplies
  only accepted PostgreSQL results to downstream nodes.
- `src/modules/runs/postgres.ts` persists runs, occurrences, accepted results,
  raw native events, and normalized activity.
- `src/modules/workspaces/location.ts` validates canonical local-runner paths,
  persists revisioned workspace locations, and rechecks immutable Run snapshots.
- `src/mcp/unified` mounts the one authenticated, request-scoped Foreman Code MCP
  server at `/mcp`; the credential's role selects the real tools from
  `src/mcp/operator` (management, shared with the browser HTTP boundary) or
  `src/mcp/app` (workflow Agents) and lists the rest as role-limited stubs.

The real product slice also implements durable management, graph drafts,
revision-checked Save, exact-version Start, idempotent Stop, scoped local
credentials, command receipts, and management audit. See
[`../../docs/operator-mcp-v1.md`](../../docs/operator-mcp-v1.md).

Before a real Start, Workspace Settings must contain an existing local-runner
directory. `HARNESS_WORKSPACE_ROOT` remains Foreman Code-owned scratch storage and
must not overlap a selected project directory. A configured CWD is not a
filesystem sandbox; native harness policies and stronger isolation remain
separate work.

## Local run

From the repository root:

```sh
corepack pnpm db:up
cp apps/api/.env.example apps/api/.env
corepack pnpm dev:api
curl http://127.0.0.1:3000/health/ready
corepack pnpm dev
```

Run the destructive-free real harness acceptance gate while PostgreSQL is up:

```sh
corepack pnpm test:acceptance
```

Stop PostgreSQL with `corepack pnpm db:down`. Add `-v` manually only when you explicitly
want to delete the local database volume.

## Production build and regression checks

```sh
pnpm build
pnpm --filter @foreman-code/api start
# In a separate shell, against the test database:
pnpm test:integration
pnpm test:production
```

The contracts package builds JavaScript and declarations into `dist` before
its consumers build. Production starts plain `node dist/server.js`; no `tsx`
or native TypeScript stripping is required. The optional local `.env` file is
loaded by the composition root on both development and production paths. Root
development commands also watch/rebuild contracts, and root validation commands
build contracts before checking consumers.

Both PostgreSQL pools handle and log idle-client errors. Readiness checks the
application pool and actual checkpoint tables through the saver's own pool.
`READINESS_TIMEOUT_MS` defaults to 2000. Each dependency has at most one in-flight
probe; callers share it until the underlying operation has finished cleanup.
On a readiness deadline, an active probe connection is destroyed. An acquisition
already waiting for a pool slot is bounded by `DATABASE_CONNECTION_TIMEOUT_MS`
(capped at 1000 ms). Pools retain up to four established idle sessions and expire
other idle sessions after 60 seconds to reduce authentication during source I/O.
Read-only MCP tools retry a transient connection acquisition timeout once;
SQL statements and mutations are never automatically replayed by this policy.
The readiness probe's eventual lease is discarded without querying. Both pools also enforce
`DATABASE_QUERY_TIMEOUT_MS` (default 1000) as a client query timeout and a server
statement timeout. Configure these bounds for the intended workload.

CI builds/checks with Node 22.16.0 and runs the compiled production command on
both Node 22.16.0 and the declared Node 22.0.0 runtime baseline. It also runs
`node scripts/production-smoke.mjs --restart-postgres` to stop and restart the
repository's Compose PostgreSQL service while the same API process is alive.
This disruptive restart test is opt-in; the normal production smoke command
does not stop PostgreSQL. Use only a dedicated test database for integration tests.
