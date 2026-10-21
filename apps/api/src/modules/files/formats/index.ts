import { lstat, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { checkPlainText, fail, failure, FORMAT_LIMITS, isDocumentFormat } from "./policy.js";
import { runIsolated } from "./supervisor.js";
import type { DocumentEdit, DocumentInput, EditDocumentResult, FormatJob, FormatOptions, JobResult, ReadDocumentResult } from "./types.js";

export { DOCUMENT_MEDIA_TYPES, FORMAT_LIMITS } from "./policy.js";
export type { DocumentEdit, DocumentFormat, DocumentInput, DocumentText, EditDocumentResult, FailureStatus,
  FormatFailure, FormatOptions, ReadDocumentResult, TextSection } from "./types.js";

let active = 0;
async function privateScratch(root: string | undefined): Promise<string> {
  if (!root || !path.isAbsolute(root)) fail("unavailable", "DOCX requires an absolute private scratch root");
  const resolved = path.resolve(root);
  let current = path.parse(resolved).root;
  for (const component of ["", ...resolved.slice(current.length).split(path.sep).filter(Boolean)]) {
    current = path.join(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("unavailable", "Scratch root contains a link or non-directory");
  }
  const stats = await lstat(resolved);
  if ((stats.mode & 0o077) !== 0 || (process.getuid && stats.uid !== process.getuid())) {
    fail("unavailable", "Scratch root must be private and owned by the API account");
  }
  return mkdtemp(path.join(resolved, "fil06-"));
}
async function operate(input: DocumentInput, edit: DocumentEdit | undefined, options: FormatOptions): Promise<JobResult> {
  if (!input || !isDocumentFormat(input.format)) return { status: "unsupported", reason: "Unsupported document format" };
  if (!(input.bytes instanceof Uint8Array)) return { status: "corrupt", reason: "Expected document bytes, not a path or URL" };
  if (input.bytes.byteLength > FORMAT_LIMITS.inputBytes) return { status: "too_large", reason: "Input exceeds the file byte limit" };
  if (edit) {
    if (edit.kind !== "unchanged" && edit.kind !== "append_text") return { status: "unsupported", reason: "Unsupported document edit" };
    if (edit.kind === "append_text") {
      if (typeof edit.text !== "string") return { status: "corrupt", reason: "Expected append text" };
      if (edit.text.length > FORMAT_LIMITS.editTextBytes || Buffer.byteLength(edit.text) > FORMAT_LIMITS.editTextBytes) {
        return { status: "too_large", reason: "Append text exceeds the helper limit" };
      }
      try { checkPlainText(edit.text); } catch (error) { return failure(error); }
    }
  }
  if (active >= FORMAT_LIMITS.concurrentJobs) return { status: "busy", reason: "Format helper is at capacity; retry later" };
  active++;
  let scratchDirectory: string | undefined;
  let result: JobResult;
  try {
    // Snapshot before the first await. Caller mutations cannot move/change a running job's bytes or edit.
    const job: FormatJob = { input: { format: input.format, bytes: new Uint8Array(input.bytes) } };
    if (edit) job.edit = edit.kind === "unchanged" ? { kind: "unchanged" } : { kind: "append_text", text: edit.text };
    if (job.input.format === "docx") {
      scratchDirectory = await privateScratch(options.scratchRoot);
      job.scratchDirectory = scratchDirectory;
    }
    result = await runIsolated(job);
  } catch (error) {
    const parsed = failure(error);
    result = parsed.status === "corrupt" ? { status: "unavailable", reason: "Format isolation or scratch setup failed" } : parsed;
  } finally {
    // SIGKILL is awaited by the supervisor, so no child can write after cleanup starts.
    try { if (scratchDirectory) await rm(scratchDirectory, { recursive: true, force: true }); }
    catch { result = { status: "unavailable", reason: "Private format workspace cleanup failed" }; }
    active--;
  }
  return result!;
}
export async function readDocument(input: DocumentInput, options: FormatOptions = {}): Promise<ReadDocumentResult> {
  const result = await operate(input, undefined, options);
  if ("bytes" in result) return { status: "unavailable", reason: "Unexpected format worker response" };
  return result;
}
export async function editDocument(input: DocumentInput, edit: DocumentEdit, options: FormatOptions = {}): Promise<EditDocumentResult> {
  const result = await operate(input, edit, options);
  if ("sections" in result) return { status: "unavailable", reason: "Unexpected format worker response" };
  return result;
}
