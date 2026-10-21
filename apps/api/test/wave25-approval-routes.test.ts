import { describe, expect, it } from 'vitest'
import { resolveImmutableApprovalRoute, usesNativeSelfReview } from '../src/modules/workflows/approvalRoutes.js'
import { ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { validateReviewerBootstrap } from '../src/modules/workflows/reviewerBootstrap.js'
import { approvalFixture, routeDenialCases } from './helpers/wave25ApprovalFixture.js'

function route(version = approvalFixture().version) {
  return resolveImmutableApprovalRoute(version, 'node-worker', 'agent-worker')
}

describe('Wave 2.5 immutable approval routing', () => {
  it('returns the typed relationship and exact immutable node/configuration pins', () => {
    expect(route()).toEqual({
      workspaceId: 'workspace-approval', workflowId: 'workflow-approval', workflowVersionId: 'version-approval',
      requestingNodeId: 'node-worker', requestingAgentId: 'agent-worker', requestingConfigurationVersionId: 'cfg-worker',
      orchestratorNodeId: 'node-reviewer', reviewerAgentId: 'agent-reviewer', reviewerConfigurationVersionId: 'cfg-reviewer',
      relationshipId: 'approval-edge',
    })
  })
  it.each(routeDenialCases)('denies %s', (_name, mutate) => {
    const { version } = approvalFixture()
    mutate(version)
    expect(route(version)).toBeUndefined()
  })
  it.each([
    ['missing-node', 'agent-worker'], ['node-worker', 'wrong-agent'], ['node-reviewer', 'agent-reviewer'],
  ])('denies mismatched or self requester %s/%s', (nodeId, agentId) => {
    expect(resolveImmutableApprovalRoute(approvalFixture().version, nodeId, agentId)).toBeUndefined()
  })
  it('does not use canvas order, labels, or a current draft', () => {
    const { version } = approvalFixture()
    const before = route(version)
    version.definition.nodes.reverse()
    version.definition.nodes[0]!.name = 'Orchestrator'
    version.definition.edges.reverse()
    expect(route(version)).toEqual(before)
    const draft = structuredClone(version.definition)
    draft.edges = []
    expect(route(version)).toEqual(before)
  })
  it('rejects an inherited rather than pinned configuration ID', () => {
    const { version } = approvalFixture()
    version.agentConfigurationVersionIds = Object.create(version.agentConfigurationVersionIds) as Record<string, string>
    expect(route(version)).toBeUndefined()
  })
  it('uses accepted entry rather than nodes[0] in reviewer bootstrap', () => {
    const { version, configurations } = approvalFixture()
    version.definition.nodes.reverse()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, configurations[0]!.harness, version.entryNodeId)).not.toThrow()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, configurations[0]!.harness, 'node-worker')).toThrow()
  })
  it('accepts safe one-node native self-review without an App self-edge or artificial Worker', () => {
    const { version, configurations } = approvalFixture()
    version.definition.nodes = version.definition.nodes.slice(0, 1)
    version.definition.edges = []
    version.agentConfigurationVersionIds = { 'agent-reviewer': 'cfg-reviewer' }
    expect(usesNativeSelfReview(configurations[0]!.harness)).toBe(true)
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations: configurations.slice(0, 1) })).not.toThrow()
    expect(resolveImmutableApprovalRoute(version, 'node-reviewer', 'agent-reviewer')).toBeUndefined()
  })
  it('keeps unsafe or missing native bootstrap configuration rejected', () => {
    const { version, configurations } = approvalFixture()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, undefined)).toThrow()
    expect(() => validateReviewerBootstrap(version.definition, version.approval, configurations[1]!.harness)).toThrow()
  })
  it('validates immutable configurations and routes at executable acceptance', () => {
    const { version, configurations } = approvalFixture()
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations })).not.toThrow()
    const wrong = structuredClone(configurations)
    wrong[0]!.workspaceId = 'different-workspace'
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations: wrong })).toThrow()
    const stale = structuredClone(configurations)
    stale[0]!.id = 'stale-configuration'
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations: stale })).toThrow()
    const wrongRole = structuredClone(configurations)
    wrongRole[0]!.productRole = 'coder'
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations: wrongRole })).toThrow()
  })
  it('accepts a native self-review Worker without inventing an App assignment (G1 conflict)', () => {
    const { version, configurations } = approvalFixture()
    configurations[1]!.harness = structuredClone(configurations[0]!.harness)
    version.definition.edges = version.definition.edges.filter((e) => e.kind === 'execution')
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations })).not.toThrow()
  })
  it('rejects recursive approval snapshots before dispatch', () => {
    const { version, configurations } = approvalFixture()
    version.definition.edges.push({ id: 'cycle', kind: 'approval', source: 'node-worker', target: 'node-reviewer' })
    expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations })).toThrow()
  })
})
