import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema, type RepeatBlockV1 } from '@foreman-code/contracts/wave25'

export const unsupportedReviewerScopes = ['reviewer-in-block/requester-outside', 'different-blocks'] as const
export const supportedReviewerScopes = ['ordinary', 'same-block', 'reviewer-outside/requester-in-block', 'native-self-review-outside'] as const
export type ReviewerScopeCase = typeof unsupportedReviewerScopes[number] | typeof supportedReviewerScopes[number]

/** All variants obey the existing DAG/entry/repeat/configuration rules. The two
 * negatives differ only in the unsupported explicit App reviewer assignment. */
export function reviewerScopeFixture(kind: ReviewerScopeCase) {
  const f = makeCurrentWorkflowFixture(randomUUID(), 'approval')
  const definition = structuredClone(f.version.definition)
  const reviewer = definition.nodes[0]!, requester = definition.nodes[1]!
  const edge = definition.edges.find((item) => item.kind === 'execution')!
  const end = { kind: 'branch_end' as const }
  const outward = { kind: 'edge' as const, relationshipId: edge.id }
  const exitChoice = (target: typeof end | typeof outward) => ({ outcomes: [
    { outcome: 'issues', target }, { outcome: 'pass', target },
  ] })
  const block = (id: string, nodeIds: string[], exit: string, target: typeof end | typeof outward): RepeatBlockV1 => ({
    id, nodeIds, entryNodeId: nodeIds[0]!, exitNodeId: exit, maxOccurrences: 3,
    repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: target,
  })
  const blocks: RepeatBlockV1[] = []
  if (kind === 'same-block') {
    requester.choice = exitChoice(end)
    blocks.push(block('review-scope', [reviewer.id, requester.id], requester.id, end))
  } else {
    if (kind === 'reviewer-in-block/requester-outside' || kind === 'different-blocks' || kind === 'native-self-review-outside') {
      reviewer.choice = exitChoice(outward)
      blocks.push(block('reviewer-scope', [reviewer.id], reviewer.id, outward))
    }
    if (kind === 'reviewer-outside/requester-in-block' || kind === 'different-blocks') {
      requester.choice = exitChoice(end)
      blocks.push(block('requester-scope', [requester.id], requester.id, end))
    }
  }
  if (blocks.length) definition.repeat = { contractVersion: 1, blocks }
  if (kind === 'native-self-review-outside') {
    definition.edges = definition.edges.filter((item) => item.kind !== 'approval')
    const config = f.configurations[1]!
    if (config.harness.harness !== 'codex') throw new Error('The fixture requires native Codex self-review')
    f.configurations[1] = AgentConfigurationVersionSchema.parse({ ...config, harness: { ...config.harness,
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } } })
  }
  definition.executionPolicy = { maxParallelism: 1,
    maxNodeExecutions: definition.nodes.length + blocks.reduce((total, item) => total + (item.maxOccurrences - 1) * item.nodeIds.length, 0) }
  f.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...f.version, definition }))
  return f
}
