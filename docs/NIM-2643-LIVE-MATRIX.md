# NIM-2643 live matrix — candidate checklist

Run only against a frozen repaired head. Each row owns a distinct `nim2643-vNN` workflow, Run, input marker, browser session and database data namespace. Record exact workflow/Run/version IDs, command and Stop receipt IDs, timestamps, server responses, persisted readback and browser observations. A tab is not an independent provider or database. Coordinate any same-Run tabs explicitly. Use a private API/provider process, port, schema, runtime/project directory and session identities for restart/provider-loss cases.

| Variant and namespace | Action | Expected authoritative facts |
| --- | --- | --- |
| 01 `nim2643-v01` | Pan, zoom, select, resize panel and move a node while its Run executes. | No executable dirty state, new version, draft revision or Stop; Run continues. Presentation survives its supported reopen path. |
| 02 `nim2643-v02` | Stage a prompt and Agent model/harness edit during an active Run. | Local staged payload remains visible; current Run pins and events stay fixed; no new executable version before settlement. |
| 03 `nim2643-v03` | Stage meaning plus layout, then Discard changes. | Meaning returns to saved definition; independent layout remains; no Stop command, new version or Run effect. |
| 04 `nim2643-v04` | Use Stop current Run and save edits, with delayed terminal transition. | One exact Stop receipt is reconciled; Stop acceptance alone does not publish; after terminal and cleanup/interaction settlement the exact staged payload publishes once. |
| 05 `nim2643-v05` | Repeat variant 04 with pending interaction or cleanup after terminal. | Save waits for required settlement; retained staged payload and receipt remain inspectable throughout. |
| 06 `nim2643-v06` | Change saved revision in a second authorized session after Stop is accepted. | Revision conflict prevents publication; local intent and exact receipt remain; no silent overwrite or automatic restart. |
| 07 `nim2643-v07` | Start a competing Run after Stop settlement but before save admission. | Scope/authority/concurrent-Start recheck refuses stale publication; no second Stop or new version from the stale attempt. |
| 08 `nim2643-v08` | Lose the Stop response, reopen or refresh, then click the action twice. | Reconciliation uses the same receipt and staged payload; durable Stop and save effects occur at most once. Use an isolated process/schema if provider loss is induced. |
| 09 `nim2643-v09` | Open old draft and historical Run deep links, then select an older Run while editing. | Both links select the same workspace board; editor stays mounted; selected Run ID, version, topology, Agent pins and events remain historical across edits and navigation. |
| 10 `nim2643-v10` | Attempt the guarded save through authenticated HTTP and Operator MCP with granted and denied identities. | Denied caller has no write, receipt or audit success; granted caller follows the same settlement/revision/idempotency rules; persisted readback matches its accepted version and audit. |

## Assertions awaiting NIM-2642 public contract

- HTTP and Operator MCP: an active or unsettled affected Run blocks meaningful publish through the shared domain service, with identical scope and permission checks. Exercise both authenticated routes, a denied caller and persisted readback.
- Stop/save: capture the exact staged payload and command receipt, replay an uncertain response, wait for terminal plus cleanup/interaction settlement, then recheck revision, authority and concurrent Start before publishing once. Verify no automatic restart or historical pin rewrite.
- Cross-session races: stale saved revision, competing Start, duplicate click, refresh and reopen cannot create extra Stop receipts, executable versions or provider effects. Verify against durable records, not UI messages alone.
- Existing web seam currently counts node position as draft dirtiness and emits `node.replace_v2`; mixed Discard resets that position. The focused red regressions in `meaningfulBoardContract.test.ts` and `navigation.test.tsx` specify the desired layout contract for integration repair.
