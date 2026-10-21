import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { GraphIdSchema } from '@foreman-code/contracts/wave25'
import { RunInputSchema } from '@foreman-code/contracts'
import type { RepeatNodeRef, RepeatNodeInput, RepeatScope } from '../runs/repeatResolution.js'

export const WorkflowJobPreparationSchema=z.object({executionId:z.uuid(),attemptId:z.uuid(),operationId:z.uuid(),
  workspaceId:GraphIdSchema,workflowId:GraphIdSchema,workflowVersionId:GraphIdSchema,runId:GraphIdSchema,nodeId:GraphIdSchema,
  inputDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),input:RunInputSchema,
}).strict()
export type WorkflowJobPreparation=z.infer<typeof WorkflowJobPreparationSchema>
/** Slot-bound preparation identity is bookkeeping on the existing Run graph, not a dispatch or launch authority. */
export function makeWorkflowJobPreparation(scope:RepeatScope,ref:RepeatNodeRef,input:RepeatNodeInput,digest:string):WorkflowJobPreparation {
  return WorkflowJobPreparationSchema.parse({workspaceId:scope.workspaceId,workflowId:scope.workflowId,workflowVersionId:scope.workflowVersionId,runId:scope.runId,executionId:randomUUID(),attemptId:randomUUID(),operationId:randomUUID(),nodeId:ref.nodeId,inputDigest:digest,input})
}
