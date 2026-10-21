# ENG-04-A / NIM-2645 — bounded repeat contract v1 (A0)

**Status: source handoff, not integrated, qualified, or runtime-enabled.**
Repository: `nima20002000/graphql`; cumulative PR: `#26`.
Prerequisite / patch base: `73cb6128eca02252a98a2454ff604ba590029696`.
Historical main base: `50458ee99c67c760336449adbffea9e83985a95d`.
Authority: NIM-2632, NIM-2635, NIM-2645, NIM-2649; canonical Notion page
`3db6ac6f-6767-815c-aee1-f0b1cda81c3f`, including its September 25 activation note.

## Freeze and activation boundary

This additive package supplies contract version **1** and reserves execution semantics **3**.
It does not extend any existing saved-version, definition, Run, graph-feed, HTTP, MCP,
Start/admission, meaningful-edit, or UI union. Existing semantics-1/2 versions keep their
original bytes, identities and behavior. Existing `WorkflowVersionV2Schema` cycle rejection
remains intact. No migration, service, runtime switch or admission flag is changed.

`RepeatWorkflowVersionV1Schema` is a **candidate immutable-version validator**, not an
executable-admission capability. It reuses the complete v2 structural validator through a
private validation-only projection of the static DAG. That projection is never persisted,
returned as a saved version, passed to a runner, or substituted for a historical version.
The future saved v3 version needs its own new ID and content hash; never retag an old row.
Actual scoped configuration records, pinned product roles, native compatibility,
authorization, revision, meaningful-save and concurrent-Start checks are still required.
The candidate validator does not replace `ExecutableWorkflowV2Schema`'s configuration
checks or any authenticated domain guard.

Before any dependent code lane starts, the shell must verify this bundle, run the pinned
contract tests/typecheck, integrate it, and publish the **full committed and pushed contract
SHA**. That SHA does not exist in this handoff. B/C/D must not use the prerequisite SHA,
a ZIP digest, a branch name, or a guessed next commit as the contract freeze.
No lanes are launched by this document. Subsequent B/C/D assignments are **GPT Web xhigh**
under the owner's current no-local-coding instruction, not Linear's original Medium staffing.

## Saved repeat shape

The candidate keeps existing nodes, relationships, named choices, approval assignment,
configuration pins, execution policy and immutable-version fields. Its top-level and
`definition.executionSemanticsVersion` are both `3`. Its sole new definition field is:

```json
{
  "repeat": {
    "contractVersion": 1,
    "blocks": [{
      "id": "review-fix",
      "nodeIds": ["work", "review"],
      "entryNodeId": "work",
      "exitNodeId": "review",
      "maxOccurrences": 3,
      "repeatOutcome": "issues",
      "earlyExitOutcome": "pass",
      "limitExit": { "kind": "edge", "relationshipId": "review-limit" }
    }]
  }
}
```

The exit node already has a normal saved choice: `pass -> review-done`,
`issues -> review-limit`. The limit route deliberately equals the existing choice target
for `repeatOutcome`; there is no second route declaration that may disagree with it.
An explicit `branch_end` is supported for either final outcome, including limit exit.
No loop/back-edge is added. Below the cap, the repeat decision withholds external egress
and requests another occurrence at the block's entry instead of taking the limit route.

Supported scopes are flat, non-overlapping sets of existing nodes in an acyclic execution
graph. Every member must be reachable internally from the single entry and able to reach
the single exit. External execution edges may enter only at the entry and leave only at
the exit. A one-node scope is supported. Approval relationships remain authority
relationships, not scheduling edges. Disjoint serial or parallel blocks are supported;
an excluded/unselected block is not activated merely because it is declared.

The exit has exactly the two distinct declared outcomes. Interior conditional paths and
existing all-required joins are supported; an interior choice may not terminate with
`branch_end` in this first contract because that could bypass the block's decision.
Unsupported nesting, overlap, side entry/exit, extra exit outcomes, disconnected bodies,
arbitrary cycles and expression/configuration fields fail explicitly. No shape is silently
flattened, guessed, repaired or treated as one-shot. Plan-only validation is context-free;
use the full candidate-version validator for graph/route/pin consistency.

`maxOccurrences` is mandatory: a positive finite 32-bit integer, with **no default**.
It counts the first occurrence: cap 1 means zero business repeats. The representation
ceiling is 2,147,483,647, not a recommendation or runtime throughput promise. Existing
`maxNodeExecutions` must at least cover the static nodes plus
`sum((maxOccurrences - 1) * memberCount)` across disjoint blocks. Other execution,
timeout, technical-attempt and resource limits still apply; they do not authorize an extra
business occurrence or guarantee completion of every allowed occurrence.

## Accepted exit result and deterministic rule

Only the entire successful `ExecutionResult` accepted for the exact exit execution can
supply the decision. Existing `parseChoiceResultEnvelope` rejects prose/Markdown
extraction, malformed JSON and undeclared outcomes. Only repeat exit nodes add this fixed
`data` shape; ordinary one-shot choices retain their current arbitrary JSON data:

```json
{
  "routing": { "outcome": "issues" },
  "data": {
    "latestDeliverable": { "revision": 3, "text": "latest deliverable" },
    "remainingFindings": [{ "id": "f1", "text": "remaining issue" }]
  }
}
```

The deliverable is required non-null JSON; findings are a required JSON array (possibly
empty). The complete envelope retains existing bounded-JSON/result limits; no truncation.
At occurrence `n`: (1) `earlyExitOutcome` selects its saved target, even at the cap;
(2) `repeatOutcome` with `n < maxOccurrences` records `repeat` and target
`{kind:'next_occurrence', entryNodeId, occurrenceIndex:n+1}`;
(3) `repeatOutcome` at the cap records `limit_exit` and the explicit `limitExit` target.
No other outcome has a fallback. A repeat decision is **not a launch or native receipt**.

`resultData` on a decision must equal that occurrence's exact accepted exit data, not an
older deliverable or findings list. It is private result content, not proof of transport
delivery. At the cap there is no extra occurrence and no manufactured approval/pass.
`limit_exit` is an explicit business outcome, not an automatic rewrite of the successful
native result to failed or of the complete Run to approved. The saved continuation and
existing selected-work completion policy determine subsequent work and terminal Run state;
readback must retain the distinct limit-exit reason and findings.

## Durable identity, input, result and route provenance

| Record/key | Normative binding |
| --- | --- |
| Occurrence | Unique `(runId, workflowVersionId, blockId, occurrenceIndex)`, plus a globally unique durable `occurrenceId`; exact workspace/workflow/version/semantics scope is included. |
| Node execution | `RepeatExecutionIdentityV1Schema` pairs the complete existing node/Agent/configuration/execution/technical-attempt identity with its occurrence. No execution ID is reused in another occurrence. |
| Input | `RepeatOccurrenceV1Schema.input` points to an immutable private input snapshot by unique `bindingId` and canonical `inputDigest`. Persist actual input and exact selected sender/recipient/result bindings before launch. |
| Successor ancestry | Occurrence 1 has `previous:null`. Every later occurrence names exactly the preceding occurrence ID/index, decision ID and accepted-result digest in the same Run/version/block. |
| Accepted result | Identified by the exact occurrence **and execution ID** plus its accepted digest. A digest alone is not an identity; identical result bytes may legitimately have equal digests in different occurrences. |
| Route | Immutable unique `decisionId`, exact exit execution, accepted-result digest, observed outcome, explicit reason, target and decision time. Conflicting evidence must never overwrite an existing decision. |

The initial entry input captures the Run input and selected external predecessor results.
Those external bindings stay frozen for this invocation of the block. A successor adds
only the preceding occurrence's exact accepted exit result as the fixed carry, including
its latest deliverable and findings. Do not rerun external predecessors, re-read mutable
Agent state, mix previous body-node results into a new join, or use a different attempt's
result. Every internal selected input is keyed by the recipient occurrence and exact
sender execution/result; cross-block inputs name the completed source occurrence.
Private input storage layout is A's implementation concern; the reference/digest and
provenance semantics here are the shared boundary. A schema cannot prove backing rows,
recompute a supplied digest, or authenticate its source: A/B must do those checks.

Technical retry/recovery stays in the **same occurrence and frozen input**, using its
technical-attempt identity and existing allowed retry policy. Duplicate observations,
checkpoint replay, approval delivery/resume and lease/generation changes do not consume
the business cap. A full-Run retry gets a new `runId`, fresh occurrence/execution/input/
decision identities and occurrence 1; any parent-Run lineage is separate provenance,
never a `previous` carry into the new Run. Existing historical facts are immutable.

## Runtime and public-read obligations (NOT implemented in A0)

A must extend the existing LangGraph/coordinator/repository foundations, not add another
engine. Selected/skipped wrapper and join resolution stays occurrence-local. Required
body work and pending transitions must settle before a final block exit. Intermediate
repeat decisions must not publish external edges as selected or unselected: those edges
remain unresolved until the final early/limit exit. External joins therefore consume only
the final occurrence, and whole-Run completion still waits for every selected required
component and pending transition, not merely the first completed/limit-exited block.

Persist input/acceptance/route/occurrence effects idempotently under existing Run ownership,
generation, revision, session and command/effect-receipt fences. Every possible-submission
or lost-reply ambiguity is reconciled against the same identity; never blindly resubmit.
The acceptance/route/successor intent and corresponding public facts must share the required
transaction boundary. A pre-Stop recorded repeat decision remains evidence, but Stop blocks
future activation; neither a decision nor process absence proves native closure. Preserve
required approval acknowledgement, cleanup and terminal/save-admission barriers. Recovery
cannot invent Worker resume, duplicate a response, accept contradictory terminal evidence,
or silently restart a stopped Run.

For later readback, `RepeatOccurrenceV1Schema` and `RepeatDecisionMetadataV1Schema` provide
content-free identity/input-reference/decision records. Private `RepeatDecisionV1Schema`
adds `resultData` only for authorized, bounded result detail. Current snapshot and complete
delta replay must expose identical committed metadata at the same head, with revisions,
retention/reset and current/history pins intact. These schemas are **not** registered in
any existing graph fact/snapshot union by A0. C may display "repeat decided" from a decision,
not "next occurrence running" until authoritative occurrence/execution facts exist.
Normal lifecycle/approval/cleanup state remains authoritative; do not infer it from a
missing decision, a counter, elapsed time or animation.

## Exact exports for dependent lanes

Import from **`@graphql/contracts/wave25`**, never local copied definitions:

| Consumers | Exports (matching TypeScript types omit `Schema`) |
| --- | --- |
| A/B/C/D | `REPEAT_CONTRACT_VERSION`, `REPEAT_EXECUTION_SEMANTICS_VERSION`, `RepeatBlockV1Schema`, `RepeatPlanV1Schema`, `RepeatWorkflowVersionV1Schema` |
| A/B/C/D | `RepeatOccurrenceIdentityV1Schema`, `RepeatExecutionIdentityV1Schema`, `RepeatOccurrenceV1Schema`, `RepeatDecisionMetadataV1Schema` |
| A/B/D; C only for authorized detail | `RepeatExitDataV1Schema`, `RepeatDecisionV1Schema`, `parseRepeatExitResultV1`, `validateRepeatDecisionV1`, `validateRepeatSuccessorV1` |

`validateRepeatDecisionV1(version, decision, acceptedResult)` validates an already recorded
decision against its saved version and the loaded accepted result. The caller must prove
the result belongs to the exact execution/Run and verify its digest. It performs no effects.
`validateRepeatSuccessorV1(version, previousDecision, nextOccurrence, acceptedResult)` also
validates that prior decision, then the adjacent same-scope lineage. It supplies no Stop,
owner, cleanup, native acknowledgement, or launch permission.

## Exclusive next-lane ownership map

This is an allocation, not authorization to begin before the integrated contract SHA.
`NEW` paths below are reserved future files, not delivered implementations. Any unexpected
existing file or new overlap at the freeze SHA must return to the shell for allocation.
No worker expands a glob or edits an unlisted shared file without a revised ownership map.

| Owner | Exclusive production/test paths | Behavior |
| --- | --- | --- |
| A — core, Pro | Existing `apps/api/src/modules/runs/{oneShotGraph,oneShotNode,oneShotResolution,topology}.ts`; NEW `apps/api/src/modules/runs/{repeatGraph,repeatNode,repeatResolution,repeatPostgres,repeatRuntime}.ts`; NEW `apps/api/src/infrastructure/repeatOccurrenceMigration.ts`; NEW `apps/api/test/eng04-a-repeat-core.test.ts`; A0 `packages/contracts/src/wave25/{repeat.ts,repeat.test.ts}` and this contract document. | One engine, durable occurrence/input/result/route/effect storage, constraints/migration SQL, occurrence-local joins/completion, recovery/Stop/approval fencing. A supplies narrow integration instructions for shell-owned repository/wiring files. No API transport or UI implementation. |
| B — HTTP/Operator MCP, GPT Web xhigh | Existing `apps/api/src/modules/workflows/{management,postgres}.ts`; NEW `apps/api/src/modules/repeats/{authoring,readback}.ts`, `apps/api/src/routes/repeats.ts`, `apps/api/src/mcp/operator/repeats.ts`; NEW `packages/contracts/src/wave25/{repeatAuthoring,repeatReadback}.ts` and matching tests; NEW `apps/api/test/eng04-b-repeat-http-mcp.test.ts`. | Shared authenticated authoring/admission/readback adapters; strict v3 candidate/configuration validation; grants, all affected-workflow authority, revision/idempotency/audit, meaningful-edit protection, denied callers and persisted parity. Uses A's occurrence store; never independently progresses occurrences. New endpoint schemas must consume A0 types, not revise them. |
| C — same-board UI, GPT Web xhigh | NEW `apps/web/src/features/repeats/{RepeatEditor.tsx,RepeatStatus.tsx,repeatModel.ts,useRepeatAuthoring.ts,client.ts,index.ts,repeats.css}` and co-located `*.test.ts(x)` only. | Flat scope/entry/exit/cap/outcome authoring and truthful basic occurrence/limit state on the existing board; local staging and explicit Stop-and-save/Discard through existing protocol. TanStack Query owns server facts, Zustand only local edits, URL owns linkable selection. No new page, run-history rewrite, shared style/token changes, or second fact store. |
| D — qualification fixtures, GPT Web xhigh | NEW `apps/api/test/eng04-repeat-{identity,joins,replay,stop,approval,postgres,provider-shaped}.test.ts`, `apps/api/test/helpers/eng04RepeatFixtures.ts`; NEW `packages/contracts/src/wave25/repeat.regression.test.ts`. | Deterministic and PostgreSQL/provider-shaped fixtures, exact input/result provenance, cap/early exit, cross-occurrence joins, duplicate/restart cuts, Stop/approval uncertainty, legacy compatibility and snapshot/delta parity. No production edits, shared fixture edits, service allocation or native/browser claims. |

### Shell-exclusive cross-cutting integration

The following are deliberately **not jointly owned** by A/B/C/D:

* Existing `apps/api/src/modules/runs/{oneShotPostgres,postgres,engine}.ts`,
  `apps/api/src/modules/run-graph/*` and `apps/api/src/modules/interactions/*`:
  integrate A's durable/recovery effects with B's admission/readback and existing native fences.
  A owns repeat semantics and supplies exact proposed hunks; shell alone edits these shared files.
* Existing `packages/contracts/src/index.ts`, `packages/contracts/src/wave25/index.ts`,
  `wave25/{workflow,protocol,storage,authoring,fixtures,consumerFixture,reliability,meaningfulEdit,editIntent,boardNavigation}.ts`
  and `packages/contracts/src/management/*`: version/union/export/protocol/meaningful-edit wiring.
  A0's single barrel append is the sole already-supplied exception. No worker independently
  enables semantics 3 or changes A0 meaning. Semantic changes return to A and require a new freeze.
* `apps/api/src/{app,production}.ts`, `apps/api/src/routes/{management,product,runGraph}.ts`,
  `apps/api/src/mcp/operator/{server,types,transport,extensions}.ts`, and
  `apps/api/src/infrastructure/migrations.ts`: composition, tool registration/discovery,
  service plumbing and allocation of a collision-free migration number. A supplies SQL;
  the shell registers and runs it. Do not guess the next number from an old base.
* `apps/web/src/routes/WorkspaceRouteEntry.tsx`, `apps/web/src/features/workflow-board/*`,
  `apps/web/src/features/graph/*`, `apps/web/src/features/run-graph/*`, and existing
  `apps/web/src/shared/api/*`: integrate C's controls with the exact current board/editor,
  staged-edit protocol and feeds. Preserve unrelated UI-agent changes; require exact-file
  comparison and manual semantic reconciliation, not directory replacement.
* Existing shared API/test catalogs, package manifests/lockfile/build configuration,
  `scripts/compose-native-fixture.ts`, native/Playwright fixtures and shared service launchers:
  shell-only integration and verification. D uses new fixture files. No worker installs
  dependencies, starts/restarts services, applies migrations or mutates credentials/security.

Files outside these allocations remain read-only to the next lanes. If an implementation
needs a shared file, return precise wiring notes/hunks to the shell rather than claiming
that the dependency has been wired. Contract integration does not itself make repeats usable.

## Source grounding and remaining gate

The pinned reads used for these decisions include `AGENTS.md`, contracts root definitions,
`wave25/{workflow,json,protocol,index,fixtures}.ts`, `packages/contracts/package.json`,
API `runs/{topology,oneShotGraph,oneShotPostgres}.ts`, `app.ts`, `production.ts`,
`server.ts`, `infrastructure/{database,migrations}.ts`, `mcp/operator/transport.ts`,
`apps/api/test/wave25-agent3-langgraph.test.ts`, and the current workspace route/board.
In particular, `compileOneShotTopology` still rejects cycles, `buildOneShotGraph` uses
one-shot barriers, and `OneShotRunRepository` still enforces one execution per node.
None of those files is changed in A0.

This bundle supplies focused positive, negative and compatibility test source, not a passed
runtime gate. The handoff's verification ledger distinguishes syntax/patch/hash checks
from unrun pinned Vitest/typecheck/lint/build. After integration, NIM-2649 still requires
complete A/B/C/D code, authenticated denied/readback parity, real PostgreSQL/provider
qualification, independent review and the frozen T1–T10 live matrix. Required blocked or
skipped tests are not passes. No runtime, browser, database or native acceptance is claimed.
