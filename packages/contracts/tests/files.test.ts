import { describe, expect, expectTypeOf, it } from "vitest";
import * as files from "../src/files.js";

const CREATED = "2026-09-27T12:00:00.000Z";
const NOW = "2026-09-28T12:00:00.000Z";
const COMMAND = "file-command-0001";
const SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // abc
const operatorScope = {
  kind: "temporary", chat: { kind: "operator", ownerPrincipalId: "owner", operatorId: "operator", conversationId: "chat" },
} as const;
const agentScope = {
  kind: "temporary", chat: { kind: "agent", conversationId: "chat", agentId: "agent", workspaceId: "workspace", workflowId: "workflow" },
} as const;
const workflowScope = { kind: "workflow_reference", workspaceId: "workspace", workflowId: "workflow" } as const;
const workspaceScope = { kind: "workspace_reference", workspaceId: "workspace" } as const;
const ref = { fileId: "file", revisionId: "revision-1" };

function temporary(overrides: Partial<files.TemporaryFile> = {}): files.TemporaryFile {
  return { fileId: "file", currentRevisionId: "revision-1", createdAt: CREATED, scope: agentScope, state: "ready",
    retentionDurationSeconds: files.DEFAULT_FILE_RETENTION_SECONDS, expiresAt: "2026-10-04T12:00:00.000Z", ...overrides };
}
function permanent(overrides: Partial<files.PermanentFile> = {}): files.PermanentFile {
  return { fileId: "file", currentRevisionId: "revision-1", createdAt: CREATED, scope: workflowScope, state: "ready", ...overrides };
}
function revision(overrides: Partial<files.FileRevision> = {}): files.FileRevision {
  return { ...ref, filename: "input.md", mediaType: "text/markdown", byteSize: 3, sha256: SHA256,
    origin: "upload", createdAt: CREATED, ...overrides };
}
function row(file: files.File = permanent()): files.FileRow {
  return { file, revision: revision({ fileId: file.fileId, revisionId: file.currentRevisionId, createdAt: file.createdAt }) };
}
function page(items: files.FileRow[] = []): files.FilePage {
  return { items, pageInfo: { nextCursor: null } };
}
function readyRead() {
  return { status: "ready" as const, file: temporary(), revision: revision(), readAt: NOW,
    offset: 0, byteLength: 3, contentBase64: "YWJj", eof: true };
}
const save = { commandId: COMMAND, expectedRevision: 0, durationSeconds: files.DEFAULT_FILE_RETENTION_SECONDS };
const publish = { commandId: COMMAND, artifactId: "artifact", scope: agentScope, filename: "result.md", mediaType: "text/markdown" };

// All time-sensitive helpers receive fixed instants; these tests never depend on the wall clock.
describe("file scopes", () => {
  it.each([operatorScope, agentScope, workflowScope, workspaceScope])("accepts an explicit scope: %j", (scope) => {
    expect(files.FileScopeSchema.parse(scope)).toEqual(scope);
  });
  it("accepts Agent chat with a complete Run/execution identity", () => {
    const scope = { ...agentScope, chat: { ...agentScope.chat, runId: "run", executionId: "execution" } };
    expect(files.FileScopeSchema.parse(scope)).toEqual(scope);
  });
  it.each([
    { runId: "run" }, { executionId: "execution" }, { runId: null, executionId: null },
    { runId: "run", executionId: null }, { runId: "", executionId: "execution" },
  ])("rejects incomplete or nullable Run pins: %j", (extra) => {
    expect(files.FileScopeSchema.safeParse({ ...agentScope, chat: { ...agentScope.chat, ...extra } }).success).toBe(false);
  });
  it.each(["workspaceId", "workflowId", "runId", "executionId", "agentId"])("Operator chat cannot acquire %s", (field) => {
    expect(files.FileScopeSchema.safeParse({ ...operatorScope, chat: { ...operatorScope.chat, [field]: "extra" } }).success).toBe(false);
  });
  it.each(["ownerPrincipalId", "operatorId", "conversationId"])("requires Operator identity field %s", (field) => {
    expect(files.FileScopeSchema.safeParse({ ...operatorScope, chat: { ...operatorScope.chat, [field]: undefined } }).success).toBe(false);
  });
  it.each(["conversationId", "agentId", "workspaceId", "workflowId"])("requires Agent identity field %s", (field) => {
    expect(files.FileScopeSchema.safeParse({ ...agentScope, chat: { ...agentScope.chat, [field]: undefined } }).success).toBe(false);
  });
  it.each([
    {}, { kind: "temporary" }, { kind: "temporary", chat: null },
    { ...operatorScope, workspaceId: "workspace" },
    { ...agentScope, chat: { ...agentScope.chat, ownerPrincipalId: "owner" } },
    { kind: "workflow_reference", workspaceId: "workspace" },
    { ...workspaceScope, workflowId: null }, { ...workflowScope, conversationId: "chat" },
    { kind: "workspace_reference", workspaceId: null }, { kind: "all" },
  ])("rejects wildcards, missing identities, and extra scope fields: %j", (scope) => {
    expect(files.FileScopeSchema.safeParse(scope).success).toBe(false);
  });
  it("narrows scope kinds without nullable wildcard fields", () => {
    const scope = files.FileScopeSchema.parse(workspaceScope);
    if (scope.kind === "workspace_reference") expectTypeOf(scope.workspaceId).toEqualTypeOf<string>();
    expectTypeOf<files.AgentFilePublishInput["scope"]>().toEqualTypeOf<files.TemporaryFileScope>();
  });
});

describe("immutable revisions, allowed types, and limits", () => {
  const allowed = [
    ["image.png", "image/png"], ["image.jpg", "image/jpeg"], ["image.jpeg", "image/jpeg"],
    ["image.webp", "image/webp"], ["image.gif", "image/gif"], ["document.pdf", "application/pdf"],
    ["document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["notes.md", "text/markdown"], ["archive.zip", "application/zip"],
  ];
  it.each(allowed)("accepts %s as %s", (filename, mediaType) => {
    expect(files.FileRevisionSchema.safeParse({ ...revision(), filename, mediaType }).success).toBe(true);
  });
  it("uses explicit shared bounds", () => {
    expect(files.MAX_FILE_BYTES).toBe(26_214_400);
    expect(files.MAX_FILE_READ_BYTES).toBe(65_536);
    expect(files.MAX_MESSAGE_ATTACHMENTS).toBe(10);
    expect(files.FILE_MEDIA_TYPES).toHaveLength(8);
    expect(files.FileRevisionSchema.safeParse(revision({ byteSize: files.MAX_FILE_BYTES })).success).toBe(true);
    expect(files.FileRevisionSchema.safeParse(revision({ byteSize: 0 })).success).toBe(true);
  });
  it.each([-1, 0.5, files.MAX_FILE_BYTES + 1, Number.NaN, Number.POSITIVE_INFINITY])("rejects byteSize %s", (byteSize) => {
    expect(files.FileRevisionSchema.safeParse({ ...revision(), byteSize }).success).toBe(false);
  });
  it.each(["image/svg+xml", "image/bmp", "text/html", "text/plain", "application/octet-stream", "application/x-tar"])(
    "rejects unsupported media type %s", (mediaType) => {
      expect(files.FileRevisionSchema.safeParse({ ...revision(), mediaType }).success).toBe(false);
    });
  it.each(["", ".", "..", "../input.md", "folder\\input.md", "input\0.md", "input\n.md", "a".repeat(256)])(
    "rejects invalid filename %j", (filename) => {
      expect(files.FileRevisionSchema.safeParse({ ...revision(), filename }).success).toBe(false);
    });
  it("matches extensions case-insensitively, without accepting MIME/extension mismatches", () => {
    expect(files.FileRevisionSchema.parse(revision({ filename: "INPUT.MD" })).filename).toBe("INPUT.MD");
    expect(files.FileRevisionSchema.safeParse({ ...revision(), filename: "input.pdf" }).success).toBe(false);
    expect(files.FileRevisionSchema.safeParse({ ...revision(), filename: "md" }).success).toBe(false);
  });
  it.each(["", "A".repeat(64), "a".repeat(63), `sha256:${SHA256}`, "g".repeat(64)])("requires a raw lowercase SHA-256: %s", (sha256) => {
    expect(files.FileRevisionSchema.safeParse({ ...revision(), sha256 }).success).toBe(false);
  });
  it.each(["upload", "agent_output", "agent_copy"])("accepts origin %s", (origin) => {
    expect(files.FileRevisionSchema.safeParse({ ...revision(), origin }).success).toBe(true);
  });
  it("rejects unknown origins and freezes revision metadata", () => {
    expect(files.FileRevisionSchema.safeParse({ ...revision(), origin: "import" }).success).toBe(false);
    const value = files.FileRevisionSchema.parse(revision());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Reflect.set(value, "sha256", "b".repeat(64))).toBe(false);
    expect(value.sha256).toBe(SHA256);
    expectTypeOf<files.FileRevision>().toEqualTypeOf<Readonly<files.FileRevision>>();
  });
  it("validates file/revision pairing while allowing exact historical readback", () => {
    const file = permanent({ currentRevisionId: "revision-2" });
    expect(files.FileWithRevisionSchema.safeParse({ file, revision: revision() }).success).toBe(true);
    expect(files.FileWithRevisionSchema.safeParse({ file, revision: revision({ fileId: "other" }) }).success).toBe(false);
    expect(files.FileWithRevisionSchema.safeParse({ file, revision: revision({ createdAt: "2026-09-26T00:00:00Z" }) }).success).toBe(false);
    expect(files.FileRowSchema.safeParse({ file, revision: revision() }).success).toBe(false);
  });
});

describe("retention and tombstones", () => {
  it("uses a seven-day default with inclusive one-hour and 365-day limits", () => {
    expect(files.FileRetentionPreferenceSchema.parse({ ownerPrincipalId: "owner", revision: 0 }).durationSeconds).toBe(604_800);
    expect(files.FileRetentionDurationSchema.parse(3_600)).toBe(files.MIN_FILE_RETENTION_SECONDS);
    expect(files.FileRetentionDurationSchema.parse(31_536_000)).toBe(files.MAX_FILE_RETENTION_SECONDS);
  });
  it.each([3_599, 31_536_001, 3_600.5, "3600", null, Number.POSITIVE_INFINITY])("rejects duration %j", (durationSeconds) => {
    expect(files.FileRetentionDurationSchema.safeParse(durationSeconds).success).toBe(false);
  });
  it.each([
    ["2026-03-08T01:30:00-05:00", "2026-03-08T07:30:00.000Z"],
    ["2026-11-01T01:30:00-04:00", "2026-11-01T06:30:00.000Z"],
    ["2028-02-28T23:30:00Z", "2028-02-29T00:30:00.000Z"],
  ])("computes fixed UTC duration across calendar/offset changes: %s", (createdAt, expiresAt) => {
    expect(files.temporaryFileExpiresAt(createdAt, 3_600)).toBe(expiresAt);
  });
  it("requires the temporary expiry snapshot and forbids sliding/mismatched expiry", () => {
    expect(files.FileSchema.safeParse(temporary()).success).toBe(true);
    expect(files.FileSchema.safeParse({ ...temporary(), expiresAt: undefined }).success).toBe(false);
    expect(files.FileSchema.safeParse({ ...temporary(), retentionDurationSeconds: undefined }).success).toBe(false);
    expect(files.FileSchema.safeParse({ ...temporary(), expiresAt: "2026-10-05T12:00:00Z" }).success).toBe(false);
    expect(files.FileSchema.safeParse({ ...temporary(), expiresAt: "2026-10-04T14:00:00+02:00" }).success).toBe(false);
  });
  it("expires at the exact boundary, even if persisted state still says pending or ready", () => {
    const file = temporary();
    expect(files.fileStateAt(file, "2026-10-04T11:59:59.999Z")).toBe("ready");
    expect(files.fileStateAt(file, file.expiresAt)).toBe("expired");
    expect(files.fileStateAt({ ...file, state: "pending" }, file.expiresAt)).toBe("expired");
    expect(file.state).toBe("ready"); // Pure helper: no mutation or sliding extension on read.
    expect(file.expiresAt).toBe("2026-10-04T12:00:00.000Z");
    expect(files.canTransitionFileState({ ...file, state: "pending" }, "ready", file.expiresAt)).toBe(false);
  });
  it("applies retention from original creation, not the time of preference save", () => {
    const file = temporary();
    const shortened = files.applyFileRetention(file, 3_600, NOW);
    expect(shortened).toMatchObject({ createdAt: CREATED, expiresAt: "2026-09-27T13:00:00.000Z", state: "expired" });
    expect(files.applyFileRetention(file, 8 * 86_400, NOW)).toMatchObject({ expiresAt: "2026-10-05T12:00:00.000Z", state: "ready" });
    expect(file.retentionDurationSeconds).toBe(604_800);
  });
  it("never resurrects expired, overdue, or removed files when retention increases", () => {
    const file = temporary();
    for (const state of ["expired", "removed"] as const) {
      const terminal = { ...file, state };
      expect(files.applyFileRetention(terminal, files.MAX_FILE_RETENTION_SECONDS, NOW)).toEqual(terminal);
    }
    expect(files.applyFileRetention(file, files.MAX_FILE_RETENTION_SECONDS, file.expiresAt))
      .toEqual({ ...file, state: "expired" });
  });
  it("never expires permanent references or accepts expiry fields on them", () => {
    const file = permanent();
    expect(files.fileStateAt(file, "2099-01-01T00:00:00Z")).toBe("ready");
    expect(files.applyFileRetention(file, 3_600, NOW)).toEqual(file);
    expect(files.canTransitionFileState(file, "expired", NOW)).toBe(false);
    for (const extra of [{ expiresAt: null }, { expiresAt: NOW }, { retentionDurationSeconds: 3_600 }, { state: "expired" }]) {
      expect(files.FileSchema.safeParse({ ...file, ...extra }).success).toBe(false);
    }
  });
  it("retains complete tombstones and refuses backward lifecycle transitions", () => {
    for (const file of [temporary({ state: "removed" }), permanent({ state: "removed" })]) {
      expect(files.FileSchema.parse(file)).toEqual(file);
      expect(files.FileSchema.safeParse({ ...file, currentRevisionId: undefined }).success).toBe(false);
      expect(files.canTransitionFileState(file, "ready", NOW)).toBe(false);
      expect(files.canTransitionFileState(file, "pending", NOW)).toBe(false);
      expect(files.canTransitionFileState(file, "removed", NOW)).toBe(true);
    }
    const expired = temporary({ state: "expired" });
    expect(files.canTransitionFileState(expired, "ready", NOW)).toBe(false);
    expect(files.canTransitionFileState(expired, "pending", NOW)).toBe(false);
    expect(files.canTransitionFileState(expired, "removed", NOW)).toBe(true);
    expect(files.canTransitionFileState(temporary({ state: "pending" }), "ready", NOW)).toBe(true);
    expect(files.canTransitionFileState(temporary(), "pending", NOW)).toBe(false);
  });
  it("rejects invalid clocks and durations rather than falling back to now", () => {
    expect(() => files.temporaryFileExpiresAt("invalid", 3_600)).toThrow();
    expect(() => files.temporaryFileExpiresAt(CREATED, 1)).toThrow();
    expect(() => files.fileStateAt(temporary(), "not-a-clock")).toThrow();
  });
});

describe("owner retention preference commands", () => {
  it("accepts omitted revision while validating supplied values and applyToExisting", () => {
    expect(files.FileRetentionSaveInputSchema.parse(save).applyToExisting).toBeUndefined();
    const { expectedRevision, ...withoutRevision } = save;
    expect(files.FileRetentionSaveInputSchema.parse(withoutRevision)).toEqual(withoutRevision);
    expect(files.FileRetentionSaveInputSchema.parse({ ...withoutRevision, expectedRevision }).expectedRevision)
      .toBe(expectedRevision);
    expect(files.FileRetentionSaveInputSchema.parse({ ...save, applyToExisting: true }).applyToExisting).toBe(true);
    expect(files.FileRetentionSaveInputSchema.parse({ ...save, applyToExisting: false }).applyToExisting).toBe(false);
    for (const extra of [{ commandId: "short" }, { expectedRevision: -1 }, { expectedRevision: 0.5 },
      { commandId: null }, { expectedRevision: null }, { durationSeconds: undefined }, { applyToExisting: null }]) {
      expect(files.FileRetentionSaveInputSchema.safeParse({ ...save, ...extra }).success).toBe(false);
    }
  });
  it("gets and previews only the authenticated owner's preference", () => {
    expect(files.FileRetentionGetInputSchema.parse({})).toEqual({});
    expect(files.FileRetentionPreviewInputSchema.parse({ durationSeconds: 3_600 })).toEqual({ durationSeconds: 3_600 });
    for (const key of ["ownerPrincipalId", "workspaceId", "operatorId"]) {
      expect(files.FileRetentionGetInputSchema.safeParse({ [key]: "other" }).success).toBe(false);
      expect(files.FileRetentionSaveInputSchema.safeParse({ ...save, [key]: "other" }).success).toBe(false);
      expect(files.FileRetentionPreviewInputSchema.safeParse({ durationSeconds: 3_600, [key]: "other" }).success).toBe(false);
    }
  });
  it("returns versioned preferences and nonnegative, clock-qualified preview counts", () => {
    const preference = { ownerPrincipalId: "owner", durationSeconds: 3_600, revision: 1 };
    expect(files.FileRetentionGetResultSchema.parse({ preference })).toEqual({ preference });
    const preview = { ownerPrincipalId: "owner", preferenceRevision: 0, durationSeconds: 3_600, asOfUtc: NOW, expireNowCount: 2 };
    expect(files.FileRetentionPreviewResultSchema.parse(preview)).toEqual(preview);
    expect(files.FileRetentionPreviewResultSchema.safeParse({ ...preview, expireNowCount: 0 }).success).toBe(true);
    expect(files.FileRetentionPreviewResultSchema.safeParse({ ...preview, expireNowCount: -1 }).success).toBe(false);
    expect(files.FileRetentionPreviewResultSchema.safeParse({ ...preview, expireNowCount: 0.5 }).success).toBe(false);
    const result = { value: { preference, updatedFileCount: 2, expiredNowCount: 1 }, replayed: true };
    expect(files.FileRetentionSaveResultSchema.parse(result)).toEqual(result);
    expect(files.FileRetentionSaveResultSchema.safeParse({ ...result, value: { ...result.value, expiredNowCount: 3 } }).success).toBe(false);
  });
});

describe("message attachment pins and retry identity", () => {
  it("pins both identities and rejects unversioned, wildcard, or duplicate attachments", () => {
    expect(files.MessageAttachmentRefSchema.parse(ref)).toEqual(ref);
    for (const value of [{ fileId: "file" }, { ...ref, revisionId: null }, { ...ref, latest: true }]) {
      expect(files.MessageAttachmentRefSchema.safeParse(value).success).toBe(false);
    }
    expect(files.MessageAttachmentRefsSchema.safeParse([ref, { ...ref, revisionId: "revision-2" }]).success).toBe(false);
    expect(files.MessageAttachmentRefsSchema.safeParse(Array.from({ length: 10 }, (_, i) => ({ ...ref, fileId: `f-${i}` }))).success).toBe(true);
    expect(files.MessageAttachmentRefsSchema.safeParse(Array.from({ length: 11 }, (_, i) => ({ ...ref, fileId: `f-${i}` }))).success).toBe(false);
  });
  it("canonicalizes object key order and omitted empty attachments", () => {
    expect(files.messageAttachmentIdentity({ requestId: "request" })).toBe(files.messageAttachmentIdentity({ requestId: "request", attachments: [] }));
    expect(files.messageAttachmentIdentity({ requestId: "request", attachments: [ref] }))
      .toBe(files.messageAttachmentIdentity({ attachments: [{ revisionId: ref.revisionId, fileId: ref.fileId }], requestId: "request" }));
  });
  it("conflicts on adding, removing, changing a file, changing a revision, or reordering files", () => {
    const before = { requestId: "request", attachments: [ref] };
    for (const attachments of [[], [{ ...ref, fileId: "other" }], [{ ...ref, revisionId: "revision-2" }], [ref, { fileId: "other", revisionId: "v1" }]]) {
      expect(files.hasMessageAttachmentConflict(before, { ...before, attachments })).toBe(true);
    }
    const two = { requestId: "request", attachments: [ref, { fileId: "other", revisionId: "v1" }] };
    expect(files.hasMessageAttachmentConflict(two, { ...two, attachments: [...two.attachments].reverse() })).toBe(true);
    expect(files.hasMessageAttachmentConflict({ requestId: "request" }, before)).toBe(true);
    expect(files.hasMessageAttachmentConflict(before, before)).toBe(false);
    expect(files.hasMessageAttachmentConflict(before, { requestId: "another-request", attachments: [] })).toBe(false);
  });
  it("uses unambiguous tuple serialization even when identifiers contain separators", () => {
    expect(files.messageAttachmentIdentity({ requestId: "r", attachments: [{ fileId: "a:b", revisionId: "c" }] }))
      .not.toBe(files.messageAttachmentIdentity({ requestId: "r", attachments: [{ fileId: "a", revisionId: "b:c" }] }));
  });
});

describe("Agent file tools", () => {
  it.each([operatorScope, agentScope, workflowScope, workspaceScope])("lists an exact authorized scope: %j", (scope) => {
    expect(files.AgentFileListInputSchema.parse({ scope }).limit).toBe(50);
    expect(files.AgentFileListInputSchema.safeParse({ scope, limit: 101 }).success).toBe(false);
  });
  it("requires a scope, bounds manifest pages, and forbids list write flags", () => {
    expect(files.AgentFileListInputSchema.safeParse({}).success).toBe(false);
    expect(files.AgentFileListInputSchema.safeParse({ scope: workspaceScope, remove: true }).success).toBe(false);
    expect(files.AgentFileListResultSchema.parse(page([row()])).items).toHaveLength(1);
    expect(files.AgentFileListResultSchema.safeParse(page(Array.from({ length: 101 }, (_, i) => row(permanent({ fileId: `f-${i}` }))))).success).toBe(false);
    expect(files.AgentFileListResultSchema.safeParse(page([row(), row()])).success).toBe(false);
  });
  it("requires pinned, bounded read ranges", () => {
    expect(files.AgentFileReadInputSchema.parse(ref)).toEqual({ ...ref, offset: 0, length: 65_536 });
    for (const extra of [{ revisionId: undefined }, { offset: -1 }, { offset: 0.1 }, { length: 0 }, { length: 65_537 }, { replace: true }]) {
      expect(files.AgentFileReadInputSchema.safeParse({ ...ref, ...extra }).success).toBe(false);
    }
    expect(files.parseAgentFileReadResult(ref, readyRead())).toEqual(readyRead());
  });
  it("returns only the pinned historical revision, regardless of the mutable head", () => {
    const historical = { ...readyRead(), file: temporary({ currentRevisionId: "revision-2" }) };
    expect(files.parseAgentFileReadResult(ref, historical).status).toBe("ready");
    expect(() => files.parseAgentFileReadResult(ref, { ...historical, revision: revision({ revisionId: "revision-2" }) })).toThrow(/revision\/range/);
    expect(() => files.parseAgentFileReadResult({ ...ref, length: 2 }, historical)).toThrow(/revision\/range/);
    expect(() => files.parseAgentFileReadResult({ ...ref, offset: 1 }, historical)).toThrow(/revision\/range/);
    const unavailable = { status: "unavailable", ref: { ...ref, revisionId: "revision-2" }, reason: "removed" };
    expect(() => files.parseAgentFileReadResult(ref, unavailable)).toThrow(/revision\/range/);
  });
  it.each(["pending", "expired", "removed", "not_found", "forbidden"])("returns no bytes when %s", (reason) => {
    const result = { status: "unavailable", ref, reason };
    expect(files.parseAgentFileReadResult(ref, result)).toEqual(result);
    expect(files.AgentFileReadResultSchema.safeParse({ ...result, contentBase64: "YWJj" }).success).toBe(false);
  });
  it("rejects stale ready records at expiry and malformed clocks without throwing from safeParse", () => {
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), readAt: temporary().expiresAt }).success).toBe(false);
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), readAt: "invalid" }).success).toBe(false);
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), file: { ...temporary(), expiresAt: "invalid" } }).success).toBe(false);
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), readAt: "2026-09-26T12:00:00Z" }).success).toBe(false);
    for (const state of ["pending", "expired", "removed"] as const) {
      expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), file: temporary({ state }) }).success).toBe(false);
    }
  });
  it("validates byte counts, EOF, canonical base64, and file pairing", () => {
    for (const extra of [{ byteLength: 2 }, { eof: false }, { offset: 1 }, { contentBase64: "not-base64" },
      { byteLength: 1, contentBase64: "YR==" }, { file: temporary({ fileId: "other" }) }]) {
      expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), ...extra }).success).toBe(false);
    }
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), offset: 3, byteLength: 0, contentBase64: "" }).success).toBe(true);
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), byteLength: 0, contentBase64: "", eof: false }).success).toBe(false);
    expect(files.AgentFileReadResultSchema.safeParse({ ...readyRead(), byteLength: 1, contentBase64: "YQ==", eof: false }).success).toBe(true);
  });
  it.each([operatorScope, agentScope])("copies and publishes only into temporary conversation storage: %j", (scope) => {
    const copy = { commandId: COMMAND, source: ref, destination: scope };
    expect(files.AgentFileCreateWorkingCopyInputSchema.parse(copy)).toEqual(copy);
    const result = { value: { artifactId: "artifact", source: ref, destination: scope, filename: "input.md", createdAt: NOW }, replayed: false };
    expect(files.AgentFileCreateWorkingCopyResultSchema.parse(result)).toEqual(result);
    expect(files.AgentFilePublishInputSchema.parse({ ...publish, scope })).toEqual({ ...publish, scope });
    for (const origin of ["agent_output", "agent_copy"] as const) {
      const published = { value: { file: temporary({ scope }), revision: revision({ origin }) }, replayed: true };
      expect(files.AgentFilePublishResultSchema.parse(published)).toEqual(published);
    }
  });
  it.each([workflowScope, workspaceScope])("cannot publish, replace, or remove permanent references: %j", (scope) => {
    expect(files.AgentFileCreateWorkingCopyInputSchema.safeParse({ commandId: COMMAND, source: ref, destination: scope }).success).toBe(false);
    expect(files.AgentFilePublishInputSchema.safeParse({ ...publish, scope }).success).toBe(false);
    expect(files.AgentFilePublishResultSchema.safeParse({ value: { file: permanent({ scope }), revision: revision({ origin: "agent_output" }) }, replayed: false }).success).toBe(false);
  });
  it("rejects mutation target IDs, arbitrary paths/URLs, caller origin/hash, and destructive flags", () => {
    for (const extra of [{ targetFileId: "reference" }, { fileId: "reference" }, { revisionId: "v1" }, { replace: true },
      { remove: true }, { path: "/etc/passwd" }, { url: "https://example.invalid/file" }, { origin: "upload" }, { sha256: SHA256 }]) {
      expect(files.AgentFilePublishInputSchema.safeParse({ ...publish, ...extra }).success).toBe(false);
      expect(files.AgentFileCreateWorkingCopyInputSchema.safeParse({ commandId: COMMAND, source: ref, destination: agentScope, ...extra }).success).toBe(false);
    }
    expect(files.AgentFileCreateWorkingCopyInputSchema.safeParse({ commandId: COMMAND, source: { fileId: "file" }, destination: agentScope }).success).toBe(false);
    expect(files.AgentFilePublishInputSchema.safeParse({ ...publish, filename: "result.exe" }).success).toBe(false);
    expect(files.AgentFilePublishResultSchema.safeParse({ value: { file: temporary(), revision: revision() }, replayed: false }).success).toBe(false);
    expect(files.AgentFilePublishResultSchema.safeParse({ value: { file: temporary({ state: "pending" }), revision: revision({ origin: "agent_output" }) }, replayed: false }).success).toBe(false);
  });
});

describe("Run provenance and small Files DTOs", () => {
  it("preserves immutable Run/execution/revision/read-time facts after head updates and removal", () => {
    const provenance = files.RunFileProvenanceSchema.parse({ runId: "run", executionId: "execution", ...ref, readAt: NOW });
    const tombstone = row(permanent({ currentRevisionId: "revision-2", state: "removed" }));
    expect(files.FileRowSchema.parse(tombstone).revision.revisionId).toBe("revision-2");
    expect(provenance.revisionId).toBe("revision-1");
    expect(Object.isFrozen(provenance)).toBe(true);
    expect(Reflect.set(provenance, "revisionId", "revision-2")).toBe(false);
    for (const key of ["runId", "executionId", "fileId", "revisionId", "readAt"]) {
      expect(files.RunFileProvenanceSchema.safeParse({ ...provenance, [key]: undefined }).success).toBe(false);
    }
    expect(files.RunFileProvenanceSchema.safeParse({ ...provenance, currentRevisionId: "revision-2" }).success).toBe(false);
  });
  it("keeps workflow and inherited workspace groups separate and independently pageable", () => {
    const board = { workspaceId: "workspace", workflowId: "workflow", workflowFiles: page([row()]),
      inheritedWorkspaceFiles: page([row(permanent({ fileId: "workspace-file", scope: workspaceScope }))]) };
    expect(files.BoardFilesListSchema.parse(board)).toEqual(board);
    expect(files.BoardFilesListInputSchema.parse({ workspaceId: "workspace", workflowId: "workflow", workflowCursor: "wf-page", inheritedWorkspaceCursor: "ws-page" }))
      .toMatchObject({ workflowCursor: "wf-page", inheritedWorkspaceCursor: "ws-page", limit: 50 });
    expect(files.BoardFilesListSchema.safeParse({ ...board, workflowFiles: board.inheritedWorkspaceFiles }).success).toBe(false);
    expect(files.BoardFilesListSchema.safeParse({ ...board, workspaceId: "other-workspace" }).success).toBe(false);
    expect(files.BoardFilesListSchema.safeParse({ ...board, workflowId: "other-workflow" }).success).toBe(false);
    expect(files.BoardFilesListSchema.safeParse({ ...board, workflowFiles: page([row(temporary())]) }).success).toBe(false);
    expect(files.BoardFilesListSchema.safeParse({ ...board, inheritedWorkspaceFiles: page([row(permanent({ scope: workspaceScope }))]) }).success).toBe(false);
    // The same workspace reference is inherited by every workflow, not copied into workflow storage.
    expect(files.BoardFilesListSchema.parse({ ...board, workflowId: "second-workflow", workflowFiles: page() }).inheritedWorkspaceFiles)
      .toEqual(board.inheritedWorkspaceFiles);
  });
  it("shows only workspace references in Project files and never includes inline content", () => {
    const list = { workspaceId: "workspace", files: page([row(permanent({ scope: workspaceScope }))]) };
    expect(files.WorkspaceProjectFilesListSchema.parse(list)).toEqual(list);
    expect(files.WorkspaceProjectFilesListInputSchema.parse({ workspaceId: "workspace" }).limit).toBe(50);
    expect(files.WorkspaceProjectFilesListSchema.safeParse({ ...list, workspaceId: "other-workspace" }).success).toBe(false);
    expect(files.WorkspaceProjectFilesListSchema.safeParse({ ...list, files: page([row()]) }).success).toBe(false);
    expect(files.WorkspaceProjectFilesListSchema.safeParse({ ...list, files: page([row(temporary())]) }).success).toBe(false);
    expect(files.FileRowSchema.safeParse({ ...row(), contentBase64: "YWJj" }).success).toBe(false);
  });
});
