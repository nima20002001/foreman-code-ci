import { z } from "zod";

/** Persisted facts retain the provider that originally produced them. */
export const RecordedAgentHarnessSchema = z.enum(["codex", "opencode", "claude"]);
export type RecordedAgentHarness = z.infer<typeof RecordedAgentHarnessSchema>;
