import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FORMAT_LIMITS } from "./policy.js";
import type { FormatFailure, FormatJob, JobResult } from "./types.js";

/** Internal test seam. No URL, executable, budget, or environment is accepted by the public byte API. */
export interface WorkerSettings { entrypoint?: URL; operationMs?: number }
export async function runIsolated(job: FormatJob, settings: WorkerSettings = {}): Promise<JobResult> {
  const entrypoint = settings.entrypoint ?? new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url);
  const operationMs = settings.operationMs ?? FORMAT_LIMITS.operationMs;
  return new Promise<JobResult>((resolve) => {
    let result: JobResult | undefined;
    let forced: FormatFailure | undefined;
    let closed = false;
    const child = fork(fileURLToPath(entrypoint), [], {
      execPath: process.execPath,
      execArgv: [
        `--max-old-space-size=${FORMAT_LIMITS.heapMiB}`, "--stack-size=512", "--disable-proto=throw", "--no-addons",
        ...(entrypoint.pathname.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : []),
      ],
      // Do not inherit NODE_OPTIONS/loaders, credentials, proxies, or arbitrary parent startup hooks.
      env: { NODE_ENV: "production", LANG: "C.UTF-8", TZ: "UTC" },
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    function stop(failure: FormatFailure): void {
      if (closed || forced) return;
      forced = failure;
      child.kill("SIGKILL");
    }
    const timer = setTimeout(() => stop({ status: "timeout", reason: "Format operation exceeded its deadline" }), operationMs);
    child.once("message", (message: JobResult) => { result = message; });
    child.once("error", () => stop({ status: "unavailable", reason: "Unable to start or communicate with the Node format process" }));
    child.once("close", (code, signal) => {
      closed = true;
      clearTimeout(timer);
      // Only return success after exit: the caller can now safely remove this job's scratch directory.
      resolve(forced ?? (code === 0 && result ? result : {
        status: signal === "SIGABRT" ? "too_large" : "unavailable",
        reason: signal === "SIGABRT" ? "Format process hit its memory or stack limit" : "Format process exited without a complete result",
      }));
    });
    child.send(job, (error: Error | null) => {
      if (error) stop({ status: "unavailable", reason: "Unable to send bytes to the Node format process" });
    });
  });
}
