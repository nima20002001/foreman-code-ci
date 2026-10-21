# FIL-07 ZIP helpers

Base: `4884027a7fa168a4131fb6957a21237c48ceecaa` (`feat/nim-2733-files`).
No ZIP dependency is added. The parser/writer uses Node buffers, filesystem APIs
and bounded streaming raw DEFLATE. Frozen contracts, storage, routes, native
adapters, UI and other format lanes are unchanged.

## API and ownership

`listZip(bytes)` validates the full archive index and returns entry name, kind,
compressed/uncompressed size and compression method. It does not inflate any
entry. **Listing is metadata-only**: it does not certify a payload CRC or trust
advertised expansion as actual verified bytes.

`extractZip(bytes, parentDirectory, names?)` validates **every indexed path and
header**, including unselected entries, then creates a fresh private child
under the supplied parent. Omitted names extract all entries; a provided array
extracts exactly those names; an empty array creates an empty workspace. A
selected directory creates only that directory, not its descendants. Requested
names must match the list exactly. Only selected payloads are inflated and CRC
verified; implicit parents are created as needed. Directories use mode 0700 and
files use 0600, exclusive creation and O_NOFOLLOW. No existing file is replaced.
Failure removes the newly created workspace before rejecting. If cleanup itself
fails, an AggregateError reports both failures rather than claiming cleanup.

The returned `workingDirectory` is an internal server/runner path. It is **not**
an artifact ID, public tool result or authorization grant. The caller must own
an absolute, symlink-free parent, hold exclusive control during extraction and
only grant subsequent working-area access as permitted by the existing harness.
Source bytes are snapshotted before asynchronous work. Successful-workspace
lifecycle cleanup belongs to the caller; this helper never guesses storage paths.

`repackZip(workingDirectory)` reads a quiescent, exclusively owned working tree
and returns a new deterministic ZIP buffer. It uses incremental directory
iteration and bounded per-file reads, rejects links and special files, and
checks file identity/size/timestamps around each read. It strips original host
paths, permissions, executable bits and timestamps. Empty directories and files
are preserved. It never modifies working files or executes their contents.

Output uses **STORE**, a valid uncompressed ZIP method: no extra compressor
attack surface or compression CPU spike. Consequently, some highly compressible
trees accepted for extraction cannot be repacked within the 25 MiB output cap;
this reports `limit_exceeded`, never an oversized or silently partial ZIP.

## Security and resource policy

`ZIP_LIMITS` are private server resource policy, not newly invented wire schemas:

| Bound | Value |
| --- | --- |
| Input and repacked ZIP bytes | Shared contract `MAX_FILE_BYTES` (25 MiB) |
| Explicit entries and filesystem nodes including implicit parents | 256 |
| Uncompressed bytes per entry | 25 MiB |
| Total advertised uncompressed bytes | 64 MiB |
| Per-entry advertised compression ratio | 100:1 |
| Path depth / UTF-8 name bytes / component bytes | 16 / 1,024 / 255 |
| Cooperative operation budget | 10 seconds |

Actual inflation is stopped as soon as output exceeds the entry's declared size
or its hard cap. Thus lying about sizes cannot bypass aggregate bounds. Streams
are destroyed on timeout, errors are propagated, consumed compressed length is
checked, and exact expanded length plus CRC32 are verified. Nested archives are
ordinary inert files: no recursion or execution is performed.

Before writing, the parser rejects absolute/drive/UNC paths, traversal,
backslashes, control characters, Windows devices/alternate streams, ambiguous
normalization, case aliases, duplicates, file/parent collisions, symlinks and
special file modes and Windows reparse attributes. Local and central names, flags, compression, sizes and CRCs
must agree. It checks data descriptors, every span, the complete central
directory and end record, and rejects overlaps, prefixes, gaps, unindexed data
and trailing bytes. CRC is an integrity check, not a cryptographic authenticity
claim; revision SHA-256 and authorization remain service responsibilities.

Filesystem checks are **not an OS sandbox against a malicious same-UID writer**
renaming ancestor directories concurrently. Node's portable path APIs do not
provide a full openat-style directory-handle walk. Exclusive runner ownership
is a required precondition, not an optional convenience. Static symlink roots,
symlink ancestors, descendant symlinks, hard links and special files are rejected.
The filesystem helpers fail closed on Windows/missing O_NOFOLLOW; listing is
platform-independent. Filesystem behavior was exercised on Linux only.

I/O and native zlib work are not a hard wall-clock sandbox. The caller retains
its normal process limits and concurrency bounds. No database, app-managed
storage policy, network call, child process or execution privilege is introduced.

## Deliberate compatibility limits / contract gaps

Supported: classic single-disk ZIP, STORE and DEFLATE, UTF-8 names (or ASCII
legacy names), comments, signed/unsigned classic data descriptors, and empty
stored/deflated directories. Unsupported features fail closed: ZIP64,
encryption, split archives, self-extracting/prefixed archives, other compression
methods, non-ASCII legacy encodings, Unicode alternate-name/Unix link-bearing extras.
Other structurally valid extras are ignored and never restored as permissions,
links or host metadata. The portable name policy is intentionally stricter than
some desktop ZIP tools.

The frozen contract does not define archive-operation schemas, these resource
bounds or workspace locking. Integration must resolve authorized revision bytes
and runner-owned working artifacts and map the explicit helper errors to the
future tool surface. Do not expose the `parentDirectory`/`workingDirectory`
parameters directly to an Agent or make a read-only harness writable. Publishing
repacked bytes must allocate a new temporary file/revision via the existing
contract; this helper neither publishes nor changes reference storage.

## Verification

48 ZIP cases passed with the local Node test runner adapter: independent Python
stored/deflated ZIPs, descriptors, UTF-8, selective extraction, unsafe paths,
links, collisions, count/size/depth/ratio bombs, forged actual inflation, CRC
failure cleanup, header disagreement, working-tree bounds and repack round trips.
A separate Python zipfile read/testzip verified repacked output and unchanged
binary/empty-directory contents. A deterministic 10,000-mutation parser smoke
check found no unexpected native exceptions (517 metadata-only acceptances,
9,483 explicit rejections); this is not a security audit or full fuzz campaign.

Golden ZIP fixtures were generated with Python's standard zipfile library.
The ratio-bomb fixture is only 194 bytes and expands to 64 KiB. The link/FIFO
fixtures contain metadata and inert strings, not executable content. Unit tests
use OS temporary directories, but runtime helpers have no default /tmp path.
Actual repository-pinned pnpm/Vitest/lint/build/integration/acceptance did not
run. See the top-level MANIFEST and the image README for dependency follow-through.
