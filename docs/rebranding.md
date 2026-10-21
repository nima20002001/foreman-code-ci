# Foreman Code rename compatibility

Foreman Code uses the package scope `@foreman-code`, product slug `foreman-code`,
and canonical environment prefix `FOREMAN_CODE_`. No dependency versions,
execution semantics, grants, pairing protocol or database contents change.

Every first-party `GRAPHQL_*` setting also accepts the equivalent `FOREMAN_CODE_*`
name. Defaults stay the same. Old-only, new-only and equal dual definitions work;
conflicting values fail with variable names only. Process settings override env-file
settings across either spelling. `FOREMAN_CODE_API_ENV_FILE` (or
`GRAPHQL_API_ENV_FILE`) selects the file before it is read. Private env files need
no edits. Unprefixed settings such as `DATABASE_URL`, `HARNESS_WORKSPACE_ROOT`,
`DEVICE_LISTENER_*` and provider variables keep their names.

Supported suffixes include `API_ENV_FILE`, `BROWSER_ORIGIN`, `DEV_BROWSER_ORIGIN`,
`WEB_PORT`, `DEV_BROWSER_ACCESS`, `DEV_OPERATOR_PRINCIPAL_ID`,
`LAPTOP_EXECUTION_ENABLED`, `DEVICE_LISTENER_ENABLED`, `LOCAL_PRODUCTION`,
`WEB_DIST`, `APP_MCP_DIRECTORY`, `PRODUCTION_DB_PASSWORD`,
`ENABLE_EXPERIMENTAL_CODEX_APP_SERVER`, `ENABLE_EXPERIMENTAL_CLAUDE_SDK`,
`MCP_TOKEN`, `WORKER_BUILD_COMMIT`,
`WORKER_ARTIFACT_DIRECTORY`, `HEAVY_BASE_TMPDIR`, `HEAVY_JOB_COMMON`,
`HEAVY_JOB_TOKEN`, `INTEGRATION_START_AT`, `INTEGRATION_FAILED_LOG`,
`INTEGRATION_SHARDS`, `INTEGRATION_IDLE_TIMEOUT_MS`, and
`INTEGRATION_FILE_TIMEOUT_MS`. Browser access uses the implicit local human;
`DEV_BROWSER_ACCESS` and `DEV_OPERATOR_PRINCIPAL_ID` no longer select browser
authority. The existing `DEV_BROWSER_ORIGIN` spelling remains supported and
must agree with `BROWSER_ORIGIN` when both are supplied.
The production installer accepts either database-password spelling and retains
`GRAPHQL_PRODUCTION_DB_PASSWORD` only in its generated EnvironmentFile because
existing database units invoke Compose with that name. Other installer-managed
settings use canonical names. Both spellings are excluded from native child
environments. Operator-owned settings retain their spelling and values; either
alias of an installer-owned setting is forbidden in `operator.json`.
Job containers receive both `FOREMAN_CODE_JOB_INPUT_MANIFEST` and
`GRAPHQL_JOB_INPUT_MANIFEST` because older captured entrypoints may consume the latter.

Foreman Code MCP uses `foreman-code` for fresh native entries and recognizes a
supported existing `graphql` entry. Installing or repairing through Harness
Settings is a human-reviewed action: it migrates a supported owned old entry,
preserves disabled/tool/approval policies, and removes retired `graphql-app` and
`graphql-operator` entries in the same write. Customized or inherited entries and
collisions between old and new names require native-source review. Review saved
Agent/Operator policies tied to the old name too; scoped
launches refuse a policy whose app connection name is absent. The existing
supported connection stays usable. No native
configuration is rewritten merely by upgrading the app. Operator MCP requests
use the same reviewed service and grants. The serialized preset remains `graphql`.
Scoped native processes receive both token spellings where installed entries need
them; ambient application secrets are removed in both namespaces. Credential
bindings, expiry, revocation and instance routing remain unchanged.

Intentional residual identifiers:

- PostgreSQL database/user defaults, schema/migration names, Compose project and
  named volumes, installation IDs and signing/pairing material.
- Browser keys including `graphql-theme`, navigation settings, conversations and
  draft/outbox keys. The pre-paint script and mounted theme keep the same key.
- `graphql-api` health identity, `/__graphql_dev_identity`, API/MCP routes,
  serialized fields such as `graphqlTools`, managed preset `graphql`, protocol
  events, native file-only server names, and persisted credential bindings.
- `X-Graphql-Companion-Session` remains the companion's session header so installed
  pages and servers share the same pairing contract.
- `~/.local/share/graphql` storage/launcher roots, worker app/state directories,
  `graphql-worker.service`, `graphql-operator-api.service`, production paths and
  desktop identities, `/graphql.svg` icon URLs, companion launcher/desktop filenames, worker artifact
  filenames, job/container ownership labels and scheduler directories.
- Existing GitHub repository/checkout paths, working documentation links, genuine
  GraphQL technology references, third-party names, historical audit records and
  user-created content.

Rollback uses the previous committed app and package lockfile with the same data,
identities and paths. Older launch commands still work. If a human migrated native
MCP settings, review and restore their prior native entry/token reference before
running an older app; retain native backups. A rename never requires clearing
storage, resetting the database, changing infrastructure or pairing computers again.
External repository, account, domain and infrastructure renames require separate
authorization and are outside this change.
