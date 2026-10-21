# Startup hardening todo

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Goal: resolve the six startup risks audited in this conversation. Source baseline:
`26e49892feb24668ff742625ee61a93055c5153a`. No Linear work is authorized.

## Implementation and integration

- [x] Worker MCP: automatic authenticated per-instance routing and audited migration.
- [x] Operator chat: recover missing selections and isolate persisted state by installation.
- [x] Startup identity: verify checkout, database installation, and frontend/API pairing before reuse.
- [x] Browser origin: derive exact configured origin consistently without relaxing CSRF.
- [x] Execution readiness: distinguish server health, setup, and actual execution eligibility.
- [x] Launcher identity: recognize the managed installation across Node runtime path changes.
- [x] Integrate the six isolated commits and resolve shared contract/wiring conflicts.
- [x] Verify focused tests, authenticated MCP denial/readback, multiple ports and restart behavior.
- [x] Verify relevant rendered flows using built-in computer-use.

## Final review

- [x] Start one independent GPT-6 Astra reviewer at low reasoning effort after integration: `/root/final_review` (review complete).
- [x] Add each reviewer finding below with evidence, disposition, fix, and validation.
- [x] Primary agent fixes confirmed findings personally; no delegated fixes or second review pass.
- [x] Run relevant verification after fixes, commit, and report remaining limitations accurately.

### Findings

- [x] F1 (P1): API reuse did not verify the intended browser origin (`scripts/dev.mjs`).
  - Trigger: same checkout/database API remains running while `GRAPHQL_WEB_PORT` changes.
  - Evidence: originless session probe accepted old API; real API3040 accepted origin5182 and rejected5183 with403.
  - Impact: startup reports ready but browser API operations fail CSRF validation.
  - Fix: probe local browser access with the resolved Origin and explain mismatched API configuration.
  - Validation: CLI integration regression passed; live reuse on browser5183 against API trusting5182 correctly exited1 before frontend startup.

Reviewer `/root/final_review` completed the single read-only Astra-low review. No other findings were reported.

## Boundaries

Preserve explicit grants, scopes, read-only restrictions, rollout opt-ins, native
write approval, revision checks, idempotency, and audit records. Do not repoint or
stop unrelated instances. Keep credentials out of logs and commits. Full E2E is
not run by default. Passing unrelated tests is not proof of changed behavior.

## Verification evidence collected before review

- All six lane commits integrated; aggregate typecheck and lint passed.
- Focused browser integration: 39 tests passed.
- Final API unit sweep: 1450 passed, 9 skipped across 144 files.
- Live app started on browser 5182/API 3040; matching servers reused.
- Wrong frontend API target rejected without stopping its listener or the valid API.
- Recreated task-owned database at the same URL: checkout/database target unchanged, installation UUID changed.
- Browser showed blocked execution without opt-in, continued browsing, and a fresh empty composer after recreation.
- Aggregate build/typecheck/lint passed; 15 authenticated integration tests passed across 7 files. Full web sweep had timing failures; focused rerun passed43/45 with2 CodexPluginManager failures remaining outside this workstream.

## User correction after review

- [x] U1: permanently enable supported local Codex and OpenCode startup by default instead of only displaying its opt-in blocker. Preserve explicit disable, production restrictions, and native qualification/security. Verify real chat turns and both native MCP repairs.

## Live migration and service cleanup

- Codex Worker MCP repaired through Harness Settings; workspace shows Setup found.
- OpenCode Worker and Operator MCP repaired through Harness Settings; saved native entries are enabled.
- Existing Operator launcher content verified unchanged, then installation provenance recorded; both launchers recognized from a different installed Node runtime.
- Both harnesses report eligible under the corrected local defaults.
- Real chats returned STARTUP_CODEX_OK and STARTUP_OPENCODE_OK. Original Codex read-only defaults restored afterward.
- At user request, old API3000 and old frontend5174/5175 processes stopped and listener absence verified. Current app pair remains3040/5182.

The user explicitly requested permanent local execution defaults after seeing the
old opt-in blocker. Local loopback Codex/OpenCode now qualify and run by default.
Explicit disables and existing production restrictions remain enforced. This
is the user's authorized change to the initial diagnostic-only approach.

## Publication

User requested one PR per job, merge into GitHub main, then rebase local main onto origin/main. All implementation jobs were published and merged in PRs #33–#43, preserving newer upstream work. Redundant worktrees were removed after ancestry verification; the canonical checkout is local main.
