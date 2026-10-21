# FIL-05b — scoped working-copy byte edits

> Historical implementation and verification record. OpenCode support was
> removed on 2026-10-08. Its references below describe saved history and
> earlier observations, not a supported creation or execution path.

Base: `nima20002000/graphql`, branch `feat/nim-2733-files`, commit
`08bfa311f0b680012821f8fd015f09c56469d7b4`.

## Delivery status

**Partial end-to-end delivery.** This patch supplies additive contracts, the
file-tool service operations, authenticated `/mcp/files` registration/discovery,
a PostgreSQL snapshot compare-and-set guard, and tests. It does **not** wire the
new operations into the native Codex/OpenCode bridges or make their existing
read-mode admissions accept file mutations. Those adapters and all project
filesystem restrictions are unchanged. The pinned Vitest/typecheck/build and
PostgreSQL suites could not be run in the delivery environment.

There are no new dependencies, lockfile changes, migrations, browser changes,
workflow App MCP tools, Operator credentials, or worker credentials.

## Agent surface

`files.write_working_copy` accepts:

```json
{
  "artifactId": "<create_working_copy handle>",
  "baseRevisionId": "<optional working snapshot revision>",
  "contentBase64": "IyBlZGl0ZWQK"
}
```

`files.apply_format_edit` accepts the same target and optional base revision,
plus exactly one `edit` object:

```json
{ "kind": "append_text", "text": "\nAdded paragraph.\n" }
```

```json
{ "kind": "resize_image", "width": 640, "height": 480 }
```

```json
{ "kind": "replace_zip_entry", "entryName": "notes/readme.txt", "contentBase64": "ZWRpdGVk" }
```

Append uses the existing `formats.editDocument` helper for Markdown, DOCX and
PDF; the helper retains its own format-specific behavior and failure states.
Resize uses `images.resizeImage` for PNG/JPEG/WebP/GIF. ZIP edit replaces exactly
one existing regular entry using `archives.listZip`, `extractZip` and `repackZip`.
It does not add entries, accept host paths, execute archive contents, or bypass
ZIP path/link/expansion limits. Other entries' payloads are preserved; repacking
is not a byte-identical preservation of archive metadata/compression.

Both return only `{ artifactId, revisionId, byteSize, sha256 }` for the exact
committed working snapshot. No published file is created until the existing
`files.publish_result` call. `revisionId` here is a working-snapshot revision,
not the source's pinned revision or a future publication revision. The unchanged
copy result does not expose the initial snapshot revision; omit the optional
base on a first edit. Subsequent edits can use the returned revision.

Full replacement and ZIP replacement bytes are canonical padded base64, capped
at **25 MiB decoded** (`MAX_FILE_BYTES`). Empty replacement is allowed, subject
to the existing media-type validator. Both encoded length and decoded length
are checked, including the one-extra-byte case sharing the same base64 length.
Append text is capped at **64 KiB UTF-8**, and image dimensions at **8192** per
axis; existing helper limits can be stricter. Strict schemas reject additional
owner, conversation, scope, file target, media-type or host-path fields.

The MCP body limit is base64(25 MiB) plus 512 KiB for a bounded JSON envelope.
Local-request and file-session authentication run before buffering that body.

## Authorization, storage and retries

Only `gql_file_` sessions are accepted. Both the exact new operation in the
accepted allowlist and `allowMutation: true` are mandatory. The current owner's
chat-write grant and complete conversation lineage are rechecked. A read-only
file session remains denied; merely listing the new tool does not grant it.
These are file-only operations, not authority to edit project files.

Targets resolve exclusively through the UUID artifact registry, bound to owner,
conversation, native session and turn (including Run/execution through the
conversation scope). A permanent file ID, original upload ID, foreign handle or
generated-output-only handle cannot be an edit target. An authorized reference
may still be copied through the existing copy service: its resulting temporary
artifact is detached, and editing that copy cannot mutate the reference.

Every accepted edit creates new immutable storage bytes. It never changes the
source revision or a snapshot already selected for publication. Storage still
performs FIL-03's existing size, hash, media-type and structure validation.
Document/ZIP scratch is created privately by the API and removed in `finally`;
it is never an agent project directory or a tool-selected location.

The service always guards the snapshot it actually read, even when the caller
omits `baseRevisionId`. `beginWrite` atomically tests that revision in PostgreSQL
in addition to the writer state and session binding. A stale/competing writer
returns `FILE_WORKING_COPY_CONFLICT`; format work cannot silently overwrite a
newer edit that completed while a helper ran. A failed storage write remains
unpublishable and retains the previous snapshot for a guarded recovery write.
Helper/schema failures before writer acquisition leave the snapshot untouched.

These new edit calls have **no durable command receipt** and are advertised as
non-idempotent. Do not automatically retry an unguarded append after an unknown
result. A retry with the same explicit base revision cannot append twice: it
conflicts after the first commit. Existing copy/publish request hashes and
receipt schemas are unchanged, including changed-bytes publication conflicts.

## Exact additive exports in `packages/contracts/src/files.ts`

The original file is retained byte-for-byte as a prefix; only these exports and
a private target-field object are appended:

- Constant: `MAX_FILE_WRITE_BYTES`.
- Schemas: `FileWorkingCopyBytesSchema`, `AgentFileFormatEditSchema`,
  `AgentFileWriteWorkingCopyInputSchema`, `AgentFileWriteWorkingCopyResultSchema`,
  `AgentFileApplyFormatEditInputSchema`, `AgentFileApplyFormatEditResultSchema`,
  `AgentFileWorkingCopyEditResultSchema`.
- Types: `AgentFileFormatEdit`, `AgentFileWriteWorkingCopyInput`,
  `AgentFileWriteWorkingCopyResult`, `AgentFileApplyFormatEditInput`,
  `AgentFileApplyFormatEditResult`, `AgentFileWorkingCopyEditResult`.

Backend-only additions are `FILE_EDIT_TOOL_NAMES`, `FileEditToolName`,
`ALL_FILE_TOOL_NAMES`, and `FileToolOperation`. The original four-member
`FILE_TOOL_NAMES`/`FileToolName` are deliberately retained for native adapter
compatibility. `FileToolContext.allowedTools` accepts the wider operation type.
The MCP surface uses the full list, but a legacy native facade without edit
methods does not advertise them. `completeWrite` retains its `Promise<void>`
interface; the new internal `completeEdit` returns this writer's exact snapshot.

## Native integration still required

Do not apply this ZIP and claim native read-mode editing is enabled.
At this base, Codex rejects read mode with file mutation via
`CODEX_READ_MODE_FILE_EDIT_UNSUPPORTED`; OpenCode checks that project mode matches
`context.allowMutation` and rejects a mismatch with `FILE_SECURITY_CONFLICT`.
Those checks have not been weakened here.

The native integration must explicitly negotiate conversation-file mutation
separately from project write authority, register/dispatch the two operations,
and preserve all session/turn and cancellation guards. Codex's alias/schema/
dispatch maps and OpenCode's facade need forwarding to `writeWorkingCopy` and
`applyFormatEdit`. Use server-managed artifacts in read mode, without opening a
writable project path or materializing a writable execution-host copy. Publish
must use the edited registry snapshot rather than resealing an older host copy
and overwriting the server edit. Keep workflow App MCP disabled and revoke file
sessions at turn end. These native edits/acceptance tests are not in this ZIP.

## Tests and actual verification

`apps/api/test/file-working-copy-edits.test.ts` covers write/publish/readback,
original pins, existing publication replay/conflicts, optional/stale guards,
competing writers, storage failure/recovery, revoked grants after I/O, permanent
and foreign targets, exact per-tool permissions, md/docx/pdf/png/zip helpers,
unsafe ZIP selections, canonical base64/UTF-8 size limits, and real Fastify/MCP
discovery/dispatch/denial with in-memory persistence and byte storage. It is not
a substitute for the FIL-03 real disk/type-validation suite or native tests.

`file-working-copy-edits-postgres.integration.test.ts` adds real database tests
for racing base guards, stale revisions after repository reconstruction,
foreign bindings, and legacy/failed-writer recovery. It uses the existing
migration in a random isolated schema and an explicit loopback test database.

Executed in the delivery environment: all 11 delivered TypeScript files
syntax-transpiled with installed TypeScript **5.8.3**, with no syntax diagnostics.
The actual appended base64 refinement predicate was extracted and checked with
Node 22.16.0 against 22,026 valid/malformed/boundary cases; the UTF-8 predicate
passed seven boundary cases. This supplemental check did not execute Zod.
Existing-file baselines were verified against their pinned Git blob hashes.

Not executed: pinned TypeScript 5.9.3 full typecheck, lint, build, Vitest (including
all five real format helpers), PostgreSQL tests, native acceptance, or full
migration/startup checks. The pinned pnpm 11.27.0 bootstrap failed with
`EAI_AGAIN registry.npmjs.org`; no alternate dependencies or npm installs were
used. See `MANIFEST.txt` for payload hashes and remaining limitations.

Run after applying the patch to the pinned checkout:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @graphql/contracts build
corepack pnpm --filter @graphql/api typecheck
corepack pnpm --filter @graphql/api lint
corepack pnpm --filter @graphql/api test test/file-tools.test.ts test/file-working-copy-edits.test.ts
# Set TEST_DATABASE_URL to an explicit loopback database whose name includes test.
corepack pnpm --filter @graphql/api exec node ../../scripts/heavy-job.mjs -- vitest run test/file-tools-postgres.integration.test.ts test/file-working-copy-edits-postgres.integration.test.ts --no-file-parallelism
```

Also run the existing FIL-03 storage/format suites and repository-wide checks
from `AGENTS.md`. No test failure observed here establishes a product bug: the
integration tests were authored but unavailable to execute.
