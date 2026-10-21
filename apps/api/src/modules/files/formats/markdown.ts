import { checkOutput, checkPlainText, documentText, utf8 } from "./policy.js";
import type { DocumentEdit, DocumentText } from "./types.js";

export function readMarkdown(bytes: Uint8Array): DocumentText {
  const text = utf8(bytes);
  checkPlainText(text);
  return documentText([{ kind: "document", number: 1, text }]);
}
export function editMarkdown(bytes: Uint8Array, edit: DocumentEdit): Uint8Array {
  const text = utf8(bytes);
  checkPlainText(text);
  if (edit.kind === "unchanged" || edit.text === "") return bytes;
  checkPlainText(edit.text);
  // Append exactly the supplied UTF-8 text; never normalize the existing BOM or CRLFs.
  return checkOutput(Buffer.concat([bytes, Buffer.from(edit.text, "utf8")]));
}
