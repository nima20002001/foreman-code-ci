# Main consolidation

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

The canonical checkout is `/home/user/Desktop/graphql` on `main`. GitHub `main`
is authoritative. Startup, Operator routing, catalog pagination/batch selection,
and the restored approval-detail display were replayed onto GitHub main at
`801436b`, retaining its V3 workflow engine and logging changes.

Historical worktrees were inspected before removal. Approval, chat, directory,
and legacy graph changes match the already-merged `dbf7156` implementation.
Create-navigation behavior and its regressions are also present in the newer
main implementation. The lost correlated approval target/change summary was
ported into the current inbox, without restoring the retired UI.

PRs 9–16 had heads already reachable from main. All 28 non-merge commits in PRs
27–30 have exact stable patch-id counterparts incorporated through PR26. Those
stale PR records were closed; their work was not discarded. Original worktree
and PR source histories are preserved as merge parents after the verified code
integration, so historical snapshots do not overwrite newer main code.

Validation before publication included actual Codex and OpenCode chat replies,
automatic native MCP configuration repair, exact-origin startup refusal,
database-recreation identity checks, authenticated MCP denial/readback, and
focused regression tests. The upstream tree retains legacy-test type errors;
those are distinguished from the application-source and focused checks.

Temporary and historical checkouts are removed only after their heads are
reachable from main. Local environment files are kept outside Git, and the
running application is moved to the canonical checkout with its data preserved.

## Completed state

Implementation PRs #33–#43 are merged. The twelve obsolete PR records are closed
as already incorporated. All additional registered worktrees have been removed
after verifying their heads are reachable from main. The API and frontend now
run from `/home/user/Desktop/graphql/apps/api` and `apps/web` respectively, on
3040 and 5182, using the preserved app database. Historical non-main branch tips
are archived as tags before branch cleanup; generated handoff artifacts are not
reintroduced into the application tree.
