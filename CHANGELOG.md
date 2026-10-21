# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.114] - 2026-10-21

### Fixed
- Operator MCP parity: closed gaps in workspace, workflow and settings tools found by a parity sweep.
- Agent chat: configuration transitions use serialized request sizing; transport limit restored to 1,048,576 characters for HTTP and MCP.
- CI gates cancel unfinished parts once a sibling part fails, so a failed gate no longer blocks the next one.
- CI gate planning: provider status reads no longer exhaust the database pool; integration uses cloud slots as a second wave when checks fill the free slots.
- Board side panel keeps Escape working after the focused control disappears; board URL state is isolated between views.
- Worker shutdown drains pairing reads before releasing its lock.
- Operator chat recovery waits for queued terminal settlement and reconciles submitted live turns.
- Flaky tests fixed at the root: preparation deadline process read, remote recovery initialization, cloud requeue recovery, Worker restart history read.

## [0.0.113] - 2026-10-19

Review fan-outs converge, and CI tests are steadier.
- A coder that hands one change to several reviewers now gets their feedback as one continuation, instead of one parallel coder run per reviewer. A node never runs two feedback continuations at once; returns for the same caller are grouped, and returns for different callers keep their own replies.
- When some reviewers accept and another finishes, the join-all step after them still runs. Feedback that arrives after a continuation has started goes into the next one instead of being lost. Continuations queued before this upgrade still resolve.
- Test reliability: CI fleet-preference and cloud throughput-weight tests wait for every computer's status before admitting work.

## [0.0.112] - 2026-10-19

CI keeps moving when a computer goes offline.
- A CI part whose computer stops answering is moved to another computer after twice its expected duration (5 to 15 minutes), instead of holding its whole gate until the 210-minute deadline. The old computer's slot stays reserved until it confirms the stop, and late results from the abandoned execution are ignored.
- A computer that still reports the execution in its status is never treated as offline, including status reads made for planning.
- Gate parts split onto cloud CI after a move each get their own execution, so every file is tested once.

## [0.0.111] - 2026-10-19

Remote Agent results reach Main reliably.
- An Agent on a paired computer that finished no longer leaves its Run stuck: when the computer has evicted a physical readout Main still reads (not_retained), Main re-observes the operation instead of retrying the dead selector forever.
- Worker maintenance and Main cleanup now share one cancellation while a retained native session settles, so a reviewer cancellation no longer reports its original native closure as unconfirmed.

## [0.0.110] - 2026-10-19

Runtime ownership and Worker update reliability.
- Main no longer shuts itself down when a runtime-ownership database read is slow: ownership is fenced only on positive evidence (the ownership connection ends, or an independent check shows the lock is no longer held by this session, matched by PID and backend start time), checked on its own timer; concurrent route refreshes share one deadline and a refresh timeout no longer aborts running Agents.
- Paired computer Worker updates no longer roll back when a release pins a new native Codex package: the CI smoke's 160 s window starts after dependency installation, the whole update attempt keeps one absolute deadline, older update records keep their previous budgets, and the packaged supervisor ships every module it imports.
- Harness qualification: a check that goes stale after an installation update refreshes the inventory and rechecks in its own slot, so the active profile keeps priority.
- Test reliability: host CI build-preference test waits for both Workers' readiness.
- CI scheduling: entries now match the real test files (an inventory check fails on renames), so recovery suites run exclusively on installed-Worker hosts; CI observations no longer use a stale listing's executor, so a gate's setup retry is observed where it runs.
- Logging: pruning tolerates rotated files removed concurrently.
- Test reliability: native store tests use a local fixture registry; runner recovery and one-slot-pool delivery tests synchronize and honor retryable DATABASE_BUSY.

## [0.0.109] - 2026-10-18

Workflow, runtime and CI fixes found by multi-Agent scenarios.
- Workflow saves through the Operator keep node positions; workflows without an approval setting default to native approval; equivalent qualified harness profiles are chosen deterministically; invalid initial saves return graph validation issues instead of an internal error.
- Interval loops keep their session and checkout across ticks and do not resend the initial task; stopped Runs release their checkouts without waiting for the retention delay.
- A Run waiting for work direction no longer re-drives the engine until it is answered.
- Faster Run database paths: native events, executions, completion, projections and Start admission use batched queries (Start went from 242–329 queries per transaction to a bounded count).
- agent_create no longer runs native discovery inside its transaction.
- Native cleanup: Main releases history replies it reads and discards, cleanup replies are never refused by Worker backpressure, and restart closure finishes abandoned attempts.
- CI: terminal runs on GitHub Actions, CircleCI and paired computers reach a confirmed executor state and release capacity instead of retrying forever; CI hosts provision the native Codex package for offline installs; the production database gets CPU priority over disposable CI databases.
- Test reliability: board repeat-authoring and worker-file tests no longer time out under load.

## [0.0.108] - 2026-10-18

CI reliability fixes.
- CI setup validates the required native Codex payload before reusing or publishing a package install, and fails loudly instead of accepting an incomplete one; the pinned schema exporter is used from the CI install without downloading during tests.
- CI duration learning: a finished run's file durations are counted once even when two observations collect it at the same time; expired history is pruned after the collection commits, avoiding deadlocks.
- Board: duplicate refetches no longer start before the previous request settles in the CI dialog.
- Test fixtures: packaging tarballs store hardlinked files with their contents; the Board manual-positions suite runs in the heavy phase.

## [0.0.107] - 2026-10-18

CircleCI recovery and flake fixes.
- CircleCI: pipelines that finish processing with no workflow are recognised, cancelled and retried safely; late workflows from earlier attempts stay tracked and cancelled after ticket completion; an older attempt's failure no longer fails its replacement; deadline release clears executor cleanup.
- CircleCI usage: shutdown cancels slow credit refreshes within seconds, keeps pending exports for restart and finishes cache cleanup.
- Worker chats: terminal operation receipts wait for native cleanup, fixing a rollover race after compaction.

## [0.0.106] - 2026-10-18

CI correctness and speed.
- Full rounds: a CI part's setup retry no longer swaps its assigned test files for duplicates, so every full round runs every file.
- Affected integration runs select tests by recorded per-test coverage from full runs (with per-file static fallback, conservative handling of filesystem, subprocess and Worker-bundle inputs, and full scope for CI-host runtime changes), cutting typical selections by about two thirds.
- Cloud CI: GitHub "inputs too large" and throttling refusals, CircleCI trigger refusals and mirror publication failures are recorded as never sent and retried instead of stranding a ticket; mirror pushes recover from missing remote objects with a complete pack.
- Remote review: Stop waits for confirmed closure after graceful Main recovery.

## [0.0.105] - 2026-10-18

CI reliability.
- CI preparation fills the shared package store from the lockfile in an isolated staging directory under the repository lock, only when dependency inputs change, so test fixtures never download packages mid-run on slow computers; real fetch failures stop setup loudly; repositories with pnpm hooks install offline before taking the refill lock.
- Tests: build-preference placement waits for every computer's readiness before starting.

## [0.0.104] - 2026-10-18

Reliability fixes for flaky gate tests.
- Logging: a rotating log file no longer exceeds its size bound under buffered writes; retention keeps rotation order, never prunes segments still draining, and keeps running under continuous rotation.
- Tests: profile-check Start scope selects only checks for the updated provider version; hover-card help waits for the opened card.

## [0.0.103] - 2026-10-18

Owner bug sweep and edge-case hardening: owner-reported UI and backend bugs #1–#50 fixed, plus five edge-case reviews with eleven reviewed fix lanes.
- UI: Settings computers cards rebuilt with rename and colored harness/GitHub/MCP chips and one update button; compact sidebar computer and cloud icons with compute hovers; simpler skills and workflow settings pages; Board layered layout with movable nodes, straight and curved edges, newest container on top, resizable Agent chat containers; Operator and Agent chats share one composer (/plan only, no session options, no stray notices, empty chats hidden); auto-reconnect after the API returns.
- Agents across computers: chat, files, live settings, /new, /compact and /plan work for Agents on another computer; Claude replies stream; warm sessions shorten Operator replies; approvals answered from any computer settle once and survive restarts; one worktree is never shared by Agents on two computers.
- CI: a second CircleCI account can stand by as overflow when primary organizations run out of credits; CircleCI organization discovery and submission no longer depend on the dispatch-pass deadline; credit checks run after the final journal write; build-slot locks from reboots and empty slot directories are reclaimed; CI no longer prefers Main; per-computer priority and allowance apply.
- Storage and recovery: bounded test-fixture caches and retention; shared checkouts kept and charged after interruption; run recovery, archive, clock, attachment and output-validation fixes.

## [0.0.102] - 2026-10-17

Multi-computer reliability: the cross-computer Agent scenario (Main + two laptops, two repositories, Foreman CI on every computer + CircleCI + GitHub) passed two consecutive rounds, the second on the first round's leftover state.
- Remote execution: a Run no longer hangs after a link drop during session start; an expired laptop reply is re-read instead of being treated as a lost Agent process; queued device requests honor caller deadlines.
- Sources: finished Runs' retained worktrees are reclaimed oldest first when a computer's source budget is full; transient capacity pressure retries; capacity diagnostics are persisted and readable.
- CI: mirror pushes retry once on "missing necessary objects" at both push sites; dispatch delivery stays isolated from shared-pool saturation; Run activity is ordered at commit time, removing long advisory-lock waits.
- Tests: fixtures isolated from runner environments; flaky lock and carrier tests fixed.

## [0.0.101] - 2026-10-16

Multi-computer reliability round: the cross-computer CI scenario (Agents on Main and two laptops, two repositories, Foreman CI on every computer) passes end to end.
- Remote execution: retained reviewer authority, signal-scoped caches, output persistence and cancellation fixes; Worker update handoff recovery; device link reconnect and readiness fixes.
- CI: cloud cancellation waits for provider confirmation; fresh execution attempts keep their history; unsupported affected selection fails loudly (CI_SELECTION_UNSUPPORTED); executor speed lookup uses an index; Git credential prompts are reported as sign-in failures.
- Engine and history: execution authority reads cut from 62 to 10 queries; native history retention gap and oversized event paging fixed; stop and classification fixes.
- API load: cached MCP catalog with per-request grant checks; batched systemd unit-state queries; cached Syncthing probe.
- Scenario Agents use gpt-6.1-sol.

## [0.0.100] - 2026-10-14

Agent loops: an Agent node in a workflow can loop (re-activate) on an interval while its Run is active and stops when the Run ends; "Interval checks" are now called Loops everywhere, and each loop can carry its own prompt (node.interval.prompt) in the UI and through Operator MCP. Workflow schedules, which start Runs, stay separate.
Paperwork removed: device connection changes need no owner approval (pairing is the approval); harness plugin/MCP routes accept bearer callers; Tailscale hosts are accepted with normal auth; workspace locations and folder browsing accept any folder.
Fixes: plugin operation principal IDs; artifact edge and result cache test races.

## [0.0.99] - 2026-10-14

CI speed round:
- Gate plans skip occupied build computers and fall back to an occupied one only when no free one is eligible.
- Unit gate parts are budgeted from measured file durations.
- Cloud completion polls are prioritized; mirror publication overlaps planning.
- Cloud setup skips redundant work on validated package-cache hits.
- CircleCI Suite output is read through REST instead of CLI subprocesses; just-finished passed jobs stay pending until their artifacts are visible.
Flake fixes: Start contention teardown waits for settlement; edit-intent recovery no longer depends on real waits.

## [0.0.98] - 2026-10-14

### Prototype simplification
- Settings and workflow edits use last-write-wins with optional revisions and generated command IDs; removed location, presentation and geometry baselines.
- One `ci` action for CI; credentials that could start jobs get it automatically. Default Codex workflow approval policy is `never`; tracked source is captured without path approvals.
- MCP inputs strip unknown fields; Operator credentials no longer expire by default.

### CI speed and reliability
- `ci_run` returns without waiting for unrelated dispatch or cleanup; preparation time is logged per phase.
- CI mirror publishing keeps source alternates out of the mirror clone and reads source commits only in their own clone.
- Cloud setup failures requeue once on another slot; Workers that reconnect wake enrollment and dispatch.
- Orphan CI compose networks and resources are reclaimed; cleanup tolerates resources another slot already removed.
- Releases accept validated reruns of failed gate parts (`--rerun`), including reruns split across computers.
- Integration shards reserve 1.5 GiB each (measured), so build computers no longer swap or refuse source work under gate load.
- The API no longer spawns a lock process per retained CI run on every status poll, and listing CI computers no longer waits for cloud recovery sweeps: gate admission drops from about 100 s to under 10 s.
- CI admission no longer fails for pushed commits that are missing from Main's shallow clone; CircleCI jobs without artifacts finish collection.

### Product fixes
- The web app reconnects automatically while the API restarts and keeps domain errors inline.
- Source reservations admit one preparation on an idle low-memory host.
- Workflow source closure backs off instead of retrying hundreds of times a minute.
- Large workspace and graph reads are truncated newest-first.

## [0.0.97] - 2026-10-13

### Fixes from the connection audit
- 122 confirmed connection-audit findings fixed across CI host, runs, interactions, conversations, harnesses, sources, contracts, worker, scripts and the web Board, each with a regression test that fails before the fix.

### CI
- Gate mode: one complete typecheck, lint, unit and integration gate, planned from recorded durations; checks run ahead of integration overflow.
- Idle build computers take unstarted gate parts (cloud-planned and other busy build computers' parts); gate check parts run on any free equivalent slot.
- Cloud starts no longer wait for mirror pruning; each commit is published once per mirror.
- Admission does slow commit resolution outside the command transaction; no statement timeouts under concurrency.
- A failed gate releases the full-run barrier; lost build-computer starts and ended CircleCI runs are reconciled instead of holding slots.
- CircleCI pipeline parameters match their declared types; config errors surface immediately.
- NUL bytes in CI logs no longer stop dispatch.
- The hang watchdog covers only test suites, with no deadline for unknown durations and a three-minute idle limit.
- Warm runners, one Vitest coordinator per integration slot, reused Worker fixture releases and leaner cloud caches.

### Production install
- The post-deploy CI smoke authenticates with a short-lived, audited install credential.
- Deploys back up the database only when migrations are pending, and before stopping the API.
- API CPU hot spots removed (mirror pruning, process report calls, log slicing).

### Faster CI and deploys
- Full gates finish in about 9-10 minutes instead of 20-40: shard sizing respects each computer's build allowance, CI PostgreSQL is sized by shards, the planner learns each executor's speed, and cloud slots are reserved for non-gate CI.
- Deploys take about a minute: persistent source tree, shared API dependency trees, background Worker artifact publishing and release pruning, and a faster pre-migration backup.
- The API drains in-flight requests for up to 10 seconds on shutdown instead of being killed.
- Affected CI runs over 2000 files fall back to a full run instead of failing; affected runs reuse passes of files whose inputs did not change.
- Paired Workers download runtime updates before draining, so CI is no longer blocked while an update downloads.
- Releases reuse the clean gate of the release commit instead of running a second round.

### Product
- Agent chat UI improvements; the 1000-lines-per-file lint rule is removed.

## [0.0.96] - 2026-10-12

### Fixed

- The v0.0.95 web build failed on test-file type errors; this release ships v0.0.95's changes.

## [0.0.95] - 2026-10-12

### Changed

- Board Agent chat redesign with live Agent activity (tools, commands, files, plans) while an Agent works.
- CI queue entries say why they wait.

### Fixed

- Releases no longer interrupt running Agents: computer pins survive shutdown and credential leases are renewed safely across the restart.
- Long Loop runs no longer starve on "source staging budget": finished executions release their workspace copies.
- A dropped Codex app-server connection reconnects and resumes the Agent's thread instead of ending the Run; interrupted Runs keep the failure reason.
- Integration CI: only the few tests that need a build computer wait for one; everything else spreads over cloud slots, and a cloud slice can no longer take the build computer its sibling needs.
- Agent chat history paging, late responses, live tool status and Claude tool details; bounded chat memory.
- Sidebar computer icons keep their width; harness icons have readable contrast in both themes.
- Worker restart no longer fails with WORKER_WORKFLOW_UNAVAILABLE.

## [0.0.94] - 2026-10-12

### Changed

- Sidebar: computers, cloud CI and harnesses are icons (Claude orange, Codex blue) with details on hover; computer icons show a running ring, count and a pulse on new work; entries are buttons, so no browser URL preview appears.
- Workflows can be reordered by drag and drop in the sidebar; switching workflows shows fresh status at once.

### Fixed

- Agents' CI results: full CircleCI logs, an exact file:line location for each failed test, fast log reads while a cloud run is collected.
- Cloud CI mirror pushes no longer fail when several tickets start at once.
- A CI ticket whose commit the public mirror refuses fails at once with the reason instead of waiting forever.
- Worker unit tests run on GitHub Actions (podman path length).
- A Checker's failures reliably reach the Fixer: routing guidance tells Agents that finish hands off and return only answers the requester.
- CI reads no longer take database locks.

## [0.0.93] - 2026-10-12

### Changed

- Board: no CI ticket strip, Jobs drawer, status strip, "Start here" badge, edge labels or arrows; the CI server is a tower that appears automatically on every workflow; subagents are small nodes around their Agent; nodes can be selected and moved during a Run; edge clicks open nothing; hover controls no longer flicker.
- Sidebar: compact Computers rows colored by load with a hover detail card; harnesses share one row.
- The app reloads itself after a release when nothing is unsaved; many notices and boilerplate texts removed.

### Fixed

- Long chatty Agents no longer die with NATIVE_HISTORY_GAP when the database stalls.
- Cloud CI (GitHub Actions, CircleCI) shows live steps and log lines; provider polling is bounded with backoff; the CircleCI CLI no longer spawns telemetry processes.
- Affected unit-web/unit-other CI parts no longer fail connecting to a database they do not use.
- ci_logs_read clamps maxBytes instead of rejecting large reads.

## [0.0.92] - 2026-10-12

### Changed

- The Board's CI server is drawn as a server tower with drive-bay status lights.

### Fixed

- A test no longer names a fleet computer, which had blocked all cloud CI through the public mirror.

## [0.0.91] - 2026-10-12

### Fixed

- Board: an Agent woken by its interval check shows "Checking · check N" instead of Idle.
- Board: CI no longer shows "unavailable" (CI routes registered after startup); subagents load while projections catch up.
- Agent chat shows the transcript while starting/running and allows follow-ups after completion.
- Board node action icons appear on hover; nodes can be moved and resized during a Run.

## [0.0.90] - 2026-10-12

### Fixed

- Deploying a new release no longer interrupts running Agents: harness qualification no longer depends on the release install folder.

## [0.0.89] - 2026-10-12

### Fixed

- Stopping a Run cancels its Agents' CI tickets and provider runs.
- ci_computers_list shows each computer's running tickets; a just-triggered CircleCI run is not an error.
- The web app offers a reload after a release instead of failing Operator settings and chat checks.

## [0.0.88] - 2026-10-12

### Fixed

- Ships the v0.0.87 CI distribution change (v0.0.87 failed to build).

## [0.0.87] - 2026-10-12

### Fixed

- CI distribution: CircleCI now takes typecheck, lint, build and unit parts too (all but the podman Worker unit tests) instead of leaving checks queued behind GitHub slots.
- The systemd restart integration coverage is split to fit the runner watchdog; a retired source-text test became a behavior test.

## [0.0.86] - 2026-10-12

### Fixed

- Agent start: source preparation 93 s → about 15 s (no redundant copies, batched writes, shared Git imports).
- A restart during source preparation no longer leaves Runs queued forever; native qualification survives restarts.
- Database: 1 s pool acquisition with one retry for read-only MCP tools; native activity query 7x faster; CI group index.
- Agent sessions survive short database stalls instead of losing their lease.
- A failed execution start is always persisted; abandoned starts are reconciled.

## [0.0.85] - 2026-10-12

### Fixed

- A "model at capacity" turn failure is retried in the same session with backoff instead of failing the Run.
- An Agent whose final result breaks the handoff contract gets up to two corrective turns before the node fails.
- Foreman Code MCP no longer fails to start because of a credential-binding race at session start.
- Changing an Agent's model or profile moves its workflow node placements on save; agent_update lists affected workflows.

## [0.0.84] - 2026-10-12

### Fixed

- After an API restart, running Agents and their interval checks are re-adopted before source verification and finish normally (restart survival, part 4).

## [0.0.83] - 2026-10-12

### Added

- Per-role native tools: Orchestrator and Coder Agents load only Foreman Code by default (no host MCP servers or apps); the Operator inherits host settings. Per-Agent overrides and Operator MCP parity.

### Fixed

- Runs in a GitHub workspace start their Agents from the current default-branch commit instead of an old approved snapshot; unchanged Agent CI tests that commit.
- A recovery record left mid-publication no longer kills an Agent's interval check.
- Tests that need user systemd run only on build computers; a script test no longer leaks its CI environment.

## [0.0.82] - 2026-10-12

### Fixed

- Agent processes and interval checks survive an API restart during a check (restart survival, part 3).
- Fast MCP calls: `ci_get` reads stored CI status and log tails instead of waiting on fleet dispatch; CI keeps dispatching and finishing in the background.
- Long Agent sessions no longer fail when their event history passes the graph JSON limit.
- The changelog no longer blocks the public CI mirror.

## [0.0.81] - 2026-10-12

### Fixed

- Agent worktrees on Main and Workers get a repo-local Foreman Code Agent Git identity when none is set (reported by an in-app Integrator Agent).
- A transient database timeout (read or statement timeout) no longer kills running Agents or interval checks; bookkeeping retries while the native session is kept. Ownership loss, Stop and real failures still close.
- Laptop CI: legacy runtime preparation no longer loops; Host CI readiness is reported correctly (the second laptop is ready).

## [0.0.80] - 2026-10-12

### Fixed

- Running graph work and interval checks survive an API restart: preservation is decided before handoff cancellation, and closure retries keep that decision.

## [0.0.79] - 2026-10-12

### Fixed

- Running Agents survive an API restart or hot swap: the service unit stops only the API process (KillMode=process), so native sessions detach and are recovered.
- Agent executions start faster: source preparation reads the snapshot in qualified directory batches (4,573 file scopes → 561) and shares Git bootstrap handles; stage timings are logged.

## [0.0.78] - 2026-10-12

### Changed

- Interval checks run outside the workflow's parallelism limit, so a watcher can check while other Agents work.
- Agent executions start faster: source files are prepared, copied and verified in parallel.

### Fixed

- Laptop CI preparation: the root binding owner mismatch that failed every minute; retries reuse the same source capture and back off (up to 1 hour) with the failure shown in enrollment status.
- CI computers prune verification images no profile needs; settled Runs' source copies are reclaimed.
- CI volumes are sparse (32 GiB default) instead of fully allocated 96 GiB; leaked CI seed receipts; approved-root identity survives remounts and reboots.
- Flaky remote-review recovery tests (connection epoch before installations).

## [0.0.77] - 2026-10-12

### Added

- CI server on every Run Board: it lights up while CI runs, sends a light from the requesting Agent and back with the result, and opens a Jobs / Tests / Log modal with Passed / Failed / Skipped filters. CI records per-test results; Operator MCP `ci_list` and `ci_get testStatus` read them.
- Per-Agent interval checks (off by default): an Agent node can re-check its work every N seconds/minutes/hours beside the graph, with the Agent MCP tool `run_status_get`. At most 1,000 checks per Run.

### Fixed

- Full suite green: Codex threads before their first turn, restart recovery of running turns, remote owner interruption cleanup, CI runner start/exit races, laptop CI umask.
- Board forms no longer fill browser storage with the whole Agent catalog ("Changes can't be kept in this browser").
- The sidebar keeps computers and their last readings through slow refreshes.

## [0.0.76] - 2026-10-12

### Added

- `ci_run` accepts `baseCommit`: affected selection compares against that commit, so Agents can ask for "changed since the last release" without running git.

### Fixed

- Stopping a Run converges when its native owner is gone, so stuck Runs settle and their workflows can be archived.
- A planned API restart keeps active Agent turns and resumes them instead of interrupting them.
- Workflow and workspace lists refresh live; CircleCI trigger parameters stay under its length limit; remote source preparation no longer overflows its timer.

## [0.0.75] - 2026-10-11

### Fixed

- Remote workflow Agents register their Foreman Code MCP launcher route before the session starts, so their MCP tools load.
- Workflow turns start only after Codex reports the Foreman Code MCP server connected with tools; the managed launcher entry sets MCP startup and tool timeouts.
- Approved Git objects are imported in batches, so large repositories materialize; failures keep a safe diagnostic.
- MCP schema conversions are shared by schema shape; aged snapshots are released every ten minutes; production statements get five seconds.

## [0.0.74] - 2026-10-11

### Fixed

- A transient failure refreshing an Agent's App credential is retried while the credential is valid instead of stopping the Agent.
- Reconciliation closes executions whose native owner is gone and backs off per Run instead of retrying in a hot loop.
- Paired Workers reconnect by themselves after Main restarts and retry an interrupted self-update.

## [0.0.73] - 2026-10-11

### Fixed

- A paired Worker no longer stops admitting Agent work while an obsolete CI runtime refresh is pending; cross-filesystem quota relocation is skipped safely.
- The Worker MCP installer builds on platforms without `process.getuid`.

## [0.0.72] - 2026-10-11

### Performance

- MCP request servers, payload validation, source directory identity checks, canonical graph JSON and launcher discovery do less repeated work under load.

### Fixed

- A Worker update keeps its managed Foreman Code MCP launcher entry recognized when its Node interpreter changes.

## [0.0.71] - 2026-10-11

### Performance

- The production API database pool has 40 connections instead of 10.

## [0.0.70] - 2026-10-11

### Performance

- MCP requests reuse tool JSON Schema conversions instead of rebuilding ~250 schemas per request.

### Fixed

- A transient database timeout on a native lane lease renewal is retried while the lease is still valid instead of cancelling the Agent.

## [0.0.69] - 2026-10-11

### Performance

- Main no longer rescans every native process record: observations are cached and confirmed retired records are pruned.
- Idle filesystem identity walks, telemetry reads and executable probes are cached, freeing the API's main thread under load.

### Fixed

- Shutdown waits for unstarted guardians and drains retained reviewer operations before releasing runtime ownership.
- Closing during a native start waits for it to settle instead of failing the restart closure.

## [0.0.68] - 2026-10-11

### Fixed

- Run readback (`run_get`, events, activities) reads an unlocked snapshot instead of waiting behind writers; a database timeout on a read returns a retryable error instead of an internal error.
- Snapshot release deletes files after committing its fence, outside the storage lock, so concurrent Agent preparations no longer time out.
- Main's automatic Codex qualification retries a transient unreadable version from an unchanged binary.
- Restart closure drains a rejected native startup before disposing its manager.

### Tests

- Flake fixes for Claude approval composition and installed workflow receipt transfer fixtures.

## [0.0.67] - 2026-10-11

### Fixed

- Agent preparation no longer scans every retained source snapshot under the shared storage lock; release runs only under storage pressure or in maintenance, so many concurrent Agents no longer time out Main's database.
- Integration test slots are reused only after their database cleanup is confirmed.

### Tests

- The live CI scenario disables its Codex profiles when it finishes; host CI MCP coverage shares one database per file.

## [0.0.66] - 2026-10-11

### Fixed

- Concurrent Run starts on one computer queue for up to 30 seconds instead of failing with a database timeout; a busy start returns a retryable `RUN_START_BUSY`.
- Main re-qualifies Codex automatically after a restart whose startup checks timed out.
- A source snapshot that is a root's current binding is never released; placement choices show unusable computers with the reason.
- Failed capture cleanup no longer holds storage locks during file work, so approvals do not time out while cleanup runs.

### Tests

- Live cross-computer CI acceptance scenario restored for two projects, counting cloud runners as computers.

## [0.0.65] - 2026-10-11

### CI

- `ci_run` defaults to affected tests; the runner selects them against the workspace default branch when no files are given, and `scope: full` runs everything.
- Host CI runs any repository's own package scripts as single jobs, and Agent CI requests appear in the Run's activity and on the Board.
- The heavy web unit phase runs as two shards; CircleCI takes up to 28 integration parts at once.

### Sources

- Stuck preparing source captures are reclaimed, and source storage capacity is sized from the host instead of fixed limits.

## [0.0.64] - 2026-10-11

### CI

- Integration partitions prefer CircleCI and build computers; GitHub Actions slots stay free for check and unit parts while they wait.

## [0.0.63] - 2026-10-11

### CI

- CPU-heavy integration files count as two slots, so a small runner never runs more heavy work than its CPUs carry.
- CircleCI takes integration partitions only; check and unit parts run on GitHub Actions or build computers.

### Fixes

- A Worker chat continuation no longer stalls when Main's reconciliation runs before the Worker journals the turn.

## [0.0.62] - 2026-10-11

### CI

- Host CI uses only computers whose build participation is enabled, in their build priority order.
- Build computers prepare the test database and harness CLIs for unit and integration parts, as cloud runs do.
- CPU-heavy integration files are spread one per partition.
- `ci_computers_list` lists cloud CI slots; Main reads CI runs a few at a time; concurrent `ci-remote` commands share one pushed snapshot and name their parts.

## [0.0.61] - 2026-10-11

### CI

- CI runs on GitHub Actions and CircleCI through a public mirror of the code (fresh history, private names refused), together with the build computers; the full suite takes about five minutes.
- `pnpm test`, `typecheck`, `lint` and `test:integration` run on Main's CI unless on a CI machine; agent runs test only what their changes affect.
- Unit, lint, typecheck and build split into parts on separate machines; runs start and are read concurrently; one mirror push per commit.
- An integration file still running after three minutes fails; fixed sleeps in integration tests are lint errors; failing files keep their full logs.
- Test databases are cloned from a migrated template; Worker artifacts and fixtures are cached by content across runs.

### Accounts

- Several Codex and Claude accounts per computer, managed under each Settings harness card: sign-in, defaults for new work, removal, and per-account models; saved Runs and chats keep their account.

### Computers

- The sidebar shows live CPU, memory and disk for every computer (paired laptops now report without a Job runtime) and the cloud CI services with their machines in use.

### Fixes

- Remote review continues across Main crash, expired receipts and graceful restart; Main restart closure and remote disposal settle.
- Many race and timing fixes in tests found by the cloud runs.

## [0.0.60] - 2026-10-11

### CI

- Integration partitions are sized by each computer's measured speed so they finish together.
- Hung integration files are stopped at an adaptive deadline from their usual duration and reported as HUNG with the last case and output.
- Main learns per-file durations from every run and uses them for partitioning and deadlines.
- Exclusive integration files run after the parallel work instead of idling slots mid-run; dedicated CI computers fill every slot.

### Fixes

- Git error output no longer reaches public errors (F160); Worker Claude file calls keep per-tool cancellation (F179); send recovery survives a post-admission 401/403 (F193); attention summaries include standalone native requests (F207).

## [0.0.59] - 2026-10-10

### CI

- CI runs directly on build computers, like self-hosted runners: each computer fetches the commit with its own GitHub login, installs packages and runs the repository's own scripts in a fresh worktree, capped by a systemd unit. Integration can be split across computers with `partitions`. The container image, offline seed and qualification path is no longer used.
- Paired Workers download updates from a GitHub release instead of through Main.

## [0.0.58] - 2026-10-10

### Workflows and Runs

- Run the Board's selected Run in place: the Selected Run sidebar is gone, Runs has a New run entry, Run names use one short id, and subagents orbit their agent with details beside the selected orb.
- Resize agent circles by dragging their border on draft and Run boards.
- Workflow edits are no longer blocked by finished Runs that used their own worktree, recovered detached native sessions, or a delivered work direction.
- Board header shows the workflow worktree, confirms renames, and supports Board-wide undo and redo with notices recorded in Run Activity.
- Separate agent Chat, Settings and Info surfaces, with Activity as an Info tab.

### Paired computers and CI

- Paired Workers prepare and adopt managed CI storage automatically after pairing, reclaim CI runtime storage, and stop repeated enrollment refreshes.
- The installed Worker service can use the installed CI quota and rootless container helpers; CI workloads still enforce no-new-privileges.
- Worker self-updates are no longer cut short by managed-setup retries, and an interrupted update is retried automatically.
- Computer maintenance history is bounded across MCP and Settings.

### Look and feel

- Aurora palette: livelier colors and glow across the app and Board canvases.

### Production

- Installs wait for active Runs before restarting the API and prune old releases, keeping the current and previous release.

## [0.0.57] - 2026-10-10

### Production and paired computers

- Automatically update paired Workers to Main's release over the authenticated computer connection. Updates wait for active work to finish, support rollback, and expose saved status and retries in Computers settings and Operator MCP.
- Refresh managed launchers when upgrading the canonical production instance. Open the production dashboard automatically only on an interactive first install.
- Package newly required Worker modules with the installed Worker so paired computers can use the release's shared services.

### Bug reports

- Agents can report problems with Foreman Code features and MCP tools. Settings > Bugs lists reports newest first, with status and severity filters and report details; the Operator can manage reports through MCP.

### Prompt settings

- Edit the app system prompt and the Operator's initial prompt in Settings or through Operator MCP, with revision checks, audited changes and safe retries.
- Capture prompts when a session starts and use the saved app prompt in Codex and Claude workflow and chat contexts. Prompt editors show clearer breadcrumbs and navigation.

### Provider accounts

- Add multiple named Codex and Claude accounts with isolated credentials, subscription sign-in or API-key authentication, status refresh and per-provider defaults.
- Select provider accounts for Agents and the Operator through shared settings and MCP services, keeping credentials on their computer.

### Workspace Git and worktrees

- Prepare workspace GitHub repositories from workspace settings or Operator MCP, with saved recovery for interrupted imports.
- Configure workflow and Agent worktree choices, inherit saved selections during execution, and show the selected worktree in saved workflow and Run views.

### Verification

- Add a dense repository test gate that schedules the complete unit, integration, web smoke and script suites alongside lint, typecheck and build according to available CPU and memory. Reports identify missing coverage, failures and flaky retries; acceptance remains a separate gate.

### Fixes

- Read saved execution results without recomputing routing, and show server errors and failure codes in the saved Run inspector.
- Preserve Agent timeout causes through cleanup and recovery, allow six-hour defaults, and keep Stop authoritative. Recover failures around native session creation and uncertain publication without leaving idle sessions behind.
- Keep Board edits recoverable after rejected Agent worktree changes, and preserve browser drafts through temporary local authentication lookup failures.
- Report missing workspace CI templates during enrollment instead of implying readiness.
- Improve harness discovery and fleet maintenance retries, preserve explicit harness selections, and show quota errors and skipped credentials in the UI and Operator MCP.
- Reuse database transaction connections for provider account lookups so production startup and settings writes work with a single-connection pool.
- Avoid repeated Worker payload hashing during workflow startup while retaining fresh identity and launch checks. Reject missing explicit Claude API keys before session admission.
- Improve workflow, settings, computer pairing, plugin and MCP error handling, cancellation and saved-state readback.

## [0.0.56] - 2026-10-10

### CI across computers

- Automatically enroll saved workspace CI and Job profiles on connected, build-enabled computers, including Main, prepare their runtimes, and reuse enrollment after reconnecting. The Operator can read enrollment and enable or disable each workspace/computer pair through `ci_enrollment_get` and `ci_enrollment_update`; disabling new placement leaves accepted Jobs intact.
- Prepare Main as a build computer through `build_computer_prepare`, with persisted preparation that resumes after Main's runtime refresh and restart.
- Reuse verified CI images across source-only commits when dependency inputs, runtime controls and platform match, while capturing fresh source for qualification. Runtime status reports image reuse.
- Qualify integration runtimes with a committed smoke subset covering PostgreSQL, migrations, MCP, sources and Jobs; ordinary integration CI still requests the full suite.
- Queue Jobs as “Waiting for source capacity” when source slots or disk capacity are exhausted, with persisted retries up to one minute apart. Waiting does not consume the source preparation timeout; queue deadlines and cancellation still apply.
- Retire unused runtime configurations, images and installer copies, and reclaim interrupted build inputs while protecting current profiles, accepted Jobs and pending qualifications. Image pruning checks installation ownership and preserves images with other tags or container references.
- Keep seed and context receipts immutable across rebuilds, and retain receipts and qualification sources needed by installed configurations.
- Isolated verification reports required native-containment, Docker Compose and installed-Worker suites as unavailable when their capabilities are absent. Required unit and integration coverage stays incomplete and returns a nonzero result until it runs on a capable host; published reports retain the missing-capability details.

### Operator MCP

- Return each Operator MCP tool result as one compact JSON text item, cutting tool discovery and result size. `workspace_list` returns compact summaries by default; pass `detail: "full"` for complete records. Denied calls return a structured `{ error: { code, message } }` result.

### Agents/workflows

- Set each workflow's Agent active-time limit in Workflow settings or through Operator MCP, or clear it to inherit the server default. Runs use their saved WorkflowVersion's limit and retain existing approval-wait and recovery accounting.
- Keep authorized Agent and CI source-root bindings available when a workspace moves to another computer and back, without rewriting saved roots, runtime profiles or Run history.
- Keep Agent worktrees out of a computer's CI source-slot count, and preserve installed source-quota ownership when authorized snapshots or workspace bindings change.
- Account for Agent attempts, Jobs and pending Job preparation together. Exhausted budgets and preparation timeouts enter terminal cleanup with their original failure reason preserved across restart; Job outputs remain available to downstream Agents and repeat blocks.

### Harnesses

- Detect installed Codex and Claude updates and automatically recheck previously qualified, enabled configurations before new launches. Main also requalifies a previously qualified Codex after restarting; pending checks and failures are visible through HTTP and Operator MCP. Existing sessions retain their accepted installation and profile facts.
- Show installation status in the sidebar separately from sign-in and execution qualification, so an installed harness is not marked missing because a preset check fails.
- Cache unchanged Codex and Claude payload fingerprints for passive inventory on Main and Workers, while keeping qualification and launch identity checks fresh.
- Allow cold native version checks more time after installation hashing, and report `HARNESS_CHECK_TIMEOUT` instead of an internal error. MCP detection has a two-minute overall inspection budget with bounded individual commands and cancellation.
- Repair the app-managed MCP launcher when its recorded Node interpreter has been removed, while preserving customized entries. Launcher lock waits now honor cancellation and deadlines.
- Keep MCP settings reads fresh after writes, reject failed refreshes instead of serving stale success indefinitely, and validate the saved workspace directory before HTTP or Operator MCP diagnostics.
- Fleet MCP sync warns about unsupported disabled definitions, tool restrictions and credential-reference settings, and preserves existing Worker entries for those skipped definitions instead of silently removing or changing them.
- Preserve the original error when native diagnostic admission fails before reserving a launch, roll back failed reservation publication, and report full recovery storage as `HARNESS_RECOVERY_STORAGE_FULL` without inventing process-closure evidence.

### Fixes

- Runtime qualification retries reconcile the original operation after an uncertain result, expiry, profile edits or a confirmed reboot before launch. Older attempts cannot overwrite newer qualification results; HTTP and MCP readback distinguish operation history from current readiness and expose operations needing recovery.
- Runtime readiness rechecks current root authorization, runtime configuration and mount-tool identity, and rejects stale Worker inspection responses. CI preparation rejects missing, changed or revoked computers and joins canceled preparation and cleanup during shutdown.
- Recover owned containers interrupted before launch as preparation failures only after confirming cleanup, without fabricating an exit code or allowing a late start.
- Report full CI storage with observed byte and inode usage and limits, or explicitly unavailable quota readback. Preserve known source cleanup and authorization error codes across the Worker channel while redacting private details.
- Create project folders with an atomic move that preserves directory identity and refuses collisions or cross-filesystem copying, including on CI images without GNU `mv --no-copy`.
- Make workspace location retries atomic with their receipts and audit records, protect folder validation against concurrent deletion, and prevent the legacy location setter from removing modern root evidence. Folder errors are actionable, the compact picker can reload stale saved locations, and reselecting a replaced folder repairs its identity.
- Read approved remote and additional Main workspace folders through their saved host policies, and distinguish identical paths on different computers during cleanup. Close project-directory handles when runtime-root acquisition fails.
- Preserve mounted pages and local drafts while the browser automatically reconnects after network errors or temporary server failures.
- Bind Worker installations to their canonical state directory and serialize setup and Companion activation with updates. Artifacts use the product release version; recovery instructions require the retained release's matching Node runtime. An open Companion detects installation changes, and activation success requires a fresh active-service check.
- Package the CI context builder and its dependencies inside the deployed API and Worker artifacts. Private preparation Git commands ignore inherited outer Git paths, fetch partial-clone objects before capture, and qualify the installed PostgreSQL binary and version.
- Give nested verification commands separate report directories, support the offline production `pnpm deploy --prod --legacy` invocation, and preserve frozen dependency and release-age policies. Correct CI fixtures for isolated source trees, current enrollment and workflow contracts, and deterministic native chat-delivery faults.

### Known issues

- `computer-workflow-save.regression-directories` and `computer-workflow-save.regression-reservation-cleanup` can time out in full parallel integration runs: a second remote Codex execution stays in `starting` after Worker qualification. It passes in isolation; a fix is planned for the next release.

## [0.0.55] - 2026-10-09

Known issues: under heavy parallel load, Main can shut down before a completed remote Agent session has closed, leaving its Run for reconciliation (seen only in the computer-workflow-save test). A Worker's unit-test verification profile cannot qualify while its tests run inside an overlay-root container. A workspace located on another computer cannot start CI runs from that computer (RUNNER_UNSUPPORTED). The real-model remote CI acceptance (an Agent running CI on Builder) currently fails with SOURCE_QUOTA_MISSING on the build computer and is being fixed.

### Added

- CI verifies several projects at once across every qualified build computer, and each workflow's CI activity shows its own requests.

### Changed

- Unit-test verification honors the worker limit the build computer qualified with.

### Fixed

- Completed CI queue tickets close, and a busy build computer is released when its Job finishes; preparation quota is reconciled when a source moves to another root, and the Run is locked before its Worker credential binding to avoid deadlocks.
- Computer maintenance queues same-kind tasks instead of rejecting them, keeps task results across restarts, and selects the maintained Codex on Main too.
- Fleet sync keeps each computer's own MCP servers and plugins through partial failures, delivers available catalogs even when one source is unreadable, and refuses inline MCP credentials.
- The Operator can delete and restore its own chats over MCP, and keeps requested chat drafts with retryable creation.
- Worker telemetry continues after a Worker reconnects; Worker profile checks use the Codex currently selected by maintenance.
- Verification templates report ready only when their computer's runtime is currently ready, and a failed runtime inspection marks the profile for refresh instead of reporting an old ready state.
- Computers shows an unknown account state when a GitHub, Codex or Claude sign-in check fails, instead of "Signed out" or a healthy badge.
- Qualification reports are kept after a runtime inspection fails.
- A CI or Job request with an explicit computer no longer waits forever as incompatible: matching names the computer and root, not the root attestation that each listing renews.
- CI no longer fails with INTERNAL_ERROR when one build computer rejects the commit for its root (for example after the workspace moved); the request queues on the computers that accept it.
- CI requests no longer fail with SOURCE_CAPACITY after a busy day of commits: when a new source capture would exceed Main's budget, snapshots that nothing actively uses are released before their retention window ends.
- Internal CI tool failures are logged on Main instead of surfacing only as INTERNAL_ERROR.
- Workflow Agents on Codex 0.16x no longer stop at a native approval prompt for each of their own Foreman Code MCP tools (for example `ci_run`); each call is still authorized by the Agent's grants.
- Build computer CI preparation no longer fails at the offline package install when the CI image holds a node_modules layout from another lockfile.
- Build computer CI preparation no longer fails with "Premature close" when tar finishes reading the qualification source before git writes its trailing padding.
- Build computer CI preparation streams the unit suite's Codex binary instead of buffering it, so it no longer fails on Codex releases larger than about 190 MB.

## [0.0.54] - 2026-10-09

Known issues: under heavy parallel load, Main can shut down before a completed remote Agent session has closed, leaving its Run for reconciliation (seen only in the computer-workflow-save test). A reboot that changes a Worker's storage device identity requires its approved roots to be re-approved. Computers status can briefly show harness versions read before an update finished.

### Added

- Update computers from Main: one action updates every computer's system packages (respecting Ubuntu phased updates), Codex and Claude, and reports each computer's result, including pending or unreachable ones.
- Main keeps every computer's MCP servers and Codex and Claude plugins the same as its own; additions and removals reach the other computers within about a minute.
- The Operator installs MCP connections and Codex and Claude plugins itself, and the harness settings cards show and install the Operator MCP.
- Syncthing shared folders per workspace and computer, synchronized over Tailscale with Main as hub, automatic pairing, simple file versioning, Computers status and Operator MCP controls.
- General settings shows per-computer workspace file sync; the theme preference is saved on Main and shared by connected browsers, with Operator MCP read and update support.
- Chat retention moved to General settings.
- Board Jobs button with a compact history of a workflow's Jobs; Jobs are otherwise managed by Agents and the Operator through MCP (`job_workflow_list`).
- Inspect executions from saved Run nodes.
- Settings pages show summary cards; detailed changes go through the Operator. Computers use one build priority order.

### Changed

- Update computers now updates the Codex each Worker actually runs, and a failed Codex update no longer skips the Claude update.

### Fixed

- Two CI runs started together in one workspace no longer deadlock in the database and fail one of them.
- Worker Agent chat no longer fails when the Worker takes more than 30 seconds to start the native session.
- Agent context reads no longer wait on a slow or unavailable shared-folder status.
- The Operator capability listing includes `job_workflow_list`.
- Many CI, Job queue, Claude preset, session control, workflow save and Run evidence fixes from the PR 59 review lanes.

### Removed

- OpenCode support. Saved OpenCode history remains readable as a retired, non-executable harness.
- Google Drive shared folders via rclone, including OAuth sign-in and mount services.
- The Jobs page and the Account page.

## [0.0.53] - 2026-10-08

Claude and OpenCode workflows across two computers remain untested. The available laptop provider logins support Codex only. Installed OpenCode workers refuse declared artifact outputs. Claude Agents run on Main only; laptops run Codex.

### Added

- Remote Orchestrator review turns on the original native session, with authenticated assignment and decision readback.
- Native artifact production, sealing, publication and Agent-to-Agent transfer for Main and installed Codex workers.
- Worker build targets for Ubuntu 24.04 and 26.04 x64 with Node 22.23.2, retaining exact OS, libc and runtime checks.
- Run CI Jobs on paired laptops: Main selects a qualified Worker, transfers the approved source and collects reports and logs.
- Mark build computers primary or backup and set how much of each computer's CPU and memory builds may use; backups take Jobs only when no primary has room.
- Place Claude Agents on Main in workflows that also run Agents on other computers.
- Workflow Agents run CI themselves: `ci_run` queues install, typecheck, lint, unit or build for their Run's workspace on the connected build computers, and `ci_get` reads the result (Operator MCP has the same tools).
- Computers settings lists each computer as a row in build order, with drag-to-reorder, Primary/Backup, builds on/off, build allowance and live CPU and memory; the sidebar shows busy computers and opens their running Jobs and Agents.
- Run CI for any commit whose dependency files match the commit a computer was qualified with.
- Computers settings shows, per computer, whether Codex, Claude, OpenCode, the GitHub CLI and Google Drive are installed and which account each is signed in to (`computer_accounts_list`).
- Sign the GitHub CLI in or out on any computer with a one-time code, from Computers settings or Operator MCP; git on that computer then uses the account.
- Give each workflow Agent its own git worktree and branch of the workspace's GitHub repository on its computer; the Run, the Board and `context_get` show the branch.
- Agent CI runs on the Agent's own computer first and moves to the next build computer in order only when its own is busy; it tests the Agent's current files, sent as a git bundle, with nothing pushed.
- Build computers prepare their own CI runtime for a commit with no human step: offline packages, verification image, profile update, protected refresh and requalification (`build_computer_prepare`, and automatically when a commit changes dependency files).
- Connect Google Drive on any computer through rclone: sign in to Google on Main, and the app's "Foreman Code" Drive folder mounts at `~/Foreman Code Drive` on that computer. The app sees only files it created in that folder (`drive.file`), not the rest of the Drive. Agents get their workspace's shared Drive folder from `context_get`.
- Update every Agent that uses an older version of a skill, and re-save the workflows that pin them, in one click (`skill_users_update`).

### Changed

- CI qualification on a paired computer no longer needs approval: capture its installed runtime and qualify it directly in the app or through Operator MCP.
- Default new OpenCode configurations to OpenCode Go models.
- Resolve unplaced Agents to authorized Main source, root and harness choices when a workflow has an explicit remote placement; retain every accepted node placement in the Run.
- Match saved Agents and qualified host presets using their shared effective settings while preserving omitted Advanced fields in immutable Agent versions.
- Page native history and large results, archive settled review payloads and rotate acknowledgment retries fairly.

### Fixed

- Deliver an Agent's instructions to Claude in workflows and Agent chat.
- Run the unit suite in CI with its own disposable PostgreSQL inside the offline verification image.
- Forget retired Agent worktrees so their branches can be checked out again.
- Run Claude workflow turns whose MCP check, execution correlation and terminal result now match the rest of the workflow engine.
- Replace a source transfer that expired on the Worker and wait for the Worker to reconnect, instead of retrying the expired transfer until the Job times out.
- Read per-Job quota source trees from their quota folder when preparing the private repository on a Worker.
- Report a missing project folder on Main or a laptop as `ROOT_DIRECTORY_MISSING` instead of an internal error.
- Wait 30 seconds before re-inspecting a Job runtime the Worker rejected, and retry immediately when only the Worker connection was pending.
- Reclaim expired Worker transfers before counting staging capacity for a new Job.
- Keep collecting Worker telemetry after one busy sample times out.
- Keep each computer's native qualification independent when multiple hosts check the same installed binary.
- Deliver approvals on the initial native connection and retain response history after the provider process closes.
- Finish source cleanup after the original native finalizer and use cleanup read authority without renewing model-tool access.
- Preserve original execution, process and journal ownership through reconnects, Main restart, worker crashes and credential renewal.
- Continue verified original sessions after a host preset changes while retaining latest enabled settings for new launches.
- Keep retained remote Orchestrator source claims active until the original process closes, preserving ownership and storage accounting during review turns.
- Retain the original scoped Worker credential atomically when an Orchestrator finishes its initial turn, preserving authenticated review access through credential cleanup.
- Start and recover fully placed Agent workflows using their accepted host directories while preserving the workspace selection and authorization checks.
- Keep scoped cancellation available on saturated channels and retry original approval responses only when non-delivery is proven.
- Keep Main available when a native catalog cannot select an automatic default model, persist its unavailable state and expose it through Settings and Operator MCP.
- Let an operator select one native preset while other harnesses remain unavailable, retaining native checks, revisions and idempotent retries.
- Forward explicit native acceptance file selections through the queued root command.
- Reduce native publication database reads by reusing validated records for one frame and combining fresh source, entry, receipt and lifetime queries; retain all ownership and commit checks.

### Security

- Retain sandbox permissions, scoped credentials, assignment checks and owner fences across local and remote artifact and review paths.
- Preserve kernel-backed native closure evidence and revalidate authenticated reconnects without authorizing replacement launches.

### Known issues

Released as is at the owner's request; these are open and will be fixed later.

- Integration: 7 files fail on this release (full run at 481740c4b: 237 of 272 files passed under heavy load; 13 failed twice, 7 of those still failed in a quieter rerun). Fixes for the first three are on branch `integ/crosscomputer-integfix3` (not included):
  - `workflow-schedule-placement`: `RUNNER_UNSUPPORTED` ("Runner 'local' is not supported by this API instance").
  - `job-queue-configuration`: duplicate key (23505) when restoring persisted runtime profiles.
  - `handoff-approval`: review resumes return `blocked_disconnected REVIEW_SESSION_DISCONNECTED` before the publication cut.
  - `remote-review-production`: times out waiting for the routed native interaction.
  - `computer-workflow-save.regression-directories` and `computer-workflow-save.regression-reservation-cleanup`: production runtime shutdown leaves runtime ownership unreleased.
  - `job-admission-queue` (five concurrent requests on one heavy slot) and `agent-chat-f5` (A-R15) time out.
- `scripts/test-integration.test.mjs` (part of `pnpm test:scripts`) fails to load: it imports `adminDatabaseUrl`, which `scripts/test-integration.mjs` no longer exports.
- The full integration suite and acceptance tests were not rerun after the last PR 59 review-fix merges.
- A failed or uncertain source activation can leave a materialization reservation with no owner. It counts against the computer's CI slots forever, so that computer reports `busy` and Agent `ci_run` Jobs wait indefinitely (seen on a paired laptop). A partial fix is on branch `integ/crosscomputer-reservleak` (uncommitted, not included).
- Main logs a `qualification-validation-debug` line on every runtime revalidation, which floods its log.
- Several PR 59 review findings are still open; their fix branches are not merged: `fix/pr59-accountsui`, `fix/pr59-buildsave`, `fix/pr59-compaction`, `fix/pr59-drive`, `fix/pr59-github`, `fix/pr59-launch`, `fix/pr59-sesssettings`.
- Browser journey tests of the CI and multi-computer workflow UI (Computers settings, adding Agents, running multi-computer workflows, Agent CI) have not been run.
- The integration runner in this release is the PR 59 one: the 0.0.51 and 0.0.52 changes (slowest-first scheduling with per-machine durations, launching Vitest directly) conflicted and are not in it yet.
- Google Drive sign-in uses rclone's shared Google OAuth client ID, which Google is retiring.

## [0.0.52] - 2026-10-08

### Changed

- Integration file durations now live in `~/.cache/graphql-disposable-tests/integration-durations.json` on each machine, so fresh snapshot checkouts (Builder lanes) keep the slowest-first schedule.

## [0.0.51] - 2026-10-08

### Changed

- Integration runs start the slowest recorded files first, using per-file durations kept in the Git common directory (`graphql-integration-durations.json`); unmeasured files run first.
- Integration files launch the workspace Vitest binary directly instead of through `corepack pnpm exec`, removing about 2.4 s of startup per file.

### Verification

- Runner unit tests (30) and lint passed; a focused two-file integration run passed and recorded durations.
- not verified: full `test:integration` timing comparison.

## [0.0.50] - 2026-10-06

### Added

- Add shared Operator and Agent chat session controls for manual compaction, Plan mode, context usage and supported native context settings, with matching HTTP and Operator MCP operations.
- Add capability-driven chat controls and persistent command receipts, preserving drafts, native session identity and denied-caller behavior.

### Fixed

- Keep native context observations separate from editable settings revisions and retain newer Worker receipts when replies arrive out of order.
- Give configuration inspection separate process ownership, preserve saved OpenCode connection facts and observed version, and retain the caller on authorized Agent control reads.
- Page complete MCP tool catalogs within existing Worker relay limits while retaining schemas, annotations, grant filtering and cursor validation.

### Validation

- Retain prior focused passing checks, including 85 conversation integrations, 123 Codex adapter cases, Worker ownership and callback checks, MCP catalog/permission checks, and actual namespace routing.
- Codex Operator on Main and device, Codex Agent on Main, and OpenCode Agent on Main passed their ordinary native control journeys on earlier candidates.
- Integrated main v0.0.49 once and passed direct typecheck and lint. Release was completed under the owner order without further native tests or a complete acceptance rerun.


### Verification

- not verified: paired Worker restart case (moved to crosscomputer lane)
- not verified / follow-up: Codex Agent/device first-turn callback timeout; remaining OpenCode Operator and device control journeys; Claude Full-access context-setting live coverage. Main’s explicit Full-access Claude policy is preserved.
- not verified / follow-up: browser acceptance and interrupted compaction dispatch recovery. The full session-control acceptance matrix is incomplete; no complete native or browser acceptance is claimed.
- not verified / follow-up: final caller-context and saved OpenCode inspection adjustments received typecheck/lint only under the owner release order; native reruns were stopped.
## [0.0.49] - 2026-10-06

### Changed

- Require explicit Full access for Claude profiles, presets and Agents at Save and Start through the UI and Operator MCP. Existing unsupported values remain readable until explicitly corrected; they are never upgraded silently.
- Retire Claude read-only and workspace-write execution policy and the custom AppArmor prerequisite. Application grants, permission rules and native qualification still apply to Full access.

### Fixed

- Retain the saved Claude host profile for local workflow execution and the complete accepted request during native inspection, including its execution context and correlation. Compare JSON values independently of object key order.
- Deliver the scoped application bearer credential to the inspected Claude HTTP connection before requiring connected health, while retaining endpoint validation and the SDK credential acknowledgement.
- Deliver pinned Agent instructions and verified skills through the Claude SDK instruction channel.
- Persist Claude native correlations through an upgrade migration and validate workflow completion against the original SDK result and native message receipt.
- Preserve sanitized native failure diagnostics before cleanup and keep detached desktop browser files outside temporary build directories.

### Verified

- Passed typecheck, lint, build and the affected contract, API, UI, authenticated MCP and PostgreSQL regressions, including denied callers, persisted Full access readback, invalid-mode Start refusal and database upgrade behavior.
- Installed and qualified Claude Haiku (`claude-haiku-4-5-20251001`) with Full access on the local PC; completed a saved-profile workflow with a real native session and accepted result.
- Confirmed Claude, Codex and OpenCode saved presets are eligible, installed services are active, the production database is separate, and the dashboard and desktop icons resolve.
- The approval-case timeout passed its single unchanged rerun. The installed service also recovered an initial database response deadline on its unchanged automatic startup retry; final installed verification passed.

## [0.0.48] - 2026-10-06

### Fixed

- Route managed MCP requests from native PID namespaces through the authenticated owning endpoint, preserving scope checks and revocation.
- Preserve the original active OpenCode turn generation during recovery, and recapture the same running output call when an approval observer releases its writer lease.
- Open the scoped Run graph publication before adopting artifacts with retained native approval receipts, preserving original approvals and publication results across restart.
- Register native fixture databases and recover only idle owned databases after process closure, retaining active or foreign resources for confirmed cleanup.
- Share private credential copying between the native runner and Haiku qualification fixture, preserving refreshed test credentials and the original host login.
- Apply the artifact restart fixture's exact four-approval and zero-join expectations to its single-entry scenario.

### Verified

- Completed all 20 previously untested single-computer OpenCode cases locally: artifacts, mixed-provider handoffs, review returns, joins, approvals, handoff limits, audited qualification, Agent chat fork and terminal human-access isolation.
- Qualified Claude Haiku (`claude-haiku-4-5-20251001`) through real native lifecycle and tool-policy checks. In-app Codex subjects used `gpt-5.6-luna` at medium reasoning; OpenCode used the pinned 1.18.31 binary.
- Passed focused unit, authenticated MCP and PostgreSQL regressions, plus typecheck, lint and build. Two timing-only failures passed their single unchanged-case reruns under the owner rule; assertions and deadlines remain unchanged.

## [0.0.47] - 2026-10-06

### Fixed

- Measure the selected executable's real hash in qualification deadline regression fixtures, so current integrity checks admit the valid candidate and reject a replacement before any native suite runs.

## [0.0.46] - 2026-10-06

### Added

- Discover owned Operator conversations and retry creation with a command ID without creating duplicates.
- Page Operator message history and activities through MCP, and inspect the configuration pinned to an existing conversation or request.
- Use separately scoped file and management capabilities together in Codex and OpenCode Operator turns, including attached-spec workflow creation and persisted readback.

### Changed

- Return authorized execution-location details from workspace updates and command replays.
- Recover owned OpenCode Operator sessions through observation attachment without issuing new management credentials or starting another turn.

### Fixed

- Recheck workspace mutation and replay authority under the command transaction, and require read access for Operator sends that return conversation state.
- Compensate failed workspace provisioning after receipt, audit or commit failures, retaining uncertain commits for recovery.
- Report malformed, unsupported and oversized MCP requests as safe client errors.
- Preserve file declarations, original native session history and both credential lifecycles when a text-first Operator resumes with an attachment.
- Retain split native fixture notifications through complete JSONL records and avoid saved-thread reads for stateless events, preserving burst delivery, bounded history and cursor coverage.
- Join already active Job preparations when draining queue work, so closure failures and recovery remain observable after an automatic rescan.
- Preserve process-closure refusal causes in source recovery diagnostics and archive requested native acceptance evidence before disposable storage is removed.
- Reconcile completed current-turn tool activity through its original native owner so saved Codex results can settle without conflicting with late-child activity guards.

### Security

- Audit direct calls to known tools hidden by grants, while preserving unknown-tool responses and failing closed when audit storage is unavailable.
- Keep file credentials separate from owner-delegated management grants; retain read-only harness policies, live revocation checks and scoped recovery ownership.




## [0.0.45] - 2026-10-06

### Added

- Read and retry dynamic harness compatibility checks through Operator MCP with the same contracts, grants and audit service as the local app.

### Changed

- Accept compatible Codex, Claude Code and OpenCode installations by checking their observed runtime contracts rather than exact release versions or recorded schema hashes.
- Prefer the computer's installed native Codex, with the bundled package as a fallback, and read model catalogs and supported settings from the selected harness.
- Recheck compatibility when launcher or native payload identity changes, while preserving recorded Run, WorkflowVersion and native-session provenance.

### Fixed

- Make newer compatible Codex installations usable with their own model catalogs, including Codex 0.160.0/0.160.1 and gpt-6-luna at medium effort.
- Resume saved native sessions across compatible harness releases without rewriting their historical version facts.
- Report the observed harness version and missing protocol contract when compatibility verification fails.
- Keep dedicated Codex and Claude native verification storage disposable, including cleanup after failed scenarios.
- Include the MCP client required by the Claude runtime in deployed production dependencies, so the compiled API can start.

### Security

- Preserve launcher integrity and path trust, credential isolation, read-only enforcement, sandbox settings, approval policy and authenticated host-bound qualification.
- Keep MCP and Worker credentials scoped and separate from the implicit local human; compatible-version checks grant no execution or write authority.

## [0.0.44] - 2026-10-06 - 2026-10-06

### Fixed

- Observe each provider's native startup event during installed recovery verification, requiring the bound execution and session and rejecting replayed history.
- Remove the installed test's runtime workspace after native cleanup on success and failure, while retaining production data and persisted audit history.
- Retire the obsolete installer-owned browser-access setting during production updates, preserving native provider configuration and MCP security.
- Give the standalone migration command a separate bounded DDL deadline while retaining API request deadlines, transactions and migration locks.
- Remove unsuccessful release staging without deleting an activated release or production data.
- Snapshot deployed API and workspace dependencies into independent files so later source builds cannot mutate an installed release.
- Read committed Run-only snapshots during native publication without taking a mutation-blocking Run lock; preserve live grants, immutable pins, locked execution detail and mutation/Stop checks.
- Cover delayed read/write responses, persisted write readback, replacement connections after SQL cancellation and bounded missing replies in the PostgreSQL deadline regression.
- Preserve the supported OpenCode credential key when disposable test storage changes launcher identity, with unit and live native preflight coverage for legacy configuration merging.
- Bind isolated OpenCode preflight and execution to the fixture-owned configuration file and directory, preventing a later source-directory override, restoring both settings during cleanup and preserving managed-launcher and credential checks.
- Use one private OpenCode user-profile entry for native execution and managed MCP setup, retaining source ownership checks and restoring the prior configuration home.
- Include the MCP client in production API dependencies so the compiled Claude runtime and installed API start without development packages.
- Retain server-side failure codes and locations for unexpected Operator MCP errors without logging private error text, tool arguments or credentials.
- Keep the native version-command deadline separate from installation verification and confirmed process cleanup during qualification, preserving binary guards and cancellation.

### Changed

- Verify compiled production hosting and scoped agent HTTP/MCP readback with denied callers after the noauth upgrade; verify credential-free human creation/edits in the actual browser without altering OS client attribution.
- Retain redacted private Operator failure events and attempt independent test resource cleanup when another cleanup step fails.
- Retain bounded database wait and blocker diagnostics during installed recovery verification.
- Document OpenCode runtime isolation, private native storage and the Node/Bubblewrap requirements after the installed file-runtime upgrade.

## [0.0.43] - 2026-10-06

### Added

- Explicit native harness approval handling for workflows, configured through the Board and Operator MCP with compatible pinned Agent settings and saved permission rules.
- Publish declared artifact outputs from local Codex/OpenCode and connected Codex workflow turns through authenticated MCP and retain their original publication records for recovery.
- Restore checkpoint-bound OpenCode approval sessions after verified restart without creating replacement native turns.

### Changed

- Retain every terminal handoff activation in Run output, including results from repeated review revisions.
- Preserve frozen activation inputs during upgrades and provide the original caller through trusted execution context.
- Sixteen real-native workflow cases covering OpenCode artifacts, mixed Codex/OpenCode handoffs, review returns, joins, approvals and handoff limits were verified locally in v0.0.48. All three Codex-only cases passed in the original gate.
- The OpenCode approval-wait lifecycle case was verified locally in v0.0.48.

### Fixed

- Give workflow native-output storage a distinct migration number after the published Operator terminal migrations, preserving both capabilities when upgrading an existing database.
- Preserve fresh original OpenCode terminal history after requester attachment, separating the current history observation from the original prompt submission generation.
- Restore the original requester from its saved approval checkpoint before recording a response, joining startup recovery and retaining native identity and delivery checks.
- Retain original Codex command output deltas when its completed command omits aggregated output, keeping native command, sandbox witness and process closure validation.
- Close fixture-owned native processes and remove isolated databases and private directories after successful or failed acceptance runs, retaining cleanup and verification failures.
- Accept the original first Codex transport generation for local and installed artifact storage, and recover its budget records without changing native identity.
- Preserve original approval checkpoints when restart begins before the active graph invocation releases its Run owner.
- Drain graph finalization writes along with activation tasks before Stop or restart releases ownership.
- Keep resumed native observation on one writer lease until another approval or terminal result, so original MCP artifact calls remain authorized.
- Cancel pending artifact adoption before restart locks the Run, then recover the same published output after recomposition.
- Pass pinned file references through strict download validation during artifact adoption while retaining hash, size, scope and byte verification.
- Adopt local workflow outputs after native settlement and resume unfinished adoption from the saved terminal execution after restart.
- Use the same pinned artifact declarations during preflight and execution, and lock Run parents before artifact execution rows to prevent publication deadlocks.
- Preserve original OpenCode call and permission names under both supported MCP connection names.
- Validate Codex sandbox probe command payloads within the selected shell wrapper while retaining original session, terminal and filesystem checks.
- Bind Orchestrator approvals to the accepted requester ancestry across delegated work, review returns and handoff-limit continuations.
- Settle permanent failures and enforce one execution budget across retries, queued activations, returns and denial continuations.
- Resolve choice branches and exhausted connections in separate causal join rounds, with replay-safe dispatch when branches arrive concurrently.
- Support combined handoff/artifact results, clean choice-node finishes and durable direction waits for accepted review findings or exhausted routes.
- Check derived return and notice sizes against persisted PostgreSQL envelopes before acceptance, including large numeric payloads.
- Preserve safely unsubmitted or settled handoff work across restart, and physically close invalid artifact turns while retaining validation failures.
- Reconstruct activation-result publication records for authenticated canonical graph reads after review cycles.
- Lock the Run before its execution when checking original native output approvals, preventing deadlocks with credential recovery.

### Security

- Run sandbox qualification from an immutable program in protected storage, retaining the original actor and descendant write-denial checks and verified cleanup.
- Keep native output storage outside agent write access, verify original native call ownership and sandbox policy, and enforce saved OpenCode permissions and original approvals for output operations.
- Retain grants, scope checks, native closure records and credential revocation through output publication and approval recovery.

## [0.0.42] - 2026-10-06

### Added

- Dedicated test PostgreSQL, owned disposable databases, and private homes, storage, MCP routes and runtime directories for each test invocation.
- Ownership and cleanup recovery checks for database-backed tests and native acceptance.

### Changed

- Root and API test commands, including selected-file runs, provision isolated resources and preserve current Foreman Code local-human and scoped MCP behavior.
- Installed production verification uses the separate `production:verify` command and refuses disposable test contexts.

### Fixed

- Keep source capture and qualification fixtures inside owned storage, join pending work on teardown, and keep controller Node startup options out of native commands.
- Local smoke shutdown drains pending web requests before closing its dev server; settled resources are removed after failed assertions too.
- Native acceptance uses explicit private provider profiles and managed MCP configuration, with retained diagnostics when physical cleanup cannot be confirmed.
- Bounded MCP readback fills its response budget while preserving JSON characters, identity, choices and continuation integrity.

### Security

- Tests reject application and production database connections, ambient database fallbacks, and cleanup outside owned database or filesystem roots.
- Native agents receive scoped provider and MCP settings without inheriting test-controller credentials, database selectors or the ambient user home.
- Codex model diagnostics strip App and controller credentials and disable only configured App MCP entries, preserving provider sign-in and native startup with empty MCP configuration.

## [0.0.41] - 2026-10-06

### Added

- Add an opt-in live Haiku check for the installed Claude SDK, covering native lifecycle, resume, fork, history and full-access tool policy.
- Show when live or saved chat messages have been shortened, including matching HTTP, SSE and Operator MCP readback.

### Changed

- Qualify the installed Haiku profile for full-access lifecycle and tool policy. Active cancellation, startup prompts, read-only sandbox and workspace-write sandbox remain unqualified in this profile.
- Apply backpressure to Claude event streams while retaining a bounded UTF-8 text prefix and terminal events.
- Retire completed callback and file-call resources while keeping persisted retry records available.

### Fixed

- Resume ended or failed Claude sessions automatically with their saved native session ID, retaining failure records and avoiding duplicate input.
- Keep response ownership through tool rounds and compaction, and handle terminal results that contain no assistant reply.
- Recover approvals, cancellation and chat closure after interrupted storage writes without replaying prompts or repeating acknowledged native effects.
- Save terminal history before settling chat turns while keeping accepted message inputs unchanged across database upgrades.
- Retry interrupted Operator cleanup without reading stopped native managers, preserving known unsent inputs and their saved failures.
- Wait for fixture native turn state before injecting startup-persistence recovery events.
- Support Claude management and file tools through the official SDK with configured Foreman Code MCP connections, supported installation aliases and decoded Markdown readback.
- Roll over full session bookkeeping safely and preserve active-turn and observer ownership checks.

### Security

- Enforce saved tool policies, delegated grants, callback ownership and replay protection for native tool calls and authenticated MCP operations.
- Reject database credentials before Claude runtime allocation and preserve scoped credential identity across supported installation aliases.

## [0.0.40] - 2026-10-06

### Fixed

- Stabilize the Job queue HTTP/MCP parity regression by joining replay-triggered queue scans before reading cancellation revisions. Preserve denied access, revision conflicts, persisted readback and idempotent cancellation across both transports.

## [0.0.39] - 2026-10-06

### Fixed

- Preserve the original managed-launcher location when native acceptance inspects copied MCP configuration, then install and use the fixture-owned launcher. Keep scoped credential provenance and preflight enforcement intact across both supported environment names.
- Restore the outer isolated launcher setting during cleanup and prevent legacy environment aliases from redirecting native route writes outside owned storage.

## [0.0.38] - 2026-10-06

### Fixed

- Restore interrupted heavy-job slot records from their acquired queue tickets, preserving capacity for unresolved native work while allowing later jobs to use free slots.
- Keep existing process and token ownership checks intact. Cover a lost coordinator with a live child process and mixed scheduler versions, with owned process and filesystem cleanup.

## [0.0.37] - 2026-10-06

### Added

- Support native questions, form input and standalone elicitation through shared web, HTTP and authenticated MCP responses, including remote execution.
- Control and recover owned Codex child sessions, including prompts, interruption and their own native approval or input callbacks.

### Changed

- Preserve implicit local human access and the existing scoped MCP and worker credentials after browser authentication removal.
- Qualify native acceptance per provider, allowing Codex cases to run independently of an unused OpenCode installation.
- Correlate late session and turn acknowledgements with the original accepted request and retain startup output until admission is persisted.
- Run selected native acceptance files with invocation-owned databases and preserve process-group cleanup and qualification diagnostics.
- OpenCode approval isolation (E03-A01), OpenCode Agent chat fork and terminal OpenCode local-human isolation were verified locally in v0.0.48.

### Fixed

- Report native model-catalog refresh failures separately from an unadvertised model, and close owned metadata inspections before session admission.
- Preserve a confirmed prompt rejection that arrives during a native history read, keeping recovery usable for an explicit retry.
- Recover known unsent chat requests and failed cleanup across service restarts while keeping uncertain native submissions from being replayed.
- Preserve complete assistant output, callback ordering and child controls when native startup or persistence acknowledgements arrive late.
- Reconcile input responses after a lost database commit without sending another native response, and preserve Operator readback and file delivery through cleanup.
- Observe the selected Run canvas from the canonical cache without replacing its fetcher or clearing a retained Stop before both cleanup readbacks settle.

### Security

- Reject supplied application-global credentials before native qualification or idle diagnostics, while preserving scoped App MCP tokens.
- Keep owner, session, generation, native request and authorization checks intact across callbacks, child controls, diagnostics and recovery.
- Exclude both supported App MCP credential names and configured bearer credentials from idle diagnostic processes.

## [0.0.36] - 2026-10-06

### Fixed

- Copy Codex plugin caches into disposable native acceptance storage without following stale internal version aliases. Preserve linked caches and available plugin assets while isolating writes from the original profile.
- Verify internal and external plugin links stay isolated and temporary storage is removed on success and failure.

## [0.0.35] - 2026-10-06

### Fixed

- Reclaim a heavy-job slot after its coordinator exits or its PID is reused and the published process group is empty, even when unrelated process environments cannot be read.
- Retain slots with live detached token-bearing workers and preserve conservative handling of foreign, malformed, unreadable or incomplete ownership records.

## [0.0.34] - 2026-10-06

### Fixed

- Pass the owned fixture directory explicitly to terminal OpenCode requests, preventing inherited PWD from creating the native session in the surrounding checkout.
- Verify native MCP startup reads the fixture's unique placement marker while preserving every local HTTP denial, scoped MCP permission and cleanup assertion.
- Check the selected native OpenCode model and provider through the shared qualification service before terminal launch, keeping unsupported models separate from missing provider credentials and closing the diagnostic process before the unregistered isolation client starts.
- Terminal OpenCode local-human isolation was verified locally in v0.0.48. Native preflight reports missing provider credentials explicitly. Both Codex isolation cases passed on Laptop in the original gate.

## [0.0.33] - 2026-10-06

### Fixed

- Read installed OpenCode MCP credential provenance before switching native acceptance to its owned launcher, preserving the verified token reference across merged native configuration. Keep managed-launcher and scoped credential enforcement intact; remove copied login state during cleanup.

## [0.0.32] - 2026-10-06

### Added

- Isolated OpenCode file delivery for Agent and Operator chat, including attachments and inherited references.
- Follow-up input for idle native OpenCode subagents through authenticated Operator MCP, with scoped denial, idempotent commands and persisted readback.

### Changed

- Discover file tools before model input and bind file-operation credentials after native acknowledgement.
- Support the full accepted image attachment count and size with bounded native media identities and recovery history.
- Keep native acceptance histories, caches, configuration changes and MCP routes in disposable storage, and retain redacted failure codes in run logs.
- OpenCode approval isolation (E03-A01), audited OpenCode qualification and OpenCode Agent chat fork were verified locally in v0.0.48. Codex lifecycle and fork cases passed in the original gate; this group adds no Claude provider case.

### Fixed

- Preserve child agent, model, variant and system settings on follow-up input, including explicit unnamed variants during fork and reconnect.
- Synchronize native and file-tool working-copy edits, retain edited versions across crashes and publish their current bytes.
- Complete queued chat turns despite retryable cleanup failures, and recover owned cleanup after API or native-process restart.
- Give Operator file turns conversation-owned storage while retaining scoped management access and distinct file credentials.
- Recover accepted inline media after conversation restart and fork, preserving ownership and avoiding duplicate delivery.
- Preserve native child chronology, capability revisions and chat event subscriptions as queued turns advance.
- Forward selected acceptance files through the root runner and configure the actual fixture MCP endpoint before native submission.

### Security

- Verify namespace, process generation and vault ownership before native file access, isolating API vaults and other conversations' files and media on the pinned Node runtime.
- Separate pre-acknowledgement discovery from authenticated file operations, validate publication provenance and recheck scope, revocation and writer lifetime before commit.

## [0.0.31] - 2026-10-06

### Fixed

- Initialize the disposable database in the Operator Claude publication recovery fixture before its unchanged five-second behavior deadline. Keep authenticated file publication, replay, revocation and persisted readback checks, and close fixture resources after the test.

## [0.0.30] - 2026-10-06

### Fixed

- Give native workflow acceptance invocation-owned CLI configuration and a temporary managed launcher, routing scoped credentials to the fixture API instead of an ambient installation's fixed endpoint.
- Preserve installed MCP names and credential references, reject unmanaged connections through native preflight, and remove invocation-owned launcher resources during fixture cleanup.
- Keep the selected Codex login in the private fixture CLI home, with private file permissions and cleanup after native processes close; leave the original native configuration untouched.
- E03-A01 approval isolation was verified locally with the connected OpenCode Go provider in v0.0.48.

## [0.0.29] - 2026-10-06

### Fixed

- Load the shipped Worker mount before its installed Codex qualification test creates temporary identity state, keeping cold module compilation outside the unchanged five-second behavior deadline and preventing timeout leftovers. Preserve Main proof, installation identity, revision and fail-closed checks.

## [0.0.28] - 2026-10-06

### Fixed

- Recover finalized Claude file publications in Operator message attachments after credentials are revoked or publication adoption is interrupted.
- Verify authenticated MCP publication and replay, then persisted message readback after credential revocation; cover unauthorized requests and conversation isolation.

## [0.0.27] - 2026-10-06

### Fixed

- Give PostgreSQL responses a bounded delivery grace after the server's unchanged SQL deadline, avoiding false client timeouts while a completed write acknowledges durable WAL. Preserve synchronous commit, query cancellation, transaction locks and execution ownership.
- Report Run inspection read deadlines, cancellation, lock timeouts and deadlocks consistently through HTTP and Operator MCP, with safe reasons and SQLSTATE instead of private database text.
- Verify completed queries with delayed responses, server cancellation of slow SQL and bounded failure when the response is withheld, with proxy sockets cleaned on success and failure.

## [0.0.26] - 2026-10-06

### Fixed

- Verify local API access guidance after rejected harness compatibility retries, preserving the existing report for both unavailable and denied access without requiring browser account authentication.

## [0.0.25] - 2026-10-06

### Fixed

- Verify Codex MCP absence through the requested named CLI lookup instead of an obsolete empty catalog fixture.
- Cover definite missing names, failed lookups, contradictory output and malformed named configuration through the public inspection API and real subprocess runner.

### Security

- Preserve failure classification: unreadable or malformed MCP configuration cannot be mistaken for a definitely absent entry.

## [0.0.24] - 2026-10-06

### Fixed

- Make Agent chat creation and native inspection fixtures return only the requested configured MCP entry, covering both Foreman Code and supported legacy installation names without fabricating a naming collision.

## [0.0.23] - 2026-10-06

### Added

- Selected unit and native acceptance files through the root heavy-job queue and owned disposable test databases.

### Changed

- Open local development and production dashboards without account setup, login, passkeys, browser tokens or cookies.
- Preserve the former browser owner's conversations, attachments, permissions and command retries across upgrade and restart.
- Native human-access isolation and credentialed OpenCode qualification were verified locally in v0.0.48; Claude Haiku lifecycle and tool-policy qualification also passed.

### Removed

- Browser authentication endpoints, sign-in/setup pages, account/session tables and authentication dependencies.

### Fixed

- Serve local HTTP before optional native model discovery, while retaining qualification checks and joining discovery during shutdown.

- Read dashboard root location and root policies through local HTTP without login.
- Reconcile a lost Start response after upgrade using the original Run and command ownership.
- Preserve schedule ownership, occurrence history and exhausted cursors through no-login HTTP and authenticated MCP.
- Allow scoped callers to read their own permissions while retaining operation-specific checks.
- Give cold native conversation attachment its startup budget before observing the existing turn.
- Preserve compiled production hosting, queued Job access, native streaming and Auto placement after authentication removal.

### Security

- Keep local services on loopback with origin checks and OS socket/process attribution for human requests, including the development proxy.
- Preserve authenticated MCP grants, scopes, revocation, read-only access, human approval boundaries and harness isolation.
- Preserve Foreman Code package and environment names and recognize both supported MCP credential spellings when isolating native clients.

## [0.0.22] - 2026-10-05

### Fixed

- Return only the configured MCP entry in shared native replay fixtures, keeping canonical and legacy naming collision checks intact and restoring native output and late child-completion coverage.

## [0.0.21] - 2026-10-05

### Fixed

- Reuse the reviewed native MCP launcher for local production's automatic credential routing, while keeping production data separate.
- Transition managed launchers from the previous production directory without changing native commands, credential references, tool policies, approvals or disabled flags.
- Preserve launcher registrations across older and concurrent writers, and recover interrupted or lost transitions from the retained managed installation.
- Keep unused routing folders intact without recognizing an uninstalled or unmanaged launcher.

### Changed

- Scope OpenCode live qualification to its approval case so Codex-only cases can run independently, retaining each provider's qualification and original assertions and deadlines.
- Use explicit verification subject models without changing user defaults: interim Codex gpt-5.6-luna with medium reasoning and Claude Haiku when selected.
- Single-computer OpenCode lifecycle, qualification, fork and isolation cases were verified locally in v0.0.48, along with Claude Haiku qualification. Desktop production installation and native recovery verification are recorded separately.

## [0.0.20] - 2026-10-05

### Fixed

- Reduce live workflow Start and reconciliation overhead by observing committed native progress, reusing validated unchanged history and projections, and reusing prepared reads on each dedicated PostgreSQL owner session.
- Inspect named Codex MCP configuration without waiting on unrelated server status checks, while retaining configuration, credential, alias and ownership validation.
- Retain content-free workflow, database and native timing diagnostics for investigating execution delays.

## [0.0.19] - 2026-10-05

### Fixed

- Keep ready native output in bounded batches after scheduler pauses, avoiding fragmented database publications while preserving prompt silent-stream flushing and immediate approval and reliability events.
- Add a deterministic scheduler-pause regression without increasing native stream test timeouts or relaxing frame-order, source-capture, lease, or Operator MCP checks.

## [0.0.18] - 2026-10-05

### Fixed

- Keep real native workflow acceptance storage under a validated private location, independent of shared job temporary directories.
- Use supported Codex test models and medium reasoning with explicit overrides, without changing product defaults.
- Give workflow agents return-routing templates from accepted request IDs to reduce copying errors while retaining exact backend validation.

## [0.0.17] - 2026-10-05

### Fixed

- Publish native approval interrupt bindings as soon as their checkpoint is saved, so independent sibling executions can progress while approval prompts remain usable in the app and Operator MCP readback.
- Commit delivered approval responses through the active Run owner and queue continuation behind the existing graph invocation, avoiding duplicate native submissions.
- Join queued approval continuation during Stop before reclaiming cleanup ownership, including responses delivered while a sibling is still active.

## [0.0.16] - 2026-10-05

### Fixed

- Restore native chat and launcher test fixtures to the Foreman Code MCP naming, supported aliases and MCP list/get contracts without weakening credential or delivery checks.
- Keep transfer security fixtures independent of checkout depth, align installed Codex qualification with the shipped suite, and validate current workflow saves through behavior rather than obsolete migration text.
- Complete selected Board Activities and Operator file HTTP fixtures, retain exact Claude preset readback, and scope Stop reconciliation verification to the selected Run.
- Keep attachment picker-order assertions independent of concurrent HTTP arrival order and complete workspace root metadata fixtures for route verification.

### Security

- Pin both Foreman Code and legacy GraphQL App MCP credential names during Codex diagnostics, preserving credential exclusion for existing native configurations.

## [0.0.15] - 2026-10-05

### Fixed

- Align Operator OpenCode file-delivery fixtures with the canonical Foreman Code MCP entry, preserving exactly-once attachment delivery and file-only authority for Markdown, images and publication flows.
- Report persisted Operator turn errors directly in delivery tests and verify MCP isolation for supported and legacy connection names.

## [0.0.14] - 2026-10-05

### Fixed

- Keep ready native output in bounded publications when database lease checks are slow, so parallel stream drains preserve progress, output order and writer ownership.

## [0.0.13] - 2026-10-05

### Added

- Show the latest scheduled attempt, safe outcome guidance and an accepted Run link in the schedule dialog.

### Changed

- Dispatch independent schedules with bounded concurrency and recover missed occurrences in immediate batches.
- Bound Start preparation, reuse validated preflight across short-interval retries and refresh open schedule readback without replacing edits.
- Isolate installed package files across worktrees so parallel installs cannot change native executable identity metadata during qualification.

### Fixed

- Preserve pending and exhausted occurrence cursors when unchanged enabled settings are saved or enabled again, including elapsed Once saves in the UI and Operator MCP.
- Default Once to the next device-local calendar date across daylight-saving changes.
- Record stale roots, harness instances, removed installations, unavailable sources and revoked devices as immediate scheduling rejections while retrying temporary inventory gaps.
- Restore saved harness selections after restart and check their persisted revisions before accepting a scheduled Run.
- Keep the installed Node runtime stable during native acceptance isolation and qualify scheduled placement using its persisted model defaults.
- Return decoded Markdown alongside pinned bytes in Codex file callbacks and live qualification, with fresh qualification suite evidence.

### Security

- Retain cancellation and authorization fences through Start preparation and placement checks; log safe application and device classifications with workflow context without exposing native output or credentials.

## [0.0.12] - 2026-10-05

### Fixed

- Restore companion pairing and status requests after the Foreman Code rebrand by retaining the valid `X-Graphql-Companion-Session` header used by installed companions and servers.

## [0.0.11] - 2026-10-05

### Fixed

- Restore the source workspace's full frozen dependency installation after production staging, including failed deployment, so later commands run unattended without switching to production-only dependencies.
- Preserve both deployment and workspace-restoration errors when staging fails.

## [0.0.10] - 2026-10-05

### Added

- Retain redacted OpenCode qualification transcripts and MCP request and file-response details for diagnosing native failures.
- Select explicit native acceptance test files through the root runner while preserving isolated test databases and the default lifecycle gate.

### Changed

- Run each OpenCode live qualification check once and require qualification suite revision 5, so another model attempt cannot hide a failed check.

### Fixed

- Include decoded UTF-8 Markdown in authenticated file MCP reads alongside the unchanged pinned byte result, preventing marker corruption during model-side base64 decoding.

## [0.0.9] - 2026-10-05

### Added

- Canonical FOREMAN_CODE environment settings with supported legacy GRAPHQL aliases, preserved process/file precedence, and explicit conflict diagnostics.
- Fresh foreman-code MCP entries with recognition of existing graphql connections and human-reviewed configuration migration.
- Rename compatibility and rollback documentation for existing installations.

### Changed

- Product, dashboard, desktop and companion branding to Foreman Code, and first-party private packages and build consumers to @foreman-code.
- MCP discovery, setup and generated agent instructions to Foreman Code MCP while retaining public operations, grants and serialized contracts.
- Local production installation settings and packaged runtime consumers to the canonical names while retaining service, storage, database and pairing identities.

### Fixed

- Preserve old startup commands, managed launchers, scoped native credentials and worker artifact packaging after the rename.
- Reject conflicting old/new installation targets and installer-setting overrides without modifying operator-owned configuration.
- Retain native qualification diagnostics through test cleanup while preserving the full qualification gate.

### Security

- Remove production database passwords and ambient application secrets under both prefixes before native execution; retain existing permission and qualification checks.

## [0.0.8] - 2026-10-05

### Added

- Run-wide Activities for selected Runs, including Job-only Runs and failures before an Agent execution exists.
- Refresh and bounded execution discovery when a selected Run's Agent execution becomes available later.

### Changed

- Page complete public Activity rows within 128 KiB over HTTP and Operator MCP, with cursors for all retained history and heavier snapshots available through Run details.
- Keep incremental Activity reads independent of full execution history, back off unchanged feeds, and batch authorized workspace Run summaries.
- Preserve configured native acceptance evidence directories and private qualification error details while the root runner creates and cleans up its disposable database.

### Fixed

- Preserve historical WorkflowVersion and Run records through database upgrades while keeping current execution on semantics 3.
- Order Run pages chronologically, update cached rows from fresh summaries, refresh evicted history pages, and distinguish Runs that never started.
- Preserve admission-time Agent names in Activity history and save node display names without changing executable version pins or stopping Runs.
- Recover retained rename edits and commands across reloads with concurrent-name checks and existing Stop uncertainty preserved.
- Report native null-error success, cancellation and Claude tool activity consistently in public Activities and normalized Run snapshots.
- Serialize older Activity reads with polling and Refresh, retain valid cursors as history advances, and recover transient failures without losing loaded rows.

### Security

- Revalidate live and delegated Run-list grants, including empty pages, and deny unauthorized workspace and workflow scopes while retaining scoped readers and redacted HTTP/MCP parity.
- Authorize edit-intent advancement before reading caller-private commands, preserving persisted rename recovery and original command identities.

## [0.0.7] - 2026-10-05

### Changed

- Document explicit provider credential configuration and native login locations for the installed user service, including provider authentication failures.

### Security

- Exclude the production database password from native harness environments while retaining explicitly configured provider credentials.
- Apply shared credential filtering to Codex launch, credential refresh and resumed sessions, and reject database-secret reinjection.

## [0.0.6] - 2026-10-05

### Added

- Persistent build request queue with original deadlines, idempotent submission, capacity-aware Auto or fixed placement, and scoped cancellation.
- Start placement overrides, reserved-computer and cleanup status, complete active-request discovery, and paginated queue history through Jobs, HTTP, and Operator MCP.

### Changed

- Reserve computer and source capacity before preparation, and continue claiming work for available computers while other requests prepare.
- Require owner-reviewed Main queue configuration with explicit resource envelopes; retain capacity through uncertain execution and pending publication or cleanup.

### Fixed

- Recover queued, preparing, accepted, and unfinished settled Jobs after Main restart without replacing their saved definition or attempt identities.
- Preserve historical command retries and fixed requests' immutable qualified profile versions after edits.
- Close undelivered cancelled or disabled attempts through fenced non-entry and positive source closure, and keep pending cleanup visible until it completes.
- Restore inspected runtime metadata without creating or extending qualification; retain original journal recovery and cancellation when fresh qualification is unavailable or expired.

### Security

- Preserve live workspace and computer grants, saved source and root bindings, revision conflicts, command receipts, and audited HTTP/MCP denials for queue operations and placement overrides.
- Keep runtime qualification mandatory for new launches and restrict recovery and cleanup to the original owned attempt, releasing capacity only after confirmed closure.

## [0.0.5] - 2026-10-05

### Fixed

- Drain native workflow output in bounded publications so parallel turns and approval waits complete without duplicate native submissions.
- Detach failed event observers promptly while preserving the original native sessions for recovery.
- Preserve caller-selected native acceptance database servers, evidence directories and pinned binaries through isolated test bootstrap.

## [0.0.4] - 2026-10-05

### Added

- A local production install/update command that deploys the compiled API and web shell, runs migrations, and enables user services.
- A persistent production PostgreSQL volume, separate database credentials and storage directories, and a loopback dashboard at port 3041.
- Desktop and session-start launchers that open the dashboard in Chrome, with application and web icons.
- Installed-service checks for native execution, Operator MCP grants, cancellation, database recovery and service crash recovery.

### Changed

- Preserve validated operator configuration across updates and serialize installation, migration and release activation.
- Run the root native acceptance command with an owned disposable database and retained test evidence.

### Fixed

- Serve saved dashboard routes from the production build while preserving API and MCP error responses.
- Restart the API after database ownership loss or an initially failed database activation.
- Confirm and persist native cleanup after systemd removes a killed cgroup.
- Preserve quoted and escaped configuration values and verify installation identity before declaring readiness.

### Security

- Enable qualified native execution only for explicitly selected loopback local production installations, retaining grants, scope checks, sandboxing and execution admission.
- Keep production credentials private and production storage separate from disposable test databases.

## [0.0.3] - 2026-10-04

### Fixed

- Restore native cancellation, recovery and reviewer safety verification with persisted session and turn identities, retaining coverage for both bound and unbound recovered lanes.
- Exercise startup recovery and orderly shutdown with the production rsync availability result in the lifecycle fixture.
- Align source-capture timeout verification with the intended five-minute preparation budget and enable the existing worker execution policy in the source reconciliation fixture.
- Make schedule editor and modal verification independent of the machine timezone while preserving saved instants, device-local display and daylight-saving behavior.

## [0.0.2] - 2026-10-04

### Added

- Build participation and priority settings in Settings → Computers, with persisted status and revision checks through HTTP and Operator MCP.
- Auto Job definitions that select an authorized, ready computer, approved workspace root and compatible qualified runtime at Start.

### Changed

- New Jobs default to Auto; fixed targets and historical execution selections retain their saved facts.
- Job admission reserves computer and source storage capacity before transfer and retains the selection across interrupted transfers, uncertain delivery and recovery.
- The root integration runner supports an explicit file selection through the shared heavy-job queue and disposable databases.

### Fixed

- Preserve saved Auto runtime requirements when editing a Job.
- Block new launches after build participation is disabled while retaining running-job cancellation, recovery and artifact readback.

### Security

- Preserve explicit grants, scope checks, approved source and input revisions, qualified isolation, runtime limits and Main's startup execution gate during automatic selection.

## [0.0.1] - 2026-10-04

### Added

- Byte-bounded interaction summaries and cursor-based retrieval of complete large requests.

### Fixed

- Preserve interaction identity, response options and retrieval cursors in OpenCode model output.
- Keep large interaction responses within the remote worker relay and model text limits.
- Cancel pending MCP approval decisions before commit while preserving committed decisions for readback.
- Distinguish authentication, forbidden, oversized request, service, timeout and connection failures with safe retry guidance.
- Resolve interaction summary schema loading and strict lint errors found during integration.

### Security

- Limit cancellation to the originating authenticated caller and reauthorize every retrieved content chunk.
