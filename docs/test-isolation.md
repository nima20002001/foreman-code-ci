# Disposable test resources

Run `corepack pnpm db:up` before database-backed tests. It starts only
`compose.test.yaml`, with the fixed Compose project `graphql-tests`, volume
`graphql-tests_graphql-test-data`, loopback port 55439, and test-only credentials.
The application Compose file and its database are independent. `db:down` checks
test ownership labels before removing only this test project and its volume.
`db:up` preserves the existing owned server across checkout and snapshot paths
so another test request cannot replace it while clients are connected.
An owned stopped server is recreated with the current configuration and its
existing volume, so stale snapshot mounts cannot prevent the next startup.
The disposable server disables crash durability to avoid cluster-wide checkpoint
stalls while concurrent fixtures create and remove databases. Committed rows
remain visible across connections and application restarts; host-crash durability
must be verified against a durable database. Application/production PostgreSQL
settings are independent of this test-only configuration.

Root and API package test commands provision UUID databases on that instance.
The root unit command also runs the integration-runner and acceptance safety
script tests alongside the workspace suites.
API Vitest global setup also provisions resources for direct `pnpm exec vitest`
invocations. Ambient database selectors (including DB-gated unit-test selectors)
are replaced with the disposable URL. Real `pg` connections outside the test
endpoint are rejected before connection. No application or default database URL
is a test fallback. Fixture schema search paths exclude `public`.

Each test invocation or integration slot owns a private temporary root containing
its home, app files and workspaces, MCP launcher/routes, Codex and Claude homes,
XDG directories, logs, and acceptance evidence. Cleanup checks filesystem and
PostgreSQL ownership markers before deletion. Uncertain process or cleanup
settlement retains resources. Integration logs are retained in an owned directory
under ignored `.logs/test-integration/`.
Invocation roots live under the private `~/.cache/graphql-disposable-tests`
directory. Temporary files use a separate `tmp` child so application file storage
does not overlap temporary directories or require a weaker storage policy.

For focused verification, use `corepack pnpm test:files scripts|unit|integration|acceptance`
followed by explicit repository-relative test file paths. Empty lists and unknown
integration files are rejected. Integration uses the same disposable slots and
fails on skipped cases; its report identifies a selected-file run.
The startup probe, repository latency benchmark, Operator chat fixture, and
production runtime lifecycle fixture run in exclusive phases. Their bounded
setup and wall-clock checks need shared host resources without concurrent fixture
migrations. Other integration files use the configured disposable slots.

Native acceptance uses dedicated authentication. Set `FOREMAN_CODE_TEST_CODEX_AUTH_FILE`
and/or `FOREMAN_CODE_TEST_CLAUDE_AUTH_FILE` to explicit test authentication files;
Codex references its dedicated private authentication file; Claude copies its
credentials into the disposable profile with mode 0600 so refresh leaves the
source credentials unchanged.
Each supplied file must be private and owned by the current user. The native CLI
uses its normal authentication store, including token refresh, so use dedicated
test credentials and verify the supplied stores before and after live runs.
API-key authentication can use
`FOREMAN_CODE_TEST_OPENAI_API_KEY` or `FOREMAN_CODE_TEST_ANTHROPIC_API_KEY`. Ambient provider keys and real harness homes are
not reused. Do not commit credential files. Acceptance fails when its native
prerequisites or dedicated authentication are unavailable.
Native agents do not inherit controller Node startup options, database selector URLs,
or test-controller ownership and credential variables. Explicit provider authentication stays in their private
profiles and standard provider variables.
Test settings use `FOREMAN_CODE_*`. The shared product environment resolver also
accepts the legacy spellings documented in [rename compatibility](rebranding.md)
and rejects conflicting values before configuring disposable resources. Database
identities, Compose volumes, ownership markers and physical storage paths stay stable.

Run full integration verification with `FOREMAN_CODE_INTEGRATION_SHARDS=12 corepack
pnpm test:integration`. Package integration uses the same runner. Unit and native
acceptance commands use the same provisioner; standalone local acceptance also
uses this dedicated instance. Prepared native acceptance also checks that the
selected API identity matches its owned database before submitting work. Lifecycle and suite runs must not overlap with
`db:down` or the opt-in dependency restart in `test:production`.

The production workspace and MCP-directory selectors are replaced by owned test paths, and inherited built-web deployment paths are discarded. The compiled API validates test-owned paths before startup without depending on repository test scripts. Native acceptance bootstrap uses a marked child database on the dedicated test server with a private default schema and retains it when native cleanup is unconfirmed.

Installed-host validation is available separately as `corepack pnpm production:verify`. It changes live production data/services and cannot run inside a disposable test invocation. It is not part of the test suites.
