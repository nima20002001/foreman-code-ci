import { z } from 'zod'
import { IdSchema } from '../schemaPrimitives.js'

export const ChoiceOutcomeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
export const ChoiceTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edge'), relationshipId: IdSchema }).strict(),
  z.object({ kind: z.literal('branch_end') }).strict(),
])
export const WorkflowChoiceSchema = z.object({
  outcomes: z.array(z.object({ outcome: ChoiceOutcomeSchema, target: ChoiceTargetSchema }).strict()).min(1).max(16),
}).strict().superRefine((value, context) => {
  const outcomes = new Set<string>()
  for (const [index, declaration] of value.outcomes.entries()) {
    if (outcomes.has(declaration.outcome)) context.addIssue({ code: 'custom', path: ['outcomes', index], message: 'outcomes must be unique' })
    outcomes.add(declaration.outcome)
  }
})
export type WorkflowChoice = z.infer<typeof WorkflowChoiceSchema>
