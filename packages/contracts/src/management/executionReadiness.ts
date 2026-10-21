import { z } from 'zod'

const ExecutionReadinessScopeSchema = z.enum(['saved-harness-defaults', 'operator-configuration'])
export const ExecutionReadinessInputSchema = z.object({
  harness: z.enum(['codex', 'claude']),
  scope: ExecutionReadinessScopeSchema.default('saved-harness-defaults'),
  configurationVersionId: z.string().min(1).optional(),
}).strict().refine(value => !value.configurationVersionId || value.scope === 'operator-configuration', {
  message: 'An Operator configuration pin requires Operator readiness scope.', path: ['configurationVersionId'],
})
export const ExecutionReadinessSchema = z.object({
  harness: z.enum(['codex', 'claude']),
  scope: ExecutionReadinessScopeSchema,
  configurationVersionId: z.string().min(1).optional(),
  status: z.enum(['blocked', 'unverified', 'eligible']),
  rolloutEnabled: z.boolean(),
  defaultsRevision: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().datetime(),
  reason: z.object({ code: z.string(), message: z.string() }).nullable(),
  limitation: z.string(),
}).strict()
export type ExecutionReadiness = z.infer<typeof ExecutionReadinessSchema>
