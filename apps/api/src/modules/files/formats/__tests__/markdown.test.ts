import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { editDocument, FORMAT_LIMITS, readDocument } from "../index.js";

vi.setConfig({ testTimeout: 60_000 });
describe("Markdown byte helpers through the isolated public API", () => {
  it("reads a marker and appends literal UTF-8 without changing BOM or CRLF", async () => {
    const bytes = Buffer.from("\uFEFF# ORIGINAL marker\r\n\r\nKeep café and 世界.\r\n");
    const read = await readDocument({ format: "markdown", bytes });
    assert.equal(read.status, "ready"); assert.ok("text" in read);
    assert.match(read.text, /\[\[Document 1\]\]/); assert.match(read.text, /ORIGINAL marker/);
    const edit = await editDocument({ format: "markdown", bytes }, { kind: "append_text", text: "\nAppended **literal** text 🙂\n" });
    assert.equal(edit.status, "ready"); assert.ok("bytes" in edit);
    assert.equal(edit.changed, true); assert.equal(edit.mediaType, "text/markdown");
    assert.deepEqual(Buffer.from(edit.bytes.subarray(0, bytes.length)), bytes);
    const reread = await readDocument({ format: "markdown", bytes: edit.bytes });
    assert.ok("text" in reread); assert.match(reread.text, /Appended \*\*literal\*\* text 🙂/);
  });
  it("returns byte-identical data for unchanged and empty-append requests", async () => {
    const bytes = Buffer.from("\uFEFFORIGINAL\r\n");
    for (const edit of [{ kind: "unchanged" }, { kind: "append_text", text: "" }] as const) {
      const result = await editDocument({ format: "markdown", bytes }, edit);
      assert.ok("bytes" in result); assert.equal(result.changed, false); assert.deepEqual(Buffer.from(result.bytes), bytes);
    }
  });
  it("reports empty separately and does not execute HTML or Markdown", async () => {
    assert.equal((await readDocument({ format: "markdown", bytes: Buffer.alloc(0) })).status, "empty");
    assert.equal((await readDocument({ format: "markdown", bytes: Buffer.from("\r\n \t") })).status, "empty");
    const literal = '<script>throw new Error("never")</script>\n![image](https://example.invalid/no)';
    const read = await readDocument({ format: "markdown", bytes: Buffer.from(literal) });
    assert.ok("sections" in read); assert.equal(read.sections[0]?.text, literal);
  });
  it("rejects malformed UTF-8, binary controls, and invalid append Unicode", async () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0]), Buffer.from([0x7f])]) {
      assert.equal((await readDocument({ format: "markdown", bytes })).status, "corrupt");
      assert.equal((await editDocument({ format: "markdown", bytes }, { kind: "unchanged" })).status, "corrupt");
    }
    assert.equal((await editDocument({ format: "markdown", bytes: Buffer.alloc(0) }, { kind: "append_text", text: "\ud800" })).status, "corrupt");
  });
  it("returns too_large, not partial success, at the text and input limits", async () => {
    assert.equal((await readDocument({ format: "markdown", bytes: Buffer.alloc(FORMAT_LIMITS.textBytes, 65) })).status, "too_large");
    assert.equal((await readDocument({ format: "markdown", bytes: Buffer.alloc(FORMAT_LIMITS.inputBytes + 1) })).status, "too_large");
    assert.equal((await editDocument({ format: "markdown", bytes: Buffer.alloc(0) }, { kind: "append_text", text: "é".repeat(FORMAT_LIMITS.editTextBytes) })).status, "too_large");
  });
  it("snapshots input before the caller can mutate it", async () => {
    const bytes = Buffer.from("ORIGINAL"); const read = readDocument({ format: "markdown", bytes }); bytes.fill(88);
    const result = await read; assert.ok("sections" in result); assert.equal(result.sections[0]?.text, "ORIGINAL");
  });
});
