# CircleCI primary and standby capacity

Foreman supports one primary CircleCI login and one standby login, each with three explicitly registered GitHub
organizations. An organization belongs to exactly one login. Keep `default` as the primary account ID; the standby
uses a stable ID containing lowercase letters, digits or dashes. Labels are for display, and `account` in CI rows
still means the GitHub organization owner.

The Computers settings page is a read-only summary. The Operator manages registration and allowance settings
through MCP. A responsible human provisions provider tokens locally, outside Foreman. These are owner setup
instructions, not actions performed by opening Settings or registering an account.

## Prepare the six public mirrors

1. Keep the existing primary login and its three organizations. Use the existing second CircleCI account for the
   standby. Its GitHub identity is an automation-only machine account owning the standby CI organizations.
   [GitHub permits one free machine account](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service#3-account-requirements)
   in addition to a free personal account, created and maintained by a responsible human. Use a paid account if
   that allowance is already used.
2. Give each login its own three dedicated GitHub organizations. In each of the six organizations, create a public
   `foreman-code-ci` repository with the same mirror name as the workspace. Keep these mirrors dedicated to public
   Linux CI workloads. Main's existing GitHub transport identity needs push access to all six repositories; arrange
   that access outside Foreman without globally switching Main's `gh` login.
3. Seed each additional mirror from the sanitized current public mirror tree as one commit. Never push the private
   source repository's history or credentials. For example, in a disposable directory on disk:

   ```sh
   git init --bare <seed-directory>
   cd <seed-directory>
   git fetch --depth 1 https://github.com/<existing-mirror-owner>/foreman-code-ci.git main:refs/heads/main
   git push https://github.com/<new-org>/foreman-code-ci.git \
     "$(git -c user.name=ci -c user.email=ci@example.invalid commit-tree 'main^{tree}' -m 'CI mirror seed')":refs/heads/main
   ```

4. Sign in to CircleCI as each login and authorize its own three GitHub organizations. Set up/follow every public
   mirror using the repository's `.circleci/config.yml`. Check that `oss`, `dynamic-config` and `unversioned-config`
   have the required values; Foreman does not create projects or enable these settings for you.
5. Preserve the workflow's nonempty-`run_id` condition in `.circleci/config.yml`. An ordinary mirror push, including
   the initial seed, must not start a standby build. Confirm the setup without dispatching a job.

## Provision and verify each account profile

Create a personal API token in the intended CircleCI account with access to its project and usage operations.
The managed CLI profile is `<config-root>/foreman-code/circleci-accounts/<account-id>/circleci/config.yml`.
Its account directory is that login's `XDG_CONFIG_HOME`. Use directory permissions `0700` and profile permissions
`0600`. Store the token in this profile only; no second token file is needed.

Use the installed CLI's supported private file/stdin setup, such as `circleci setting set token -` with the account's
`XDG_CONFIG_HOME` selected. Do not put a token in a command argument, shell history, MCP input, screenshot or Git.
Avoid ordinary login/logout flows that replace the primary's shared keyring credential. The primary retains its
existing credential precedence until its own managed profile is provisioned; the standby only reads its own profile.

For verification, select the account's XDG home **and** its resolved token in the child environment. XDG isolation
alone is insufficient: an ambient `CIRCLE_TOKEN` overrides stored credentials. Foreman's account adapter supplies
the selected token to both token environment variables, preserving the rest of the child environment. Keep the
CircleCI host at `https://circleci.com`.

With that account context already selected, use read-only checks for each of its three mirrors:

```sh
circleci auth me
circleci project get --project gh/<org>/foreman-code-ci --json
circleci project setting list --project gh/<org>/foreman-code-ci
```

Check the displayed identity and project, without printing token settings or environment values. Record the six
organization owners and resolved CircleCI org IDs privately as setup inputs. Standby discovery uses these explicit
bindings; it does not require membership in Main's `gh` account. Confirm Main's existing transport can publish to
every mirror. Usage-export verification against a real org requires a separate owner-authorized request; do not
issue ad hoc export POSTs as a diagnostic or on every UI poll.

See the [CLI configuration reference](https://cli.circleci.com/reference/) for the installed CLI's supported setup
and stdin options. Token creation, rotation and revocation remain local owner actions; registration accepts metadata
even when a profile is missing.

## Register metadata through the Operator

Read `circle_accounts_list` first. Bind the primary's three orgs to reserved ID `default` using `circle_account_add`,
then register the standby with the same tool. These fixture examples show the nonsecret input shape:

```json
{"account":{"id":"default","label":"Primary","role":"primary","organizations":["primary-one","primary-two","primary-three"]}}
```

```json
{"account":{"id":"overflow","label":"Standby","organizations":["standby-one","standby-two","standby-three"]}}
```

The additional account defaults to standby. There is no active/active switch. `expectedRevision` and `commandId`
are optional; a supplied stale revision conflicts, and repeating the same command ID and input is idempotent.
Use the existing global `settings:read` and `settings:update` grants. No new approval or baseline is needed.

Read `circle_accounts_list` again and compare with the Computers card. It returns labels, account IDs, bindings,
credential-configured/readiness status, each org's scheduling role/reason, running jobs and estimated credits,
plus the saved revision. `Configured` means a token is present; `Setup needed` means local provisioning is missing.
An authenticated `Standby` row is waiting for credit overflow, rather than logged out.

Read `circle_credit_allowance_get` before making allowance changes. Eligible public Linux orgs have a fallback
allowance of 400,000 credits, but saved defaults and per-org overrides remain unchanged. A saved 30,000 may be
intentional. If the owner chooses to correct it, use `circle_credit_allowance_update`, preserving unrelated/custom
values. The wire field `value.accounts` is still keyed by **org owner**, not CircleCI account ID. Read back the result.
The [CircleCI credits guide](https://circleci.com/docs/guides/plans-pricing/credits/) describes OSS eligibility;
Foreman displays estimates, rather than an actual provider balance.

Registration should leave all three secondary orgs on standby while the primary orgs have capacity. It must not
trigger a build. The HTTP metadata reader is `GET /api/management/settings/circle-accounts`; there is no token form
or token API endpoint.

## Overflow, sampling and monthly reset

An org is exhausted for new work at **estimated credits left ≤20,000**, including exactly 20,000. This reserve
accounts for delayed readings. Each exhausted primary org permits at most one eligible standby replacement, in
normalized org-owner order, with the requested workspace's mirror. Healthy primary orgs remain active:

| Exhausted primary orgs | Active primary orgs | Active standby orgs, at most |
| --- | --- | --- |
| 0 | 3 | 0 |
| 1 | 2 | 1 |
| 2 | 1 | 2 |
| 3 | 0 | 3 |

Queue spikes, full slots, failed authentication and missing mirrors do not activate overflow. Unknown credits do
not imply exhaustion. A standby needs a known eligible current-month reading for first activation. A remembered
exhaustion result and its replacement survive stale/failed reads for that UTC month; a fresh qualifying reading,
including an intentional allowance correction, can recover capacity. The same 20,000 threshold applies to orgs
on either login. Later unknown readings retain an existing replacement assignment and are reported as unavailable.

Exports are created at most every three hours per org, with creation attempts and pending jobs retained across
restarts. The [Usage API](https://circleci.com/docs/api/v2/index.html#tag/Usage) permits at most 10 export-creation
POSTs per day and 10 export GETs per minute per org. Foreman keeps a six-second GET floor, resumes pending jobs
without a new POST, and respects rate-limit backoff. Repeated Settings/MCP reads do not create extra exports.
Readings are usable for four hours from the export window's end; `asOf` is the download time. Usage may include
other consumption and may lag recent jobs, so the estimate cannot guarantee exact balance or uninterrupted runs.

At 00:00 UTC on day 1, prior-month usage, exhaustion and role assignments reset together. Primaries resume new
work and secondary orgs return to standby. Existing jobs drain through their original login, including log reads,
collection and cancellation. A late previous-month export cannot exhaust the new month. Temporary overlap while
old jobs drain is expected; no job is migrated or canceled by failover/reset.

## Troubleshooting and removal

- **Setup needed:** provision the named account's private CLI profile locally. Re-read the summary; never send the
  token to the Operator. A missing standby profile must not silently reuse the primary credential.
- **Configured, needs attention:** check the account identity and each explicit project with that account's selected
  context. Confirm GitHub authorization and mirror access. Authentication failure does not count as credit exhaustion.
- **Standby:** normal while the server has no exhausted primary org to replace, or no eligible mirror/reading for this
  workspace. Check the returned reason. Do not infer activation from a queue spike or calculate it in the browser.
- **Out of credits with jobs running:** new starts have stopped at the reserve; accepted jobs continue on their saved
  login. Keep old unnamed CircleCI rows and their journals until those jobs and collection finish.
- **Credits unavailable/stale:** check the returned reason and export cadence. Wait for the existing job/backoff;
  repeated export creation can consume the daily quota. An expired reading does not erase remembered exhaustion.
- **No extra free capacity:** standby and exhausted slots do not accept new work; their draining jobs remain visible.
  At most three logical org capacities accept work at once across both logins.

To remove the secondary, let dependent starts, runs and collection settle, including retained execution references.
Call `circle_account_remove` with its ID, then read `circle_accounts_list`. Removal can be blocked while work still
depends on that account; it cannot remove or repurpose `default`. Historical run records and journals stay intact.
After successful metadata removal, the owner separately revokes its token and removes its private local profile.
No SSH, VPS, router or transport-security changes are part of this setup.
