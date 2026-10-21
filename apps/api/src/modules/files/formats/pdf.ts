import { checkOutput, documentText, fail, FORMAT_LIMITS, TextBudget } from "./policy.js";
import type { DocumentEdit, DocumentText, TextSection } from "./types.js";
import { ignoreError } from '../../diagnostics/ignoredError.js'

function envelope(bytes: Uint8Array): void {
  const header = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString("latin1");
  const eof = tail.lastIndexOf("%%EOF");
  if (!/^%PDF-(?:1\.[0-7]|2\.0)\b/.test(header) || eof < 0
    || [...tail.slice(eof + 5)].some((char) => !"\0\t\n\f\r ".includes(char))) {
    fail("corrupt", "PDF is missing its header or final EOF marker");
  }
}
export async function readPdf(bytes: Uint8Array): Promise<DocumentText> {
  envelope(bytes);
  // The pinned unpdf build inlines PDF.js; no canvas, browser, remote worker or rendering API.
  const { getResolvedPDFJS } = await import("unpdf");
  const { getDocument } = await getResolvedPDFJS();
  let externalRequested = false;
  class DisabledDataFactory {
    async fetch(): Promise<never> {
      externalRequested = true;
      throw new Error("External PDF resources are disabled");
    }
  }
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useWasm: false,
    useWorkerFetch: false,
    // Text-only fallback metrics for the standard fonts; no rendering or host font access.
    useSystemFonts: true,
    disableFontFace: true,
    disableAutoFetch: true,
    disableStream: true,
    disableRange: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    enableXfa: false,
    maxImageSize: 0,
    stopAtErrors: true,
    verbosity: 0,
    CMapReaderFactory: DisabledDataFactory,
    StandardFontDataFactory: DisabledDataFactory,
    WasmFactory: DisabledDataFactory,
  });
  try {
    const pdf = await task.promise;
    // Password-less opening does not imply unencrypted: owner-protected PDFs may use an empty user password.
    if (await pdf.getPermissions() !== null) fail("encrypted", "Encrypted PDFs are not supported");
    if (pdf.numPages < 1) fail("corrupt", "PDF has no pages");
    if (pdf.numPages > FORMAT_LIMITS.pdfPages) fail("too_large", "PDF exceeds the page limit");
    const budget = new TextBudget();
    const sections: TextSection[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const reader = page.streamTextContent({ includeMarkedContent: false }).getReader();
      let text = "";
      let complete = false;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) { complete = true; break; }
          for (const item of chunk.value.items) {
            if (!("str" in item)) continue;
            text += budget.add(`${item.str}${item.hasEOL ? "\n" : " "}`);
          }
        }
      } finally {
        if (!complete) await reader.cancel(new Error("PDF text extraction stopped")).catch(ignoreError('lifecycle', 'cancel PDF reader'));
        reader.releaseLock();
        page.cleanup();
      }
      sections.push({ kind: "page", number, text: text.trimEnd() });
    }
    // Do not turn a missing CMap/font resource into a misleading empty/partial extraction.
    if (externalRequested) fail("unsupported", "PDF text requires an unavailable font or character map");
    return documentText(sections);
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") fail("encrypted", "Encrypted PDFs are not supported");
    if (externalRequested) fail("unsupported", "PDF text requires an unavailable font or character map");
    throw error;
  } finally {
    // Parent owns process teardown too; an internal destroy error must not hide the actual parse state.
    await task.destroy().catch(ignoreError('lifecycle', 'task.destroy', { module: 'files/formats/pdf' }));
  }
}
export async function editPdf(bytes: Uint8Array, edit: DocumentEdit): Promise<Uint8Array> {
  const original = await readPdf(bytes);
  if (edit.kind === "unchanged" || edit.text === "") return bytes;
  if (original.sections.length >= FORMAT_LIMITS.pdfPages) fail("too_large", "Appending would exceed the PDF page limit");
  // Deliberately small edit surface: one Courier page. Reject unsupported characters, never replace them.
  if (/[^\x20-\x7e\t\r\n]/.test(edit.text)) fail("unsupported", "PDF append supports printable ASCII, tabs and line breaks only");
  const lines = edit.text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  if (lines.length > 48 || lines.some((line) => line.length > 76)) fail("too_large", "Appended PDF page exceeds 48 lines or 76 columns");
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  let document;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
  } catch (error) {
    if (error instanceof Error && /encrypted/i.test(error.message)) fail("encrypted", "Encrypted PDFs are not supported");
    throw error;
  }
  const font = await document.embedFont(StandardFonts.Courier);
  const page = document.addPage([612, 792]);
  lines.forEach((line, index) => page.drawText(line, { font, size: 11, x: 48, y: 744 - index * 14 }));
  const output = checkOutput(await document.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false }));
  await readPdf(output); // A changed file must pass the same reader and limits as its input.
  return output;
}
