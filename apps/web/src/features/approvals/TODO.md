# Human approval panel UX

- [x] Hide scrollbar chrome while keeping long queues scrollable.
- [x] Remove the panel header and title copy.
- [x] Remove the hamburger/sidebar bar; keep Refresh and Close together at the top-right.
- [x] Use one arrow control to close and reopen the agent sidebar.
- [x] Animate the sidebar closing and reopening.
- [x] Reduce the empty state to `No requests yet.`
- [x] Keep request rows minimal: request information only, with Approve and Reject side-by-side on the left.
- [x] Use a compact square default panel footprint.
- [x] Preserve the panel's last position and size after closing and reopening it.
- [x] Make `No requests yet.` smaller, restrained, and correctly centered in the request area.
- [x] Keep Refresh and Close anchored at the panel's top-right even when there are no agents or requests.
- [x] ~~Replace the ambiguous refresh glyph with a recognizable refresh icon.~~ Superseded: remove manual refresh entirely.
- [x] ~~Keep human approval-delivery failures visible while their agent is waiting, with a compact recovery action.~~ Superseded: delivery recovery is not an approval decision.
- [x] Verify the panel against a live waiting agent and real interaction record.

## Message-list revision

- [x] Remove the agent sidebar and manual refresh control.
- [x] Render every pending human request as one compact message: agent icon, request label, Accept, Reject.
- [x] Open a minimal real-agent profile modal from the agent icon.
- [x] ~~Keep request details available from the request label without adding row metadata.~~ Superseded: the label is inert and the info icon owns hover details.
- [x] Remove the broken Retry action from the approval inbox.
- [x] Create and verify a fresh live pending request after cleaning up the stale demo run.
- [x] Show the live pending human-approval count on the board inbox icon; hide the badge at zero.
- [x] Replace the agent-profile modal with a compact hover/focus profile card; clicking the avatar does nothing.
- [x] Replace the literal `!` with a small raw info icon after Reject; use a normal pointer and keep its hover card inside the inbox.

## Remove Operator workflow approval

- [x] Remove `operator` from shared workflow/default/interaction handler contracts.
- [x] Remove Operator from workflow and workflow-default UI choices.
- [x] Remove Operator-only interaction HTTP routes and Operator MCP response tooling.
- [x] Remove automatic Operator review dispatch, Run authority expansion, and review-chat lifecycle code.
- [x] Migrate persisted Operator selections to User and remove Operator-review records and response receipts.
- [x] Preserve User approval and designated-Orchestrator App MCP workflows.
