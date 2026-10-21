import {
  REPEAT_CONTRACT_VERSION,
  RepeatBlockV1Schema,
  RepeatPlanV1Schema,
  CurrentWorkflowDefinitionBaseSchema,
  canonicalGraphJson,
  type RepeatBlockV1,
  type RepeatPlanV1,
  type WorkflowDefinitionV3,
} from '@foreman-code/contracts/wave25'

export type RepeatLocalBlockDraft = {
  id: string
  nodeIds: string[]
  entryNodeId: string
  exitNodeId: string
  maxOccurrences: number
  repeatOutcome: string
  earlyExitOutcome: string
}

export type RepeatLocalDraft = {
  contractVersion: typeof REPEAT_CONTRACT_VERSION
  blocks: RepeatLocalBlockDraft[]
}

export type RepeatValidationIssue = {
  code: string
  message: string
  blockId?: string
}

export const emptyRepeatDraft = (): RepeatLocalDraft => ({ contractVersion: REPEAT_CONTRACT_VERSION, blocks: [] })

export function localDraftFromPlan(plan: RepeatPlanV1 | null | undefined): RepeatLocalDraft {
  return plan ? {
    contractVersion: REPEAT_CONTRACT_VERSION,
    blocks: plan.blocks.map((block) => ({
      id: block.id, nodeIds: [...block.nodeIds], entryNodeId: block.entryNodeId, exitNodeId: block.exitNodeId,
      maxOccurrences: block.maxOccurrences, repeatOutcome: block.repeatOutcome, earlyExitOutcome: block.earlyExitOutcome,
    })),
  } : emptyRepeatDraft()
}

function exitTargets(graph: WorkflowDefinitionV3, block: RepeatLocalBlockDraft) {
  const choice = graph.nodes.find((node) => node.id === block.exitNodeId)?.choice
  const repeat = choice?.outcomes.find((item) => item.outcome === block.repeatOutcome)
  return { choice, repeat }
}

/** Build the shared contract shape. The backend remains authoritative for full candidate-version validation. */
export function repeatPlanFromLocalDraft(draft: RepeatLocalDraft, graph: WorkflowDefinitionV3): RepeatPlanV1 | null {
  const blocks: RepeatBlockV1[] = []
  for (const block of draft.blocks) {
    const { repeat } = exitTargets(graph, block)
    if (!repeat) return null
    const parsed = RepeatBlockV1Schema.safeParse({ ...block, limitExit: repeat.target })
    if (!parsed.success) return null
    blocks.push(parsed.data)
  }
  const parsed = RepeatPlanV1Schema.safeParse({ contractVersion: REPEAT_CONTRACT_VERSION, blocks })
  return parsed.success ? parsed.data : null
}

/**
 * UI preflight only. It mirrors the frozen A0 shape rules so users get immediate explanations,
 * but save/admission must still run RepeatWorkflowVersionV1Schema and authenticated domain checks.
 */
export function validateRepeatDraft(draft: RepeatLocalDraft, graphValue: WorkflowDefinitionV3): RepeatValidationIssue[] {
  const issues: RepeatValidationIssue[] = []
  const { repeat: _repeat, ...ordinary } = graphValue
  void _repeat
  const graph = CurrentWorkflowDefinitionBaseSchema.safeParse(ordinary)
  if (!graph.success) {
    issues.push({ code: 'REPEAT_GRAPH_UNSUPPORTED', message: 'Repeats require the existing acyclic workflow graph. Back-edges and arbitrary cycles stay unsupported.' })
    return issues
  }
  if (!draft.blocks.length) return issues
  const seenIds = new Set<string>(), seenMembers = new Set<string>()
  const nodes = new Map(graph.data.nodes.map((node) => [node.id, node]))
  const execution = graph.data.edges.filter((edge) => edge.kind === 'execution')
  let requiredExecutions = graph.data.nodes.length

  for (const block of draft.blocks) {
    const fail = (code: string, message: string) => issues.push({ code, message, blockId: block.id || undefined })
    if (!block.id.trim()) fail('REPEAT_ID_REQUIRED', 'Give this repeat a stable name.')
    if (seenIds.has(block.id)) fail('REPEAT_DUPLICATE_BLOCK', 'Repeat names must be unique.')
    seenIds.add(block.id)
    if (!Number.isInteger(block.maxOccurrences) || block.maxOccurrences < 1 || block.maxOccurrences > 2147483647) {
      fail('REPEAT_CAP_INVALID', 'Maximum occurrences must be a whole number of at least 1.')
    }
    if (!block.nodeIds.length) fail('REPEAT_SCOPE_REQUIRED', 'Choose at least one node for the repeat scope.')
    if (new Set(block.nodeIds).size !== block.nodeIds.length) fail('REPEAT_DUPLICATE_MEMBER', 'A node can appear only once in a repeat scope.')
    for (const nodeId of block.nodeIds) {
      if (!nodes.has(nodeId)) fail('REPEAT_UNKNOWN_MEMBER', 'The repeat scope contains a node that is no longer in this workflow.')
      if (seenMembers.has(nodeId)) fail('REPEAT_OVERLAP_OR_NESTING_UNSUPPORTED', 'Repeat scopes cannot overlap or nest in this version.')
      seenMembers.add(nodeId)
    }
    if (!block.nodeIds.includes(block.entryNodeId) || !block.nodeIds.includes(block.exitNodeId)) {
      fail('REPEAT_BOUNDARY_NOT_IN_SCOPE', 'Entry and exit must both be inside the repeat scope.')
    }
    if (block.repeatOutcome === block.earlyExitOutcome) fail('REPEAT_OUTCOMES_MUST_DIFFER', 'Repeat and early-exit outcomes must be different.')

    const members = new Set(block.nodeIds)
    const internal = execution.filter((edge) => members.has(edge.source) && members.has(edge.target))
    const reachable = (start: string, backwards = false) => {
      const seen = new Set<string>(), queue = [start]
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index]!
        if (seen.has(id)) continue
        seen.add(id)
        for (const edge of internal) {
          if ((backwards ? edge.target : edge.source) === id) queue.push(backwards ? edge.source : edge.target)
        }
      }
      return seen
    }
    if (nodes.has(block.entryNodeId) && nodes.has(block.exitNodeId)) {
      const fromEntry = reachable(block.entryNodeId), toExit = reachable(block.exitNodeId, true)
      if (block.nodeIds.some((id) => !fromEntry.has(id) || !toExit.has(id))) {
        fail('REPEAT_SCOPE_MUST_BE_SINGLE_ENTRY_EXIT', 'Every scoped node must be reachable from the entry and able to reach the exit.')
      }
    }
    for (const edge of execution) {
      if (!members.has(edge.source) && members.has(edge.target) && edge.target !== block.entryNodeId) fail('REPEAT_SIDE_ENTRY_UNSUPPORTED', 'Execution edges may enter a repeat only through its entry.')
      if (members.has(edge.source) && !members.has(edge.target) && edge.source !== block.exitNodeId) fail('REPEAT_SIDE_EXIT_UNSUPPORTED', 'Execution edges may leave a repeat only from its exit.')
      if (edge.source === block.exitNodeId && members.has(edge.target)) fail('REPEAT_EXIT_REENTERS_SCOPE', 'The repeat exit cannot route back into its own scope.')
    }

    const exit = nodes.get(block.exitNodeId)
    const choice = exit?.choice
    const again = choice?.outcomes.find((item) => item.outcome === block.repeatOutcome)
    const early = choice?.outcomes.find((item) => item.outcome === block.earlyExitOutcome)
    if (!again || !early || choice?.outcomes.length !== 2) {
      fail('REPEAT_EXIT_REQUIRES_EXACTLY_TWO_DECLARED_OUTCOMES', 'The exit must have exactly two named outcomes: repeat and early exit.')
    }
    for (const nodeId of block.nodeIds) {
      if (nodeId !== block.exitNodeId && nodes.get(nodeId)?.choice?.outcomes.some((item) => item.target.kind === 'branch_end')) {
        fail('REPEAT_INTERIOR_BRANCH_END_UNSUPPORTED', 'An interior choice cannot end its branch before the repeat exit in this version.')
      }
    }
    if (Number.isInteger(block.maxOccurrences) && block.maxOccurrences >= 1) {
      requiredExecutions += (block.maxOccurrences - 1) * block.nodeIds.length
    }
  }

  if (!Number.isSafeInteger(requiredExecutions) || (graph.data.executionPolicy?.maxNodeExecutions ?? 0) < requiredExecutions) {
    issues.push({ code: 'REPEAT_EXECUTION_BUDGET_INSUFFICIENT', message: `Execution policy must allow at least ${requiredExecutions} node executions for this repeat plan.` })
  }
  if (!repeatPlanFromLocalDraft(draft, graphValue) && !issues.length) {
    issues.push({ code: 'REPEAT_PLAN_INVALID', message: 'The repeat definition is incomplete or unsupported by contract v1.' })
  }
  return issues
}

export function repeatDraftEqual(left: RepeatLocalDraft, right: RepeatLocalDraft): boolean {
  return canonicalGraphJson(left) === canonicalGraphJson(right)
}

export function blockOutcomeOptions(graph: WorkflowDefinitionV3, exitNodeId: string) {
  return graph.nodes.find((node) => node.id === exitNodeId)?.choice?.outcomes.map((item) => item.outcome) ?? []
}

export function targetLabel(target: RepeatBlockV1['limitExit'] | undefined): string {
  if (!target) return 'Choose a valid repeat outcome to see the limit route.'
  return target.kind === 'branch_end' ? 'End this branch' : `Continue through ${target.relationshipId}`
}
