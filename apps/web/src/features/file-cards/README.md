# FIL-12 — message file cards

Base: `nima20002000/graphql`, `feat/nim-2733-files`,
`73162fcfeac56320804b378cff91c0c5baf8e945`.

Only new files in this directory are supplied. No chat files, shared contracts,
API routes, package manifests, or lockfiles are changed. No new dependency.

## Public API

```tsx
import {
  FileCard,
  MessageFileCards,
  createFileCardHttpClient,
  type FileCardClient,
} from '../file-cards'
```

`FileCard` accepts `file: FileWithRevision`, `client: FileCardClient`, and an
optional `attachment: MessageAttachmentRef` to enforce an additional exact pin
check. `MessageFileCards` accepts the message's `attachments`, hydrated `files`,
and the client. It preserves attachment order and joins both IDs, not the mutable
head. Missing historical metadata shows `Unavailable`; there is no latest-file
fallback. Empty attachment arrays render nothing.

`fileCardKey` and `resolveMessageFileCards` are also exported. The latter returns
one DTO or `undefined` per reference, in message order. All domain types and
validation come from `@foreman-code/contracts/files`; use `FileWithRevisionSchema`,
not `FileRowSchema`, to parse historical revision readback.

The enclosing app already supplies `QueryClientProvider`. Keep `client` stable
at the composition root. Metadata and attachment references remain in the
parent's TanStack Query readback; do not copy them into a draft/UI store.

## Integration

1. The download path is the existing backend `GET` route under either
   `/api/operator/conversations/:conversationId/files` or
   `/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/files`,
   followed by `/{fileId}/revisions/{revisionId}/content`.
2. The parent must obtain persisted message attachment refs and authorized,
   revision-pinned metadata. This package does not invent a metadata endpoint,
   add fields to existing Message DTOs, or mistake upload completion for a sent
   attachment. Wire the relevant message/readback integration lane first.
3. The shared `ApiClient.request` is JSON-only. This scoped binary sibling follows
   FIL-11's existing boundary pattern: sole HTTP access in the client file, late
   binding of real `fetch` for MSW, shared `ApiError`, shared authentication event,
   and shared session generation/abort boundary. No feature component fetches.

Construct the client once at the composition root:

```ts
const fileCardClient = createFileCardHttpClient({
  download: '/api/operator/conversations/conversation-id/files/{fileId}/revisions/{revisionId}/content',
})
```

Use the agent-chat root for agent conversations. Substitute the actual encoded
conversation and workspace IDs at the composition root. The factory substitutes
and encodes the whole `{fileId}` and `{revisionId}` segments. Other route shapes,
query strings, signed URLs and latest-head alternatives are rejected.

Expected HTTP behavior: authenticated same-origin GET; a 200 binary response
with the revision's allowed Content-Type, exact byte count and SHA-256; errors
in the repo's `ApiErrorResponseSchema` envelope. `FILE_NOT_READY`, `FILE_EXPIRED`
and `FILE_REMOVED` normalize to card states. A denied/missing response is
`Unavailable`, never guessed to mean `Removed`. Authorization of both the file
and its revision remains the backend's responsibility; metadata is not a grant.

This is a presentation/consumer lane: no domain capability, credential, upload,
edit, or MCP tool is introduced. FIL-03/shared file-service MCP read parity and
its denied-caller checks remain with the backend lane; no end-to-end parity
verification was performed here.

## Mount lines (instructions only; existing files were not edited)

The identifiers `attachmentRefsByMessageId` and `pinnedFilesByMessageId` below
stand for maps derived from authoritative message/file query readback, keyed by
message ID. They are not existing fields or locally synthesized attachment data.
Their values are respectively `readonly MessageAttachmentRef[]` and
`readonly FileWithRevision[]`. Use the same `fileCardClient` instance above.

### OperatorMessages.tsx

In `apps/web/src/features/operator-chat/OperatorMessages.tsx`, add:

```tsx
import { MessageFileCards } from '../file-cards'
```

Inside `rows.map`, before the existing empty-content guard:

```tsx
const attachmentRefs = message
  ? attachmentRefsByMessageId[message.id] ?? []
  : []
const pinnedFiles = message
  ? pinnedFilesByMessageId[message.id] ?? []
  : []
```

Replace only the guard during integration so attachment-only messages survive:

```tsx
if (!content && !entries.length && !active && !orderedTimeline?.length
  && !attachmentRefs.length) return null
```

Inside the existing `MessageBubble`, after message text and before its closing
`</MessageBubble>`, add:

```tsx
<MessageFileCards
  attachments={attachmentRefs}
  files={pinnedFiles}
  client={fileCardClient}
/>
```

Do not attach cards to synthetic activity/live rows without a stored message.
Keep the message's existing key, activity placement and transcript ownership.

### AgentChatTranscript.tsx

In `apps/web/src/features/conversations/agentChat/AgentChatTranscript.tsx`, add:

```tsx
import { MessageFileCards } from '../../file-cards'
```

The existing `ConversationHistory` already exposes `renderAfter`; add this prop
to its existing invocation, preserving `renderActions` and `interleaved`:

```tsx
renderAfter={(message) => (
  <MessageFileCards
    attachments={attachmentRefsByMessageId[message.id] ?? []}
    files={pinnedFilesByMessageId[message.id] ?? []}
    client={fileCardClient}
  />
)}
```

This mounts cards inside the same message `<li>`, immediately after its bubble,
without modifying `ConversationHistory.tsx`. Do not replace the existing urgent
turn controls or mount unconfirmed drafts as if they were sent messages. When
wiring transcript bottom-following, include the message attachment/readback
revision in the owner's existing viewport revision input if attachment metadata
can arrive separately from the message; this package does not take scroll ownership.

## Behavior and resource ownership

- All temporary states retain the actual DTO expiry date. Ready/pending show
  `Expires <date>`; expired/removed show their short state and the date. The exact
  localized timestamp and timezone are in the tooltip/accessibility label and
  the original ISO value is in `<time dateTime>`. Permanent references have no
  expiry. The deadline is checked on a timer, focus and visibility changes.
- Only ready files have Download. Pending and tombstones never request bytes.
  Server state errors fence the card until new lifecycle metadata changes its
  identity or it is remounted by the owning refreshed view. Transient download
  failures keep a manual Download retry; there is no automatic download retry.
- PNG/JPEG/WebP/GIF thumbnails use verified Blob object URLs. Only images up to
  2 MiB are fetched automatically; larger images use a static icon and still
  support explicit download. Bad image decoding falls back to an icon.
- No file body is rendered as HTML, SVG, Markdown, a frame, or an embedded
  document. Static trusted Nocturne icons may themselves be SVG. Content-Type,
  raster signature, bounded streamed size and revision SHA-256 are checked
  before a Blob is returned. A secure WebCrypto context (HTTPS/trustworthy
  localhost) is required; there is no unverified fallback.
- Query owns preview bytes; Mutation owns download progress/errors. Blob caches
  are per view/client/session/pin and have `gcTime: 0`. Download mutations return
  no Blob data. Any app persistence/dehydration policy must exclude
  `message-file-preview` and `message-file-download`; `meta.persist: false` is
  a signal to that policy, not a claim that TanStack implements persistence.
- Object URL state, image decode failure and captured abort signals are local
  browser-resource lifetimes, not duplicated server state or interactive app
  state. No Zustand store is needed for this stateless card. Thumbnail URLs are
  revoked on change, decode error and unmount. Save URLs are revoked after the
  click task (one-second grace) or earlier on view cleanup, idempotently.
- Revision/state changes and unmount abort pending requests. Session changes
  also use the shared generation guard, including against late responses. A
  new current head alone neither replaces nor refetches an old pinned preview.
  The existing auth boundary must still clear/remount the parent conversation
  and metadata queries; this card does not assume ownership of them.
- Scoped CSS uses minmax(0, 1fr), filename truncation with full-name tooltips,
  wrapping metadata, and a second action row at <=360px. Download retains a
  44px minimum touch target. No actual 320px browser run was possible here.

## Verification

Written tests use Vitest, Testing Library and the repo's shared MSW server. They
exercise all eight MIME types (both JPEG filename extensions), lifecycle states,
permanent scopes, actual expiry, pin mismatch/history resolution, download pin
and headers, tampered/oversize/wrong-type responses, retry, StrictMode cleanup,
decode failure, expiry/removal/session cleanup, and late preview/download races.
Images in `testFixtures.ts` are real one-pixel PNG/JPEG/WebP/GIF bytes. Nonimage
fixtures are intentionally inert payloads because this layer never parses them.

After applying the ZIP to the exact base and installing with the repo's pinned
pnpm (do not use a plain npm install), run from the repo root:

```sh
corepack pnpm install
corepack pnpm --filter @foreman-code/contracts build
cd apps/web
node ../../scripts/heavy-job.mjs -- corepack pnpm exec vitest run --maxWorkers=4 \
  src/features/file-cards/fileCardClient.test.ts \
  src/features/file-cards/fileCards.test.tsx
cd ../..
corepack pnpm --filter @foreman-code/web typecheck
corepack pnpm --filter @foreman-code/web lint
corepack pnpm --filter @foreman-code/web build
```

Then run the broader root checks in AGENTS.md and the existing app's permitted
browser verification, including a 320px message container and actual downloads.

Actually run in the handoff environment:

- TypeScript 5.8.3 syntax/transpile diagnostics: **9 TS/TSX files, 0 errors**.
  This is not the repo's pinned TypeScript 5.9.3 semantic typecheck.
- **43/43 isolated actual-source transport/helper checks passed** using Node's
  Response, ReadableStream, Blob and WebCrypto. Contract/auth imports were
  minimal stubs. These checks did NOT execute Zod validation, React hooks,
  TanStack Query, Vitest, MSW, or the real authentication lifecycle.
- ZIP integrity, path ownership and SHA-256 verification are recorded in the
  handoff manifest.

Not run: the submitted Vitest/MSW suite; full repo typecheck/lint/build; live API,
MCP or browser tests. The environment has no checked-out dependency tree and
`corepack pnpm --version` failed fetching the package registry. Direct Git access
also failed proxy resolution. Reads were through the connected GitHub tool at the
pinned SHA. No browser isolation or security-setting workaround was attempted.
