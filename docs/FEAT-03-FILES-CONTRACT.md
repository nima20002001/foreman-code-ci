# FIL-02 — file contract decisions

## Identity and lifetime

`scope.kind` is `temporary`, `workflow_reference`, or `workspace_reference`.
Temporary scope has a strict `chat.kind` union: Operator identity includes its
owner, Operator, and conversation; Agent identity includes its conversation,
Agent, workspace, and workflow, with Run/execution IDs supplied together. No
nullable scope wildcards. Workspace references are inherited, not copied.

`File` holds logical identity, scope, lifecycle, original `createdAt`, and a
mutable discovery-only `currentRevisionId`. `FileRevision` freezes the exact
filename, media type, size, SHA-256, origin, and revision creation time. Removal
keeps the file tombstone and revision metadata; retaining metadata does not
promise retained bytes. Every byte read pins **both** fileId and revisionId.
Old Runs keep their immutable provenance pins: return unavailable when those
bytes expire/disappear, never follow the head to newer bytes.

Temporary `expiresAt` is UTC `File.createdAt + retentionDurationSeconds`.
Duration is snapshotted at creation; reads, messages, new revisions, and resumes
never slide it. Preferences belong to the authenticated owner: default seven
24-hour days, inclusive bounds one hour through 365 days, integer seconds.
`applyToExisting` omitted/false changes only the preference for future files.
Explicit true recomputes still-live temporary files from their **original**
creation time. Already expired, overdue, or removed files never resurrect.
Permanent references have neither expiry fields nor an expired state.
Preview counts only still-live owner files newly expiring under the proposal;
it is an as-of preview, not a reservation. Saves remain revision-checked.

## Transport and authority

Chosen limits: **25 MiB per file** for every allowed type, **64 KiB per read**,
**10 attachments per message**, **100 manifest rows per page**. These are
contract defaults, not existing backend limits. Canonical MIME values and
matching case-insensitive extensions are required; MIME, size, hash, archive
safety, and actual bytes must still be verified by the service.

Attachment identity is the ordered `(fileId, revisionId)` tuple sequence;
omission equals `[]`. Add `messageAttachmentIdentity` to the existing complete
chat receipt hash, retaining text/intent/target identity. Reusing a requestId
with changed attachments is a conflict, never another delivery. Existing
text-only receipts cannot authorize adding attachments during replay.

Agent list/read are read-only. Working copies use conversation-bound runner
artifact handles; publish always allocates new temporary file/revision IDs.
No Agent tool accepts a permanent write destination or a replace/remove target.
Copies must not share writable backing bytes with references. `agent_copy`
means an unchanged copy; generated/edited content is `agent_output`.
Authentication, conversation ownership, workspace/workflow/Run lineage, artifact
lookup, immutable storage, and receipt persistence are service obligations;
IDs are not grants. Artifact IDs are never interpreted as host paths/URLs.
Preserve harness write restrictions. This lane adds no runtime tools or routes.

## Export/integration follow-through (not edited here)

Add to `packages/contracts/src/index.ts`:

```ts
export * from "./files.js";
```

Add the `packages/contracts/package.json` subpath export:

```json
"./files": { "types": "./dist/files.d.ts", "import": "./dist/files.js" }
```

Both chat send schemas must compose `MessageAttachmentFields` and include its
canonical identity in retries. Use `parseAgentFileReadResult` to bind responses
to exact requested pins/ranges. Persist `RunFileProvenance` on successful Run
reads. Neither chat schemas, export wiring, backend, nor UI are changed here.
