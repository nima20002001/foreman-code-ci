# Storage ownership and retention

Fixture caches keep the newest two complete entries per fixture kind when a new
entry is published. Builders hold exclusive kernel locks; returned paths hold
shared locks for the caller's process lifetime. Older locked entries remain until
a later publication can reclaim them. Before population and publication,
abandoned pending directories are removed only while holding their content key's
exclusive lock; active builders keep their pending bytes. Lock files remain so concurrent openers
always coordinate on the same inode. Installed API fixture creation also removes
shared dependency trees unreferenced by the retained installed fixtures, under the
same builder lock. Restart fixtures own a separate dependency namespace;
independent deployment tests keep dependencies inside their invocation-owned
fixture directories. A retained fixture's dependency symlinks must remain valid.
Previously shared dependency trees remain untouched because older consumers may
still be using them.

CI executor directories and Main's fallback log tails share the existing
three-day window and newest-200-per-computer floor. Main clears a tail only after
the owning executor confirms removal of the final attempt's directory, including
an already absent directory after a crash. Active tickets, pending result
collection, unconfirmed executor cleanup and live or cleaning-up requester Runs
retain their tails. Cleanup uses the existing five-minute endpoint maintenance
cadence and retry backoff. Ticket records, test results, timings, result-cache
keys and request/audit identities remain for history, failure analysis and release
verification. HTTP and MCP reads use the same stored records and log policy.

Temporary-file retention preferences cover file payloads; source snapshot
retention covers private captured source bytes. Neither policy expires native
execution history. `harness_native_events` supplies historical activity and chat
transcripts as well as recovery. `workflow_native_proofs` retains immutable
original sources and their provenance. Terminal verification, approval
acknowledgments and artifact admission read these originals; graph source digests
alone do not replace them. A later history observation is not a declared
supersession of every earlier source. These tables remain protected rather than
being deleted by age or by an absence of foreign-key references. Reclaiming them
requires an archival contract that preserves those public reads and audit facts.

Command response expiry follows [receipt retention](receipt-retention.md).
Deleting rows or clearing payloads makes PostgreSQL pages reusable; ordinary
vacuum does not promise to shrink relation files or return those bytes to the
filesystem. These maintenance policies do not run `VACUUM FULL` or rewrite live
tables.
