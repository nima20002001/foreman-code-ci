import type { AgentConfigurationVersion, HarnessExecution, WorkflowRun } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'

/** Synthetic accepted identities only. Never starts a native session. */
export function approvalFixture() {
  const createdAt = '2026-09-21T00:00:00.000Z'
  const configurations: AgentConfigurationVersion[] = ['reviewer', 'worker'].map((name) => ({
    id: `cfg-${name}`, workspaceId: 'workspace-approval', agentId: `agent-${name}`,
    productRole: name === 'reviewer' ? 'orchestrator' : 'coder', version: 1,
    harness: {
      harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
      advanced: {
        approvalPolicy: 'on-request', approvalsReviewer: name === 'reviewer' ? 'auto_review' : 'user',
        additionalWritableDirectories: [], sessionPersistence: 'persistent',
        shellEnvironment: { inherit: 'all', ignoreDefaultExcludes: false, filters: {}, set: {} },
        webSearch: 'disabled', mcpServers: {},
      },
    },
    prompt: {}, assignedSkills: [], contentHash: 'sha256:' + '0'.repeat(64), createdAt,
  }))
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: 'agent-reviewer' }
  const version: WorkflowVersionV3 = {
    id: 'version-approval', workspaceId: 'workspace-approval', workflowId: 'workflow-approval', version: 1,
    executionSemanticsVersion: 3, entryNodeId: 'node-reviewer', approval,
    agentConfigurationVersionIds: { 'agent-reviewer': 'cfg-reviewer', 'agent-worker': 'cfg-worker' },
    definition: {
      id: 'workflow-approval', workspaceId: 'workspace-approval', name: 'Approval fixture', version: 1,
      executionSemanticsVersion: 3, entryNodeId: 'node-reviewer', approval,
      executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
      nodes: [{ id: 'node-reviewer', agentId: 'agent-reviewer', name: 'Reviewer' },
        { id: 'node-worker', agentId: 'agent-worker', name: 'Worker' }],
      edges: [{ id: 'execution-edge', kind: 'execution', source: 'node-reviewer', target: 'node-worker' },
        { id: 'approval-edge', kind: 'approval', source: 'node-reviewer', target: 'node-worker' }],
    },
    contentHash: 'sha256:' + '0'.repeat(64), createdAt,
  }
  const run: WorkflowRun & { executionSemanticsVersion: 3 } = {
    id: 'run-approval', workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowVersionId: version.id, executionSemanticsVersion: 3,
    authorizationPrincipalId: 'approval-fixture-author',
    executionLocation: { runnerId: 'local', rootPath: '/synthetic/approval-test', locationRevision: 1, identityHash: 'sha256:' + '1'.repeat(64) },
    agentConfigurationVersionIds: { ...version.agentConfigurationVersionIds }, approval: { ...approval },
    executionCondition: { kind: 'manual' }, executionState: 'waiting', outcome: 'pending', input: {}, createdAt,
  }
  const executions: HarnessExecution[] = version.definition.nodes.map((node) => {
    if (node.kind === 'job') throw new Error('Approval fixture executions require Agent nodes')
    return {
      id: `execution-${node.agentId}`, runId: run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId]!, attempt: 1,
      nativeSessionId: `session-${node.agentId}`, input: {}, state: 'waiting', createdAt,
    }
  })
  return { version, configurations, run, executions, createdAt }
}

export const routeDenialCases: ReadonlyArray<readonly [string, (version: WorkflowVersionV3) => void]> = [
  ['execution adjacency only', (v) => { v.definition.edges = v.definition.edges.filter((e) => e.kind === 'execution') }],
  ['reversed approval', (v) => { Object.assign(v.definition.edges[1]!, { source: 'node-worker', target: 'node-reviewer' }) }],
  ['duplicate identical assignment', (v) => { v.definition.edges.push({ ...v.definition.edges[1]!, id: 'duplicate' }) }],
  ['duplicate relationship identity', (v) => { v.definition.edges[1]!.id = v.definition.edges[0]!.id }],
  ['self assignment', (v) => { v.definition.edges[1]!.source = 'node-worker' }],
  ['dangling endpoint', (v) => { v.definition.edges[1]!.source = 'missing-node' }],
  ['duplicate node identity', (v) => { v.definition.nodes.push({ ...v.definition.nodes[0]! }) }],
  ['duplicate Agent occurrence', (v) => { v.definition.nodes.push({ ...v.definition.nodes[0]!, id: 'other-occurrence' }) }],
  ['authored entry differs', (v) => { v.definition.entryNodeId = 'node-worker' }],
  ['no authored entry', (v) => { v.definition.entryNodeId = null }],
  ['non-initialized reviewer', (v) => { v.definition.entryNodeId = v.entryNodeId = 'node-worker' }],
  ['incoming entry execution', (v) => { Object.assign(v.definition.edges[0]!, { source: 'node-worker', target: 'node-reviewer' }) }],
  ['recursive review', (v) => { v.definition.edges.push({ id: 'recursive', kind: 'approval', source: 'node-worker', target: 'node-reviewer' }) }],
  ['independent second reviewer', (v) => {
    v.definition.nodes.push({ id: 'second-reviewer', agentId: 'second-agent', name: 'Second reviewer' })
    v.definition.edges.push({ id: 'second-assignment', kind: 'approval', source: 'second-reviewer', target: 'node-worker' })
  }],
  ['transitive-only assignment', (v) => {
    v.definition.nodes.push({ id: 'middle', agentId: 'middle-agent', name: 'Middle' })
    v.definition.edges[1]!.target = 'middle'
    v.definition.edges.push({ id: 'transitive', kind: 'approval', source: 'middle', target: 'node-worker' })
  }],
  ['wrong immutable workspace', (v) => { v.workspaceId = 'other-workspace' }],
  ['wrong immutable workflow', (v) => { v.workflowId = 'other-workflow' }],
  ['wrong immutable version number', (v) => { v.version += 1 }],
  ['different definition approval', (v) => { v.definition.approval = { handler: 'user' } }],
  ['different accepted reviewer', (v) => { v.approval = { handler: 'orchestrator', designatedOrchestratorAgentId: 'other-agent' } }],
  ['explicit user mode', (v) => { v.approval = { handler: 'user' }; v.definition.approval = { handler: 'user' } }],
  ['missing requester pin', (v) => { delete v.agentConfigurationVersionIds['agent-worker'] }],
  ['missing reviewer pin', (v) => { delete v.agentConfigurationVersionIds['agent-reviewer'] }],
  ['empty requester pin', (v) => { v.agentConfigurationVersionIds['agent-worker'] = '' }],
]

export function deliveryFixture() {
  const createdAt = '2026-09-21T00:00:00.000Z'
  const interaction: import('@foreman-code/contracts').DurableInteraction = {
    id: 'interaction-approval', revision: 1, workspaceId: 'workspace-approval', workflowId: 'workflow-approval',
    runId: 'run-approval', executionId: 'execution-agent-worker', requestingAgentId: 'agent-worker',
    harness: 'codex', providerVersion: 'synthetic-test', nativeSessionId: 'session-agent-worker',
    nativeRequestId: 'request-worker', nativeRequestType: 'item/commandExecution/requestApproval',
    graphThreadId: 'thread-approval', request: {},
    approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'agent-reviewer' },
    responseOptions: [
      { optionId: 'approve-once', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
        affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
      { optionId: 'reject', semantic: 'reject', label: 'Reject', persistence: 'request',
        affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
    ],
    status: 'decided', deliveryState: 'not_started', selectedOptionId: 'approve-once', selectedSemantic: 'approve_once',
    nativeResponse: { decision: 'accept' }, createdAt, updatedAt: createdAt, decidedAt: createdAt,
  }
  const session: import('@foreman-code/contracts').NativeSessionReference = {
    harness: interaction.harness, providerVersion: interaction.providerVersion, nativeSessionId: interaction.nativeSessionId,
  }
  const proof: import('../../src/modules/interactions/delivery.js').NativeResponseDeliveryEvidence = {
    source: 'provider_acknowledgement', ...session, nativeRequestId: interaction.nativeRequestId,
    nativeRequestType: interaction.nativeRequestType, optionId: 'approve-once', semantic: 'approve_once',
  }
  const history: import('../../src/modules/harnesses/port.js').NativeHistory = { events: [], pendingInteractions: [], responseDeliveries: [proof] }
  return { interaction, session, proof, history }
}
