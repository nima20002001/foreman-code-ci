import { createHash } from 'node:crypto'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'

/** Canonical S3-01..04 candidates shared by contract and runtime regression tests.
 * Static data only: callers must use real Save/Start for publication proof. */
type NoRepeatShape = 'single' | 'sequential' | 'parallel' | 'conditional' | 'approval'

type RawScenario = {
  id: string
  shape: NoRepeatShape
  version: Record<string, unknown>
  configurations: Array<ReturnType<typeof AgentConfigurationVersionSchema.parse>>
  nodeIds: string[]
}

export const at = '2026-09-25T14:00:00.000Z'
export const digest = (value: unknown) => `sha256:${createHash('sha256').update(canonicalGraphJson(value)).digest('hex')}`
const edge = (id: string, source: string, target: string) => ({ id, kind: 'execution' as const, source, target })
const approvalEdge = (id: string, source: string, target: string) => ({ id, kind: 'approval' as const, source, target })

function configuration(workspaceId: string, scenario: string, name: string, role: 'coder' | 'orchestrator' = 'coder') {
  const agentId = `agent-${scenario}-${name}`
  return AgentConfigurationVersionSchema.parse({
    id: `config-${scenario}-${name}`,
    workspaceId,
    agentId,
    productRole: role,
    version: 1,
    harness: {
      harness: 'codex',
      model: 'synthetic-no-native-call',
      reasoningEffort: 'low',
      sandbox: 'read-only',
      serviceTier: 'standard',
    },
    prompt: {},
    assignedSkills: [],
    contentHash: `sha256:${'0'.repeat(64)}`,
    createdAt: at,
  })
}

export function noRepeatScenario(id: string, shape: NoRepeatShape): RawScenario {
  const workspaceId = `ws-${id}`
  const workflowId = `wf-${id}`
  const names = shape === 'single' ? ['a']
    : shape === 'sequential' || shape === 'approval' ? ['a', 'b']
      : shape === 'parallel' ? ['a', 'b', 'c', 'e', 'd']
        : ['a', 'b', 'c', 'd']
  const configurations = names.map((name) => configuration(workspaceId, id, name,
    shape === 'approval' && name === 'a' ? 'orchestrator' : 'coder'))
  const nodes = configurations.map((item) => ({ id: `node-${id}-${item.agentId.split('-').at(-1)}`, agentId: item.agentId,
    name: `S3 ${item.agentId}`,
    ...(shape === 'parallel' && item.agentId.endsWith('-d') ? { join: { mode: 'all' as const } } : {}) }))
  const node = (name: string) => nodes[names.indexOf(name)]!.id
  const edges = shape === 'single' ? []
    : shape === 'sequential' ? [edge(`${id}-a-b`, node('a'), node('b'))]
      : shape === 'parallel' ? [
        edge(`${id}-a-b`, node('a'), node('b')),
        edge(`${id}-a-c`, node('a'), node('c')),
        edge(`${id}-c-e`, node('c'), node('e')),
        edge(`${id}-b-d`, node('b'), node('d')),
        edge(`${id}-e-d`, node('e'), node('d')),
      ]
        : shape === 'conditional' ? [
          edge(`${id}-a-b`, node('a'), node('b')),
          edge(`${id}-a-c`, node('a'), node('c')),
          edge(`${id}-b-d`, node('b'), node('d')),
          edge(`${id}-c-d`, node('c'), node('d')),
        ]
          : [edge(`${id}-a-b`, node('a'), node('b')), approvalEdge(`${id}-approval-a-b`, node('a'), node('b'))]

  if (shape === 'conditional') {
    nodes[0] = {
      ...nodes[0]!,
      choice: { outcomes: [
        { outcome: 'left', target: { kind: 'edge' as const, relationshipId: `${id}-a-b` } },
        { outcome: 'right', target: { kind: 'edge' as const, relationshipId: `${id}-a-c` } },
      ] },
    } as typeof nodes[number]
  }

  const approval = shape === 'approval'
    ? { handler: 'orchestrator' as const, designatedOrchestratorAgentId: configurations[0]!.agentId }
    : { handler: 'user' as const }
  const definition = {
    id: workflowId,
    workspaceId,
    name: `S3 ${id}`,
    version: 1,
    executionSemanticsVersion: 3 as const,
    entryNodeId: nodes[0]!.id,
    executionCondition: { kind: 'manual' as const },
    approval,
    executionPolicy: { maxParallelism: shape === 'parallel' || shape === 'conditional' ? 3 : 1, maxNodeExecutions: nodes.length },
    nodes,
    edges,
    // Canonical S3-01..04 representation: repeat is ABSENT, never null/empty/cap-one.
  }
  const pins = Object.fromEntries(configurations.map((item) => [item.agentId, item.id]))
  const version = {
    id: `wv-${id}`,
    workspaceId,
    workflowId,
    version: 1,
    executionSemanticsVersion: 3 as const,
    entryNodeId: nodes[0]!.id,
    definition,
    approval,
    agentConfigurationVersionIds: pins,
    contentHash: digest({ definition, pins }),
    createdAt: at,
  }
  return { id, shape, version, configurations, nodeIds: nodes.map((item) => item.id) }
}

export function location(id: string) {
  return { runnerId: `runner-${id}`, rootPath: `/synthetic/${id}`, locationRevision: 9,
    identityHash: digest({ device: id, inode: 9 }) }
}

export function runCandidate(scenario: RawScenario, input: Record<string, unknown>) {
  const version = scenario.version as {
    id: string; workspaceId: string; workflowId: string; agentConfigurationVersionIds: Record<string, string>;
    approval: unknown; definition: { executionCondition: unknown }
  }
  return {
    id: `run-${scenario.id}`,
    workspaceId: version.workspaceId,
    workflowId: version.workflowId,
    workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds,
    approval: version.approval,
    executionLocation: location(scenario.id),
    authorizationPrincipalId: `principal-${scenario.id}`,
    executionCondition: version.definition.executionCondition,
    executionState: 'queued' as const,
    outcome: 'pending' as const,
    input,
    createdAt: at,
  }
}

