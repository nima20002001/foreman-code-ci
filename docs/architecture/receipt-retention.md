# Retry receipt retention

The native-process registry writes closure observations in `retireRegistration`.
Its older maintenance policy moves observations into `closed` archives, retaining
them indefinitely. Recovery snapshots now enumerate owner directories only;
archived observations remain available by owner and launch ID until expiration.

Worker maintenance visits at most 100 closure certificates every ten minutes.
It deletes a certificate only after 24 hours and a point lookup confirms that the
workflow journal has retired that execution. Workflow retirement follows Main's
physical acknowledgement or Main's source-preparation closure request. A terminal
receipt alone, without retirement, does not permit deletion. Unknown owners,
unsettled executions and observations of live processes remain. This also applies
to certificates archived before retention was introduced. Completed maintenance
sweeps repeat hourly; partial sweeps resume their directory cursor. Cleanup runs
independently of update drain.

Managed MCP owners (`managed-mcp:codex:<UUID>`) belong to one-shot configuration
operations rather than workflow executions. Their confirmed closed certificates
expire after the same 24-hour window without a workflow acknowledgement. Fresh
certificates and observations of live processes remain protected by the same checks.

Main keeps completed command response snapshots for 30 days after both creation
and the latest successful command audit. This matches the existing remote runtime
journal's 30-day retry snapshot window and allows disconnected clients weeks to
retry. Browser command attempts have no automatic expiry, so a time window alone
cannot make deletion safe: the existing audit identity remains after deletion.
The command coordinator rejects an expired result with `COMMAND_RESULT_EXPIRED`
instead of executing its effect again. Native conversation controls also consult
their original reservation audit before inserting a command, preserving that
fence across deletion and concurrent retries.

The existing Main reconciliation loop removes at most 100 responses every ten
minutes. Selection requires an existing audit fence. The latest completion audit
must be older than the window, and deletion compares the receipt revision so a
concurrent update survives. Pending and uncertain controls remain; completed
responses with an accepted native response require a provider acknowledgement.
Selection first takes at most 100 old rows in the receipt index's operation,
creation time and command identity order. Completion audits are looked up only
for that page. A keyset cursor advances even when a page contains only retained
records and wraps after reaching the end. Cursor timestamps retain PostgreSQL's
full precision so unresolved receipts cannot trap the scan in one millisecond.

The retention policy explicitly lists operations whose receipts are retry
snapshots. Unlisted operations remain because the table also stores permanent
artifact and input bindings, trusted connection configuration, workflow publication
facts and resumable preparation state. New operations must establish their data
ownership before joining the retry snapshot policy. No run history is deleted.
In particular, `workspace.location.set` results remain recovery data: repository
imports can adopt a committed location after a crash before their journal save.
The additive migration contains indexes for bounded receipt selection and audit
identity lookup; it does not change data or retention settings.


Source approval and project capture responses use the same 30-day retry window.
They become candidates only after the snapshot referenced by the approval
response is unavailable. A project capture resolves the same command's approval
response or its original approval row. Reused snapshots need no new approval row;
their approval response stays until the capture response has expired, so page
boundaries cannot strand the capture. Retained snapshots and unresolved captures
remain protected. Snapshot metadata, root bindings, approval records and audit
identities remain. An expired approval still returns `SOURCE_UNAVAILABLE`; an
expired project capture is fenced by its successful command audit rather than
capturing the source again. File retention preferences do not change this window.
