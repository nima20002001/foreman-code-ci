import { z } from 'zod'
import { FileSha256Schema, MAX_FILE_BYTES } from './files.js'

/** The worker declares bytes only. Main derives execution, root, context and authority. */
export const WorkflowArtifactTransferInputSchema = z.object({
  commandId: z.string().min(8).max(200),
  sha256: FileSha256Schema,
  byteSize: z.number().int().nonnegative().max(MAX_FILE_BYTES),
}).strict()
export type WorkflowArtifactTransferInput = z.infer<typeof WorkflowArtifactTransferInputSchema>
