import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, it, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { Budget } from "../../archives/policy.js";
import { decodeEntry, parseZip } from "../../archives/zip.js";
import { editDocument, FORMAT_LIMITS, readDocument } from "../index.js";
import { docx, docxParts, officeContainer, zip } from "./fixtures.js";

vi.setConfig({ testTimeout: 60_000 });

async function partsOf(bytes: Uint8Array): Promise<Map<string, Buffer>> {
  const buffer = Buffer.from(bytes), budget = new Budget();
  const parts = new Map<string, Buffer>();
  for (const entry of parseZip(buffer, budget)) if (entry.kind === "file") parts.set(entry.name, await decodeEntry(buffer, entry, budget));
  return parts;
}
describe("DOCX helpers using the pinned contained ZIP implementation", () => {
  let scratchRoot: string;
  beforeAll(async () => { scratchRoot = await mkdtemp(path.join(tmpdir(), "fil06-docx-test-")); });
  afterEach(async () => { assert.deepEqual(await readdir(scratchRoot), [], "Parent removes workspaces after success and failure"); });
  afterAll(async () => { await rm(scratchRoot, { recursive: true, force: true }); });
  it("reads numbered paragraphs, tables, tabs and breaks without exposing deleted text or fields", async () => {
    const bytes = docx('<q:p><q:r><q:t>MARKER</q:t><q:tab/><q:t>tabbed</q:t><q:br/><q:t>next</q:t><q:instrText>EXECUTE NOTHING</q:instrText></q:r><q:del><q:r><q:t>DELETED</q:t></q:r></q:del></q:p><q:tbl><q:tr><q:tc><q:p><q:r><q:t>TABLE</q:t></q:r></q:p></q:tc></q:tr></q:tbl>');
    const read = await readDocument({ format: "docx", bytes }, { scratchRoot });
    assert.equal(read.status, "ready"); assert.ok("sections" in read);
    assert.deepEqual(read.sections.map((section) => section.text), ["MARKER\ttabbed\nnext", "TABLE"]);
    assert.match(read.text, /\[\[Paragraph 1\]\]/); assert.match(read.text, /\[\[Paragraph 2\]\]/);
    assert.doesNotMatch(read.text, /EXECUTE|DELETED/);
  });
  it("appends escaped text, reparses, preserves paragraph properties and every other part byte-for-byte", async () => {
    const bytes = docx(); const before = await partsOf(bytes);
    const text = '  NEW <tag> ]]> & "quotes"\t世界\r\nline two  ';
    const result = await editDocument({ format: "docx", bytes }, { kind: "append_text", text }, { scratchRoot });
    assert.equal(result.status, "ready"); assert.ok("bytes" in result); assert.equal(result.changed, true);
    const after = await partsOf(result.bytes);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort());
    for (const [name, part] of before) if (name !== "word/document.xml") assert.deepEqual(after.get(name), part, name);
    const outputXml = after.get("word/document.xml")!.toString();
    assert.match(outputXml, /keepNext/); assert.match(outputXml, /xml:space="preserve"/); assert.match(outputXml, /&lt;tag&gt;/);
    const document = new DOMParser().parseFromString(outputXml, "application/xml");
    const body = document.getElementsByTagNameNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "body").item(0)!;
    assert.equal(body.lastChild?.localName, "sectPr");
    const reread = await readDocument({ format: "docx", bytes: result.bytes }, { scratchRoot });
    assert.ok("sections" in reread);
    assert.deepEqual(reread.sections.map((section) => section.text), ["ORIGINAL & marker", text.replace(/\r\n/g, "\n")]);
  });
  it("returns byte-identical original ZIP bytes on no-op, including empty append", async () => {
    const bytes = docx();
    for (const edit of [{ kind: "unchanged" }, { kind: "append_text", text: "" }] as const) {
      const result = await editDocument({ format: "docx", bytes }, edit, { scratchRoot });
      assert.ok("bytes" in result); assert.equal(result.changed, false); assert.deepEqual(Buffer.from(result.bytes), bytes);
    }
  });
  it("handles empty documents and alternate/strict Word namespaces", async () => {
    assert.equal((await readDocument({ format: "docx", bytes: docx("") }, { scratchRoot })).status, "empty");
    assert.equal((await readDocument({ format: "docx", bytes: docx("<q:p/>") }, { scratchRoot })).status, "empty");
    const parts = docxParts();
    parts["word/document.xml"] = String(parts["word/document.xml"]).replace("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main");
    const edited = await editDocument({ format: "docx", bytes: zip(parts) }, { kind: "append_text", text: "STRICT" }, { scratchRoot });
    assert.ok("bytes" in edited);
    const read = await readDocument({ format: "docx", bytes: edited.bytes }, { scratchRoot });
    assert.ok("text" in read); assert.match(read.text, /STRICT/);
  });
  it("fails closed on corrupt/truncated archives, missing parts, malformed XML and invalid UTF-8", async () => {
    const missing = docxParts(); delete missing["_rels/.rels"];
    const malformed = docxParts(); malformed["word/document.xml"] = '<q:document xmlns:q="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><q:body><q:p></q:body></q:document>';
    const nonUtf8 = docxParts(); nonUtf8["word/document.xml"] = Buffer.from([0xc3, 0x28]);
    for (const bytes of [Buffer.alloc(0), docx().subarray(0, 100), zip(missing), zip(malformed), zip(nonUtf8)]) {
      assert.equal((await readDocument({ format: "docx", bytes }, { scratchRoot })).status, "corrupt");
    }
  });
  it("CRC-validates parts not used in extraction", async () => {
    const bytes = docx(); const item = parseZip(bytes, new Budget()).find((entry) => entry.name === "word/media/pixel.png")!;
    bytes[item.dataOffset] = bytes[item.dataOffset]! ^ 1;
    assert.equal((await readDocument({ format: "docx", bytes }, { scratchRoot })).status, "corrupt");
    assert.equal((await editDocument({ format: "docx", bytes }, { kind: "unchanged" }, { scratchRoot })).status, "corrupt");
  });
  it("rejects traversal and never writes outside the private workspace", async () => {
    const parts = docxParts(); parts["../escape"] = "never written";
    assert.equal((await readDocument({ format: "docx", bytes: zip(parts) }, { scratchRoot })).status, "corrupt");
  });
  it("does not expand DTD/entities, execute macros, or follow an external main document", async () => {
    const dtd = docxParts(); dtd["word/document.xml"] = '<!DOCTYPE q:document [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + String(dtd["word/document.xml"]);
    const macro = docxParts(); macro["word/vbaProject.bin"] = Buffer.from([1, 2, 3]);
    const external = docxParts(); external["_rels/.rels"] = String(external["_rels/.rels"]).replace('Target="word/document.xml"', 'Target="https://example.invalid/document.xml" TargetMode="External"');
    for (const parts of [dtd, macro, external]) assert.equal((await readDocument({ format: "docx", bytes: zip(parts) }, { scratchRoot })).status, "unsupported");
  });
  it("distinguishes declared ZIP and Office encryption from arbitrary legacy OLE", async () => {
    const bytes = docx();
    // Declare the same encryption flag in each local header and central record. No decryption is attempted.
    for (let offset = 0; offset < bytes.length - 46; offset++) {
      if (bytes.readUInt32LE(offset) === 0x04034b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 6) | 1, offset + 6);
      if (bytes.readUInt32LE(offset) === 0x02014b50) bytes.writeUInt16LE(bytes.readUInt16LE(offset + 8) | 1, offset + 8);
    }
    assert.equal((await readDocument({ format: "docx", bytes }, { scratchRoot })).status, "encrypted");
    assert.equal((await readDocument({ format: "docx", bytes: officeContainer(true) }, { scratchRoot })).status, "encrypted");
    assert.equal((await readDocument({ format: "docx", bytes: officeContainer(false) }, { scratchRoot })).status, "unsupported");
    assert.equal((await readDocument({ format: "docx", bytes: Buffer.from("d0cf11e0a1b11ae1", "hex") }, { scratchRoot })).status, "corrupt");
  });
  it("bounds XML bytes, nesting, and complete extracted text", async () => {
    const huge = docxParts(); huge["word/styles.xml"] = " ".repeat(FORMAT_LIMITS.xmlBytes + 1);
    const deep = docx('<q:sdt>'.repeat(FORMAT_LIMITS.xmlDepth) + '<q:p/>' + '</q:sdt>'.repeat(FORMAT_LIMITS.xmlDepth));
    const long = docx(`<q:p><q:r><q:t>${"x".repeat(FORMAT_LIMITS.textBytes)}</q:t></q:r></q:p>`);
    for (const bytes of [zip(huge), deep, long]) assert.equal((await readDocument({ format: "docx", bytes }, { scratchRoot })).status, "too_large");
  });
  it("requires a private, non-symlink server scratch root", async () => {
    assert.equal((await readDocument({ format: "docx", bytes: docx() })).status, "unavailable");
    const link = `${scratchRoot}-link`;
    try {
      await symlink(scratchRoot, link);
      assert.equal((await readDocument({ format: "docx", bytes: docx() }, { scratchRoot: link })).status, "unavailable");
    } finally { await rm(link, { force: true }); }
    try {
      await chmod(scratchRoot, 0o755);
      assert.equal((await readDocument({ format: "docx", bytes: docx() }, { scratchRoot })).status, "unavailable");
    } finally { await chmod(scratchRoot, 0o700); }
  });
});
