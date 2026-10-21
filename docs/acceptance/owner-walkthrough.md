# ENG-07 owner walkthrough — one Board, execution semantics 3

**Lane:** ENG07-C / NIM-2662 · **Repository:** `nima20002000/graphql` · **PR:** #26
**Source baseline:** `16b33373b3b2962dd0d0c57ad0b2f2c93198c400` (`16b3337`).

This is a procedure and expected-results checklist, **not a completed acceptance report**. Use the real Board, HTTP services, Operator MCP, PostgreSQL and native provider. Record FAIL or NOT RUN instead of substituting a mocked result, inferred acknowledgement or a fresh Run for recovery. The repeat plan's `contractVersion: 1` versions repeat data; every workflow and Run here uses **execution semantics 3**.

## 1. Start an isolated acceptance session

### Prerequisites

Use a non-root **Linux** account for the full walkthrough. This head's durable native process recovery uses Linux process identity/guardian evidence; macOS is allowed for the setup-only `--smoke` command, not as restart-recovery acceptance. Windows and root execution are rejected. Have Node 22+, Corepack and Docker with Compose. Run `corepack pnpm db:up` to start the dedicated disposable PostgreSQL **17** server from `compose.test.yaml` on **127.0.0.1:55439**. The provisioner verifies its server marker and uses its test-only credentials. A system PostgreSQL installation or the application's database cannot substitute for this server.

Install the repository's pinned dependencies before running the launcher. Do not substitute another package manager, relax package-age checks, update the lockfile or install a newer native provider as part of acceptance.

```sh
git rev-parse HEAD
corepack pnpm install --frozen-lockfile
corepack pnpm db:up
node --test scripts/acceptance/*.test.mjs
node scripts/acceptance/local.mjs --help
```

For native work, select a qualified **Claude** installation and test credentials authorized for **`claude-haiku-4-5-20251001`**. Claude model availability and authentication remain live preflight checks. This walkthrough explicitly uses the supported Full access policy with no native tools except a human-approved Bash call in S3-04. Native Starts may incur provider charges; seeding itself does not start a Run.

Supply authentication explicitly through `FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE` and, for a mixed run, `FOREMAN_CODE_TEST_CODEX_AUTH_FILE`. Each value is an absolute path to a private credential file authorized for tests. Claude credentials are copied into this invocation's disposable profile with mode 0600; Codex references its dedicated authentication file. Do not paste credential values into commands, prompts, `.env`, screenshots or the launcher's input. Ambient provider keys and native account/configuration directories are excluded. The API/native process receives the selected test authentication; Vite does not receive provider keys. The launcher ignores ambient `DATABASE_URL`, all `PG*` variables, proxy settings, `NODE_OPTIONS`, application env-file selectors and rollout flags. Qualification remains required.

Run a disposable setup smoke check first; native credentials are unnecessary for smoke mode:

```sh
node scripts/acceptance/local.mjs --smoke
```

**Expected:** a new owned database and schemas on the dedicated test server; real migrations/checkpointer setup; eight saved workflows and 27 persisted Agents; web/API readiness; authenticated HTTP/MCP reads, idempotent metadata write/replay and read/write denials; orderly teardown. No native Run or browser acceptance is claimed by this command. Failure is nonzero, with a stage/code rather than raw logs. Do not continue on a failed smoke check.

Start the interactive session with available ports:

```sh
FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE=/absolute/path/to/test-claude-credentials.json \
node scripts/acceptance/local.mjs \
  --api-port 3307 --web-port 5307
```

Replace the credential-file path with your test account's file. The launcher builds contracts using pinned pnpm, starts API and Vite, and prints the exact loopback web/API URLs, workspace ID and execution folder. Open the printed **127.0.0.1** web URL, not `localhost`, another port or a remotely forwarded origin.

**Expected:** dev browser access without bearer-token enrollment; workspace **ENG07 Acceptance**; one Board containing the saved scenarios below. No Run has started. An occupied API/web port fails; no existing process is killed or reused. The API uses the same production composition, migrations, atomic checkpointer, engine and native recovery services as the application, with isolated storage, harness homes and logs.

### Storage and ownership boundary

Every invocation creates a fresh owner-only `eng07-*` directory under `~/.cache/graphql-disposable-tests` (beneath the outer invocation's isolated HOME when nested). Its generated `graphql_test_<random>` database carries the invocation's ownership marker on the dedicated **127.0.0.1:55439** test server. Application tables use schema `eng07`; checkpoints use `eng07_checkpoints`. Before migrating, the API verifies the owned root, database marker, selected database and search path.

There is no external database URL, existing-state attachment, reset or drop-database option. PostgreSQL calls use the dedicated loopback test endpoint, test administrator and generated database. The app/production database is excluded. Project files, native runtime files, provider homes, logs and temporary files stay beneath the private invocation root. Cleanup targets owned child handles and verified ownership markers. Nested invocation ownership keeps the parent root and database available until child cleanup completes.

Claude uses the explicitly saved profile directory and configuration. Runtime issues scoped credentials; the launcher does not fabricate or persist them. Do not archive task database/runtime directories: the native recovery subsystem retains private control/ownership state there, and private Run bodies also belong outside acceptance evidence bundles.

### Optional mixed Codex/Claude run

Adding `--codex-model OWNER_AUTHENTICATED_MODEL_ID` replaces only **Right** in S3-02 with Codex, preserving a Claude Left branch. Supply `FOREMAN_CODE_TEST_CODEX_AUTH_FILE` or `FOREMAN_CODE_TEST_OPENAI_API_KEY` and use a model available to that test account's repository-qualified Codex installation. The launcher does not guess a model, change trust settings or auto-enable an experimental rollout.

A project-local `.codex/config.toml` contains only the App MCP endpoint and `bearer_token_env_var = "FOREMAN_CODE_MCP_TOKEN"`. Confirm in native configuration inspection that this **task folder's** configuration is trusted/loaded and that the App MCP endpoint matches the printed API port. If project config is ignored or qualification fails, record the Codex row as BLOCKED; do not change global configuration, grant broad permissions or bypass preflight merely to pass. The default all-Claude S3-02 does not establish mixed-provider acceptance.

## 2. Common owner observation rules

Open each named workflow on the Board. Before Start, inspect its saved version and execution folder. Start once with the default input; retain that Run ID and the accepted WorkflowVersion/configuration/location pins. Do not double-click or use another command ID to resolve an uncertain Start.

Use the Board's **Details** / **Runs** drawer, node execution/attempt inspection, accepted inputs/results and relationship/input-binding inspection. Selecting a past Run must keep the same Board and show that Run's immutable topology and version, not today's draft. Use **Stop showing this run** to return to draft context. Refresh the page or restore its deep link: selection must not silently change to another Run.

Baseline counts below assume no technical failure/retry. A retry is another technical attempt of the same execution slot; a business repetition has a real occurrence identity; a new full-Run retry has a new Run ID. Never count these as interchangeable. Record actual identifiers and accepted-result/input digests, not just a green node or Agent's natural-language claim.

For every scenario, check current Run facts while active, past Run facts after settlement, and the same facts after browser reload. Ordinary S3-01..04 must have **no repeat plan and no synthetic repetition history**. Select one completed Run and enter `parity RUN_ID` in the launcher's terminal to cross-check private HTTP/MCP detail, inputs, accepted results, bindings and version pins.

## 3. S3-01 — sequential

1. Select **S3-01 Sequential**. Verify `First → Second`, no repeat, and the saved Claude configurations. Start once.
   **Expected:** First starts before Second; Second is not eligible merely because First was submitted.
2. Wait for completion, then inspect both executions and the connecting relationship.
   **Expected:** two successful executions, one per node, with First's exact accepted result bound into Second's accepted predecessor input. Markers are `ENG07_S3-01_0` and `ENG07_S3-01_1`; pin/receipt identity, not marker text alone, establishes provenance.
3. Start another full Run deliberately, then select the first from Runs and reload.
   **Expected:** distinct Run IDs, independent histories and immutable inputs/results. The first Run never acquires facts or draft changes from the second. No repetition rows appear in either.

## 4. S3-02 — parallel, then an all-required join

1. Select **S3-02 Parallel join**. Verify Fork fans out to Left and Right, both feed Join, the join is all-required and maximum parallelism is 2. Start once.
   **Expected:** Fork settles first; Left and Right become eligible independently. Observe both active together or retain execution timings proving overlap. Four completed nodes alone are not evidence of parallel execution.
2. Inspect Join before and after the branches settle.
   **Expected:** it does not run after just one branch; its exact accepted input contains both successful predecessor results with their distinct execution identities/bindings, and it runs once. Normal total: four executions.
3. With the optional Codex seed, inspect each accepted configuration.
   **Expected:** Left is Claude, Right is Codex, both actually execute, and Join consumes both results. Model labels without native execution are not mixed-provider proof. Without this option, record mixed-provider evidence as NOT RUN.

### S3-02 Uneven parallel join (both branches selected)

Run **S3-02 Uneven parallel join**. Fork feeds Short and Long one; Long one feeds Long two; Short and Long two both feed Join (all required).

**Expected:** Short completes while Long one/Long two are still running, and Join stays unadmitted until Long two's result is accepted. Join then runs exactly once, with both exact accepted predecessor bindings (Short and Long two). Five executions, and the Run succeeds.

## 5. S3-03 — conditional routing with an uneven join

1. Run **S3-03 Uneven join short**. Route declares exactly `short` and `long`; Short feeds Join directly, while Long one passes through Long two before Join.
   **Expected:** the exact accepted choice is `short`; Route, Short and Join execute (three successful baseline executions). Long one and Long two are resolved as non-selected/skipped, not failed work and not fabricated successful results. Join does not wait forever for the inactive two-node path.
2. Run **S3-03 Uneven join long**.
   **Expected:** accepted choice `long`; Route, Long one, Long two and Join execute (four). Short contributes no result. Join waits for Long two rather than running when Long one finishes.
3. Inspect each Join's incoming facts, then switch between these past Runs and reload.
   **Expected:** selected/skipped relationships agree with the accepted finite-choice result, inputs and recorded history. No inactive-path output leaks into the selected Join and no draft rerouting changes either Run.

## 6. S3-04 — a real human approval, without repeat

1. Select **S3-04 Human approval** and Start. Permission requests native Bash **exactly once** for `printf ENG07_APPROVED`.
   **Expected:** the narrow native permission request appears as a pending human approval in the same Board; the Run waits and After approval does not execute. The saved Bash rule asks the human for each call. A model saying “approved” without a real request/acknowledgement fails the case.
2. Reload while pending; inspect request identity, context and one-request scope. Choose the one-request approval option, not a session/persistent policy change.
   **Expected:** the same pending interaction survives reload; one accepted response goes to the original request. Delivered and native-acknowledged are distinct facts. Only the acknowledged continuation may let After approval run. Normal successful total: two executions and no repeat history.
3. After the response, attempt no fresh response command. Refresh/read back instead.
   **Expected:** the old interaction is not presented as actionable again; there is no duplicate native submission or second execution solely from replay/reload.
4. On a **new** Run, reject the permission request; on another, Stop while it is pending.
   **Expected:** truthful rejection/interruption/cancellation with downstream not falsely successful; Stop settles native/interaction obligations. Terminal Run state alone is not enough if cleanup is still pending. These are separate evidence rows from the approved baseline.

## 7. S3-05 — bounded repeat: early exit and limit exit

1. Inspect **S3-05 Repeat early**: Deliver → Decide, one block, maximum occurrences **3 including the first**, `issues` repeats, `pass` exits, explicit branch-end limit exit; execution budget 6. Start.
   **Expected:** Decide returns `pass`, so only occurrence 1 runs (two executions). Latest deliverable marker is `ENG07_early`; remaining findings are empty. There is no occurrence 2 just to fill the bound.
2. Inspect and run **S3-05 Repeat limit** with the same bound/budget.
   **Expected:** Decide returns `issues` each time. Exactly occurrences 1, 2 and 3 run (six successful baseline executions), then the **limit exit** is recorded. There is no fourth occurrence. Latest deliverable marker `ENG07_limit` and `demo finding still open` remain available; reaching the bound must not invent an early pass or erase unresolved findings.
3. Inspect Deliver and Decide in **each** occurrence, including exact accepted input and accepted result.
   **Expected:** stable Run/version pins; distinct occurrence/execution identities; Decide consumes that occurrence's Deliver result; occurrences 2 and 3 receive the accepted previous decision/carry, not a recomputation from current files or an unbounded recursive history copy. Technical attempt numbers remain separate from occurrence indices.
4. Start another limit Run and Stop while a repeated node is active.
   **Expected:** no new occurrence is admitted after Stop wins; current native/approval obligations close and `cleanupPending` eventually becomes false. Already accepted results remain inspectable. A completed/succeeded occurrence is not rewritten as if it never happened.
5. To check pre-native Stop, Start a new Run and Stop immediately while still queued.
   **Expected:** no native work after accepted Stop. Only label this a pre-native cut if the observed record proves it; otherwise classify it as a during-execution Stop, not a passing pre-launch case.

## 8. Layout, protected edits, discard and Stop-and-save

1. Start S3-04 and leave its real approval pending. Move a node on the Board and save the presentation change.
   **Expected:** geometry can change without canceling the Run, changing its executable version/configuration/input pins, or publishing a meaningful new executable version. Reload and confirm both layout and historical pin integrity.
2. In draft controls, change After approval's initial prompt to a harmless new marker and Save/stage the meaningful edit.
   **Expected:** the active Run continues to display its old accepted prompt/version; publication is blocked until affected Runs settle. The UI exposes the protected-edit decision rather than silently saving during native work.
3. Choose **discard** before authorizing Stop.
   **Expected:** staged edits are discarded; current saved executable version is unchanged; the waiting Run and original approval remain intact. Discard is not Stop or a native response.
4. Stage the prompt change again and explicitly choose **Stop-and-save**.
   **Expected:** the server-owned edit intent identifies affected Runs; Stop acceptance may precede cleanup, but Save does **not** publish until terminal state plus native, interaction, reviewer and cleanup settlement are established. Pending approval becomes non-actionable without a forged acknowledgement. Exactly one new immutable version is published.
5. Reload during this operation, then read back the same intent.
   **Expected:** the UI reconciles its reserved Stage/Stop/Save commands, not a fresh payload or a new command ID. If blocked/uncertain, retain the intent and use readback. No optimistic “saved”/“stopped” while obligations remain.
6. Select the stopped past Run, then start a new Run from the new saved version.
   **Expected:** old Run retains old pins/results; new Run accepts the changed prompt and new version. Repeat this edit while recovery is in progress (next section): the settlement fence still applies. With multiple affected active Runs or shared Agents, all affected Runs—not only the selected one—must settle before publication.

For version-boundary inspection, remove repeat from a settled repeat workflow using Board draft controls and save; its next Run is ordinary (two nodes, no occurrence rows). Its old repeated Run must still show the old repeat plan/history. Add the bounded block again and save before another Start; only subsequent Runs use it. Never manufacture repeat rows to make ordinary history fit a repeated view. If the relevant authoring control is unavailable, record NOT RUN rather than modifying durable rows directly.

## 9. Backend restart and honest recovery

Use the **launcher's commands**, not `pkill`, a port-killer, `pnpm dev`, another checkout or a database reset. Keep the browser and current Run selected.

1. On a settled S3-01 Run, record input/result digests, execution IDs, version pins and cleanup state; type `restart-api`.
   **Expected:** graceful API-only restart; same PG database, project folder, native recovery directories and web process; no reseed. Reloaded Board and `parity RUN_ID` retain the exact completed facts.
2. Start S3-04, wait for its native approval, record its Run/interaction identity, then type `crash-api`.
   **Expected:** only this launcher's API process receives SIGKILL. Native descendants are left to the real durable recovery protocol, not killed by name or assumed dead. The new API reconciles the same Run using owner/generation/session/receipt fences. It must not create another native submission just because its in-memory registry is empty.
3. Observe readback. When exact completed/acknowledged evidence exists, it may be recovered without resubmission. When it does not, expect a truthful interrupted/uncertain/failed or canceled result, with bounded technical retry only where the product's policy and closure proof allow it.
   **Expected:** no indefinitely “running”/“waiting” dead owner, fabricated success, replayed human response, new full Run or reset business-repeat count. Select Stop and wait for cleanup settlement if the Run is still unsettled. `EXECUTION_INTERRUPTED` can be a correct conservative result; an endlessly repeating `REPEAT_CLEANUP_PENDING` is not acceptance.
4. Repeat a crash during S3-05-limit while an occurrence is active. Inspect completed occurrences, accepted carries and the eventual terminal state.
   **Expected:** durable completed history remains exact; retries stay within the same slot and finite retry policy; no duplicate occurrence or limit overrun. Stop while recovering must settle. Stage a meaningful edit and use Stop-and-save: it must wait for those same obligations.
5. For a between-occurrences cut, record the first decision as committed and the next occurrence as not yet entered before crashing.
   **Expected:** continuation derives from the committed decision/carry, not a new interpretation of model output. If that exact timing was not observed, mark the cut NOT RUN. This manual procedure does not claim deterministic coverage of the narrower `entered`-before-spawn or durable-result-before-closure transaction cuts; use the dedicated fault-injection suites for those.

The baseline commit's own message reports open durable-terminal acceptance cases. That note is not this lane's live evidence and does not relax the expected results above. Do not patch product state or turn uncertainty into success to complete this checklist.

## 10. HTTP / authenticated Operator MCP parity

In the launcher's terminal, enter:

```text
parity
parity RUN_ID
```

Replace `RUN_ID` with one **settled** Run ID from this workspace. The first command reads the workspace and all eight saved definitions, performs a same-description workspace metadata update over HTTP, replays the **same command ID/payload** through MCP, and checks exactly one revision increment. It also verifies unauthorized read and write denial over both transports. Each invocation deliberately adds one workspace metadata revision; it never edits executable definitions or Starts a Run.

The second additionally compares Run record, accepted version, every bounded execution page/detail and every bounded input-binding page. It checks terminal stability across the probe. It uses one short-lived, workspace-scoped Operator principal for both transports; a separate under-granted principal supplies denials. Raw tokens stay in process memory, only hashes enter the access table, and both principals are revoked in `finally`. The terminal reports counts only. Revocation failure is a probe failure, not success.

| Shared read | HTTP under `/api/management/workspaces/{ws}` | Operator MCP tool |
| --- | --- | --- |
| Saved definition | `/workflows/{wf}/definition` | `workflow_saved_get_v3` |
| Bounded Run record | `/runs/{run}/record` | `run_record_get` |
| Accepted version | `/runs/{run}/version` | `run_version_get` |
| Execution page/detail | `/runs/{run}/executions[/execution]` | `run_executions_list` / `run_execution_get` |
| Input bindings | `/runs/{run}/executions/{execution}/bindings` | `run_execution_bindings_list` |

**Expected:** identical domain values, exact accepted inputs/results and pins, stable page traversal, no duplicated mutation, and `ACCESS_DENIED` rather than a filtered success for an unauthorized point read/write. Workspace comparisons exclude the volatile folder-validation `checkedAt` timestamp; Run/version/execution/binding values are compared without normalization. A live changing Run is rejected by this probe as unsuitable for a stable comparison, not misreported as a transport mismatch. Pagination is bounded (25 items/request; 500 pages per traversal); exceeding its budget fails rather than truncating a successful report.

This helper is **not** a complete Start/Stop/approval command-parity suite. For those owner checks, use an already authorized Operator MCP client and the schemas advertised by the running server's tool discovery: read the saved version/location pins, submit one Start, and select that exact returned Run on the Board; then submit Stop and observe acceptance separately from cleanup. **Expected:** same native engine and admission/settlement rules as Board HTTP, not an alternate execution path. An Operator credential must not impersonate a human approval responder. Retain existing command identity for readback/replay; do not retry an uncertain mutation with another ID. Use the ENG07-B real-transport fixtures for exhaustive command and denial coverage.

## 11. Evidence, security and shutdown

For each row retain: source commit, date, platform/provider versions (not account identifiers), scenario, Run ID, accepted WorkflowVersion ID, observed cut, expected/actual result, cleanup settled/not settled, and redacted Board screenshots or small exact digest/identity notes. Suggested rows: each of the seven seeds; approved/rejected/stopped approval; layout; discard; Stop-and-save; settled restart; pending-approval crash; repeated crash/Stop; HTTP/MCP probe; optional mixed provider. Leave unperformed rows **NOT RUN**.

Inspect only application-level Board/readback evidence. Do not export raw HAR files, request headers, browser storage, provider debug/config output, native sessions, database dumps or the task runtime. Public graph snapshots/deltas must not contain credential values, raw native session payloads or private input/result bodies; use the authorized private inspector for exact disclosure. Browser reconnect should restore a consistent recorded cut, not optimistically acknowledge an uncertain command. Check that history remains paged instead of eagerly loading every result.

When finished, Stop active Runs through the Board and confirm cleanup. Enter `quit` or press Ctrl-C once. **Expected:** API drains native work, owned web/API exit, then the invocation's marked database and verified private directory are removed. The dedicated test PostgreSQL server remains running; no shared service or app database is stopped.

If cleanup/ownership is uncertain, or recovery emitted an unresolved notice, the launcher exits nonzero and retains the private task directory and owned database. Do **not** archive them as evidence or run broad removal/kill commands. Retain the exact identity/receipt state for diagnosis by the owner; inspect any surviving process using that task's durable registry, not a reused PID or name. The launcher deliberately provides no attach-existing-state or force-reset command. A new invocation always creates a separate task and cannot establish recovery of the retained Run. An uncatchable launcher/host crash also requires this conservative path.

### Failure triage

Argument validation runs before provisioning. For test-server/version/dependency failures, check `corepack pnpm db:up`, the dedicated server marker and the pinned installation; do not substitute the application's database. A migration or seed-stage failure is a failed setup, not permission to seed SQL fixtures into another instance. Native preflight/authentication failure requires test-account readiness inspection; do not print native debug output or hard-code a token. A model violating the finite-choice output contract is a native failure, not proof of routing. A product defect discovered by the walkthrough should be reported with source head, Run/cut, redacted error code and missing invariant; this lane changes no product code.

### Source anchors at the baseline

`apps/api/src/config.ts`, `server.ts`, `production.ts`, `infrastructure/{database,migrations,checkpoints}.ts`; `modules/workspaces/{management,storage}.ts`; `modules/workflows/currentAuthoring.ts`; `modules/graph-drafts/currentEditIntent.ts`; `modules/harnesses/claudeSdk/`; `modules/harnesses/recovery/processRegistry.ts`; `modules/runs/{workflowPrompt,inspection}.ts`; `routes/{currentWorkflow,runInspection}.ts`; `modules/access/postgres.ts`; `packages/contracts/src/wave25/{currentAuthoring,currentEditIntent,currentJournal,repeat,runInspection}.ts`; `apps/web/vite.config.ts`; `apps/web/src/features/workflow-board/WorkflowBoard.tsx` and its actions/inspect modules.
