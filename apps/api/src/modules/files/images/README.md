# FIL-07 image helpers

Base: `4884027a7fa168a4131fb6957a21237c48ceecaa` (`feat/nim-2733-files`).
Only this directory and the sibling `archives/` directory are owned by this lane.
The frozen file contract and all shared manifests/configuration are unchanged.

## Integration prerequisite: one new dependency

Add `sharp` as an exact **runtime** dependency of `@foreman-code/api`, and regenerate
`pnpm-lock.yaml` using the repository-pinned pnpm and its release-age policy:

```sh
corepack pnpm --filter @foreman-code/api add --save-exact sharp@0.35.4
corepack pnpm --filter @foreman-code/contracts build
corepack pnpm --filter @foreman-code/api test src/modules/files/images/index.test.ts src/modules/files/archives/index.test.ts
corepack pnpm --filter @foreman-code/api typecheck
corepack pnpm --filter @foreman-code/api lint
```

This registration/lockfile change is **not** included: those shared files are
outside this lane, and the pinned pnpm could not be bootstrapped in the supplied
environment. There is no vendored library or silent fallback to a host binary.

Why sharp: one codec library supports actual decoding and same-format encoding
for all four required formats, including GIF/WebP animations. A signature or
image-size parser cannot implement safe edits. It is one new package, but it is
**not a tiny dependency**: it brings native libvips/codec binaries. The API's
existing dependency list provides no equivalent. ZIP adds no dependency.

Proposed pin 0.35.4 was published on 2026-08-26. The documented 0.35.5 release
was on 2026-09-27, inside the repo's 48-hour age gate on the task date; do not
bypass that gate. The proposed pin was not installed/tested here. Local tests
used the already-installed sharp 0.34.1, not a repository dependency upgrade.
Check the package and platform binaries through the normal install/review flow.

## API

`readImage({ bytes, mediaType })` returns display-oriented, per-frame width and
height, frame count, animation status, type and byte size. It snapshots caller
bytes, checks the PNG/JPEG/WebP/GIF signature/container, checks the decoder's
actual format, and fully decodes **all frames**. Metadata-only success is not
accepted as proof of valid pixels. Inputs are bytes, never host paths or URLs.

`resizeImage(input, { width, height })` returns `{ bytes, changed, ...info }` in
the **same media type**, after re-validating the encoded result. Dimensions are
positive integer display pixels; resize fills the exact rectangle. GIF/WebP
frame count, delay and loop are retained. Real edits apply EXIF orientation and
strip other metadata. `null` or the existing display dimensions returns a new
buffer containing the exact original bytes, including metadata: `changed=false`.
Mutating that buffer cannot mutate the source/reference bytes.

`prepareNativeImage(input, options?)` produces bytes without creating storage
records, native sessions, URLs or artifact handles. The caller can supply
`acceptedMediaTypes`, `maxBytes` and `maxDimension`; overrides may tighten, not
raise, the limits below. It preserves already-suitable non-animated bytes;
otherwise it normalizes orientation, chooses an accepted encoding and reduces
dimensions until the encoded bytes fit. It never upscales. An impossible budget
throws rather than returning oversized data. The returned media type is the
actual encoding; callers must use it, not the source filename extension.

Animation is **explicitly** converted to its first frame for native input:
`firstFrameOnly=true`, `sourceFrames` preserves the original count, and `frames=1`.
This preparation does not publish/send the file. Model-specific capabilities
remain the caller's responsibility; defaults do not assert any model support.

## Resource policy and limits

Input/output file bytes use `MAX_FILE_BYTES` from `@foreman-code/contracts/files`
(25 MiB at the frozen base). Decoding is limited to 16,777,216 total pixels
summed over all frames, 8,192 pixels per frame dimension, and 64 frames. Raw
validation output is explicitly RGBA uchar (at most 64 MiB). Native output is
at most 4 MiB and 2,048 pixels per dimension by default. Native encoding takes
at most 12 reductions from the maximum edge down to one pixel.

Each operation carries a 10-second cooperative budget and configures sharp's
processing timeout from the remaining budget. This is **not** an OS memory/CPU
sandbox or a hard wall-clock deadline: native allocation/cache overhead exists,
metadata work and libuv queue wait are not hard-preempted by sharp's timeout.
The integrating runner/service must bound concurrent calls and retain its normal
process/resource isolation. No global sharp cache or concurrency settings are
changed by importing this module. No network calls, shell commands, SVG/PDF
rendering or embedded-content execution are used.

PNG container checks reject APNG explicitly (`unsupported_type`) because this
codec path does not promise APNG animation preservation. JPEG/GIF terminators
and exact PNG/WebP container bounds are required; permissively accepted trailing
garbage is not supported. Errors have `ImageHelperError.code` values rather than
pretending corrupt, spoofed, over-budget or unsupported input was successful.

## Contract follow-through / gaps (contract not changed)

The frozen contract specifies byte-oriented revision reads and artifact-based
publication, not image-operation requests, image limits, animated input policy
or model capability schemas. These are private server helper shapes, not new
public transport contracts. An integration lane must bind authorized immutable
revision bytes and runner-owned artifact handles, supply model policy, and map
errors honestly. It must not pass an artifact ID as a host path or silently
publish an edit over a reference. A no-op working copy remains `agent_copy`;
actual edited publication is `agent_output` with new file/revision IDs.

APNG support and dependency registration are remaining integration/coverage
limits. The current API build config includes all of `src` and excludes only
`test`; these co-located tests therefore also compile under that config. They
are not imported by the helpers. A build-config owner may exclude co-located
`*.test.ts` files from production output; this lane does not change that config.

## Fixtures and evidence

Fixtures are original, generated with Pillow: 8x6 still images; two-frame
GIF/WebP/APNG; EXIF-oriented JPEG; a tiny 1-bit PNG whose declared pixel count
exceeds the cap; a 65-frame 2x2 GIF. No external content is included.

30 image cases passed through a local Node test adapter; actual repository
Vitest did not run. A scoped strict TypeScript check passed with local TypeScript
5.8.3 and sharp 0.34.1, using an explicit local facade for the frozen contract's
imported constant/type. This does not certify the pinned monorepo build.
Pillow separately decoded all four edited formats, both edited animations and
both native first-frame outputs. See the ZIP-level MANIFEST for exact caveats.

Reference documentation consulted: sharp constructor, output/timeout, security,
and 0.35.4/0.35.5 release notes at `sharp.pixelplumbing.com`.
