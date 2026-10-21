# Workflow runtime timing

Set `LOG_LEVEL=debug` to emit `runtime-timing` diagnostics through the existing API
logger. They contain phase names, timestamps, durations, and Run, execution,
native-session, or process-owner identifiers. They exclude prompts, model text,
SQL bodies, credentials, and environment values.

SQL records include a truncated SHA-256 `statementId` of the statement text,
computed only while timing observers are enabled. Bind parameter values are not
included. This groups repeated query shapes without retaining their SQL bodies.
Separate begin, commit and rollback spans measure transaction-control latency.

In-process diagnostic collectors can subscribe to the Node diagnostics channel
`foreman-code.runtime-timing`. Observers must return immediately and must not
throw. The native acceptance runner retains these records in its scenario
artifact, with a count if its bounded collector drops records.

Start and native-submission points locate the beginning of a Run and its turns.
Native event points identify first and last message deltas and terminal events.
Other phases measure worker admission, connection queueing, SQL calls, persisted
lease checks and renewal, batch reads and publication, reconcile backoff, terminal
acceptance, settlement, process closure, and Run cleanup. Heartbeat and batching
intervals are recorded without changing them. RPC records include their deadline,
so a deadline can be distinguished from an interval actually spent waiting.

Snapshot read spans include the immutable Run and execution validation. Graph
finalization spans separate public projection capture, its commit check, and
canonical receipt checks from other transaction work. These spans include SQL
and validation CPU time; compare them with their nested SQL spans to distinguish
database waits from validation work.

`native.history_replay` reports how many semantic frames in a complete captured
history already have matching committed raw bytes, graph receipts, and the
current native binding. Their new full-history proof and commit checks still run.

Spans overlap. Do not add their durations as elapsed Run time: a healthy wrapper
can wait for a provider while heartbeats and persistence proceed concurrently.
For a critical-path breakdown, merge interval ranges, compare native output and
terminal timestamps with the original provider rollout, and separately account
for application work before submission and after the native terminal. An open
provider turn does not by itself prove that every second is irreducible provider
work; stream backpressure must be checked against event-read and persistence spans.

Set `FOREMAN_CODE_CODEX_RUNTIME_TIMING=1` to collect Codex's native API and stream
durations. This opt-in starts a private loopback OTLP/HTTP JSON receiver for each
app-server process and overrides only that process's log exporter. It never edits
the user's native configuration. Prompt export stays disabled. The receiver
discards all fields except transport event names, native timestamps, durations,
session identifiers, stream kinds, attempts, HTTP status and success. It ignores
prompt and tool-result events entirely and closes with the native transport.

Native exporters deliver asynchronously: use the event's native timestamp, not
its arrival time. `native.api_request`, `native.sse_event`,
`native.websocket_request` and `native.websocket_event` distinguish request and
stream waits inside a native turn from client startup, tool readiness and graph
persistence. These diagnostics never authorize execution or schedule work.

Run ownership uses its dedicated physical PostgreSQL session to prepare repeated
parameterized reads. The bounded cache holds statement names, not results,
permissions or ownership. Every call still executes on the same guarded
transaction with its current parameters. Borrowed pool connections retain
unnamed statements. Closing the owner releases its session and prepared plans.
