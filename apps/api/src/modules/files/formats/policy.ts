import { MAX_FILE_BYTES, MAX_FILE_READ_BYTES } from "@foreman-code/contracts/files";
import type { DocumentFormat, DocumentText, FailureStatus, FormatFailure, TextSection } from "./types.js";

export const FORMAT_LIMITS = Object.freeze({
  inputBytes: MAX_FILE_BYTES,
  outputBytes: MAX_FILE_BYTES,
  textBytes: MAX_FILE_READ_BYTES,
  editTextBytes: MAX_FILE_READ_BYTES,
  pdfPages: 128,
  textItems: 100_000,
  xmlBytes: 1024 * 1024,
  xmlNodes: 50_000,
  xmlDepth: 128,
  docxExpandedBytes: MAX_FILE_BYTES,
  operationMs: 45_000,
  heapMiB: 128,
  concurrentJobs: 2,
});
export const DOCUMENT_MEDIA_TYPES = Object.freeze({
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  markdown: "text/markdown",
} as const);
export class FormatError extends Error {
  constructor(readonly status: FailureStatus, message: string) { super(message); this.name = "FormatError"; }
}
export function fail(status: FailureStatus, message: string): never { throw new FormatError(status, message); }
export function failure(error: unknown): FormatFailure {
  if (error instanceof FormatError) return { status: error.status, reason: error.message };
  if (error instanceof Error && "code" in error && ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(String(error.code))) {
    return { status: "unavailable", reason: "A required format dependency is not installed" };
  }
  // Do not return parser errors containing document text or private host paths.
  return { status: "corrupt", reason: "The document could not be parsed" };
}
export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return value === "pdf" || value === "docx" || value === "markdown";
}
export function utf8(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail("corrupt", "The document is not valid UTF-8"); }
}
export function checkPlainText(text: string): void {
  // Match the backend's text policy: reject binary controls and isolated UTF-16 surrogates.
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      || (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff) {
      fail("corrupt", "Text contains binary controls or invalid Unicode");
    }
  }
}
/** Count UTF-8 before retaining text; never return a silently truncated success. */
export class TextBudget {
  private bytes = 0;
  private items = 0;
  add(text: string): string {
    this.bytes += Buffer.byteLength(text, "utf8");
    if (++this.items > FORMAT_LIMITS.textItems || this.bytes > FORMAT_LIMITS.textBytes) {
      fail("too_large", "Extracted text exceeds the helper limit");
    }
    return text;
  }
}
export function documentText(sections: TextSection[]): DocumentText {
  const budget = new TextBudget();
  const text = sections.map((section) => budget.add(
    `[[${section.kind === "page" ? "Page" : section.kind === "paragraph" ? "Paragraph" : "Document"} ${section.number}]]\n${section.text}\n`,
  )).join("\n");
  // Account for separators too, including documents containing many empty paragraphs.
  if (Buffer.byteLength(text) > FORMAT_LIMITS.textBytes) fail("too_large", "Marked extraction exceeds the helper limit");
  return { status: sections.some((section) => section.text.trim().length > 0) ? "ready" : "empty", text, sections };
}
export function checkOutput(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > FORMAT_LIMITS.outputBytes) fail("too_large", "Edited file exceeds the file byte limit");
  return bytes;
}
