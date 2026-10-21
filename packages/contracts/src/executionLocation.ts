import { z } from "zod";
import { IdSchema } from "./schemaPrimitives.js";

/** Runner-owned directory inherited by every workflow and Agent in a workspace. */
export const ExecutionLocationSchema = z
  .object({
    runnerId: IdSchema,
    rootPath: z.string().min(1).refine((value) => !value.includes("\0"), "rootPath cannot contain NUL"),
  })
  .strict();
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;
