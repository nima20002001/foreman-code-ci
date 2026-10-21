import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { PDFDocument, PDFRawStream } from "pdf-lib";
import { editDocument, FORMAT_LIMITS, readDocument } from "../index.js";
import { pdfFixture } from "./fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

describe("PDF extraction and append-page editing with real npm libraries", () => {
  it("reads explicit page markers and appends a page whose output reparses", async () => {
    const bytes = pdfFixture();
    const read = await readDocument({ format: "pdf", bytes });
    assert.equal(read.status, "ready"); assert.ok("sections" in read);
    assert.equal(read.sections.length, 2); assert.match(read.text, /\[\[Page 1\]\]/); assert.match(read.text, /\[\[Page 2\]\]/);
    assert.match(read.sections[0]!.text, /PAGE ONE marker/); assert.match(read.sections[1]!.text, /PAGE TWO untouched/);
    const result = await editDocument({ format: "pdf", bytes }, { kind: "append_text", text: "APPENDED marker\nsecond line" });
    assert.equal(result.status, "ready"); assert.ok("bytes" in result); assert.equal(result.changed, true); assert.equal(result.mediaType, "application/pdf");
    const reread = await readDocument({ format: "pdf", bytes: result.bytes });
    assert.ok("sections" in reread); assert.equal(reread.sections.length, 3);
    assert.deepEqual(reread.sections.slice(0, 2), read.sections); assert.match(reread.sections[2]!.text, /APPENDED marker/);
    const before = await PDFDocument.load(bytes), after = await PDFDocument.load(result.bytes);
    // Verify old stream bytes survive; a changed PDF is not expected to preserve serialization/xref layout.
    for (let index = 0; index < 2; index++) {
      const originalStream = before.getPage(index).node.Contents();
      assert.ok(originalStream instanceof PDFRawStream);
      const originalContents = originalStream.getContents();
      const streams = after.context.enumerateIndirectObjects().map(([, object]) => object).filter((object) => object instanceof PDFRawStream);
      assert.ok(streams.some((stream) => Buffer.from(stream.getContents()).equals(Buffer.from(originalContents))));
    }
  }, 60_000);
  it("does not reserialize no-op requests", async () => {
    const bytes = pdfFixture();
    for (const edit of [{ kind: "unchanged" }, { kind: "append_text", text: "" }] as const) {
      const result = await editDocument({ format: "pdf", bytes }, edit);
      assert.ok("bytes" in result); assert.equal(result.changed, false); assert.deepEqual(Buffer.from(result.bytes), bytes);
    }
  }, 60_000);
  it("reports a scanned/image-only PDF as empty, with page markers and no OCR claim", async () => {
    const read = await readDocument({ format: "pdf", bytes: pdfFixture([""], { scan: true }) });
    assert.equal(read.status, "empty"); assert.ok("sections" in read);
    assert.equal(read.sections.length, 1); assert.equal(read.sections[0]?.text, ""); assert.match(read.text, /\[\[Page 1\]\]/);
  });
  it("reports password-protected and empty-user-password encrypted PDFs honestly", async () => {
    for (const password of ["fixture-password", ""]) {
      const bytes = pdfFixture(["encrypted text"], { password });
      assert.equal((await readDocument({ format: "pdf", bytes })).status, "encrypted");
      assert.equal((await editDocument({ format: "pdf", bytes }, { kind: "unchanged" })).status, "encrypted");
    }
  }, 60_000);
  it("does not execute a catalog JavaScript action while reading or editing", async () => {
    const bytes = pdfFixture(["SAFE marker"], { action: true });
    const read = await readDocument({ format: "pdf", bytes });
    assert.equal(read.status, "ready"); assert.ok("text" in read); assert.match(read.text, /SAFE marker/);
    assert.equal((await editDocument({ format: "pdf", bytes }, { kind: "append_text", text: "SAFE append" })).status, "ready");
  }, 60_000);
  it("rejects corrupt/truncated/empty input without fabricating extraction", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("%PDF-1.7\nnot a PDF\n%%EOF"), pdfFixture().subarray(0, 80)]) {
      assert.equal((await readDocument({ format: "pdf", bytes })).status, "corrupt");
    }
  });
  it("enforces pages, decompressed text, and append-page layout bounds", async () => {
    assert.equal((await readDocument({ format: "pdf", bytes: pdfFixture(Array.from({ length: FORMAT_LIMITS.pdfPages + 1 }, () => "x")) })).status, "too_large");
    assert.equal((await readDocument({ format: "pdf", bytes: pdfFixture([""], { compressedText: "x".repeat(FORMAT_LIMITS.textBytes + 1) }) })).status, "too_large");
    assert.equal((await editDocument({ format: "pdf", bytes: pdfFixture() }, { kind: "append_text", text: "x".repeat(77) })).status, "too_large");
    assert.equal((await editDocument({ format: "pdf", bytes: pdfFixture() }, { kind: "append_text", text: "世界" })).status, "unsupported");
  }, 60_000);
});
