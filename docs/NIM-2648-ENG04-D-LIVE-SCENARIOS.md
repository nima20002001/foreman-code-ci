# NIM-2648 / ENG04-D — ENG-S3-ONLY reusable gate scenarios

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

This document prepares NIM-2649 live testing. The current D checkpoint ran authenticated HTTP/MCP and PostgreSQL 17 tests, but did not run the mounted browser or a real Codex/OpenCode workflow.

Current regression checkpoint base: `c327f4a7a70635643c9302fd9ba80bfa1ea41ac2`.
The current automated evidence and remaining boundaries are recorded in
`NIM-2648-ENG04-D-RETIREMENT-INVENTORY.md`. This document remains the live
qualification contract; automated PostgreSQL and synthetic runtime passes do
not mark these native scenarios complete.

## ENG-S3-ONLY evidence rule

Every **positive** current workflow in this gate is execution semantics 3. For S3-01 through S3-04 the saved workflow definition must have the `repeat` property **absent**. `null`, `{ blocks: [] }`, a cap-one block, a hidden wrapper, or a V3-to-V2 projection does not satisfy the scenario. S3-05 alone has a real configured finite repeat block.

For each live case record raw evidence, not UI labels or timing guesses:

- candidate Git SHA;
- workspace ID, workflow ID, every saved workflow-version ID/revision and exact semantics pin;
- exact `agentConfigurationVersionIds` map and accepted workspace execution-location snapshot/revision;
- Start command ID, authenticated caller/source, receipt ID/result and replay/conflict result;
- Run ID and raw node/execution/technical-attempt IDs;
- exact bound input bytes/digest and accepted result bytes/digest;
- provider harness, provider/native session/thread ID and native terminal identity where applicable;
- approval interaction/resume/ack/cleanup identities where applicable;
- repeat block/occurrence/input/decision IDs only for S3-05;
- graph snapshot `asOfSequence`, complete delta base/through/head sequences and reconstructed-state parity;
- Stop/edit command IDs and receipts when the scenario exercises them.

A spinner, card state, node color, process absence, test double, old ENG-03 result, or source inspection is not live native evidence.

## Mandatory reusable architecture smoke

### S3-01 — single and sequential V3, no repeat

On the actual mounted Board, create and save (a) a one-agent workflow and (b) A → B. Reopen each saved workflow before Start. Verify the saved definition omits `repeat`, persisted semantics is exactly 3, and the same Board Start uses the current shared service. Repeat equivalent create/save/read/Start through authenticated HTTP and Operator MCP using the shared domain family rather than a compatibility endpoint.

Verify exact version/configuration/location pins survive Start. For A → B, verify B receives A's exact accepted result through a durable predecessor binding. Ordinary runs must have real execution/attempt/input/result rows and **zero** synthetic repeat occurrence/carry/decision rows. Fetch snapshot plus complete delta at the same head and prove reconstructed state equals the snapshot cut.

### S3-02 — parallel/all-required unequal-depth join V3, no repeat

Create/save/reopen a V3 graph with one fast branch and one deeper branch feeding the same all-required join. `repeat` is absent. Start through Board and one authenticated programmatic surface, then verify the join does not run until every selected required predecessor has an accepted result. Record each raw branch execution/result identity and the join's exact bound predecessor set/digests.

Repeat-specific tables/projection facts must remain empty for the ordinary run. Snapshot/complete-delta parity must preserve both branch histories and the single join activation.

### S3-03 — conditional selected/unselected V3, no repeat

Create/save/reopen a V3 conditional with two explicitly named outcomes leading to alternative branches and a downstream join/continuation. `repeat` is absent. Drive each outcome in isolated runs. Verify only the declared selected edge activates, the other branch is durably unselected/skipped as the current graph contract requires, and no fallback is inferred from prose or canvas geometry.

Record the exact accepted routing result, selected/unselected relationship identities, downstream input digest and no repeat-only persistence. Run replay must not change the chosen route or duplicate an execution.

### S3-04 — approval V3, no repeat

Create/save/reopen a supported approval workflow with `repeat` absent and persisted semantics 3. Start it through the same current Start family as S3-01..03. Hold the exact approval, allow any independent selected sibling work to make legitimate progress, then deliver the approved decision through the supported reviewer path.

Verify a delivered UI response alone is insufficient: the exact graph-resume/native acknowledgement/cleanup evidence required by production must settle before progression. Record interaction, requesting execution, reviewer/native session, receipt and acknowledgement IDs. No repeat occurrence is created merely because an approval waits/resumes.

### S3-05 — real bounded repeat V3

Use one real configured finite repeat block. Qualify both:

1. **Early exit:** occurrence 1 (or a later occurrence below the cap) emits the declared early-exit outcome. Verify no unnecessary successor occurrence is created.
2. **Limit exit:** return the repeat outcome through the exact configured maximum occurrence. Verify the final decision is `limit_exit`, follows the saved limit target, preserves the latest deliverable + remaining findings and creates no extra occurrence/launch.

Retain all existing D evidence: distinct occurrence/input/result/decision identities, unequal selected joins inside each occurrence, unselected work, invalid-result rejection, duplicate observation, technical retry vs business repeat vs whole-Run retry, Stop mid-occurrence/between occurrences, approval settlement and provider-shaped/native identity checks.

## V3 add/remove repeat journey

Using one workflow, save V3 version N with `repeat` absent, version N+1 after adding a valid bounded block, then version N+2 after removing it. All three versions remain semantics 3 and preserve the exact configuration pins unless an intentional configuration edit is separately saved. Reopen each version/current workflow through the supported product path.

Run the no-repeat and repeat versions in separate Runs. No-repeat Runs must not receive repeat occurrence/round/carry/decision rows. The repeated Run must use real occurrence identities. Adding/removing repeat is a normal meaningful V3 version change, not an engine/complexity selector.

## Denial, replay, conflict and retired-tag cases

For Board-equivalent authenticated HTTP/MCP operations:

- a caller lacking the exact grant must fail before persistence/native dispatch;
- replaying the same command ID + canonical payload returns the stored receipt without duplicate work;
- reusing the same command ID with changed input fails conflict without another Run/version/effect;
- stale workflow revision, workflow-version/configuration pins or location revision fail before Start;
- explicit retired execution tags `1` and `2`, omitted saved semantics where a saved pin is required, and malformed/unknown tags fail clearly with no Run/native effect;
- never convert a retired tag to V3 and never route it to a legacy engine.

## Publication and read parity

Positive Start evidence must use A's real production V3 Start/lifecycle publisher as connected by B, not the old D test publisher or a mocked `admitRepeatRun` result. Verify the admitted Run opens the canonical current graph history and publishes native/accepted-result changes through the production path.

At a stable head sequence:

1. fetch the authoritative V3 snapshot;
2. fetch complete delta from the required base until `hasMore=false` at that same head;
3. reconstruct state from the delta and compare it to the snapshot state/topology cut;
4. refresh/reconnect and repeat the read without creating duplicate facts;
5. verify denied readers cannot learn graph payloads.

Protocol version `1` in this graph feed is an independent wire-protocol version and is allowed; it is not execution semantics 1.

## PostgreSQL qualification

Use only a D-owned disposable PostgreSQL-17 database/role. Never point destructive D tests at the shared app database. The opt-in repeat suite uses `RUN_ENG04_REPEAT_POSTGRES=1` plus an explicitly supplied admin URL dedicated to task-owned database/role creation.

The D suite now includes a no-repeat V3 persistence case that removes `repeat` from the fixture version and asserts all repeat evidence tables stay empty while an ordinary execution retains exact Run/node/Agent/configuration/attempt/input identity. On the current pre-A base that positive may be red if production schema/migration validation still requires repeat; that is a blocking A/integration dependency, not permission to fake a block.

## Provider pairing and native proof

Pair S3/T cases across available Codex/OpenCode combinations within native capacity. Provider-shaped deterministic tests are regression coverage only, never live proof. A live positive needs the actual raw provider/native session and terminal evidence captured from the frozen candidate.

## Retirement check before ENG-04 closes

The frozen candidate must have zero active V1/V2 **execution-semantics** dependency in current contracts, save/read/Start/runtime, mounted Board, bootstrap/fixtures and positive gate tests. The D source guard intentionally identifies remaining compatibility-only migration fixtures until they are retired/rebased to V3.

Do not confuse this with independent values that may legitimately remain: graph/MCP/native protocol versions, repeat contract version, provider versions, ordinary workflow revision numbers, or historical ENG-03 documentation/evidence.
