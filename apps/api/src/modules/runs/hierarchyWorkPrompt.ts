import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

/** The saved hierarchy's handoff contract is independent of the result-protocol cutover. */
export function hierarchyWorkPrompt(definition: WorkflowDefinitionV3, nodeId: string): string {
  const node = definition.nodes.find(candidate => candidate.id === nodeId)
  if (!definition.hierarchy || !node || node.kind === 'job') throw new Error('HIERARCHY_AGENT_REQUIRED')
  const outcomes = node.choice?.outcomes.map(choice => choice.outcome) ?? []
  return [
    'Return one complete JSON object with routing, data, and summary, within 65536 UTF-8 bytes.',
    'data has latestDeliverable (your non-null business deliverable) and remainingFindings (an array of detailed findings).',
    'summary is a nonempty string of at most 600 characters.',
    `Saved work routes: ${JSON.stringify(outcomes)}.`,
    'Delegate to selected direct children with {"kind":"delegate","requests":[{"outcome":<saved direct-child route>,"data":<the child task>}]} in routing.',
    'Each child may be selected once. Your reserved continuation receives all selected children\'s deliverables and findings after they settle.',
    'For a single saved work handoff use {"kind":"request","outcome":<saved route>}.',
    'Answer your actual caller with {"kind":"return","requestId":<received request ID>,"outcome":"accepted" or "needs_changes"}.',
    'Only the Master may finish the workflow with {"kind":"finish"}, after every child obligation settles. Finish never starts unselected children.',
    'Master finish with remaining findings waits for explicit user direction in this same Run.',
    ...(node.artifactOutputs ? [`Also include artifactOutputs with the original publication command IDs for these keys: ${JSON.stringify(node.artifactOutputs.outputKeys)}.`] : []),
    ...(node.outputSchema ? [`latestDeliverable must satisfy this JSON Schema: ${JSON.stringify(node.outputSchema)}.`] : []),
  ].join('\n')
}
