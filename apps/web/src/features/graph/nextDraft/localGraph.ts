import { z } from 'zod'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import { WorkflowDefinitionV3Schema, WorkflowExecutionPolicySchema,
  CurrentAgentWorkflowNodeSchema, RepeatBlockV1Schema } from '@foreman-code/contracts/wave25'

// Form snapshots are not executable definitions. They may contain an unfinished
// selection, partial outcome text or an invalid numeric field. Strict shared V3
// validation still runs before Stage/Save and at every HTTP boundary.
// JSON represents the UI's NaN (blank number field) as null; restore it as NaN,
// never as a valid default limit or a synthetic repeat configuration.
const FormNumber = z.union([z.number().finite(), z.nan(), z.null()]).transform((value) => value ?? Number.NaN)
const FormTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('branch_end') }).strict(),
  z.object({ kind: z.literal('edge'), relationshipId: z.string() }).strict(),
])
const FormChoice = z.object({ outcomes: z.array(z.object({
  outcome: z.string(), target: FormTarget,
}).strict()).max(16) }).strict().optional()
const FormNode = z.union([CurrentAgentWorkflowNodeSchema.safeExtend({choice:FormChoice}), z.object({...JobWorkflowNodeSchema.shape,choice:FormChoice}).strict()])
const FormBlock = z.object({ ...RepeatBlockV1Schema.shape,
  id: z.string(), nodeIds: z.array(z.string()), entryNodeId: z.string(), exitNodeId: z.string(),
  maxOccurrences: FormNumber, repeatOutcome: z.string(), earlyExitOutcome: z.string(), limitExit: FormTarget,
}).strict()
export const LocalWorkflowFormSchema = z.object({ ...WorkflowDefinitionV3Schema.shape,
  nodes: z.array(FormNode), entryNodeId: z.string().nullable(),
  executionPolicy: WorkflowExecutionPolicySchema.extend({ maxParallelism: FormNumber,
    maxNodeExecutions: FormNumber, agentActiveTimeoutMs: FormNumber.optional() }).optional(),
  requiredAgentCount: FormNumber.optional(),
  repeat: z.object({ contractVersion: z.literal(1), blocks: z.array(FormBlock).min(1) }).strict().optional(),
}).strict()
