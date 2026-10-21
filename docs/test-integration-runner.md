# API integration runner

Every integration invocation first recovers abandoned roots in `~/.cache/graphql-disposable-tests`.
Roots and cleanup records capture the owning PID, Linux process start ticks, and boot identity;
recovery uses these facts rather than elapsed time. Live owners, surviving processes with a root
in their environment, working directory or open files, running bind-mounted containers, and
databases with active callers keep their recovery state. Roots from older runners without a
confirmed process identity are retained for inspection.

Recovery settles nested invocations before their parents, closes recorded native reservations,
removes stopped disposable containers bound to the root, and drops databases bearing that
root's ownership token. It makes owned directories writable without following symlinks before
removing a settled root. Failed or unsupported cleanups remain recorded and are retried by the
next invocation; one retained root does not prevent recovery of other abandoned roots.

From the repository root, `corepack pnpm test:integration` builds contracts under the project heavy-job queue, then snapshots the sorted API `*.integration.test.ts` files. A clean run creates up to twelve UUID-named disposable loopback PostgreSQL databases and separate temporary directories by default, bounded by available CPUs; partial runs create no more slots than selected files. `FOREMAN_CODE_INTEGRATION_SHARDS=1..12` can lower or raise the limit for a specific machine. Each slot runs one file at a time with one Vitest worker. The startup test runs once, alone before the parallel phase, because it starts the local development command and uses shared checkout build output.

Parallel files start in descending order of their last recorded first-pass duration; unmeasured files start first. Durations are saved atomically in `~/.cache/graphql-disposable-tests/integration-durations.json`, shared by checkouts on the same machine. Missing or corrupt records preserve discovery order. Exclusive resource checks retain their fixed order. Each file launches the API workspace's Vitest binary directly, with package binaries on `PATH` and the same isolated environment, worker limits, diagnostic filters and JSON reports.

The runner prints one bounded PASS or FAIL line per file and continues through every file after a failure or a skipped case. After a default full sweep, it automatically reruns each failed file once on fresh disposable databases, printing separate RETEST PASS or RETEST FAIL lines and a retest summary. The original full-run file and case counts remain unchanged, and any first-pass failure keeps the command nonzero even if its retest passes. Failed file output is saved under ignored `.logs/test-integration/<run-id>/`; retest failures are saved in its `retest/` subdirectory. If a child exits without a summary, the runner reports that explicitly. Interrupts and the outer job timeout stop new dispatch, signal owned child process groups, escalate to SIGKILL after a bounded grace period, wait for them to exit, then drop only databases created by this run.

A `TEST_DATABASE_URL` must name a loopback test database; it only selects the PostgreSQL server and credentials. The run stays fully parallel: each slot and each retest still gets its own disposable database on that server. To resume from a file, use `FOREMAN_CODE_INTEGRATION_START_AT=apps/api/test/<name>.integration.test.ts corepack pnpm test:integration`. To rerun only failures from a completed runner log, use `FOREMAN_CODE_INTEGRATION_FAILED_LOG=/path/to/log corepack pnpm test:integration`. Each selected path must match a discovered file. Resume and failed-file retests are partial evidence; run the command again without either setting to verify the full suite.

For a change with a bounded test scope, use `corepack pnpm test:integration --files apps/api/test/build-computers.integration.test.ts apps/api/test/job-dispatch-recovery.integration.test.ts`. Only those discovered files run, with the same queue, disposable databases, skipped-case failure policy and failure retests. Unknown paths fail before database setup; duplicate paths run once. This verifies the selected scope, not the full suite. The selector cannot be combined with a resume cursor or failed-file log.
