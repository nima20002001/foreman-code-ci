import { coordinationBusinessOutput, type CoordinationResultContext } from './coordinationResult.js'
import { z } from 'zod'
import { ExecutionResultSchema } from './index.js'
import { ChoiceOutcomeSchema, WorkflowChoiceSchema, type WorkflowChoice } from './wave25/choice.js'
import { canonicalGraphJson } from './wave25/json.js'
import { WorkflowArtifactOutputsV1Schema, WorkflowArtifactResultV1Schema, type WorkflowArtifactOutputsV1 } from './workflowArtifactDeclarations.js'
export * from './workflowArtifactDeclarations.js'

export const WorkflowArtifactResultEnvelopeV1Schema = z.object({
  data: z.json(), artifactOutputs: WorkflowArtifactResultV1Schema,
}).strict()
type WorkflowArtifactResultEnvelopeV1 = z.infer<typeof WorkflowArtifactResultEnvelopeV1Schema>
export const WorkflowChoiceArtifactResultEnvelopeV1Schema = WorkflowArtifactResultEnvelopeV1Schema.extend({
  routing: z.object({ outcome: ChoiceOutcomeSchema }).strict(),
}).strict()
type WorkflowChoiceArtifactResultEnvelopeV1 = z.infer<typeof WorkflowChoiceArtifactResultEnvelopeV1Schema>

export function parseWorkflowArtifactResult(result: unknown, declaration: WorkflowArtifactOutputsV1,
  choice: WorkflowChoice, context?: CoordinationResultContext): WorkflowChoiceArtifactResultEnvelopeV1
export function parseWorkflowArtifactResult(result: unknown, declaration: WorkflowArtifactOutputsV1, choice?: undefined, context?: CoordinationResultContext): WorkflowArtifactResultEnvelopeV1
export function parseWorkflowArtifactResult(result: unknown, declaration: WorkflowArtifactOutputsV1, choice?: WorkflowChoice, context?: CoordinationResultContext): WorkflowArtifactResultEnvelopeV1 | WorkflowChoiceArtifactResultEnvelopeV1
/** Parsing only. Preserve original native text, result digest and accepted input;
 * a command association is never proof of publication, bytes or authority. */
export function parseWorkflowArtifactResult(result: unknown, declaration: WorkflowArtifactOutputsV1, choice?: WorkflowChoice, context?: CoordinationResultContext) {
  canonicalGraphJson(result, 64 * 1024)
  const accepted = ExecutionResultSchema.parse(result)
  if (accepted.outcome !== 'succeeded') throw new Error('WORKFLOW_ARTIFACT_RESULT_NOT_SUCCESSFUL')
  const output = accepted.output
  if (!output || typeof output !== 'object' || Array.isArray(output) || Object.keys(output).length !== 1
    || !('text' in output) || typeof output.text !== 'string') throw new Error('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED')
  const parsed: unknown = context ? coordinationBusinessOutput(output, context) : JSON.parse(output.text)
  canonicalGraphJson(parsed, 64 * 1024)
  const choiceEnvelope = choice ? WorkflowChoiceArtifactResultEnvelopeV1Schema.parse(parsed) : undefined
  const envelope = choiceEnvelope ?? WorkflowArtifactResultEnvelopeV1Schema.parse(parsed)
  const saved = WorkflowArtifactOutputsV1Schema.parse(declaration)
  const keys = new Set(envelope.artifactOutputs.outputs.map(item => item.outputKey))
  if (keys.size !== saved.outputKeys.length || saved.outputKeys.some(key => !keys.has(key))) throw new Error('WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH')
  if (choice && choiceEnvelope && !WorkflowChoiceSchema.parse(choice).outcomes.some(item => item.outcome === choiceEnvelope.routing.outcome)) {
    throw new Error('CHOICE_OUTCOME_UNDECLARED')
  }
  return envelope
}
