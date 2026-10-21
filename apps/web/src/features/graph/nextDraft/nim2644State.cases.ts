import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import assert from 'node:assert/strict'
import type { Agent } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { sameExecutableWorkflow } from '@foreman-code/contracts/wave25'
import { acknowledgeAgentEdits } from './agentEdits'
import { authoringHints, entryChoices, mergeAcknowledgement, removeNode, roleEvidence, type NextDraftContext } from './model'

/** Synthetic frontend fixture; no server, native Run, configuration or authority is created. */
export function repairFixture(count = 3): NextDraftContext {
  const graph: WorkflowDefinitionV3 = {
    id: 'workflow', workspaceId: 'workspace', name: 'NIM-2644 frontend fixture', executionSemanticsVersion: 3,
    entryNodeId: 'node-0', executionCondition: { kind: 'manual' }, approval: { handler: 'user' },
    executionPolicy: { maxParallelism: 4, maxNodeExecutions: 1000 }, version: 1,
    nodes: Array.from({ length: count }, (_, i) => ({ id: `node-${i}`, agentId: `agent-${i}`, name: `Node ${i}`, position: { x: i * 250, y: 0 } })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ id: `edge-${i + 1}`, source: 'node-0', target: `node-${i + 1}`, kind: 'execution' as const })),
  }
  return { draft: { id: 'draft', workspaceId: 'workspace', workflowId: 'workflow', revision: 7, publishedRevision: 7,
    baseWorkflowVersionId: 'version-1', graph, stagedAgents: [], updatedByPrincipalId: 'fixture', updatedAt: '2026-09-24T00:00:00Z' },
  agents: graph.nodes.map((node) => ({ metadataRevision: 3, agent: { id: nativeNode(node).agentId, name: node.name!, productRole: 'coder', configurationVersionId: `configuration-${nativeNode(node).agentId}` } })) }
}
const move = (graph: WorkflowDefinitionV3, nodeId = 'node-0') => ({ ...graph,
  nodes: graph.nodes.map((node) => node.id === nodeId ? { ...node, position: { x: 912, y: -41 }, width: 280, height: 190 } : node) })
const instruction = (graph: WorkflowDefinitionV3, text: string, id = 'node-0') => ({ ...graph,
  nodes: graph.nodes.map((node) => node.id === id ? { ...node, initialPrompt: text } : node) })
const ids = (graph: WorkflowDefinitionV3) => graph.nodes.map((node) => node.id)
const local: Agent = { id: 'new-agent', name: 'New Worker', productRole: 'coder' }
const newNode = { id: 'new-node', agentId: local.id, name: local.name, position: { x: 700, y: 100 } }

export const nim2644StateCases: { name: string; run: () => void }[] = [
  { name: 'FE-003 restores a removed node and edge with later surviving-node movement', run() {
    const saved = repairFixture().draft.graph, sent = removeNode(saved, 'node-1'), current = move(sent)
    const before = structuredClone({ saved, sent, current })
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.deepEqual(ids(merged), ids(saved)); assert.deepEqual(merged.edges, saved.edges)
    assert.deepEqual(nativeNode(merged.nodes[0])?.position, { x: 912, y: -41 })
    assert.equal(nativeNode(merged.nodes[0])?.width, 280); assert.equal(nativeNode(merged.nodes[0])?.height, 190)
    assert(sameExecutableWorkflow(merged, saved))
    assert.deepEqual({ saved, sent, current }, before)
    assert.deepEqual(mergeAcknowledgement(merged, sent, saved), merged)
  } },
  { name: 'FE-003 restores multiple removed nodes, entry, and both relationship kinds in saved order', run() {
    const saved = repairFixture(4).draft.graph
    saved.edges.push({ id: 'approval-record', kind: 'approval', source: 'node-0', target: 'node-2' })
    const sent = removeNode(removeNode(saved, 'node-0'), 'node-2')
    const merged = mergeAcknowledgement(move(sent, 'node-1'), sent, saved)
    assert.deepEqual(ids(merged), ids(saved)); assert.deepEqual(merged.edges, saved.edges)
    assert.equal(merged.entryNodeId, 'node-0'); assert(sameExecutableWorkflow(merged, saved))
    assert.deepEqual(nativeNode(merged.nodes[1])?.position, { x: 912, y: -41 })
  } },
  { name: 'FE-003 restores an edge-only deletion despite unrelated layout', run() {
    const saved = repairFixture().draft.graph, sent = { ...saved, edges: saved.edges.slice(1) }
    const merged = mergeAcknowledgement(move(sent), sent, saved)
    assert.deepEqual(merged.edges, saved.edges); assert(sameExecutableWorkflow(merged, saved))
  } },
  { name: 'FE-003 preserves newer instruction while restoring staged topology removal', run() {
    const saved = repairFixture().draft.graph, sent = instruction(removeNode(saved, 'node-1'), 'staged')
    const current = instruction(move(sent), 'newer')
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.deepEqual(ids(merged), ids(saved)); assert.deepEqual(merged.edges, saved.edges)
    assert.equal(nativeNode(merged.nodes[0])?.initialPrompt, 'newer'); assert.deepEqual(nativeNode(merged.nodes[0])?.position, nativeNode(current.nodes[0])?.position)
    assert(!sameExecutableWorkflow(merged, saved))
  } },
  { name: 'FE-003 keeps a newer node deletion and does not restore its incident edges', run() {
    const saved = repairFixture().draft.graph, sent = removeNode(saved, 'node-1')
    const current = move(removeNode(sent, 'node-2'))
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.deepEqual(ids(merged), ['node-0', 'node-1'])
    assert.deepEqual(merged.edges.map((edge) => edge.id), ['edge-1'])
  } },
  { name: 'FE-003 does not restore an edge removed only after Stage', run() {
    const saved = repairFixture().draft.graph, sent = instruction(saved, 'staged')
    const current = { ...move(sent), edges: sent.edges.slice(1) }
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.deepEqual(merged.edges.map((edge) => edge.id), ['edge-2'])
    assert.equal(nativeNode(merged.nodes[0])?.initialPrompt, undefined)
  } },
  { name: 'FE-003 never restores entry onto a node removed after an explicit staged entry clear', run() {
    const saved = repairFixture().draft.graph, sent = { ...saved, entryNodeId: null }
    const current = move(removeNode(sent, 'node-0'), 'node-1')
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.equal(merged.entryNodeId, null)
    assert.deepEqual(ids(merged), ['node-1', 'node-2']); assert.deepEqual(merged.edges, [])
  } },
  { name: 'FE-003 removes a staged addition even if only its geometry changed', run() {
    const saved = repairFixture().draft.graph, sent = { ...saved, nodes: [...saved.nodes, newNode] }
    const merged = mergeAcknowledgement(move(sent, newNode.id), sent, saved)
    assert.deepEqual(ids(merged), ids(saved)); assert(sameExecutableWorkflow(merged, saved))
  } },
  { name: 'FE-003 preserves a newer semantic edit to an added node', run() {
    const saved = repairFixture().draft.graph, sent = { ...saved, nodes: [...saved.nodes, newNode] }
    const merged = mergeAcknowledgement(instruction(move(sent, newNode.id), 'newer', newNode.id), sent, saved)
    assert.equal(merged.nodes.map(nativeNode).find((node) => node.id === newNode.id)?.initialPrompt, 'newer')
    const edits = { [local.id]: local }
    assert.deepEqual(acknowledgeAgentEdits(edits, edits, repairFixture(), merged), edits)
    assert.deepEqual(acknowledgeAgentEdits(edits, edits, repairFixture(), saved), {})
  } },
  { name: 'FE-003 preserves a later addition while restoring earlier removal', run() {
    const saved = repairFixture().draft.graph, sent = removeNode(saved, 'node-1')
    const current = { ...move(sent), nodes: [...move(sent).nodes, newNode] }
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.deepEqual(ids(merged), ['node-0', 'node-1', 'node-2', 'new-node'])
  } },
  { name: 'FE-003 preserves newer ordering of surviving nodes', run() {
    const saved = repairFixture(4).draft.graph, sent = removeNode(saved, 'node-1')
    const current = { ...move(sent), nodes: [...move(sent).nodes].reverse() }
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.deepEqual(ids(merged).filter((id) => id !== 'node-1'), ids(current))
    assert.equal(new Set(ids(merged)).size, saved.nodes.length)
  } },
  { name: 'FE-003 save acknowledgement still preserves newer typing and deletion', run() {
    const sent = instruction(repairFixture().draft.graph, 'submitted')
    const saved = { ...sent, version: 2 }
    const current = instruction(move(removeNode(sent, 'node-2')), 'newer')
    const merged = mergeAcknowledgement(current, sent, saved)
    assert.equal(merged.version, 2); assert.equal(nativeNode(merged.nodes[0])?.initialPrompt, 'newer')
    assert.deepEqual(ids(merged), ids(current)); assert.deepEqual(merged.edges, current.edges)
  } },
  { name: 'FE-002 exact local Agent submission clears despite server empty-field normalization', run() {
    const context = repairFixture(), saved = { ...local, prompt: {}, assignedSkills: [], configurationVersionId: 'saved-configuration' }
    context.agents.push({ agent: saved, metadataRevision: 1 })
    assert.deepEqual(acknowledgeAgentEdits({ [local.id]: local }, { [local.id]: structuredClone(local) }, context), {})
    assert.equal(local.prompt, undefined); assert.equal(local.assignedSkills, undefined)
  } },
  { name: 'FE-002 newer Agent typing survives and saved configuration/timestamps are installed', run() {
    const context = repairFixture(), saved = { ...local, prompt: {}, assignedSkills: [], configurationVersionId: 'saved-configuration',
      createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:01Z' }
    context.agents.push({ agent: saved, metadataRevision: 1 })
    const newer = { ...local, name: 'Newer name' }
    const merged = acknowledgeAgentEdits({ [local.id]: newer }, { [local.id]: local }, context)![local.id]!
    assert.equal(merged.name, 'Newer name'); assert.equal(merged.configurationVersionId, saved.configurationVersionId)
    assert.equal(merged.createdAt, saved.createdAt); assert.equal(merged.updatedAt, saved.updatedAt)
  } },
  { name: 'FE-002 an absent local Agent submission cannot acknowledge independent Agent edits', run() {
    const context = repairFixture(), edits = { [local.id]: local }
    assert.deepEqual(acknowledgeAgentEdits(edits, undefined, context), edits)
    assert.deepEqual(acknowledgeAgentEdits(edits, {}, context), edits)
  } },
  { name: 'FE-004 a new Worker can explicitly replace the sole entry without inventing a pin', run() {
    const context = repairFixture(1), edits = { [local.id]: local }
    const added = { ...context.draft.graph, nodes: [...context.draft.graph.nodes, newNode] }
    const removed = removeNode(added, 'node-0')
    assert.equal(removed.entryNodeId, null)
    assert.deepEqual(roleEvidence(context, local.id, edits), { role: 'coder', source: 'local' })
    assert.deepEqual(entryChoices(removed, context, edits).eligible.map((node) => node.id), ['new-node'])
    assert(!entryChoices(removed, context, edits).valid)
    const selected = { ...removed, entryNodeId: newNode.id }
    assert(entryChoices(selected, context, edits).valid)
    assert.equal(authoringHints(selected, context, edits).length, 0)
    assert.equal(local.configurationVersionId, undefined)
    assert.equal(roleEvidence(context, local.id).source, 'unavailable')
  } },
  { name: 'FE-004 local Orchestrator role excludes a Worker entry but is not a saved pin', run() {
    const context = repairFixture(1), agent = { ...local, productRole: 'orchestrator' as const }
    const graph = { ...context.draft.graph, nodes: [...context.draft.graph.nodes, newNode] }
    assert.deepEqual(entryChoices(graph, context, { [agent.id]: agent }).eligible.map((node) => node.id), ['new-node'])
    assert.equal(roleEvidence(context, agent.id, { [agent.id]: agent }).configurationVersionId, undefined)
  } },
  { name: 'FE-004 free role text, labels, unknown role, and wrong local identity cannot enable entry', run() {
    const context = repairFixture(1), graph = { ...context.draft.graph, nodes: [...context.draft.graph.nodes, newNode] }
    for (const invalid of [{ id: local.id, name: 'Worker', role: 'Coder' }, { ...local, productRole: undefined }, { ...local, id: 'different' }]) {
      assert.equal(entryChoices(graph, context, { [local.id]: invalid }).eligible.length, 0)
    }
  } },
  { name: 'FE-004 local edits cannot override unavailable saved Agent evidence', run() {
    const context = repairFixture(1), current = context.agents[0]!.agent
    context.draft.sourceAgentPins = [{ agentId: current.id, metadataRevision: 3, configurationVersionId: 'stale' }]
    const edits = { [current.id]: { ...current, productRole: 'orchestrator' as const, configurationVersionId: undefined } }
    assert.equal(roleEvidence(context, current.id, edits).source, 'unavailable')
    context.agents = []; context.draft.sourceAgentPins = []
    assert.equal(roleEvidence(context, current.id, edits).source, 'unavailable')
  } },
  { name: 'FE-004 saved configuration role evidence outranks local edits', run() {
    const context = repairFixture(1), current = context.agents[0]!.agent
    const edits = { [current.id]: { ...current, productRole: 'orchestrator' as const } }
    assert.equal(roleEvidence(context, current.id, edits).role, 'coder')
    assert.equal(roleEvidence(context, current.id, edits).source, 'configuration')
    assert.equal(roleEvidence(context, current.id, edits).configurationVersionId, current.configurationVersionId)
    assert.equal(roleEvidence(context, current.id, edits).role, 'coder')
  } },
]
