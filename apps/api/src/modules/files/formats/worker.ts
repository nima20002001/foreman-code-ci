import { DOCUMENT_MEDIA_TYPES, failure } from "./policy.js";
import type { FormatJob, JobResult } from "./types.js";

/** Child entrypoint, not an importable service. Receives bytes only after the parent validates its request. */
async function perform(job: FormatJob): Promise<JobResult> {
  const { input, edit } = job;
  let result: JobResult | Uint8Array;
  if (input.format === "markdown") {
    const { readMarkdown, editMarkdown } = await import("./markdown.js");
    result = edit ? editMarkdown(input.bytes, edit) : readMarkdown(input.bytes);
  } else if (input.format === "pdf") {
    const { readPdf, editPdf } = await import("./pdf.js");
    result = edit ? await editPdf(input.bytes, edit) : await readPdf(input.bytes);
  } else {
    if (!job.scratchDirectory) return { status: "unavailable", reason: "DOCX requires a private scratch directory" };
    const { readDocx, editDocx } = await import("./docx.js");
    result = edit ? await editDocx(input.bytes, edit, job.scratchDirectory) : await readDocx(input.bytes, job.scratchDirectory);
  }
  if (result instanceof Uint8Array) {
    return { status: "ready", changed: !Buffer.from(result).equals(Buffer.from(input.bytes)),
      bytes: result, mediaType: DOCUMENT_MEDIA_TYPES[input.format] };
  }
  return result;
}
if (process.send) {
  process.once("message", (job: FormatJob) => {
    void perform(job).catch(failure).then((result) => {
      process.send!(result, (error: Error | null) => { process.exit(error ? 1 : 0); });
    });
  });
}
