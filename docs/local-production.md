# Local production on Linux

From a desktop session, with Node 22.23.2, the pinned Corepack/pnpm runtime,
Docker Compose, user systemd, Python 3, `/usr/bin/ss`, and `/usr/bin/google-chrome` installed:

```sh
corepack pnpm production:install
```

Workspace folder publication uses Python's standard-library `ctypes` to call
Linux `renameat2` with `RENAME_NOREPLACE`. The filesystem must support this atomic
rename; unavailable support fails without overwriting or copying a folder.

Use the same command to update. It installs dependencies under the release-age
policy, builds, stages a standalone release, stops the API, migrates the production
database and checkpoints, switches the installed release, restarts the API, waits
for readiness, and opens Chrome at **http://127.0.0.1:3041/workspaces**.
Build or packaging failures happen before the API is stopped. A migration failure
leaves the API stopped: inspect the error, fix it, and rerun the command. Failed
unactivated staging is removed; the previously installed release is preserved.
The standalone application/checkpoint migration command uses a bounded 60-second
DDL deadline per query batch and one connection per migration pool, separately
from the API's request deadline. Transactions and migration locks remain required. Releases
are retained for recovery; database migrations are not automatically rolled back.

The API serves the built web app on the same origin. There is no Vite server or TS
loader at runtime. Each release includes its Node executable, compiled API,
production dependencies, contracts, web assets, and the existing MCP bridge.
Services do not depend on the source checkout remaining on disk.
Staging copies deployed files into an independent snapshot, retaining internal
dependency symlinks without sharing mutable build-output inodes with the source.
Staging restores the source workspace's full frozen dependency installation after
production deployment, including a failed deployment. Later workspace commands
can run non-interactively without being switched to production-only dependencies.

The installer replaces the existing `graphql-operator-api.service` dev command
with the compiled production API, adds `graphql-production-db.service`, and enables
both at user login. Database activation and the API retry failures independently,
so an initial Docker or PostgreSQL startup failure recovers without another login
or manual API start. Docker restarts crashed PostgreSQL containers. Docker itself
must start at boot. Graphical-session autostart waits for
the services and opens an app window in the owner's existing Chrome session. The
application menu has a **Foreman Code** launcher, with the same SVG used for its desktop
icon, browser favicon, web manifest, and the Companion launcher. Chrome remains
owned by the user; closing its window does not stop the API. Desktop activation waits
for any installation to finish before starting the selected release. A terminal shows
startup progress; launch retries service and database identity checks for up to 90
seconds after acquiring the installation lock, then reports an actionable failure.
Docker discovery is bounded to 60 seconds per service activation. Browser handoff
checks immediate startup failure separately from backend readiness.

User units, application entries, icons and autostart entries follow absolute
`XDG_CONFIG_HOME` and `XDG_DATA_HOME` overrides, with the usual home directories
as defaults. Relative overrides are rejected before installation writes anything.
Existing integration files in earlier XDG locations are retained; keep the session's
XDG configuration consistent when updating. Production data and `production.env`
retain their existing locations.

The dashboard opens with implicit local human access, without a browser account
or login secret. The API attributes credential-free requests to their local
socket and process owners; agent clients still need their MCP credentials.
MCP retains its bearer credentials, roles, grants, and harness security. Host installation
is an OS-user operation, outside Operator MCP. The installer selects
`FOREMAN_CODE_LOCAL_PRODUCTION=1` (legacy `GRAPHQL_LOCAL_PRODUCTION=1` remains supported): loopback production enables local harnesses through
the same provider, account, model, approval and sandbox qualification used at
every execution admission. Explicit harness disables remain in effect. Other
production deployments retain their rollout restrictions.

Production storage is independent of development and tests:

| Resource | Production location |
| --- | --- |
| PostgreSQL | `127.0.0.1:55440`, database/user `graphql_production` |
| Compose project | `graphql-local-production` with `compose.production.yaml` |
| Docker volume | External `graphql-production-postgres` |
| Credentials | `~/.config/graphql-production/production.env` (0600) |
| Operator settings | `~/.config/graphql-production/operator.json` (0600) |
| Workspaces/uploads | `~/.local/share/graphql-production/{workspaces,files}` |
| Runs/cache | `~/.local/state/graphql-production/{runs,cache}` |
| Managed MCP launcher/routes | `~/.local/share/graphql/mcp/` (shared launcher; credential-scoped routes) |
| Releases | `~/.local/lib/graphql-production/releases/`, selected by `current` |
| API logs | `~/.local/state/graphql-production/logs/` (rotating, bounded) |

The service uses the existing reviewed native MCP launcher so upgrading does not
rewrite native connections or their tool, approval and disabled policies. Its
shared routing index contains only credential digests, loopback endpoints,
expiry times and app process IDs. Each credential routes to its issuing app;
the endpoint still validates its grants and scope. Production database, files,
workspaces and execution state remain separate from development and tests.

Updates also transition managed launchers installed under
`~/.local/state/graphql-production/mcp/`. With the API stopped, the installer
validates their installation record, retains installed executable identities,
and links that directory to the shared launcher and routing index. Saved native
commands, credential references, tool policies, approval rules and disabled flags
stay intact. Recognition requires the registered alias to resolve to the shared
launcher and the executable to pass the same managed-command checks. The original
directory is retained as `mcp.previous`; an interrupted transition resumes from it
on the next install. Transition aliases and runtime registrations are also retained
in `launcher.mjs.registration.json`, which older development APIs do not rewrite.
Current launcher writers serialize updates across processes and directory aliases;
their kernel lock is released when a writer exits. If an older update erased the
round-one transition record, the installer restores it from the validated
`mcp.previous` installation while requiring the saved directory link to still point
to the shared launcher. Each API restart rebuilds credential routes from its database.
An unused folder, including an empty `routes` subdirectory created by an older
installer, needs no transition and stays untouched. Unmanaged launcher files still
require native-source review.

The Jobs view and Operator MCP use the same persistent build queue in this
installation. Its reviewed Main configuration belongs at
`~/.local/state/graphql-production/runs/job-queue.json`, under the configured
`HARNESS_WORKSPACE_ROOT`. The owner supplies a private 0600 file with the shared
`JobBuildQueueConfigurationSchema`, the installation's Main ID, reviewed limits
and resource envelopes. Queue review is owner bootstrap metadata; Operator MCP
cannot supply or approve it. The installer preserves this runtime directory
across updates and does not create queue limits, resource allowances or approvals.
Restart the API after changing the configuration. Saved requests, original
deadlines, selections and reservations remain in the production database;
startup reconciles those attempts and keeps capacity until confirmed closure.

PostgreSQL uses its durable defaults, including fsync, synchronous commit, and
full-page writes. The production password stays stable across updates. Preserve
`production.env` with database backups; installation refuses to generate another
password if that file is missing while the production volume exists. No production
credentials are written into repository `.env` files or test configuration. Normal
tests connect to a different port and role; `db:down` uses a different Compose
project and volume. Even production Compose `down --volumes` retains this external
volume. Back up the database and workspace/upload files before updates.

Updates preserve operator settings in `operator.json`, a JSON object of environment
variable names and string values. Existing settings in `production.env` are copied
there on the first update. Migration reads the same systemd quoting as service
activation, preserving quotes, backslashes and multiline values. Edit
`operator.json`, then rerun the installer. Binary
overrides, harness rollout choices and API/database timeouts are validated before
activation. Host, ports, database credentials, storage isolation and other
installer-owned settings stay in `production.env`; do not edit that generated file.
One OS file lock serializes the complete installation, including migration,
activation and readiness. Readiness verifies the database installation identity
and selected compiled release before opening Chrome.

The installer builds the API, browser, contracts and Worker artifacts from one
captured committed checkout. Commit desired source edits before installing;
uncommitted edits are not included. Each release records component commits in
`source.json`. Startup defaults have a separate completion record in
`installation.json`, so an incomplete first install can be retried while completed
upgrades preserve disabled services and deleted autostart entries.

During an update, a PostgreSQL maintenance lock closes new Run publication through
HTTP, Operator MCP and schedules before the installer checks for active Runs.
Existing Runs can finish, receive approvals or be stopped. New Starts return
`RUN_START_MAINTENANCE`; retry with the same command after installation. Saved
command receipts remain readable, and scheduled occurrences remain due for retry.
`FOREMAN_INSTALL_RUN_WAIT_MINUTES` accepts finite nonnegative minutes (default
120); zero checks once and aborts if Runs are active. Invalid values fail before
building. `FOREMAN_INSTALL_INTERRUPT_RUNS=1` explicitly permits interruption.

After stopping the API, the installer saves a private database archive before
migration and records cutover phases in `deployment.json`. A failed cutover
restores that archive before selecting and starting the previous release. Failed
releases and diagnostics are retained. If recovery fails, the installer stops the
API and retains the archive, recording any service-stop failure too. Rerunning
the installer retries recovery before building. Do not start the API manually
against an unresolved deployment.
Installation and database restoration remain OS-owner operations; Operator MCP
does not grant service control or database restoration access.

Native Codex and Claude harnesses use the desktop user's configured login files.
The service keeps that user's `HOME`; accepted harness permissions, native
qualification and application file-tool grants still control each operation.

## Claude access mode

Claude runs only with Full access (`danger-full-access`). Read only, Workspace
write and other access modes are rejected when saving a preset, host profile or
agent and before starting a workflow. Existing saved configurations retain their
values until the owner explicitly selects Full access; they are not upgraded.
Tool approval rules, application grants and qualification still apply. Qualify
an explicitly selected Full access profile before using the installed preset.
No Claude-specific AppArmor exception is required or installed.

For an environment-based provider credential, explicitly add the provider's
variable, such as `ANTHROPIC_API_KEY`, as a string in private `operator.json`,
then rerun `production:install`. This is an OS-owner setting, outside Operator
MCP; the file and generated service environment remain 0600. Provider credentials
reach native subprocesses, while database credentials and unscoped application
tokens are excluded. Never put credentials in the checkout or qualification logs.
An HTTP 401 from a particular provider requires fixing that provider's native
login or explicit credential; qualification remains required. Supported model
selection through Settings or `harness_defaults_update` MCP (with optional `expectedRevision`)
does not authenticate another provider or bypass its qualification.

Operations:

```sh
systemctl --user status graphql-operator-api.service graphql-production-db.service
journalctl --user -u graphql-operator-api.service -u graphql-production-db.service -f
curl --fail http://127.0.0.1:3041/health/ready
"$HOME/.local/lib/graphql-production/graphql"
```

Cold-start check, without rebooting the desktop:

```sh
systemctl --user stop graphql-operator-api.service graphql-production-db.service
"$HOME/.local/lib/graphql-production/graphql"
curl --fail http://127.0.0.1:3041/health/ready
curl --fail http://127.0.0.1:3041/workspaces
```

In Chrome, verify the dashboard opens without login and that launcher/taskbar and
UI icons render. Confirm saved workspace data survives the cold start. Verify
`ss -lnt` shows only `127.0.0.1:3041` and `127.0.0.1:55440` for this installation,
and the API process runs `dist/server.js`. To verify API crash recovery, kill only
the service's main process, then check readiness and the new MainPID:

```sh
systemctl --user kill --kill-whom=main --signal=KILL graphql-operator-api.service
```

After installing and configuring qualified native profiles, run the installed
service regression through the heavy-job queue:

```sh
corepack pnpm production:verify
```

This uses the installed compiled release and scoped agent HTTP/Operator MCP with
denied callers. Automated agent processes retain their application credentials;
verify credential-free human creation and edits in the actual browser, where OS
client attribution identifies the human client. It also
checks configuration migration and updates against actual systemd environment
values in a temporary service. It tests
an Operator reply, Codex/Claude workflows, denied callers, native cancellation,
a failed first database activation followed by automatic recovery, a production
PostgreSQL container restart, and recovery after killing the API's
main process or the entire service during native work. After service-wide SIGKILL,
it stops through MCP and verifies cleanup after another restart. Kernel removal of
an empty native cgroup can confirm closure even when SIGKILL prevents an exit
receipt; recovery requires the original parent and guardian to have exited and
verifies the full, unchanged cgroup hierarchy. It verifies persisted readback and
unchanged native execution/session bindings. On success and failure, it settles its
own native work, archives its workspace, removes that workspace's test runtime
storage and revokes its credentials. Persisted conversation and run history remain
available for inspection. Run it
when no personal work is active because the recovery checks restart services.
The API unit delegates its cgroup subtree to native guardians and restarts after
both failure and unexpected clean shutdown. An explicit systemd stop stays stopped.

To disable desktop autostart, remove
`${XDG_CONFIG_HOME:-$HOME/.config}/autostart/graphql-production.desktop` or set
`Hidden=true` in that entry. Updates preserve deleted and edited autostart entries
and service enablement choices; startup defaults are applied only to a fresh
installation. To stop and disable the backend,
use:

```sh
systemctl --user disable --now graphql-operator-api.service graphql-production-db.service
```

These actions retain production data.

Installed production verification is an administrative operation. `production:verify` writes temporary workflow/chat records to the installed production database and restarts its live services. Run it deliberately in a quiet maintenance window. It replaces `test:production:installed`; ordinary `test:*` commands use disposable resources and do not invoke this operation.

After API readiness, installation runs a CI smoke with a 240-second deadline:
responsiveness probes for at least 30 seconds, two consecutive CI admissions,
and one small integration test on every ready build computer and each ready
cloud executor provider. Integration smoke also exercises gate planning without
queuing the full gate and uses the measured integration shard limit. The
installer reads its repository and commit from staged release metadata and
requires an existing workspace configured for that repository. An enabled build
computer that is unready fails the smoke rather than being omitted. Each job must
report a passing smoke test; setup failures and empty test results fail closed.
Failures restore and restart the retained release and print the original error.
On a first install without a retained release, the rejected API is stopped.
`FOREMAN_INSTALL_SKIP_CI_SMOKE=1` explicitly opts out and prints that choice.

Operators can use `ci_run.smokeComputer` (or the workspace CI HTTP endpoint) to
pin one affected unit/integration test to an enabled computer, with an explicit
commit. Normal CI start/cancel grants and workspace scope checks apply. The
persisted target appears in `ci_get`; unavailable targets never use a fallback.
