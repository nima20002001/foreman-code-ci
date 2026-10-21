import { z } from 'zod'
import { ChoiceOutcomeSchema, WorkflowChoiceSchema, ExecutionResultSchema, type WorkflowChoice } from '../index.js'
import { parseWorkflowArtifactResult, type WorkflowArtifactOutputsV1 } from '../workflowArtifactResult.js'
import { canonicalGraphJson } from './json.js'
export { ChoiceOutcomeSchema, ChoiceTargetSchema } from '../index.js'
export type { WorkflowChoice } from '../index.js'

/** Complete named result envelopes. This parsing rule is independent of any
 * retired execution version; it neither retags nor mutates the accepted result. */
export const CurrentChoiceResultEnvelopeSchema = z.object({
  routing: z.object({ outcome: ChoiceOutcomeSchema }).strict(), data: z.json(),
}).strict().superRefine((value, context) => {
  try { canonicalGraphJson(value, 64 * 1024) } catch { context.addIssue({ code: 'custom', message: 'accepted result envelope exceeds bounded JSON limits' }) }
})
export type CurrentChoiceResultEnvelope = z.infer<typeof CurrentChoiceResultEnvelopeSchema>
export function parseChoiceResultEnvelope(result: unknown, choice: WorkflowChoice, artifactOutputs?: WorkflowArtifactOutputsV1) {
  if (artifactOutputs) return parseWorkflowArtifactResult(result, artifactOutputs, choice)
  canonicalGraphJson(result, 128 * 1024)
  const accepted = ExecutionResultSchema.parse(result)
  if (accepted.outcome !== 'succeeded') throw new Error('CHOICE_RESULT_NOT_SUCCESSFUL')
  let output: unknown = accepted.output
  if (typeof output === 'string') {
    if (new TextEncoder().encode(output).byteLength > 64 * 1024) throw new Error('CHOICE_RESULT_TOO_LARGE')
    output = JSON.parse(output)
  }
  canonicalGraphJson(output, 64 * 1024)
  const envelope = CurrentChoiceResultEnvelopeSchema.parse(output)
  const declaration = WorkflowChoiceSchema.parse(choice)
  if (!declaration.outcomes.some((item) => item.outcome === envelope.routing.outcome)) throw new Error('CHOICE_OUTCOME_UNDECLARED')
  return envelope
}
