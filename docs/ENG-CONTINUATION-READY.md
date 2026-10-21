# ENG continuation G0 READY — 2026-09-24

## Cumulative source

- Repository: `nima20002000/graphql`.
- Original PR base: `50458ee99c67c760336449adbffea9e83985a95d` (`main`).
- Cumulative branch and PR: `feat/eng03-integration`, [PR #26](https://github.com/nima20002000/graphql/pull/26).
- Phase READY head: `1e3f88e309deced53070b3d9ff42603c2b4abf46`. The local integration worktree, remote branch and GitHub PR head matched and the worktree was clean when this contract was published.
- Historical planning head `a4321aee757f14a625ffc018d48433d6411ed20a` remains an ancestor. Nothing was reset to it.

All implementation, repair and evidence commits accumulate on PR #26. The orchestrator owns the integration branch, index, commits, pushes, installs, migrations and shared service lifecycle. Workers must not operate Git or restart shared services. No phase branch or replacement PR becomes the delivery head.

## Current migration handoff

The unified-board migration is committed as `1e3f88e309deced53070b3d9ff42603c2b4abf46` and pushed. Its source was produced by the existing GPT-6 Pro web migration conversation against `a4321aee757f14a625ffc018d48433d6411ed20a`; the downloaded bundle reported SHA-256 `51c06dfe9d0af842f9a3dbbebda95f2236a3f819f469bea6a5f0427f7fb152a3`. The shell integrated the bundle and added local mock/navigation adjustments in the same commit. The migration owner is no longer active and must not be duplicated.

That commit supplies the one V1 workspace composition, compatible draft/Run entrances, current/past Run selection, immutable Run pins, local typed draft/Agent staging and board regressions. It does **not** supply the shared Stop-before-meaningful-save protocol. In particular, it does not yet block meaningful publication through shared domain services while an affected Run is unsettled, reconcile an exact Stop receipt through terminal/cleanup settlement, or provide equivalent authenticated HTTP/MCP behavior.

## Frozen edit and save contract

- Presentation-only state comprises node position, viewport/pan/zoom, selection and UI-only panel size/collapse. It remains editable during execution and does not create an executable workflow version.
- Meaningful state comprises harness/model, prompts, tools/skills, execution and approval settings, Agents, execution edges, routing and repeat rules. A meaningful edit may be staged locally while affected work is active, but it cannot publish a new executable definition until the affected Run is authoritatively terminal and required cleanup/interaction settlement is complete.
- The two board actions are **Stop current Run and save edits** and **Discard changes**. Discard does not issue Stop and does not erase independent presentation state.
- Stop-and-save preserves the exact staged payload, uses and reconciles the same command receipt, waits for authoritative terminal plus required settlement, then rechecks scope, authority, saved revision and concurrent Start before saving exactly once. Stop acceptance is not settlement. Failure or uncertainty retains the staged edit. The flow never restarts automatically and never rewrites historical Run pins or facts.
- The guard belongs in shared contracts and domain services used by UI, authenticated HTTP and Operator MCP. MCP parity retains grants, scope checks, revision conflicts, idempotency and audit records; a denied caller and persisted readback are mandatory.

## ENG-03 source ownership from READY head

| Lane | State and owner | Exclusive scope |
| --- | --- | --- |
| NIM-2641, unified board | Source ready in `1e3f88e`; existing GPT-6 Pro web migration owner is finished | Existing unified-board source. Further edits only for reproduced integration defects assigned by the orchestrator. |
| NIM-2642, Stop-and-save | One GPT web implementation lane | Minimal shared contracts, API domain service and Operator MCP/HTTP parity for meaningful-save admission and exact Stop settlement; focused adversarial tests. Returns a pinned ZIP for shell intake. |
| NIM-2643, regressions | One GPT-6 Sol Medium worker | Disjoint regression/fixture files for classification, layout-only behavior, Run selection/navigation, discard, Stop/save races, refresh/reopen and denial/readback. No overlapping production edits. |
| Shell | Orchestrator | Shared wiring, bundle intake, integration conflicts, documentation, Git, full checks, phase review/test gate and small reproduced fixes. |

NIM-2642 owns any new shared contract shape. NIM-2643 consumes the frozen behavior without independently changing that contract. If a necessary fix overlaps the web lane, it returns to that lane rather than receiving a second writer.

## Runtime and tester resource map

- Frozen app candidate: the integration worktree serves the web app at `127.0.0.1:5173`; PostgreSQL listens at `127.0.0.1:5432`. No tester may restart or mutate the shared candidate while evidence is being collected.
- Browser controller: one Chrome connection currently exposes addressable tabs, including the integrated app and existing GPT web conversations. Addressable tab IDs prove targeting, not simultaneous independent pointer control.
- Non-destructive live lanes will use one task-owned workflow, Run and data namespace per tab. Same-Run multi-tab cases are explicitly coordinated rather than treated as independent writers.
- Destructive restart/provider-loss lanes require their own API/provider process, port, database/schema, session identities and runtime/project directories. They cannot reuse the shared app process or another lane's native sessions.
- Up to ten Medium testers may run only after the repaired candidate is frozen and the controller/data/provider capacity for each assigned scenario is confirmed. Actual concurrency and any serialization reason are recorded at dispatch; ten tabs alone are never reported as ten independent environments.

## Gate order

For ENG-03 through ENG-07: integrate source lanes on PR #26, run required automation, freeze an exact head, run one formal two-reviewer GPT web round, repair confirmed findings, freeze the repaired app, run the phase live matrix with Medium testers, and repair/retest until required cases pass. Then update Linear and the canonical Notion pages and advance. After ENG-07, run the separate three-reviewer whole-PR round and final live matrix. Owner acceptance remains open until the owner personally accepts the stable app.

This G0 record publishes source, ownership, interface and resource contracts. It is not implementation, review or live-test evidence.
