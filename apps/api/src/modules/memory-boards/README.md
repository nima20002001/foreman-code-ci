# Memory boards — Team A integration

This module implements NIM-2934 against base `18d735b110495e7cd7d71b381e4cbd6c520b8088`.
It imports the exact shared domain schemas and `MemoryBoardPort` named in
`contracts.md`; it does not create the Team D contract, engine, registry or shell files.

## Team D composition

- Assign a unique migration version and register `memoryBoardsMigration.sql` once,
  in dependency order. The module deliberately does not choose or register a version.
- Pass the application's PostgreSQL pool and an implementation of
  `MemoryBoardAuthority` to `createMemoryBoardService`. Each resolver uses only
  the supplied SQL handle. It must resolve live authenticated credentials and the
  exact saved configuration, node, workspace, workflow, execution or conversation
  identity. Enforce existing scoped actions, enabled tools and read-only harness
  restrictions for every `AgentSubject` kind. Never convert an agent to Operator
  or invent a Run/conversation. Existing configurations without F1 tools remain None.
- `scope`, `node` and `sourcePost` must validate saved ownership and visibility.
  `work` and `currentWork` resolve the authoritative logical business work and
  its current execution. `lifecycle` verifies the actual saved agent/work identity.
  The engine must verify continuation lineage and hold its authoritative
  publication/reservation boundary before calling any F1 callback. A reservation
  that won excludes the old result and its normal success/negative callbacks.
- Call `applyResultLocked` in the successful native publication transaction. It
  validates/applies model changes once and projects `awaiting_acceptance`. Call
  `applyLifecycleLocked` at every admission, launch, child wait, acceptance,
  negative settlement and preparation/repair failure transaction described by the
  shared contract. Call `continuation_admitted` exactly once in the old-attempt plus
  successor transaction; never emit an intermediate canceled/failed card fact.
  These methods never commit their supplied transaction or perform native/network I/O.
- Mount `registerMemoryBoardRoutes` and the seven definitions returned by
  `createMemoryBoardTools` in both authenticated Operator and scoped agent
  registries. Add their names to the central Operator tool-name union and invoke
  them through the shared audit/error wrapper. The exported
  `MemoryBoardToolDefinition` describes the feature boundary independently of
  that catalog. Keep the existing MCP unknown-field stripping wrapper and denied
  guessed-tool handling. Their service rechecks concrete scope and effective tools.
  Update D's HTTP action/bypass map for `/api/memory-boards`: the base map does not
  know this namespace and must delegate its scope-dependent action to this service.
- Supply the web client the C0 read-projection validators matching the F1 types.
  A's projections compose canonical imported objects; they do not fork those schemas.
  The exported UI components are mounted only through D's allocated shell/settings
  locations. D owns native device health subscriptions and historical-link navigation.

## Behavior and recovery

The PostgreSQL uniqueness constraint includes Done titles. Card/Note mutations,
required bindings/claims, counts, revisions, command receipts, effect ledger and
change outbox commit together. Events carry display-safe actors, exact subject
provenance and bounded reason/status/text deltas. PostgreSQL notifications wake
authorized persisted readback only after commit. Visible streams alone own listeners.

Direct deterministic mutation rejections are recorded after the failed mutation
transaction has rolled back. Unknown connection or commit outcomes are never
recorded as rejection. Same command ID plus different canonical input conflicts.
The read-only command lookup returns known success, known rejection or honest unknown.

Reads load three independent 20-card open slices and paged notes. Done is lazy;
status/outcome/prefix keysets bind filters and revision. Digest uses one repeatable
read snapshot, at most 20 cards/12 KiB with at most 4 KiB of note text. None reads
no board tables. Agent defaults and saving configuration remain Team D responsibilities.

## Verification status

Public behavior and authenticated HTTP/MCP tests are in
`apps/api/test/memory-boards.integration.test.ts` and `memory-boards-mcp.integration.test.ts`.
Typed fakes stand in only for the parallel Team D authority/owner ports; board
persistence, transactions and MCP transport in those tests use real PostgreSQL.
The test registry is also a typed composition fake. Run these files with Foreman
CI's affected integration suite; the rendered UI and stream tests use its unit suite.
End-to-end engine/shell acceptance and performance measurements require the
separately owned C0/F4/I0 integration.
