# ENG-03 G0 READY — 2026-09-23

## Source and environment

- Base: `50458ee99c67c760336449adbffea9e83985a95d` (`main` and `origin/main` at G0). Final Wave 2.5 head `42bf0134178f26b0ddf350c1fcc364c42ad66a6a` is an ancestor.
- Integration branch: `feat/eng03-integration`. A/B/C/D branch from this READY commit in separate worktrees; their PRs target this branch. The integration PR targets `main` and accumulates committed lane heads and follow-up repairs.
- Installed CLIs: `codex-cli 0.156.1`, `opencode 1.18.31`, pinned `pnpm 11.27.0`. `codex login status` reports ChatGPT login; `opencode auth list` reports existing OpenCode Zen, OpenRouter and OpenCode Go credentials. These are availability checks, not successful model or parallel-provider qualification.
- Existing Chrome app tab: `http://127.0.0.1:5173/...`; local API listens on `127.0.0.1:3000`; PostgreSQL listens on `127.0.0.1:5432`. The orchestrator owns browser interaction during parallel build. No lane may stop or reconfigure these existing processes.

## Existing source and remaining proof

- Reuse `oneShotGraph`, `oneShotNode`, `topology`, `oneShotResolution`, `oneShotPostgres`, `limiter`, `runnerAdmission` and execution-scoped native managers. Current synthetic and PostgreSQL tests cover parts of capacity, joins, inputs, duplicate acceptance and Stop; they do not certify live native overlap.
- `real-harness.acceptance.test.ts` exercises a sequential Codex → OpenCode → Codex path. Keep it as a regression and add parallel native evidence.
- `packages/contracts/src/wave25/workflow.ts` sets `WAVE25_ADMISSION_ENABLED = false` and `assertWave25Admission()` throws. Guards are called by `RunManagementService.start`, `PostgresRunRepository.admit` and `PostgresRunRepository.create`. Normal v2 admission is currently closed.
- Activation inventory to qualify: saved v2 authoring/pins and current version; authenticated HTTP and Operator MCP parity/denial; transactional admission, authority and command receipts; native session/credential/process ownership; join/input and publication durability; Stop/failure/approval/restart cleanup; legacy semantics and approval checkpoints; unknown-version rejection; same-revision snapshot/delta parity. A green provider matrix alone does not clear these gates.

## Scenario and evidence contract

IDs: `E03-P01/P02/P03` mixed/Codex pair/OpenCode pair; `E03-J01` joins; `E03-L01/L02/L03/L04` Stop/failure/replay/recovery; `E03-A01` approval isolation; `E03-U01` real UI; `E03-M01` HTTP/MCP; `E03-G01` admission/compatibility. Each result records mode (synthetic, native internal, or public path), source SHA, CLI/model versions, run/execution/native session IDs, positive native start/finish observations, expected/actual outcome, accepted output and input identities/digests, cleanup, commands and artifact path. Native overlap requires `max(startA,startB) < min(finishA,finishB)` from actual provider work. A skip, synthetic pass or safe blocked case cannot satisfy a required live success.

## Exclusive ownership and resources

| Lane | Exclusive source/test ownership | Scenarios |
| --- | --- | --- |
| A, NIM-2625 | `apps/api/test/real-harness.acceptance.test.ts` and new `eng03` native acceptance driver/evidence helpers | P01/P02/P03, native input/overlap evidence |
| B, NIM-2626 | `apps/api/src/modules/runs/{oneShotGraph,oneShotNode,topology,oneShotResolution,oneShotPostgres,limiter,runnerAdmission}.ts`, related run-graph persistence, and focused B tests | J01, durable L03 seam |
| C, NIM-2627 | `apps/api/src/modules/runs/{engine,oneShotRuntime,oneShotLifecycle}.ts`, native manager/recovery and interaction runtime/approval services, and focused C tests | L01/L02/L03/L04/A01 |
| D, NIM-2628 | `packages/contracts/src/wave25/*`, `apps/api/src/modules/runs/{management,postgres,oneShotAdmission}.ts`, web graph UI, HTTP/Operator MCP surfaces and focused D tests | U01/M01/G01 |
| Shell | This manifest, migrations, lockfile, shared fixture interface, integration and final browser acceptance | All final scenarios |

Request an ownership transfer before touching another lane's file. Do not create broad shared fixture changes independently. Each lane uses its own `eng03-<lane>` worktree, unique test database or schema, task-owned runtime/project/evidence directories and native session IDs. The project working directory policy remains intact; per-execution runtime directories are not OS confinement. A has first use of live provider capacity; B/C/D proceed with code and deterministic tests concurrently, then coordinate any shared native run. Only the orchestrator operates the existing app tab during build and final acceptance. No lane changes shared auth/config or kills another lane's process.

G0 READY means source, ownership and evidence contracts are fixed for parallel work. It does not claim product qualification or admission readiness.
