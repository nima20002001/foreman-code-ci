import { z } from "zod";

/** A non-empty identifier. IDs are intentionally unbranded at the API boundary. */
export const IdSchema = z.string().trim().min(1);
export type Id = z.infer<typeof IdSchema>;

export const TimestampSchema = z.string().datetime({ offset: true });
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Bounded identities shared by current persisted execution contracts. */
export const GraphIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);

export const RunInputSchema = z.record(z.string(), z.json())
export type RunInput = z.infer<typeof RunInputSchema>

export const OptionalTimestampFields = {
  createdAt: TimestampSchema.optional(),
  updatedAt: TimestampSchema.optional(),
} as const;
