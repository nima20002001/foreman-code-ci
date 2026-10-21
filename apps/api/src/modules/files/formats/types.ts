import type { FileMediaType } from "@foreman-code/contracts/files";

/** Internal byte-helper API, not a transport contract or authorization boundary. */
export type DocumentFormat = "pdf" | "docx" | "markdown";
export interface DocumentInput { format: DocumentFormat; bytes: Uint8Array }
export type DocumentEdit = { kind: "unchanged" } | { kind: "append_text"; text: string };
export type FailureStatus = "encrypted" | "corrupt" | "too_large" | "timeout"
  | "unsupported" | "unavailable" | "busy";
export interface FormatFailure { status: FailureStatus; reason: string }
export interface TextSection { kind: "page" | "paragraph" | "document"; number: number; text: string }
export interface DocumentText {
  status: "ready" | "empty";
  /** Markers are presentation hints, never trusted instructions or document text. */
  text: string;
  sections: TextSection[];
}
export type ReadDocumentResult = DocumentText | FormatFailure;
export type EditDocumentResult = {
  status: "ready"; changed: boolean; bytes: Uint8Array; mediaType: FileMediaType;
} | FormatFailure;
export interface FormatOptions {
  /** Trusted, existing, private server-owned scratch root. Required for DOCX, never a tool input. */
  scratchRoot?: string;
}
export interface FormatJob {
  input: DocumentInput;
  edit?: DocumentEdit;
  /** Private child directory created and reclaimed by the supervising parent. */
  scratchDirectory?: string;
}
export type JobResult = ReadDocumentResult | EditDocumentResult;
