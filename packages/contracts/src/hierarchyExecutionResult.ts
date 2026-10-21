import { z } from 'zod'
import { canonicalGraphJson } from './canonicalJson.js'
import { BoardResultSchema } from './memoryBoards.js'
import { WorkflowArtifactResultV1Schema } from './workflowArtifactDeclarations.js'
import { DelegateRoutingSchema, WorkHandoffDataSchema, WorkHandoffRoutingSchema, WorkflowDelegationContextSchema } from './workflowHierarchy.js'
import type { WorkflowDefinitionV3 } from './wave25/workflowShape.js'
import { checkDeliverable } from './wave25/outputContract.js'

/** Hierarchy routing is saved workflow behavior. It does not opt a Run into board-result effects. */
export const HierarchyExecutionResultSchema = z.object({
  routing: z.union([WorkHandoffRoutingSchema, DelegateRoutingSchema]), data: WorkHandoffDataSchema,
  summary: z.string().trim().min(1).max(600),
  board: BoardResultSchema.optional(), artifactOutputs: WorkflowArtifactResultV1Schema.optional(),
}).strict()
export type HierarchyExecutionResult = z.infer<typeof HierarchyExecutionResultSchema>

export function parseHierarchyExecutionResult(output: unknown, definition: WorkflowDefinitionV3,
  workflowNodeId: string, outstandingRequestIds?: readonly string[]): HierarchyExecutionResult {
  const node = definition.nodes.find(candidate => candidate.id === workflowNodeId)
  if (!definition.hierarchy || !definition.handoffs || !node || node.kind === 'job') throw new Error('HIERARCHY_AGENT_REQUIRED')
  const carrier = output !== null && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && 'text' in output && typeof output.text === 'string'
  if (node.artifactOutputs && !carrier) throw new Error('WORKFLOW_ARTIFACT_NATIVE_TEXT_REQUIRED')
  const text = carrier ? (output as { text: string }).text : output
  if (typeof text === 'string' && new TextEncoder().encode(text).byteLength > 64 * 1024) throw new Error('HIERARCHY_RESULT_TOO_LARGE')
  const raw: unknown = typeof text === 'string' ? JSON.parse(text) : text
  canonicalGraphJson(raw, 64 * 1024)
  const result = HierarchyExecutionResultSchema.parse(raw)
  const issues = checkDeliverable(result.data.latestDeliverable, node.outputSchema)
  if (issues.length) throw new Error(`${issues[0]!.code}: ${issues[0]!.message}`)
  const artifacts = node.artifactOutputs
  if (artifacts ? !result.artifactOutputs || result.artifactOutputs.outputs.length !== artifacts.outputKeys.length
    || result.artifactOutputs.outputs.some(item => !artifacts.outputKeys.includes(item.outputKey)) : result.artifactOutputs !== undefined) {
    throw new Error('WORKFLOW_ARTIFACT_OUTPUT_KEYS_MISMATCH')
  }
  if (result.routing.kind === 'delegate') {
    const routes = (node.choice?.outcomes ?? []).flatMap(choice => {
      if (choice.target.kind !== 'edge') return []
      const relationshipId = choice.target.relationshipId
      const edge = definition.edges.find(candidate => candidate.id === relationshipId
        && candidate.kind === 'execution' && candidate.source === workflowNodeId)
      return edge ? [{ outcome: choice.outcome, childNodeId: edge.target }] : []
    })
    WorkflowDelegationContextSchema.parse({ hierarchy: definition.hierarchy, parentNodeId: workflowNodeId,
      routing: result.routing, routes })
  } else if (result.routing.kind === 'request') {
    const outcome = result.routing.outcome
    if (!node.choice?.outcomes.some(choice => choice.outcome === outcome && choice.target.kind === 'edge')) throw new Error('HANDOFF_OUTCOME_UNDECLARED')
  }
  if (workflowNodeId === definition.hierarchy.masterNodeId && result.routing.kind === 'finish'
    && outstandingRequestIds?.length) throw new Error('HIERARCHY_WORK_UNRESOLVED')
  return result
}
