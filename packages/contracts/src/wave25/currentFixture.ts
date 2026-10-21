import { AgentConfigurationVersionSchema, DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '../index.js'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from './saved.js'
import { ExecutableWorkflowV3Schema } from './repeatAdmission.js'

export type CurrentFixtureForm = 'single' | 'sequential' | 'parallel' | 'conditional' | 'approval' | 'repeat'
/** Static contract data, NOT a persisted publication, native receipt or runtime
 * qualification. PostgreSQL tests must create/Save through the real typed writer.
 * No old execution shape is converted, even as a test bootstrap. */
export function makeCurrentWorkflowFixture(suffix = 'current-fixture', form: CurrentFixtureForm = 'sequential') {
  const workspaceId = `ws-${suffix}`, workflowId = `wf-${suffix}`, versionId = `wv-${suffix}`, runId = `run-${suffix}`
  const createdAt = '2026-09-25T00:00:00.000Z'
  const size = form === 'single' ? 1 : form === 'parallel' ? 4 : 2
  const configurations = Array.from({ length: size }, (_, index) => AgentConfigurationVersionSchema.parse({
    id: `cfg-${suffix}-${index}`, workspaceId, agentId: `agent-${suffix}-${index}`, version: 1,
    productRole: form === 'approval' && index === 0 ? 'orchestrator' : 'coder',
    harness: { harness: 'codex', model: 'contract-fixture-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard',
      // A designated Codex Orchestrator must review App MCP approvals without a person.
      ...(form === 'approval' && index === 0 ? { advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request' as const, approvalsReviewer: 'auto_review' as const } } : {}) },
    prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
  }))
  const nodes = configurations.map((config, index) => ({ id: `node-${suffix}-${index}`, agentId: config.agentId, name: `Worker ${index}` }))
  const pairs = form === 'single' ? [] : form === 'parallel' ? [[0, 1], [0, 2], [1, 3], [2, 3]] : [[0, 1]]
  const edges = pairs.map(([from, to], index) => ({ id: `edge-${suffix}-${index}`, kind: 'execution' as const,
    source: nodes[from!]!.id, target: nodes[to!]!.id }))
  const approval = form === 'approval' ? { handler: 'orchestrator' as const, designatedOrchestratorAgentId: configurations[0]!.agentId }
    : { handler: 'user' as const }
  const definition = {
    id: workflowId, workspaceId, name: `Current ${form}`, version: 1, executionSemanticsVersion: 3 as const,
    entryNodeId: nodes[0]!.id, executionCondition: { kind: 'manual' as const }, approval,
    executionPolicy: { maxParallelism: form === 'parallel' ? 2 : 1, maxNodeExecutions: form === 'repeat' ? 6 : size },
    nodes: nodes.map((node, index) => ({ ...node,
      ...(form === 'parallel' && index === 3 ? { join: { mode: 'all' as const } } : {}),
      ...(form === 'conditional' && index === 0 ? { choice: { outcomes: [
        { outcome: 'go', target: { kind: 'edge' as const, relationshipId: edges[0]!.id } },
        { outcome: 'skip', target: { kind: 'branch_end' as const } },
      ] } } : {}),
      ...(form === 'repeat' && index === 1 ? { choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' as const } },
        { outcome: 'issues', target: { kind: 'branch_end' as const } },
      ] } } : {}),
    })),
    edges: [...edges, ...(form === 'approval' ? [{ id: `review-${suffix}`, kind: 'approval' as const,
      source: nodes[0]!.id, target: nodes[1]!.id }] : [])],
    ...(form === 'repeat' ? { repeat: { contractVersion: 1 as const, blocks: [{ id: 'repair', nodeIds: nodes.map((node) => node.id),
      entryNodeId: nodes[0]!.id, exitNodeId: nodes[1]!.id, maxOccurrences: 3,
      repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' as const } }] } } : {}),
  }
  const version = WorkflowVersionV3Schema.parse({ id: versionId, workspaceId, workflowId, version: 1,
    executionSemanticsVersion: 3, entryNodeId: nodes[0]!.id, definition, approval,
    agentConfigurationVersionIds: Object.fromEntries(configurations.map((config) => [config.agentId, config.id])),
    contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
  ExecutableWorkflowV3Schema.parse({ version, configurations })
  const run = WorkflowRunV3Schema.parse({ id: runId, workspaceId, workflowId, workflowVersionId: versionId, executionSemanticsVersion: 3,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval, executionCondition: { kind: 'manual' },
    executionState: 'queued', outcome: 'pending', input: {}, createdAt })
  const scope = { workspaceId, workflowId, runId, workflowVersionId: versionId, executionSemanticsVersion: 3 as const }
  const identities = nodes.map((node, index) => ({ workflowNodeId: node.id, executionId: `exec-${suffix}-${index}`, agentId: node.agentId,
    agentConfigurationVersionId: configurations[index]!.id, attempt: 1 }))
  const agentNodes=version.definition.nodes.map(node=>{if(node.kind==='job')throw new Error('Agent-only fixture unexpectedly contains a job');return node})
  return { configurations, version:{...version,definition:{...version.definition,nodes:agentNodes}}, run, scope, identities, createdAt }
}
