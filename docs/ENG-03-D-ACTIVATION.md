# ENG-03 D candidate activation inventory

Candidate base: `f823f0e352d954c8c8081d6fe7889008f065a62d` (G0 READY). First D commit: `96e08967f6d4dc0f51bf981b354f2f981941be64`. PR: [#29](https://github.com/nima20002000/graphql/pull/29) into `feat/eng03-integration`. This is branch source, not a shared runtime or release activation. The shell must qualify the assembled final head and own final browser acceptance.

## Public callers and mode selection

| Caller | Exact v2 path | Compatibility boundary |
| --- | --- | --- |
| Typed draft editor | The legacy graph's visible `Parallel workflow draft` control opens conversion/typed authoring. Save immutable v2 version, Start with `executionSemanticsVersion: 2`, current version ID, published draft ID/revision and location revision; reopen admitted Runs from the persisted Runs list. | The legacy graph editor remains for semantics 1. Later draft edits cannot change an admitted Run's saved pin. |
| Authenticated HTTP | `POST /api/management/workspaces/:workspaceId/workflows/:workflowId/runs` selects `RunStartV2InputSchema` then `RunManagementService.start` and `admitOneShotRun`. Get/list/Stop use the same service. | Omission of the v2 tag against a saved v2 version returns `V2_ADMISSION_REQUIRED`. Unknown tags are rejected by strict input and saved-record schemas. |
| Operator MCP | `run_start`, `run_get`, `run_list`, `run_stop`, and graph capability/snapshot/events tools use the same contracts and services as HTTP. | Tool discovery still requires scoped grants; read-only or wrong-scope callers cannot start. Removed Operator workflow approval handling is not restored. |
| Workflow schedule/event trigger | The immutable workflow version is read when queuing; new v2 jobs carry the exact semantics-2 pin through dispatch, receipt hashing and replay. | Old jobs without that pin remain semantics 1. A mismatched job/Run receipt is rejected; no legacy admission fallback. |
| Legacy product `createForWorkflow` and repository `create` | No v2 INSERT. Production with Operator management rejects product mutation paths; repository methods explicitly require the v2 admission transaction. | Existing semantics-1 callers keep their old transaction and checkpoint behavior. |
| Run graph capabilities | Qualified read service reports v2 authoring/admission availability from the source-controlled candidate. | A disabled read service still reports no protocol capability. Semantics-1 `run_current` remains explicitly legacy. |

The v2 INSERT remains `insertOneShotRun` inside `withExclusiveGraphConnection`. The transaction binds current saved version, exact Agent configuration pins, workspace location identity/revision, live delegated authority, command receipt, Run record and first graph publication. Replays reauthorize and reuse the receipt without a new native dispatch. `run_get` now accepts persisted v2 records and does not apply the legacy `liveActivity` projector; current v2 node/exchange state comes from the bounded graph snapshot. The graph read remains scoped and excludes private node input/result bodies.

## Prerequisite and evidence ledger

| Prerequisite | Lane D evidence at first head | Final release condition |
| --- | --- | --- |
| Explicit saved graph, entry, current version, configuration and approval pins | Existing v2 authoring contracts; WR4-002 persisted HTTP/MCP reads (3 passing tests after the added Start/readback case). | Shell U01 browser save/Start/reopen on final integrated head. |
| Authenticated HTTP and Operator MCP parity | WR4-002 tests real loopback endpoint: HTTP Start, MCP exact replay, HTTP and MCP persisted `run_get`, read-only/wrong-scope denial, legacy-mode rejection, MCP Stop and HTTP Stop replay. | Shell M01 final app/API/MCP checks, including stale draft/version and live Stop outcome. |
| Transactional admission, receipts, authority and bounded runner capacity | `wave25-agent3-admission.integration.test.ts`: 11 passing PostgreSQL tests, including public service Start/replay/denial and v2 schedule dispatch. | Final assembled native P/L scenarios; no duplicate session or result effect. |
| Legacy semantics-1 and approval/checkpoint preservation | Strict compatible schemas and unchanged legacy admission/current paths. | Final compatibility suite plus legacy waiting/checkpoint evidence. |
| Unknown semantics and private data | Strict version/Run schemas reject unknown tags; graph publication/read contracts bound visible facts. | Final graph snapshot/delta same-revision replay and security tests. |
| Join/input publication durability | Existing Wave 2.5 one-shot graph/storage implementation. | B's exact input and J01 results on assembled head. |
| Native identity, session/owner/generation/receipt fencing, Stop, failure, approval and recovery cleanup | Existing Wave 2.5 services and C's concurrent lane work. | A/C positive native P/L/A scenarios on assembled head; safe blocked cases do not replace required successes. |
| Native provider availability and real overlap | G0 CLI/auth availability only. | A P01/P02/P03 records positive overlapping native starts/finishes with distinct identities. |
| Final product activation | No shared runtime changed by lane D. | Shell integrates, completes one review round, runs final browser scenarios itself, and records every applicable prerequisite as passed before declaring readiness. |

## Lane verification

`corepack pnpm typecheck` passed. Focused tests: contracts Wave 2.5 17/17, typed HTTP transport 6/6, v2 admission PostgreSQL 11/11, authenticated HTTP/MCP persisted workflow/Run readback 3/3. Three compatibility/graph suites passed 8 tests with 3 pre-existing todo cases (the first attempt lacked their required `TEST_DATABASE_URL`; the rerun used the task-owned database). PostgreSQL runs used `eng03_d_test` and each suite's disposable random schema. `git diff --check` passed. These tests do not claim live native or browser qualification.
