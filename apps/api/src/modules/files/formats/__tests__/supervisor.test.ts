import assert from "node:assert/strict";
import { describe, it, vi } from "vitest";
import { readDocument } from "../index.js";
import { runIsolated } from "../supervisor.js";

const job = { input: { format: "markdown", bytes: Buffer.from("fixture") } } as const;
vi.setConfig({ testTimeout: 60_000 });
describe("parent-owned format isolation", () => {
  it("terminates an event-loop-blocked parser", async () => {
    const started = performance.now();
    const result = await runIsolated(job, { entrypoint: new URL("./workers/blocked.mjs", import.meta.url), operationMs: 250 });
    assert.equal(result.status, "timeout"); assert.ok(performance.now() - started < 15_000);
  });
  it("does not publish a success while the worker is still alive", async () => {
    const result = await runIsolated(job, { entrypoint: new URL("./workers/message-without-exit.mjs", import.meta.url), operationMs: 300 });
    assert.equal(result.status, "timeout");
  });
  it("reports a child hitting its V8 heap limit as too_large", async () => {
    const result = await runIsolated(job, { entrypoint: new URL("./workers/heap-exhaustion.mjs", import.meta.url) });
    assert.equal(result.status, "too_large");
  });
  it("does not inherit application secrets or arbitrary NODE_OPTIONS", async () => {
    const previous = process.env.FIL06_TEST_SECRET, previousOptions = process.env.NODE_OPTIONS;
    process.env.FIL06_TEST_SECRET = "PRIVATE"; process.env.NODE_OPTIONS = "--this-option-must-not-reach-child";
    try {
      const result = await runIsolated(job, { entrypoint: new URL("./workers/environment.mjs", import.meta.url) });
      assert.ok("text" in result); assert.equal(result.text, "absent:absent");
    } finally {
      if (previous === undefined) delete process.env.FIL06_TEST_SECRET; else process.env.FIL06_TEST_SECRET = previous;
      if (previousOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousOptions;
    }
  });
  it("reports an unavailable worker without confusing it with an empty document", async () => {
    const result = await runIsolated(job, { entrypoint: new URL("./workers/absent.mjs", import.meta.url) });
    assert.equal(result.status, "unavailable");
  });
  it("caps concurrent jobs instead of buffering an unbounded queue", async () => {
    const first = readDocument(job.input), second = readDocument(job.input), excess = readDocument(job.input);
    const [a, b, c] = await Promise.all([first, second, excess]);
    assert.equal(a.status, "ready"); assert.equal(b.status, "ready"); assert.equal(c.status, "busy");
    assert.equal((await readDocument(job.input)).status, "ready", "completed jobs release admission slots");
  });
});
