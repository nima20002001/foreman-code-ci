# Live native acceptance

Run `corepack pnpm db:up` and `corepack pnpm test:acceptance` from the repository
root on the computer with provider credentials. The root command uses the heavy
job queue, builds shared contracts, and runs the existing
`eng03-c-native.acceptance.test.ts` file with native execution enabled.

The runner creates a unique loopback PostgreSQL database for each invocation and
supplies it as `ENG03_A_TEST_DATABASE_URL`. It closes the owned test process group
and removes its closed database after success or failure. Active database callers
retain the owned database and fail the run. The shared application database and
PostgreSQL container remain running. The child does not receive `TEST_DATABASE_URL`.

Native scenario evidence survives queue cleanup under
`.logs/native-acceptance/<invocation-database>/`. This ignored directory retains
the tested source identity, native events, and failure-state diagnostics.

Only Codex and Claude are supported. Supply dedicated test authentication for the
selected harness. Qualification, scoped App MCP validation, and the accepted
harness access policy still run through the native path. Saved retired-harness
history does not qualify or enable a new native execution.
