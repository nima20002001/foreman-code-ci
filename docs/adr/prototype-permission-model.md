# ADR: Prototype permission model — no paperwork

- Status: Accepted (owner decision)
- Date: 2026-10-13, extended 2026-10-14
- Scope: every API, MCP tool, Worker, CI and UI path

## Decision

Foreman Code is a prototype. Agents and the Operator may do whatever their work needs on the computer, without
bureaucracy. There are exactly two ways to give an Agent less power:

1. **Limit its MCP tools** in the workflow (per-node tool overrides, Agent role defaults).
2. **Run it read-only** (harness sandbox / read-only mode).

Everything else that made an authorized caller prove, approve, re-state or re-request something before acting is
"paperwork" and was removed on purpose. Its absence is not a bug.

## Rules for reviewers and fix agents

- Do not reintroduce a removed check, field, grant, approval step, cap or baseline below, not even to make a test
  pass or to "harden" a review finding. When a test expects the old behavior, change the test to the new behavior.
- Do not add new permissions, grant actions, approval steps, owner/human-only gates, expiry deadlines or
  required "expected*" baselines for Agents or the Operator. If something seems to need one, raise it with the owner
  instead of adding it.
- A review finding of the form "X is no longer restricted/approved/revision-checked" is not a defect when X is listed
  here.

## Removed paperwork

| Area | Removed | Now |
| --- | --- | --- |
| Worker bundle | Hand-maintained allowlist of API modules the Worker may import | Derived from the bundle import graph; only the deny-list remains |
| Codex approvals | Default `approvalPolicy: on-request` that refused workflows without a routed approval handler | Default `never` |
| CI grants | ci_run needing about nine actions intersected across caller and Run author | One `ci` action |
| Credentials | Default Operator token expiry and the Run token lifetime cap | No default expiry |
| Workflow edits | Required `expectedNodePresentation`, `expectedGeometry`, location/presentation baselines | Last write wins for names and layout |
| CI file selection | 2000-file cap and allowed-root path list | Any safe repository path |
| Source capture | Approving every tracked path (`approvedPaths`) before a Run or CI capture | Tracked source captured automatically |
| Device trust | Browser-made owner approval bound to an action hash for device connection changes | Pairing is the approval; `settings:update` acts directly |
| Harness settings | Local-human-only plugin and MCP change/reconcile routes | Bearer callers with the normal grant |
| Harness profile checks | Manually calling `harness_instance_check` after enabling or changing a profile | Enabled saves start the shared native check automatically; Start and placement choices check missing or stale results, deduplicated per instance revision. Start returns retryable `HARNESS_PROFILE_CHECK_PENDING` while checking; failed checks still block with their reason |
| Idempotency | Required `commandId` on simple operations | Optional; generated when omitted |
| Settings revisions | Required `expectedRevision` on settings writes | Optional; last write wins when omitted |
| Saved workflow placement | Root policy, location, source binding/snapshot and harness instance revision pins required again at Start | Saved placements name the host, root policy, instance and cwd; Start resolves their current revisions, rebinds the current approved source when needed, and records exact resolved facts on the Run |
| Workspace root sharing | Creator equality between root policies, source bindings, placements and Runs | Any caller with the normal workspace grants may use its root policies and bindings; creator IDs remain historical facts. Host, installation, registration and canonical path identity checks still apply |
| MCP inputs | Rejecting unknown fields | Unknown fields are stripped |
| Read sizes | Hard caps that threw on large workspace and graph reads | Truncated newest-first |
| Agent snapshots | 700 KiB source snapshot limit | 32 MiB |
| Local network | Loopback-only Host/Origin | Tailscale hosts (`*.ts.net`, 100.64.0.0/10) accepted with normal auth |
| Workspace folders | Locations and folder browsing only inside the app Workspaces folder | Any folder, symlinks included; containment kept for deletes |
| Device provisioning | Unimplemented `device_*` provisioning tools and `devices:provision` grant | Removed |
| Harness releases | Hand-recorded qualified release pins | Runtime verification records |
| Pairing lifetimes | 5-minute pairing grants, short provider sign-in lifetimes | Extended |
| CI reads | Agents reading only CI tickets their own execution requested | Agents with `ci_get`/`ci_logs_read`/`ci_cancel` act on every ticket of their workspace |
| Script tests | Hand-listed `scripts/*.test.mjs` files | Glob discovery |

## Real boundaries that stay

These are not paperwork; keep them:

- Bearer/session authentication, MCP tool grants and workspace scopes. A caller without the tool or grant is denied.
- Read-only Agents stay read-only; never add writable paths or tools to work around a sandbox.
- Tokenless requests must come from the local human (loopback plus not an Agent process).
- Provider API-key provisioning is local-human-only (keeps credentials away from MCP).
- Revision conflicts where a caller *chose* to send an expected revision.
- Release clean-round gate (`scripts/release.mjs`, `scripts/verify-release-round.mjs`).
- CI gates and `smokeComputer` are Operator-only (one global gate; Agents must not starve it).
- Runaway caps that normal use never hits (native pending-interaction cap, 8 MiB prompt cap).
- Directory delete containment and rsync binary ownership/symlink checks (data loss, code execution).
- pnpm minimum release age and `allowBuilds` (supply chain).
