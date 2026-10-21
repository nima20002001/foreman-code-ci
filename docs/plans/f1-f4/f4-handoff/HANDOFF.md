# Current handoff — F4 implementation part 1

## Decision and status

The user requested immediate packaging of the current saved work, after a quick independent review of what is included. Implementation stopped; this package makes no feature repairs. **All 253 actual saved changed source/test files are preserved, including incomplete native and UI work. Both independent reviewers returned a partial / NOT CLEAN verdict.** There are material integration defects, missing public regressions, and unreviewed portions; the checkpoint is not ready to merge as completed F4, release, or enable the result protocol.

Read `README.md` for the exact base, ownership, archive layout, and apply/recovery instructions. Read `REMAINING.md` for the current backlog. The authoritative work item and full plans are included under `context/`; the complete fresh bounded reviews are under `reviews/`.

## Frozen source identity

| Item | Value |
| --- | --- |
| Base commit | `003775c1e2cfb3f1616a9b3bfb8cbba7289ff7e1` |
| Base tree | `a8721bc0e5c556d101667ef440ce54cbb521c613` |
| Plan commit | `efcc0fe565843c7c3aaf45ed835591d855b0f656` |
| Source freeze UTC | `2026-10-21T01:43:21.328222+00:00` |
| Inventory SHA-256 | `05e326d1aca6037a26e4793e76c3426dbdda169731129bb556d582e8fa61f5c5` |
| Source files | 253: 104 added, 149 modified, 0 deleted |
| Source distribution | 145 API, 88 web, 20 shared-contract files |
| Test source files | 32: 25 added, 7 modified; none run |
| Postimage byte total | 3,429,048 |
| Expected overlaid Git tree | `b70efe61667467376e135d80d0dc3b7449e36347` |

The original sparse checkout used skip-worktree flags. Ordinary Git status/diff did not enumerate all saved edits. Recovery compared the actual bytes and mode of all 1,040 materialized files with the exact base tree, checked the union of old owner inventories, and retained all actual differences. Sixty changed paths were recovered beyond those prior inventories. All prior inventory paths existed; no missing baseline path was treated as a deletion. There are no excluded saved source changes or separate non-applied recovery payloads.

## What is present

The files contain hierarchy contracts, save/read/MCP/report services, group/return/direction runtime work, universal marked-result parsing/proof/repair, transactional collaboration adapters, additive migrations, durable execution-chat/control/consultation services and credentials, partial local native owner/adapter changes, and hierarchy/shared-shell UI. These are saved implementations, not validated capabilities.

The native SingleWriter qualified-control methods, actual native target capture, durable unknown-before-offer receipt path, consultation observer/prompt helpers and owner/mailbox code are present. The fresh review found that production, Main/Worker transport, authority, credential/lifetime wiring and failure cleanup still do not form a complete path.

UI source is present for the earlier U1–U6 repair work and K1–K6 shell additions: root cursors independent of child reports, new-Agent defaults, conflict retention, Worker parent Apply/Cancel, report history, removal/replacement, worker visibility/team navigation, saved-Run integration, workspace Memory, and Browser profile settings. The interrupted native-subagent visibility/composer edit has a coherent saved tail. Complete mounted acceptance coverage and final integrated review remain incomplete.

Production result-protocol admission/enforcement is **OFF**, independently confirmed at `apps/api/src/modules/runs/repeatStartAdmission.ts:348–359`. Hierarchy Start returns `HIERARCHY_RESULT_PROTOCOL_UNAVAILABLE`. This is an intentional incomplete-readiness state. Synthetic marked fixtures and parser implementations do not qualify production cutover. Preserve all unmarked Run, version, result and native evidence.

## Ownership and continuity

`context/plans/lanes.md` remains the ownership authority. Team D owns shared contracts, engine/native/device/registry/shell integration and F4. A owns F1 feature modules, B owns F2 browser/profile/runtime feature modules, and C owns F3 conversation/chat feature modules. The package contains no identified A/B/C-exclusive path. Actual peer exports are still needed; do not duplicate peer stores or managers in D modules.

Earlier owner handoffs are copied unchanged for interface details. Their absolute source paths and agent names are historical context, not required locations or active workers. Their stale remaining-work lists and proposed final filename do not supersede this package's `REMAINING.md`, frozen source, reconciled issue, or requested `F4-impl-part1.zip` name. In particular, many earlier UI/engine gaps now have source; the current review distinguishes those from still-missing work.

## Review and verification limits

The fresh backend review identifies B1–B6 concrete material findings and further race/coverage gaps. The UI review identifies the precise unfinished mounted journeys and scope limits. These are quick targeted reviews; large migrations, all engine paths and every changed file have not received a full independent approval. The backend reviewer read a few unchanged baseline transport dependencies only to ground missing interfaces; those dependencies are not included as changed files.

Packaging verified the exact-base patch application and all applied postimages, full expected overlaid index equality, source/path ownership patterns, safe archive paths and payload hashes. The byte scan found no empty files, invalid UTF-8, merge markers, credential-shaped literals, cache metadata paths or exclusive peer namespace hits; this is a bounded packaging scan, not a security or compile audit.

No tests, compiler, build, linter, formatter, migration, native process or product code were run. No dependency install, push, PR, GitHub or Linear mutation occurred. The original worktree remains preserved. The user or a subsequently authorized team must perform verification after completing the remaining work.
