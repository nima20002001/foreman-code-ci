import { z } from 'zod'

export const RunWorktreeSchema = z.object({
  executionId: z.string().min(1).optional(),
  workingDirectory: z.string().min(1).max(4096).refine(path => path.startsWith('/') && !path.includes('\0')),
  branch: z.string().min(1),
  baseCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u),
  state: z.enum(['preparing', 'active', 'removed', 'retained']),
  message: z.string().optional(),
}).strict()
export type RunWorktree = z.infer<typeof RunWorktreeSchema>
