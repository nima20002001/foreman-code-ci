# ENG07 execution-schema retirement implementation

Baseline: `4298723fa1052d94fd7f65a5bbf5e2cb8b165cf9`, PR #26.
This note supplements [the source inventory](eng07-retirement-inventory.md), particularly R01, R02 and R07. It does not rewrite that inventory's historical evidence or declare the live acceptance gate passed.

## Changed boundaries

R01: the root package no longer exports the legacy definition/version parsers or the V2/compatible union. Root workflow responses and Save payloads, management workflow/draft/version DTOs and version pages use the canonical V3 family. Generic public Start names share the exact current manual Start request, including required semantics, command, workflow revision, configuration-map and location pins. Missing or retired execution tags are not filled in or converted.

The canonical authoring shape lives in `packages/contracts/src/wave25/workflowShape.ts`; `saved.ts` continues to expose the public V3 names. Request-only and primitive leaves keep these schemas independent of the management/saved response import cycle. Existing current topology, configuration and repeat refinements are preserved. Ordinary definitions omit `repeat`; null/empty plans are invalid.

R02: legacy any/threshold join, result-route condition and `maxTraversals` parsers are removed. Typed relationship edits require an explicit execution/approval kind. Positive contract fixtures now use current choices, all-required joins and explicit finite repeat plans. Retired forms remain only as rejection cases. The old `run-current` and `run-history` contract entrypoints export denial identifiers, not success DTOs or aliases to the current history pipeline.

The acceptance seed now writes explicit physical and JSON semantics-3 pins, an authored entry, current relationship kinds and immutable Worker roles. Its version digest uses the same canonical definition/configuration-map/entry inputs as the immutable reader. Inserts remain conflict-do-nothing: no existing record is retagged, no trigger is disabled, and no native work is launched.

R07: Board copy now states Stop → full cleanup → Save for executable changes, separately describing free layout, safe Discard and explicit new Start. The inspected current Operator Save/edit descriptions already specify settlement; registration tests guard those descriptions and the canonical DTOs. No Stop/approval/recovery implementation or owner fence is changed.

Independent graph protocol 1, repeat contract 1, provider API versions and opaque immutable version IDs are not retired execution tags.

## Regression coverage and evidence boundary

`packages/contracts/tests/eng07-schema-retirement.test.ts` covers V3 forms, exact shared schema identities, ordinary/repeat readback, missing/retired/string/future tags, required Start pins and obsolete vocabulary. Existing contract, topology and former current-read tests are ported to current invariants, retaining attempt/lifecycle and exact decimal cursor coverage rather than a legacy latest-per-node projection.

`apps/api/test/eng07-seed-retirement.test.ts` exercises the real seed and immutable reader against a statement-capturing pool, including hashing, physical pins, repeatability and rollback. It is not PostgreSQL migration evidence. `eng07-operator-schema-retirement.test.ts` covers registration/schema identity and the existing audited tombstone handler; visibility policy is stubbed for registration, so this is not HTTP authentication/grant integration evidence. The web copy guard is not a mounted Board test.

The delivery validation records syntax transpilation, touched-file baseline Git hashes, preserved validator bodies, and patch apply/reverse checks. Full repository typechecking, all Vitest suites, built ESM entrypoint/import-order checks, a repository-wide import/copy sweep, fresh PostgreSQL migration/seed/read/Start, live HTTP/MCP rejection/discovery, and fresh-profile Board Stop-and-save/discard/layout checks remain required. Source checks alone do not close the retirement inventory.
