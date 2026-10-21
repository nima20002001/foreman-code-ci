import { z } from "zod";
import { IdSchema, TimestampSchema } from "./schemaPrimitives.js";

export const HarnessModelOptionSchema = z.object({
  id: IdSchema, providerId: IdSchema.optional(), name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  reasoningEfforts: z.array(z.string()), variants: z.array(z.string()), serviceTiers: z.array(z.string()),
  /** Native catalog provenance, used only when initializing an unset selection. */
  releasedAt: z.string().optional(), defaultPriority: z.number().finite().optional(),
}).strict();
export const HarnessOptionsResultSchema = z.object({
  harness: z.enum(["codex", "claude"]), providerVersion: z.string().min(1),
  authenticated: z.boolean(), models: z.array(HarnessModelOptionSchema), nativeAgents: z.array(z.string()),
  settings: z.array(z.object({
    field: z.string(), support: z.enum(["supported", "conditional", "metadata_only", "unsupported"]),
    detail: z.string(),
  }).strict()),
  restrictions: z.array(z.string()), checkedAt: TimestampSchema,
}).strict();
