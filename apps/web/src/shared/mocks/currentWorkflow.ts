import { nativeDefinition } from './nativeFixtureTypes'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  ExecutableWorkflowV3Schema, WorkflowRunV3Schema, RepeatGraphScopeV3Schema,
  RepeatGraphCurrentV3Schema, repeatGraphTopologyV3,
} from '@foreman-code/contracts/wave25'

/** Synthetic CURRENT V3 fixture. It never creates a legacy definition, retags a
 * prior version, starts a provider, or proves database/native qualification. */
export function currentWorkflowFixture(suffix = 'fixture') {
  const workspaceId = `ws-${suffix}`, workflowId = `wf-${suffix}`, versionId = `wv-${suffix}`, runId = `run-${suffix}`
  const createdAt = '2026-09-25T00:00:00.000Z'
  const configurations = ['a', 'b'].map((name) => AgentConfigurationVersionSchema.parse({
    id: `cfg-${suffix}-${name}`, workspaceId, agentId: `agent-${suffix}-${name}`, productRole: 'coder', version: 1,
    harness: { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
  }))
  const nodes = configurations.map((configuration, index) => ({ id: `node-${suffix}-${index}`,
    agentId: configuration.agentId, name: `Synthetic Worker ${index + 1}`, position: { x: index * 300, y: 100 } }))
  const definition = { id: workflowId, workspaceId, name: 'Current V3 workflow', version: 1,
    executionSemanticsVersion: 3 as const, entryNodeId: nodes[0]!.id, executionCondition: { kind: 'manual' as const },
    approval: { handler: 'user' as const }, executionPolicy: { maxParallelism: 2, maxNodeExecutions: 8 }, nodes,
    edges: [{ id: `edge-${suffix}`, source: nodes[0]!.id, target: nodes[1]!.id, kind: 'execution' as const }] }
  const { version } = ExecutableWorkflowV3Schema.parse({ version: {
    id: versionId, workspaceId, workflowId, version: 1, executionSemanticsVersion: 3, entryNodeId: definition.entryNodeId,
    definition, approval: definition.approval,
    agentConfigurationVersionIds: Object.fromEntries(configurations.map((configuration) => [configuration.agentId, configuration.id])),
    contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
  }, configurations })
  const run = WorkflowRunV3Schema.parse({ authorizationPrincipalId: 'principal-synthetic',
    executionLocation: { runnerId: 'runner-synthetic', rootPath: '/synthetic/board', locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` }, id: runId, workspaceId, workflowId, workflowVersionId: versionId,
    executionSemanticsVersion: 3, agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval: definition.approval,
    executionCondition: definition.executionCondition, executionState: 'queued', outcome: 'pending', input: {}, createdAt })
  const scope = RepeatGraphScopeV3Schema.parse({ workspaceId, workflowId, runId, workflowVersionId: versionId, executionSemanticsVersion: 3 })
  const identities = nodes.map((node, index) => ({ workflowNodeId: node.id, executionId: `exec-${suffix}-${index}`,
    agentId: node.agentId, agentConfigurationVersionId: configurations[index]!.id, attempt: 1, occurrence: null }))
  const executions = identities.map((identity) => HarnessExecutionSchema.parse({ id: identity.executionId, runId,
    workflowNodeId: identity.workflowNodeId, agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt: 1, input: { executionSemanticsVersion: 3, runInput: {}, predecessors: [] }, state: 'queued', createdAt }))
  const current = RepeatGraphCurrentV3Schema.parse({ kind: 'current', protocolVersion: 1, scope, asOfSequence: '0', retentionFloor: '0',
    historyCoverage: 'from_admission', topology: repeatGraphTopologyV3(version), state: {
      run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
      nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [],
    } })
  return { configurations, version:{...version,definition:nativeDefinition(version.definition)}, run, scope, identities, executions, current, createdAt }
}
