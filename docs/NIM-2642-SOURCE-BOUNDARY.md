# NIM-2642 — cumulative Stop-and-save implementation boundary

Status: implementation candidate; repository, PostgreSQL, browser and native acceptance remain open. This document supersedes the earlier partial boundary, whose exact bytes and hashes are retained in the replacement bundle's provenance directory.

## Exact source and preserved contract

Repository `nima20002000/graphql`, existing PR #26. Apply only to integration source `4c8c322b0157afffb1871fd9939b3723ab9052c0`, not directly to main `50458ee99c67c760336449adbffea9e83985a95d`. G0 contract is `4883fd6f9550cfd116ce000f27def72007e4a293`; unified-board migration is `1e3f88e309deced53070b3d9ff42603c2b4abf46`. All 17 paths from partial ZIP SHA-256 `d7308f17b9003281701e0d4cfe755e0642b70d5b0325935cb4d35c24b8d23fe9` remain in the cumulative payload. The manifest identifies byte-preserved and superseded partial results.

The original sidebar/board/canvas/contextual controls remain the product surface. Selected Run is URL/navigation state, never publication authority. TanStack Query owns the new server journal/affected-set readbacks; the existing Zustand slice owns the authoring document and its pinned base. No alternative Run page, runtime store or automatic Start is introduced.

## Shared admission and geometry

`GraphDraftService.save` remains the sole version-publication boundary for HTTP and Operator MCP. Workspace admission locks serialize Start and publication; workflow/draft and sorted Agent configuration locks preserve the original revision, scope and configuration fences. The original partial's live-command authorization hook and layout-only immutable-version reuse are retained.

The classifier excludes only node position and UI card width/height from executable meaning. Unknown/new fields remain meaningful. Mixed operations carry accepted geometry, while local layout survives semantic Discard, acknowledged saves and newer local typing. Direct shared geometry writes still use a real draft revision; moving a node does not turn an already-dirty draft into a published draft. Historical Run/version records are not retargeted or rewritten.

The common affected-set SQL includes every persisted Run of the workflow and every workspace Run using an existing staged shared Agent, including other workflows and historical version pins. It checks the accepted Run map and immutable version map, scope and semantics. It is not truncated to a selected Run or one active Run and does not scan lifetime activity.

Beyond terminal business outcome, publication requires Run cleanup closure, terminal harness outcomes under `record.result.outcome`, exact native-session finalization, worker credential closure, interaction/continuation settlement and review cleanup. Canceled v2 interactions require the existing durable cancellation-retirement source receipt. Queued reviews are located through their owning interaction even before a review execution exists. No new retirement, acknowledgement, cleanup or native fact is invented. Legacy interaction interpretation is retained; legacy Runs are not silently upgraded.

## Private durable journal

Additive migration `264201` creates `graph_edit_intents`; old migration SQL is unchanged. Records are principal/workspace/workflow/draft bound. Payload, expected revisions, Agent pins, affected Run/version identities and Stage/advance/discard/Stop/save command identities and input hashes are immutable. SQL constraints and an update trigger preserve ownership, terminal records and previously observed Stop receipts. There is at most one unresolved intent per principal/workspace/workflow. A discarded shared draft does not cascade-delete uncertain private intent.

Stage applies the existing typed operation and authorization machinery in memory, validates before any Stop and stores an exact candidate without publishing it or modifying the shared draft. All content/Run grants are checked before readback. Separate grants remain required for Stop; `graph:save` never implies `runs:stop`. Agent scope and immutable configuration references are checked before destructive work and at final publication. A workflow edit checks its workflow revision; later Agent heads or workspace location revisions do not reject it. Staged shared-Agent mutations still check their own base revision. Names and layout use last write wins without presentation or geometry baselines.

Advance and Discard serialize across tabs/processes with a dedicated PostgreSQL session advisory lock. Ordinary pool transactions are not held while waiting for native Stop. Advance calls the existing bound `RunManagementService.stop` with each stored exact input. It verifies the existing `run.stop` receipt's input hash and target, and retains its truthful accepted/already_terminal/not_owner status. Accepted is not stopped. A lost reply after receipt commit is reconciled from that receipt, including when natural settlement occurred before the retry. No new command identity is substituted and no newly discovered Run is added to an old Stop plan.

Each advance rechecks live authority, workspace/workflow state, saved workflow revision/version, draft identity/revision, all Agent pins and the exact full affected set. Publication repeats these checks inside `GraphDraftService.save` immediately before mutation. A concurrent Start, stale revision or changed pin blocks the intent without discarding its payload. The final save result, draft/version/Agent changes and command receipt commit in the same transaction as `state=saved`. A dropped publication reply cannot create a second version through an exact replay.

Natural completion does not generate a fabricated Stop receipt. Discard only changes private intent state: it never calls Stop or mutates shared graph, layout or Run facts. An uncertain save must be reconciled before Discard. Already-submitted Stop effects are not reversible.

## Authenticated HTTP / Operator MCP parity

New HTTP routes, under the existing authenticated management registration:

- `GET /api/management/workspaces/:workspaceId/workflows/:workflowId/drafts/:draftId/edit-intents` reads the owner's latest unresolved intent, or latest terminal intent. `/:intentId` reads an exact owned intent.
- `POST` to that root with `action: stage_edits` stages the exact v2 revision/base and typed operations.
- `POST /:intentId/advance` uses `action: stop_and_save` and the server-returned `advanceCommandId`.
- `POST /:intentId/discard` uses `action: discard_edits` and the server-returned `discardCommandId`.

URL/body mismatches and unknown authority/journal fields are rejected. The same domain methods are reachable through existing Operator tool names: `graph_save` for stage/advance, `graph_draft_get` for `action: read_edits`, and `graph_draft_discard` for private Discard. Original no-action contracts remain available. Tool schemas, output schemas and descriptions expose the new protocol, including its additional per-resource grants. No new grant, credential or tool-name bypass is introduced.

The new strict contracts validate distinct actions, exact staged/saved identities, accepted Run pins, Stop receipt targets and consistent settlement flags. The web transport also checks saved executable content against its immutable version. Persisted readback is principal-bound, not transferable through knowledge of an intent ID.

## Board recovery

The primary actions are exactly **Stop current Run and save edits** and **Discard changes**. The board explains that the full affected set can include multiple Runs and shared-Agent workflows. A visible recovery panel exposes current/past outcome versus settlement, exact pins, receipts, errors and retained payload. A compatibility inspector Discard label is retained for the committed layout regression; it invokes the same handler.

Schema-valid graph/Agent forms are stored under the existing protected identity epoch, with independent per-tab snapshots and a latest-form pointer for reopen. A shared exact Stage outbox is durably written and read back under Web Locks before any HTTP effect. Refresh, lost replies, duplicate clicks and another tab reconcile the retained request rather than allocating a replacement. Browser persistence contains authoring payload and command intent, not credentials or authorization facts.

Only an explicitly initiated waiting/stopping/saving intent can automatically finish after authenticated readback reports complete settlement. Staged, blocked and uncertain records require explicit reconciliation. No path automatically Starts a Run. In-flight/uncertain legacy Start or draft commands continue to block replacement work. Generic navigation Save cannot silently perform destructive Stop. Independent geometry remains editable during a retained semantic intent.

## Limits and acceptance gates

This private protocol is the explicit semantics-2 board authoring path; ordinary legacy save admission remains protected without silently converting a legacy Run. Stage is bounded to the existing 100-operation request boundary. It does not split one exact destructive intent into separately publishable batches; oversized input fails before Stop and remains local.

Structurally invalid in-progress forms and unavailable/quota-exhausted storage can remain memory-only, with a visible failure and Stop/save disabled. Corrupt/wrong-scope persisted data is not silently deleted or overwritten; manual recovery is still needed when it prevents the editor loader from recovering a valid form. Web Locks are required for cross-tab reservation; unsupported browsers fail closed. These are explicit recovery/usability limits, not tested full-browser support claims.

The original 19 isolated source probes and 19 additional controlled service-flow probes pass in the web scratch environment. New contract, admission, storage, mounted-form and authenticated PostgreSQL/HTTP/MCP test sources are included. None was run by the repository Vitest runner here. The three committed layout regressions were preserved unchanged; only their source-equivalent probes were executed. Real approval-wait/provider-shaped lifecycle, native shutdown, PostgreSQL contention/migration and authenticated browser/live-matrix proof remain mandatory before issue acceptance. See the bundle verification and completed/remaining ledgers for exact boundaries.
