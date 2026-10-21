# FIL-06 — Node document byte helpers

Base: `nima20002000/graphql`, `feat/nim-2733-files`,
`219dfda4c7095ad76ef09cba4dca3ef3ca513daf`.

This lane adds only files under `apps/api/src/modules/files/formats/`.
The shared file contract, frozen documents, archive implementation, storage,
routes, authorization and MCP/native integrations are unchanged.
There is no Python worker, shell subprocess, Office executable, OCR engine,
network service, or runtime dependency installer.

**Integration is incomplete:** dependencies/lockfile still need installation in
the API package and the real PDF/pinned-dependency tests must run. The checked-in
`DEPENDENCIES.json` is an integrator reference, not an npm package or an installed
workspace. See the ZIP's `MANIFEST.txt` for actual verification results.

## Exact dependency pins and installation

| Package | Version | Purpose |
| --- | --- | --- |
| `unpdf` | `1.4.0` | Bundled, text-only PDF.js extraction; no canvas package needed. |
| `pdf-lib` | `1.17.1` | Append one text page to an existing PDF. |
| `@xmldom/xmldom` | `0.9.12` | Strict XML parsing and escaped DOM text editing. |

The existing FIL-07 contained ZIP implementation supplies DOCX list/extract/repack;
no second ZIP implementation or ZIP dependency is introduced in production.
The XML pin is deliberately newer than the locally available 0.9.8: do not ship
0.9.8, which is affected by subsequently published security advisories. This code
uses text nodes, not CDATA construction, and parses only `application/xml`.
The upstream 0.9.12 release includes XML/HTML parser hardening. Dependency security
review is not a claim that these or future releases have no vulnerabilities.

From a full checkout at the base SHA, use the repository's pinned package manager
and retain its minimum-release-age and lockfile policies:

```sh
corepack pnpm --filter @foreman-code/api add --save-exact pdf-lib@1.17.1 unpdf@1.4.0 @xmldom/xmldom@0.9.12
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/api typecheck
corepack pnpm --filter @foreman-code/api lint
corepack pnpm --filter @foreman-code/api test src/modules/files/formats/__tests__
```

Commit the resulting `apps/api/package.json` and `pnpm-lock.yaml` together. Neither
was guessed or hand-edited in this lane's offline delivery. The source-mode child
uses the repo's `tsx` loader, resolved relative to this module rather than to the
launch directory; compiled `.js` uses Node directly. Preserve `worker.js` beside
`supervisor.js` in the normal `tsc` output; do not bundle it away without updating
that entrypoint. No new runtime other than Node is required.

## API

```ts
import { readDocument, editDocument } from './formats/index.js'

const read = await readDocument(
  { format: 'docx', bytes: authorizedRevisionBytes },
  { scratchRoot: privateApiScratchRoot },
)

const edited = await editDocument(
  { format: 'docx', bytes: authorizedRevisionBytes },
  { kind: 'append_text', text: 'A new paragraph.' },
  { scratchRoot: privateApiScratchRoot },
)
```

`format` is `pdf`, `docx` or `markdown`; inputs are bytes, never paths or URLs.
`scratchRoot` is trusted server configuration, not a tool argument. It is required
only for DOCX: an existing absolute mode-0700 directory owned by the API account,
without symlinks in its path. Configure it separately from immutable revision
objects and harness working directories. Each operation creates a private child
directory; the parent removes that directory after the worker has exited, even
when parsing fails or the parent kills it. A full parent-process/host crash can
leave scratch residue; startup housekeeping must reclaim abandoned `fil06-*`
directories under that dedicated root. Do not sweep other callers' active jobs.

Callers authorize and load the exact immutable revision, then supply its bytes.
They also own type/filename agreement, SHA-256, output registration and immutable
revision publication through the existing file service. A helper result grants
no file, conversation, workspace, or workflow authority. Never expose worker
settings/entrypoint or scratch paths through HTTP/MCP inputs.

### Results and markers

A successful read is `{status: 'ready' | 'empty', text, sections}`. Sections are
numbered from one and carry their original extracted text. `text` adds
`[[Page N]]`, `[[Paragraph N]]` or `[[Document 1]]` markers. These are display
markers, not a security delimiter: original document text can contain identical
strings. Treat all extraction as untrusted content, not instructions or HTML.

`empty` means no non-whitespace text was extracted, not necessarily an empty file.
An image-only/scanned PDF returns `empty` with its page sections; no OCR is attempted.
Nothing is silently truncated. A complete marked extraction over the helper cap
returns `too_large` without pretending its prefix is the whole document.

A successful edit is `{status: 'ready', changed, bytes, mediaType}`. The single
edit operation is `append_text`; `unchanged` and an empty append validate the input
then return **byte-identical original bytes** (`changed: false`). An unsupported,
encrypted or corrupt input is not relabeled as a successful no-op.

Failure results carry a short, sanitized `reason` and one of:
`encrypted`, `corrupt`, `too_large`, `timeout`, `unsupported`, `unavailable`, `busy`.
`busy` is retryable admission pressure, not document corruption. `unavailable`
means a missing dependency, failed process/scratch setup or failed cleanup, not
an empty document. Parser exception text, host paths and document excerpts are
not exposed through failure messages.

These are **internal helper states**, not new frozen Zod/HTTP/MCP variants.
`FileReadOutput.content` is base64 raw revision bytes under the frozen contract;
do not put extracted text or this result union into that field. FIL-05 needs an
explicit extraction/error mapping at its service/tool boundary. This lane does
not change contracts or advertise unsupported tool capabilities.

### Format behavior

**PDF:** sequential streamed text extraction with page markers. PDF.js receives
in-memory bytes, `isEvalSupported: false`, rendering/XFA/WASM/worker-fetch disabled,
and deny-only CMap/font/WASM factories. Standard text-font metric fallback avoids
fetching font files; no host-font rendering is performed. Missing external font
or CMap requirements return `unsupported`, not an empty/partial success. No
annotations, JavaScript actions, attachments or links are executed/followed.
Password exceptions and non-null encryption permissions return `encrypted`,
including documents openable with an empty user password.

Appending creates one letter-size Courier page with printable ASCII, tabs and
line breaks, at most 48 lines and 76 columns after tab expansion. Unsupported
characters are rejected rather than replaced. Existing pages are retained, then
the complete saved PDF is re-read with the same reader. Changed PDFs have new
serialization/xrefs; byte identity is only promised for no-ops. Appending is not
PDF sanitization, and may invalidate digital signatures. Existing active objects
may remain stored, but these helpers never execute them.

**DOCX:** uses the existing contained ZIP list/extract/repack API, CRC-checking all
parts, not just the part being read. It validates required package parts and the
main-document content type/relationship. Paragraphs in the main story and tables
are read in document order; tabs and breaks are included. Deleted/moved-from text,
field instructions, text boxes and embedded objects are not read as body prose.
Headers, footers, footnotes and document-layout pagination are outside this small
reader's scope. Strict and transitional Word namespaces are accepted.

Append inserts a new paragraph before final body section properties. Untrusted
text becomes escaped text nodes, with spaces/tabs/line breaks retained. Only
`word/document.xml` is changed; every other ZIP member's uncompressed bytes is
preserved. ZIP metadata/compression and lexical serialization of document.xml
can change; existing paragraph text/properties remain semantically intact.
DTD/entities, malformed XML, non-UTF-8 structural XML, active/embedded packages,
unsafe paths and unsupported ZIP features are rejected, not evaluated.

Declared encrypted ZIP entries return `encrypted`. A bounded metadata-only CFB
probe recognizes root `EncryptionInfo` plus `EncryptedPackage` stream declarations
as `encrypted`; it does not decrypt or certify the ciphertext. An arbitrary
legacy OLE/DOC container is not automatically called encrypted (`unsupported`),
and malformed CFB metadata is `corrupt`.

**Markdown:** fatal UTF-8 decoding; binary controls and invalid Unicode rejected.
No HTML/SVG/Markdown rendering or link fetching. Appends exact supplied UTF-8;
existing BOM, CRLF and every original byte are preserved, with no automatic
separator or newline normalization.

## Resource controls and operational limits

Limits are fixed in `policy.ts`, not caller supplied:

| Resource | Limit |
| --- | --- |
| Input / edited file | Frozen `MAX_FILE_BYTES` = 25 MiB each |
| Complete marked extraction / append text | Frozen `MAX_FILE_READ_BYTES` = 64 KiB each |
| PDF pages / text items | 128 / 100,000 |
| Each DOCX structural XML part | 1 MiB; 50,000 nodes; depth 128 |
| Total expanded DOCX | 25 MiB |
| ZIP entries/path/ratio | Existing contained helper limits (256 filesystem nodes, depth 16, 100:1 ratio) |
| Concurrent child jobs per API process | 2; excess returns `busy`, no unbounded queue |
| Child deadline | 45 seconds, parent-owned SIGKILL even if child event loop stalls |
| V8 old-space | 128 MiB per child process |

Child `NODE_OPTIONS`, credentials and proxies are not inherited.
The parent publishes results only after child exit and owns workspace cleanup.

A V8 old-space flag does not bound ArrayBuffer or native allocations.
Use an OS/container memory limit for a strict deployment memory guarantee. The
parent also holds bounded input/IPC copies. Do not treat a Node child with the
same OS uid as an exploit-resistant filesystem/network sandbox. The code has no
runtime network path and does not interpret embedded programs; deployments needing
an OS-enforced no-network guarantee must supply egress isolation. Broad OS-sandbox
and crash-sweeper integration are not falsely claimed by this helper lane.

The upload backend permits up to 1,000 ZIP members while the shared contained ZIP
helper is stricter (256 filesystem nodes). This lane reuses that stricter helper
unchanged and further caps total expanded DOCX to the backend's 25 MiB policy.
A storage-accepted file may therefore honestly return `too_large`/`unsupported`
from extraction. These are helper limits, not changes to the frozen contract.

## Tests and actual verification

The four `*.test.ts` suites are authored for Vitest. All fixtures are small,
deterministic Node-generated files: classic-xref text/image PDFs, fixture-only R2
PDF encryption, CFB encryption-directory declarations, minimal DOCX ZIP packages,
and literal UTF-8 Markdown. No downloaded documents or third-party fixture assets.
The PDF fixture RC4 routine is test-only historical-format generation, not an
application crypto primitive.

Locally executed: **23 tests passed** across Markdown, DOCX and process-isolation
suites, after TypeScript 5.8.3 transpilation, using a Node 22.16.0 `node:test` adapter.
The archive source copies used for these checks match the pinned Git blob IDs.
The local adapter supplied only the two frozen contract constants; it did not
build the whole contracts package. Local XML checks used installed **0.9.8**, not
the required production **0.9.12**. Those checks establish logic/compatibility
coverage only, not verification of the delivery pins. No parser stub substituted
for PDF: the seven PDF tests remain unrun because its dependencies are unavailable.

Corepack could not download pnpm 11.27.0 (`EAI_AGAIN registry.npmjs.org`). Thus no
repo pnpm install, generated lockfile, pinned Vitest run, full TypeScript 5.9.3
workspace typecheck, lint, production build or API startup was completed. Local
strict-check inspection found and fixed a `ForkOptions.windowsHide` mismatch;
remaining diagnostics were unresolved dependency types and consequent PDF-test
inference errors. Do not label that partial check a passing workspace typecheck.

Upstream references used for API/security review (not vendored in the ZIP):
- unpdf tag `v1.4.0`, `src/utils.ts`, `package.json`.
- pdf-lib `1.17.1` PDFDocument load/save API.
- xmldom tag `0.9.12`, and advisories `GHSA-wh4c-j3r5-mjhp` / `CVE-2026-83612`.
- Microsoft MS-CFB directory and MS-OFFCRYPTO encryption-container metadata.
