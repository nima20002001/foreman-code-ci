import { expect, it } from 'vitest'
import { ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { resolveImmutableApprovalRoute } from '../src/modules/workflows/approvalRoutes.js'
import { approvalFixture } from './helpers/wave25ApprovalFixture.js'

it('routes two Worker nodes sharing one Agent through their exact approval relationships', () => {
  const { version, configurations } = approvalFixture()
  version.definition.nodes.push({ id: 'node-worker-2', agentId: 'agent-worker', name: 'Second Worker' })
  version.definition.edges.push(
    { id: 'execution-2', kind: 'execution', source: 'node-reviewer', target: 'node-worker-2' },
    { id: 'approval-2', kind: 'approval', source: 'node-reviewer', target: 'node-worker-2' },
  )
  version.definition.executionPolicy!.maxNodeExecutions = 3
  expect(() => ExecutableWorkflowV3Schema.parse({ version, configurations })).not.toThrow()
  for (const [nodeId, relationshipId] of [['node-worker', 'approval-edge'], ['node-worker-2', 'approval-2']]) {
    expect(resolveImmutableApprovalRoute(version, nodeId!, 'agent-worker')).toMatchObject({
      requestingNodeId: nodeId, requestingConfigurationVersionId: 'cfg-worker',
      orchestratorNodeId: 'node-reviewer', reviewerConfigurationVersionId: 'cfg-reviewer', relationshipId,
    })
    expect(resolveImmutableApprovalRoute(version, nodeId!, 'wrong-agent')).toBeUndefined()
  }
  delete version.agentConfigurationVersionIds['agent-worker']
  expect(resolveImmutableApprovalRoute(version, 'node-worker-2', 'agent-worker')).toBeUndefined()
})

it('still denies ambiguous reviewer occurrences when Worker Agents can be reused', () => {
  const { version } = approvalFixture()
  version.definition.nodes.push({ id: 'other-reviewer', agentId: 'agent-reviewer', name: 'Duplicate reviewer' })
  expect(resolveImmutableApprovalRoute(version, 'node-worker', 'agent-worker')).toBeUndefined()
})
