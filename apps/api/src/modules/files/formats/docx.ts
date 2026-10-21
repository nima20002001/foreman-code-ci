import { rejectOfficeContainer } from "./office-container.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser, XMLSerializer, type Document, type Element, type Node } from "@xmldom/xmldom";
import { ArchiveHelperError, extractZip, listZip, repackZip } from "../archives/index.js";
import { checkOutput, checkPlainText, documentText, fail, FORMAT_LIMITS, TextBudget, utf8 } from "./policy.js";
import type { DocumentEdit, DocumentText, TextSection } from "./types.js";

const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const STRICT_WORD = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES = "http://schemas.openxmlformats.org/package/2006/content-types";
const MAIN_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml";
const MAIN_RELS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  "http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument",
]);
function word(node: Node, name: string): node is Element {
  return node.nodeType === 1 && (node.namespaceURI === WORD || node.namespaceURI === STRICT_WORD) && node.localName === name;
}
function xml(bytes: Uint8Array): Document {
  if (bytes.byteLength > FORMAT_LIMITS.xmlBytes) fail("too_large", "DOCX structural XML exceeds the helper limit");
  const text = utf8(bytes);
  checkPlainText(text);
  // No DTDs, user-defined entities, XInclude, schema fetching, or tolerant XML recovery.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) fail("unsupported", "DOCX DTDs and entity declarations are not supported");
  const encoding = /^\uFEFF?\s*<\?xml\b[^?]*\bencoding\s*=\s*["']([^"']+)/i.exec(text)?.[1];
  if (encoding && !/^utf-?8$/i.test(encoding)) fail("unsupported", "DOCX structural XML must use UTF-8");
  let document: Document;
  try {
    document = new DOMParser({ onError() { throw new Error("Invalid XML"); } }).parseFromString(text, "application/xml");
  } catch { return fail("corrupt", "DOCX contains malformed XML"); }
  if (!document.documentElement) fail("corrupt", "DOCX XML has no document element");
  const pending: { node: Node; depth: number }[] = [{ node: document, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop()!;
    if (++count > FORMAT_LIMITS.xmlNodes || depth > FORMAT_LIMITS.xmlDepth) fail("too_large", "DOCX XML exceeds structural limits");
    for (let child = node.lastChild; child; child = child.previousSibling) pending.push({ node: child, depth: depth + 1 });
  }
  return document;
}
/** Distinguish a declared encrypted ZIP from other unsupported ZIP features, without inflation. */
function encryptedZip(bytes: Buffer): boolean {
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (bytes.readUInt32LE(end) !== 0x06054b50 || end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length) continue;
    const count = bytes.readUInt16LE(end + 10);
    let offset = bytes.readUInt32LE(end + 16);
    if (count > 256 || offset + bytes.readUInt32LE(end + 12) !== end) return false;
    let encrypted = false;
    for (let index = 0; index < count; index++) {
      if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) return false;
      encrypted ||= (bytes.readUInt16LE(offset + 8) & 0x41) !== 0;
      offset += 46 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
      if (offset > end) return false;
    }
    return offset === end && encrypted;
  }
  return false;
}
function archiveFailure(error: unknown, bytes: Buffer): never {
  if (!(error instanceof ArchiveHelperError)) throw error;
  if (error.code === "limit_exceeded") fail("too_large", "DOCX exceeds the contained ZIP limits");
  if (error.code === "timeout") fail("timeout", "DOCX archive processing exceeded its deadline");
  if (error.code === "unsupported") {
    if (encryptedZip(bytes)) fail("encrypted", "Encrypted DOCX ZIP entries are not supported");
    fail("unsupported", "DOCX uses an unsupported ZIP feature");
  }
  fail("corrupt", "DOCX archive failed containment or integrity validation");
}
interface OpenDocx { directory: string; document: Document; body: Element }
async function openDocx(input: Uint8Array, scratchDirectory: string): Promise<OpenDocx> {
  const bytes = Buffer.from(input);
  rejectOfficeContainer(bytes);
  let directory: string;
  try {
    const entries = listZip(bytes);
    const names = new Set(entries.filter((entry) => entry.kind === "file").map((entry) => entry.name));
    if (!["[Content_Types].xml", "_rels/.rels", "word/document.xml"].every((name) => names.has(name))) {
      fail("corrupt", "DOCX is missing a required package part");
    }
    if (entries.reduce((sum, entry) => sum + entry.uncompressedBytes, 0) > FORMAT_LIMITS.docxExpandedBytes) {
      fail("too_large", "Expanded DOCX exceeds the helper limit");
    }
    for (const entry of entries) {
      if (/\.(?:xml|rels)$/i.test(entry.name) && entry.uncompressedBytes > FORMAT_LIMITS.xmlBytes) {
        fail("too_large", "DOCX XML part exceeds the helper limit");
      }
      if (/(?:^|\/)(?:embeddings|activeX)(?:\/|$)|vbaProject|altChunk/i.test(entry.name)) {
        fail("unsupported", "Active or embedded Office packages are not supported");
      }
    }
    // Extract every part, not just document.xml: CRC-check even the parts an edit must preserve.
    directory = (await extractZip(bytes, scratchDirectory)).workingDirectory;
    for (const entry of entries) {
      if (entry.kind === "file" && /\.(?:xml|rels)$/i.test(entry.name)) {
        xml(await readFile(path.join(directory, entry.name)));
      }
    }
  } catch (error) { return archiveFailure(error, bytes); }
  const types = xml(await readFile(path.join(directory, "[Content_Types].xml"))).documentElement!;
  if (types.localName !== "Types" || types.namespaceURI !== CONTENT_TYPES) fail("corrupt", "Invalid DOCX content types");
  let mainTypes = 0;
  for (let node = types.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    const type = element.getAttribute("ContentType") ?? "";
    if (/macroEnabled|vbaProject|oleObject|activeX/i.test(type)) fail("unsupported", "Active DOCX content types are not supported");
    if (element.localName === "Override" && element.namespaceURI === CONTENT_TYPES
      && element.getAttribute("PartName") === "/word/document.xml") {
      if (type !== MAIN_TYPE) fail("unsupported", "Package is not a non-macro DOCX document");
      mainTypes++;
    }
  }
  if (mainTypes !== 1) fail("corrupt", "DOCX must declare exactly one main document content type");
  const relationships = xml(await readFile(path.join(directory, "_rels/.rels"))).documentElement!;
  if (relationships.localName !== "Relationships" || relationships.namespaceURI !== RELS) fail("corrupt", "Invalid DOCX relationships");
  let mains = 0;
  const ids = new Set<string>();
  for (let node = relationships.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const element = node as Element;
    if (element.localName !== "Relationship" || element.namespaceURI !== RELS) fail("corrupt", "Invalid package relationship");
    const id = element.getAttribute("Id");
    if (!id || ids.has(id)) fail("corrupt", "Duplicate or missing package relationship ID");
    ids.add(id);
    if (MAIN_RELS.has(element.getAttribute("Type") ?? "")) {
      if (element.getAttribute("TargetMode") === "External"
        || !["word/document.xml", "/word/document.xml"].includes(element.getAttribute("Target") ?? "")) {
        fail("unsupported", "DOCX main document must be the local word/document.xml part");
      }
      mains++;
    }
  }
  if (mains !== 1) fail("corrupt", "DOCX must have exactly one main document relationship");
  const document = xml(await readFile(path.join(directory, "word/document.xml")));
  const root = document.documentElement!;
  if (!word(root, "document")) fail("corrupt", "Invalid Word document element");
  const bodies: Element[] = [];
  for (let child = root.firstChild; child; child = child.nextSibling) if (word(child, "body")) bodies.push(child);
  if (bodies.length !== 1) fail("corrupt", "DOCX must contain exactly one body");
  return { directory, document, body: bodies[0]! };
}
function paragraphs(body: Element): DocumentText {
  const sections: TextSection[] = [];
  const budget = new TextBudget();
  // Only the main story (including tables). Never evaluate fields, follow links or import altChunk.
  function visit(node: Node, current?: TextSection): void {
    if (word(node, "del") || word(node, "moveFrom") || word(node, "txbxContent") || word(node, "object")) return;
    if (word(node, "p")) {
      current = { kind: "paragraph", number: sections.length + 1, text: "" };
      budget.add(`[[Paragraph ${current.number}]]\n\n`);
      sections.push(current);
    }
    if (current && word(node, "t")) { current.text += budget.add(node.textContent ?? ""); return; }
    if (current && (word(node, "tab") || word(node, "br") || word(node, "cr"))) {
      current.text += budget.add(word(node, "tab") ? "\t" : "\n");
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, current);
  }
  visit(body);
  return documentText(sections);
}
export async function readDocx(bytes: Uint8Array, scratchDirectory: string): Promise<DocumentText> {
  return paragraphs((await openDocx(bytes, scratchDirectory)).body);
}
export async function editDocx(bytes: Uint8Array, edit: DocumentEdit, scratchDirectory: string): Promise<Uint8Array> {
  const { document, body, directory } = await openDocx(bytes, scratchDirectory);
  if (edit.kind === "unchanged" || edit.text === "") return bytes;
  checkPlainText(edit.text);
  const qualified = (local: string) => `${body.prefix ? `${body.prefix}:` : ""}${local}`;
  const element = (local: string) => document.createElementNS(body.namespaceURI, qualified(local));
  const paragraph = element("p");
  const run = element("r");
  paragraph.appendChild(run);
  for (const piece of edit.text.split(/(\r\n|\r|\n|\t)/)) {
    if (!piece) continue;
    if (/^[\r\n]+$/.test(piece)) run.appendChild(element("br"));
    else if (piece === "\t") run.appendChild(element("tab"));
    else {
      const text = element("t");
      text.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve");
      text.appendChild(document.createTextNode(piece));
      run.appendChild(text);
    }
  }
  let sectionProperties: Element | null = null;
  for (let child = body.firstChild; child; child = child.nextSibling) {
    if (word(child, "sectPr")) {
      if (sectionProperties) fail("corrupt", "DOCX body has duplicate section properties");
      sectionProperties = child;
    } else if (sectionProperties && child.nodeType === 1) fail("corrupt", "DOCX section properties must be last");
  }
  body.insertBefore(paragraph, sectionProperties);
  const changedXml = Buffer.from(new XMLSerializer().serializeToString(document), "utf8");
  xml(changedXml); // Re-parse before publication, and apply the output XML bound.
  await writeFile(path.join(directory, "word/document.xml"), changedXml);
  try { return checkOutput(await repackZip(directory)); }
  catch (error) { return archiveFailure(error, Buffer.from(bytes)); }
}
