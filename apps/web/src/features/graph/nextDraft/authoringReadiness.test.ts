import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { fixture } from './core.cases'
import { authoringHints } from './model'

const codex: CodexHarnessConfiguration = { harness: 'codex', model: 'gpt-5.6-luna', reasoningEffort: 'medium',
  sandbox: 'read-only', serviceTier: 'standard' }

describe('Board readiness reports known Save requirements', () => {
  it('includes missing limits alongside a missing reviewing orchestrator', () => {
    const context = fixture(['orchestrator'])
    const graph = { ...context.draft.graph, executionPolicy: undefined,
      approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'missing-reviewer' } }
    expect(authoringHints(graph, context).map(issue => issue.code)).toEqual([
      'EXECUTION_LIMITS_REQUIRED', 'REVIEWER_BOOTSTRAP_UNSUPPORTED',
    ])
  })
  it('counts both Agent and Job nodes when execution limits are too low', () => {
    const context = fixture(['coder'])
    const graph = { ...context.draft.graph, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
      nodes: [...context.draft.graph.nodes, { kind: 'job' as const, id: 'job-node', jobDefinitionId: 'job',
        jobDefinitionVersionId: 'job-version', jobDefinitionRevision: 1 }] }
    expect(authoringHints(graph, context)).toEqual([{ code: 'EXECUTION_LIMIT_TOO_LOW',
      message: 'Increase “Maximum node executions” to at least 2.' }])
  })
  it('reports incompatible Codex reviewer settings before Save and respects unsaved Agent settings', () => {
    const context = fixture(['orchestrator']), agent = context.agents[0]!.agent
    agent.harnessConfiguration = codex
    const graph = { ...context.draft.graph,
      approval: { handler: 'orchestrator' as const, designatedOrchestratorAgentId: agent.id } }
    const hints = authoringHints(graph, context)
    expect(hints).toEqual([expect.objectContaining({ code: 'APPROVAL_CODEX_REVIEW_CONFIGURATION_REQUIRED', nodeId: 'node-0' })])
    const compatible = { ...agent, harnessConfiguration: { ...codex,
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request' as const, approvalsReviewer: 'auto_review' as const } } }
    expect(authoringHints(graph, context, { [agent.id]: compatible })).toEqual([])
    expect(authoringHints({ ...graph, approval: { handler: 'user' } }, context)).toEqual([])
  })
})
