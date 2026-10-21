# Dense repository gate

Run `corepack pnpm test:dense` after dependencies and the local test database are
ready. The pinned pnpm runtime and the existing heavy-job reservation remain in
use. The outer reservation has a 9,000,000 ms deadline.

The gate builds contracts before starting one queue containing all integration
files, the complete contracts/API/web/worker unit portions, the web smoke test,
the registered scripts tests, lint, typecheck, and build. API unit tests exclude
integration and acceptance tests, matching `pnpm test`. Acceptance remains its
separate gate. Unit commands use `test-command.mjs` to provision isolated test
resources. Each unit portion validates its complete inventory and case totals;
missing files, skipped cases, corrupt reports, and unsuccessful processes fail
the gate.
After the contracts bootstrap, lint and typecheck invoke their recursive package
commands directly. This keeps contracts rebuilds inside the exclusive build job.

The scheduler starts the longest profiled jobs first. Linux CPU utilization and
PSI pressure, memory utilization and PSI pressure, and profiled job resource use
control admission. Defaults target 90% CPU and 80% memory with a hard concurrency
ceiling. Exclusive integration files and the build run in a dedicated window
after an initial parallel wave, so the build cannot modify distributions used by
other jobs. Failed jobs retry once, serially, after primary work completes. A
passing retry is `FLAKY` and still fails the command.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `GRAPHQL_INTEGRATION_SHARDS` | `12` | Hard maximum concurrent queue jobs (1–64). |
| `GRAPHQL_TEST_PROFILE_PATH` | `.logs/test-profiles.json` | Saved duration, peak RSS, and CPU-seconds profiles. |
| `GRAPHQL_DENSE_UNIT_WORKERS` | `2` | Internal workers per unit portion (1–12). |
| `GRAPHQL_DENSE_ITEM_TIMEOUT_MS` | `1800000` | Base timeout for unit/lint/typecheck/build jobs. |
| `GRAPHQL_DENSE_IDLE_TIMEOUT_MS` | `60000` | Silent-job supervision threshold. |

Observed load scales each job's silent-output threshold and wall-clock deadline.
The silent-job watchdog tracks stdout and stderr output; it does not use CPU
activity as a heartbeat. Process death, silence past the threshold, or deadline
expiry is reported clearly. Integration-specific
timeout controls continue to apply to integration files. `pnpm test:integration`
remains independently callable and retains its reports and selectors.
The dense gate rejects resume cursors, failed-file selectors, and test-name
patterns because they would leave the full integration inventory unchecked.

Each invocation writes a private directory under `.logs/test-dense/` and prints
its location. `summary.json` includes every required job, primary coverage,
attempt status, metrics, and bounded log references. `junit.xml` exposes flakes
and unrun jobs as failures. Unit reports and bounded command logs stay in
separate per-attempt directories; integration reports retain the existing
`parts/integration` layout. These files are local generated output and should
not be committed.
The integration inventory is captured before setup, so setup failures retain
every required integration file as an unrun job in the dense report.
Cleanup failures preserve completed attempts while marking the gate incomplete;
cancellation exit codes remain 130 or 143. JUnit includes runner errors alongside
the retained job results.

The queue's executor accepts a command item and scheduling context and returns
its completion, exit code, metrics, and logs. That interface allows a later
remote executor without changing queue policy; this gate executes locally.
