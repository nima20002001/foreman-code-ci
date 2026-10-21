# NIM-2648 / ENG04-D — current regression and retirement inventory

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

This checkpoint starts at PR #26 head `c327f4a7a70635643c9302fd9ba80bfa1ea41ac2`.
It changes tests and fixtures only. It does not claim the NIM-2649 live gate.

## Current scenarios and proof boundaries

| Evidence | Current coverage | Boundary |
| --- | --- | --- |
| `helpers/eng04ArchitectureScenarios.ts`, `eng04-v3-unified-semantics.test.ts` | Reusable S3-01 single/sequential, S3-02 unequal-depth all-required join, S3-03 conditional, S3-04 approval candidates with absent `repeat`; S3-05 early/limit; exact version/config/location/input/result pins; retired-tag rejection | Contract data; no Save or native execution is fabricated |
| `eng04-a1-engine-foundation.test.ts` | Same current LangGraph/runtime algorithms for ordinary and repeat workflows, unequal joins, selected branches, approval/Stop/replay and bounded repeat | Deterministic persistence/native ports |
| `eng04-repeat-{identity,joins,replay,stop,approval,regression-matrix,provider-shaped}.test.ts` | Exact occurrence/carry/result identity, native reservation replay, ambiguous commit, technical retry, Stop and settlement fences | SQL-shaped repository harness and provider-shaped data, not provider proof |
| `eng04-b-current-http-mcp.integration.test.ts` | All six current forms through actual authenticated Create/Save/read and production canonical Start publication; command replay/conflict; scoped denials; add/remove repeat | Public native Start intentionally remains closed in this test composition |
| `eng04-b-graph-read-qualification.integration.test.ts` | Authenticated current/snapshot/complete-delta readback, reset/retention, private-data exclusion, wrong scope/revocation and denied audit | Real PostgreSQL and production graph publication/read services |
| `eng04-migration-postgres.test.ts`, `eng04-repeat-postgres.test.ts` | V3 SQL constraints, lineage, immutable accepted data, retention, ordinary/repeat identities and rollback | Real disposable PostgreSQL 17; raw SQL constraint fixtures are not executable publication fixtures |

## Retirement performed in this checkpoint

- Shared/native/Start fixtures now originate in `makeCurrentWorkflowFixture`. They do not retag a V2 fixture or restore the deleted factory.
- Shared immutable-reader tests require the same V3 version from engine and saved views. Retired physical tags are rejected; removed uncredentialed write methods remain absent.
- Meaningful Save admission rejects old/missing execution tags instead of treating old settlement flags as permission to save.
- Removed positive V1/V2 execution/replay/uniqueness setup from the migration suite and its helper. Historical registry setup remains only to test transactional migration rollback/drift, with no old execution records seeded.
- The migration helper accepts only semantics 3. Current V3 constraint and identity assertions remain, including the exact four-column execution FK target.
- Removed assertions against the deleted repeat-only readback service from provider-shaped observation tests. Current persisted metadata, redaction, scope and denied-caller coverage is in the authenticated graph qualification suite above. Raw result opt-in pagination of the retired endpoint is not a supported current API.
- Source guards now follow the actual `createCurrentNativeProductionFactory` composition, the current graph-read qualification flag, and the removed repeat-only authoring hook. They retain rejection of legacy Start/runtime dispatch and V3-to-V2 schema projection.
- The SQL-shaped repeat harness now records the native reservation inserted by the production repository in the same transactional state. Duplicate admission must retain exactly one reservation with the same scope/execution/input identity; it grants no native launch capability.

Historical ENG-03 evidence and independent native/MCP/graph protocol labels are unchanged.

## Verification at this checkpoint

- Focused D suite: **17 files passed, 152 tests passed**; the five gated PostgreSQL tests are separately executed below.
- Current authenticated PostgreSQL suite: **2 files, 28 tests passed**.
- PostgreSQL 17 migration/repeat constraint suite: **2 files, 13 tests passed**, including the five gated tests.
- Focused ESLint on all changed D TypeScript files and `git diff --check`: passed.
- Full API typecheck: **746 diagnostics across 134 test files**, down from the initial 760. There are **zero source diagnostics and zero diagnostics in the changed D files**.
- Broad API unit command: **76 files failed, 111 passed, 3 skipped; 411 tests failed, 1,289 passed, 15 skipped**. These failures include obsolete test contracts, deleted services and outdated native composition mocks. Parallel partitions are repairing them; the full package gate remains red.

Logs are task artifacts outside Git (`eng04-artifacts/d-current-integration2.log`, `eng04-artifacts/d-migration-integration2.log`, and `/tmp/eng04-d-final-focused.log`).

## Remaining gate work

Combine the parallel retired-test/current-native repairs, build the shared contracts, and rerun API/web typecheck and the complete required verification. NIM-2649 still requires the actual mounted Board and real Codex/OpenCode evidence for S3-01 through S3-05, including public Start, native approval acknowledgement/cleanup, Stop and exact graph snapshot/delta parity. Neither synthetic runtime tests nor raw SQL fixture publication replaces that gate.
